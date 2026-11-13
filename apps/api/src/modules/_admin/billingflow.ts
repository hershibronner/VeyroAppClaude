// SaaS payment lifecycle: charge → paid | failed → grace (7 days) → suspended → reactivated on payment.
// With Stripe set up on the server the charge is real (saved card on the platform's Stripe, off-session); otherwise simulated.
import { q, one, tx } from '../../core/db';
import { audit } from '../../core/audit';
import { notify, usersWithRoles } from '../../core/notify';
import { sendMessage } from '../../adapters/messaging';
import { clearSuspendedCache } from '../admin-00-core';
import { notifyPlatform } from './common';
import { formatMoney } from '@veyro/shared';
import { stripePlatform, chargeOffSession } from '../../adapters/stripe';

export const GRACE_DAYS = 7;
type Actor = { orgId: string; userId: string | null; user: { name: string }; impersonatorId: string | null; ip: string } | null;

export async function chargeInvoice(invoiceId: string, actor: Actor, opts: { forceFail?: boolean } = {}) {
  const inv = await one<any>(`SELECT i.*, o.name org_name FROM saas_invoices i JOIN organizations o ON o.id=i.organization_id WHERE i.id=$1`, [invoiceId]);
  if (!inv) throw new Error('Invoice not found');
  if (!['open', 'failed'].includes(inv.status)) return { ok: inv.status === 'paid', status: inv.status, message: `Invoice is ${inv.status}` };
  const sub = await one<any>(`SELECT * FROM subscriptions WHERE organization_id=$1`, [inv.organization_id]);
  let fail: boolean; let reason: string | null; let ref: string | null = null;
  if (stripePlatform()) {
    if (!sub?.stripe_customer_id || !sub?.stripe_payment_method_id) { fail = true; reason = 'No payment method on file'; }
    else if (opts.forceFail) { fail = true; reason = 'Payment marked as failed by VeyroApp support'; }
    else {
      try {
        const pi = await chargeOffSession(sub.stripe_customer_id, sub.stripe_payment_method_id, Number(inv.total_cents), `VeyroApp ${inv.number}`, { saas_invoice: inv.id, organization_id: inv.organization_id }, `saas:${inv.id}:${inv.attempts}`);
        fail = pi.status !== 'succeeded'; reason = fail ? `Payment ${String(pi.status).replace(/_/g, ' ')}` : null; ref = pi.id;
      } catch (e: any) {
        fail = true;
        reason = e?.code === 'authentication_required' ? 'Your bank asked to confirm this payment — replace the card in Settings → Billing to retry' : `Card declined: ${e?.message ?? e}`;
      }
    }
  } else {
    fail = !!(opts.forceFail || !sub?.card_last4 || sub?.card_fails);
    reason = !sub?.card_last4 ? 'No payment method on file' : opts.forceFail ? 'Card declined: insufficient funds (simulated)' : sub.card_fails ? 'Card declined: do_not_honor (simulated test card 4000 0000 0000 0002)' : null;
  }
  const ctxA = actor ?? { orgId: inv.organization_id, userId: null, user: { name: 'VeyroApp Billing' }, impersonatorId: null, ip: 'system' };
  if (!fail) {
    await q(`UPDATE saas_invoices SET status='paid', paid_at=now(), attempts=attempts+1, failure_reason=NULL, provider_ref=$2 WHERE id=$1`, [inv.id, ref]);
    await audit({ ...ctxA, orgId: inv.organization_id } as any, 'saas_invoice.paid', { type: 'saas_invoice', id: inv.id, label: inv.number }, { status: inv.status }, { status: 'paid', card: `${sub.card_brand ?? 'Card'} •••• ${sub.card_last4}` });
    await reactivateIfSettled(inv.organization_id, ctxA);
    return { ok: true, status: 'paid', message: `Charged ${formatMoney(inv.total_cents)} to ${sub.card_brand ?? 'card'} •••• ${sub.card_last4}` };
  }
  await q(`UPDATE saas_invoices SET status='failed', attempts=attempts+1, failure_reason=$2 WHERE id=$1`, [inv.id, reason]);
  await audit({ ...ctxA, orgId: inv.organization_id } as any, 'saas_invoice.payment_failed', { type: 'saas_invoice', id: inv.id, label: inv.number }, { status: inv.status }, { status: 'failed', reason });
  await enterGrace(inv.organization_id, ctxA, `${inv.number}: ${reason}`);
  return { ok: false, status: 'failed', message: reason };
}

export async function enterGrace(orgId: string, actor: Actor, why: string) {
  const sub = await one<any>(`SELECT s.*, o.name org_name FROM subscriptions s JOIN organizations o ON o.id=s.organization_id WHERE s.organization_id=$1`, [orgId]);
  if (!sub || ['grace', 'suspended'].includes(sub.status)) return;
  await q(`UPDATE subscriptions SET status='grace', grace_ends_at=now() + make_interval(days => $2), updated_at=now() WHERE organization_id=$1`, [orgId, GRACE_DAYS]);
  await audit({ ...(actor ?? { userId: null, user: { name: 'VeyroApp Billing' }, impersonatorId: null, ip: 'system' }), orgId } as any, 'subscription.grace_started', { type: 'subscription', id: orgId, label: sub.org_name }, { status: sub.status }, { status: 'grace', grace_days: GRACE_DAYS }, why);
  const owners = await usersWithRoles(orgId, ['owner', 'admin']);
  await notify(orgId, owners, { event: 'billing.payment_failed', title: 'Payment failed — update your card', body: `Your VeyroApp subscription payment failed (${why}). You have ${GRACE_DAYS} days before the workspace becomes read-only.`, link: '/settings/billing' });
  const emails = await q<any>(`SELECT email FROM users WHERE id = ANY($1)`, [owners]);
  for (const e of emails) await sendMessage({ orgId, channel: 'email', to: e.email, subject: 'Action needed: VeyroApp payment failed', text: `We could not charge your card for your VeyroApp subscription.\n\nReason: ${why}\n\nUpdate your payment method within ${GRACE_DAYS} days to avoid suspension: http://localhost:3100/settings/billing`, fromName: 'VeyroApp Billing' });
  await notifyPlatform(`Payment failed: ${sub.org_name}`, why, `/platform/agencies/${orgId}`, 'billing');
}

export async function suspend(orgId: string, actor: Actor, reason: string) {
  const sub = await one<any>(`SELECT s.*, o.name org_name FROM subscriptions s JOIN organizations o ON o.id=s.organization_id WHERE s.organization_id=$1`, [orgId]);
  if (!sub || sub.status === 'suspended') return;
  await tx(async (c) => {
    await c.query(`UPDATE subscriptions SET status='suspended', suspended_at=now(), updated_at=now() WHERE organization_id=$1`, [orgId]);
    await audit({ ...(actor ?? { userId: null, user: { name: 'VeyroApp Billing' }, impersonatorId: null, ip: 'system' }), orgId } as any, 'subscription.suspended', { type: 'subscription', id: orgId, label: sub.org_name }, { status: sub.status }, { status: 'suspended' }, reason, c);
  });
  clearSuspendedCache(orgId);
  await notify(orgId, await usersWithRoles(orgId, ['owner', 'admin']), { event: 'billing.suspended', title: 'Workspace suspended (read-only)', body: 'Your VeyroApp workspace is read-only until the outstanding invoice is paid.', link: '/settings/billing' });
  await notifyPlatform(`Suspended: ${sub.org_name}`, reason, `/platform/agencies/${orgId}`, 'billing');
}

export async function reactivateIfSettled(orgId: string, actor: Actor, force = false) {
  const sub = await one<any>(`SELECT s.*, o.name org_name FROM subscriptions s JOIN organizations o ON o.id=s.organization_id WHERE s.organization_id=$1`, [orgId]);
  if (!sub) return false;
  const unpaid = (await one<any>(`SELECT count(*)::int n FROM saas_invoices WHERE organization_id=$1 AND status='failed'`, [orgId])).n;
  if (!force && (unpaid > 0 || !['grace', 'suspended', 'past_due'].includes(sub.status))) return false;
  const next = sub.trial_ends_at && new Date(sub.trial_ends_at) > new Date() && sub.plan_key === 'trial' ? 'trialing' : 'active';
  await q(`UPDATE subscriptions SET status=$2, grace_ends_at=NULL, suspended_at=NULL, updated_at=now() WHERE organization_id=$1`, [orgId, next]);
  clearSuspendedCache(orgId);
  await audit({ ...(actor ?? { userId: null, user: { name: 'VeyroApp Billing' }, impersonatorId: null, ip: 'system' }), orgId } as any, 'subscription.reactivated', { type: 'subscription', id: orgId, label: sub.org_name }, { status: sub.status }, { status: next });
  await notify(orgId, await usersWithRoles(orgId, ['owner', 'admin']), { event: 'billing.reactivated', title: 'Subscription is in good standing', body: 'Thanks — your payment went through and all features are available.', link: '/settings/billing' });
  return true;
}

/** Grace periods that ran out → suspension. */
export async function sweepGrace() {
  const due = await q<any>(`SELECT organization_id FROM subscriptions WHERE status='grace' AND grace_ends_at <= now()`);
  for (const d of due) await suspend(d.organization_id, null, `Grace period of ${GRACE_DAYS} days ended without payment`);
}
