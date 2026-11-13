// Settings → Billing & Subscription (agency side of SaaS billing). With Stripe set up on the server, cards are saved on
// Stripe Checkout (setup mode) into a Customer on VeyroApp's own Stripe account and monthly invoices are charged for real.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, tx } from '../core/db';
import { staff, need, can } from '../core/context';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit } from '../core/audit';
import { listParams, paged } from '../core/list';
import { every } from '../jobs/queue';
import { activeSeats, generateInvoice, quoteMonth, seatHistory } from './_admin/saas';
import { chargeInvoice, reactivateIfSettled, sweepGrace } from './_admin/billingflow';
import { isUuid, notifyPlatform, pad } from './_admin/common';
import { fieldError } from './_admin/common';
import { usersWithRoles, notify } from '../core/notify';
import { IS_PROD } from '../core/env';
import * as stripe from '../adapters/stripe';
import { originOf } from './finance-stripe';

every('saas.grace-sweep', 60_000, sweepGrace);

/** A card we can actually charge: a saved Stripe card when Stripe is live, the simulated vault otherwise. */
const hasCard = (sub: any) => stripe.stripePlatform() ? !!(sub?.stripe_customer_id && sub?.stripe_payment_method_id) : !!sub?.card_last4;

// Monthly run (real billing only): once a month has ended, create each agency's per-seat invoice and charge it to the
// saved card. Agencies without a card get the invoice but no charge attempt, so nobody is pushed into grace by surprise.
every('saas.monthly-billing', 60 * 60_000, async () => {
  if (!stripe.stripePlatform()) return;
  const d = new Date(); const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const ym = `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1, 2)}`;
  const orgs = await q<any>(`SELECT o.id FROM organizations o JOIN subscriptions s ON s.organization_id=o.id WHERE o.status <> 'deleted'`);
  for (const o of orgs) {
    try {
      const r = await generateInvoice(o.id, ym);
      if (!r.existing) await audit({ orgId: o.id, userId: null, user: { name: 'VeyroApp Billing' }, impersonatorId: null, ip: 'system' } as any, 'saas_invoice.generated', { type: 'saas_invoice', id: r.invoice.id, label: r.invoice.number }, null, { total_cents: r.invoice.total_cents, status: r.invoice.status });
      const sub = await one<any>(`SELECT * FROM subscriptions WHERE organization_id=$1`, [o.id]);
      const due = await q<any>(`SELECT id FROM saas_invoices WHERE organization_id=$1 AND status='open' AND attempts=0 AND total_cents > 0`, [o.id]);
      if (hasCard(sub)) for (const inv of due) await chargeInvoice(inv.id, null);
    } catch (e: any) { console.error('[saas monthly billing]', o.id, e?.message ?? e); }
  }
});

function luhn(num: string) { let s = 0; let alt = false; for (let i = num.length - 1; i >= 0; i--) { let n = Number(num[i]); if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; }
function brandOf(num: string) { return /^4/.test(num) ? 'Visa' : /^5[1-5]/.test(num) || /^2[2-7]/.test(num) ? 'Mastercard' : /^3[47]/.test(num) ? 'Amex' : /^6/.test(num) ? 'Discover' : 'Card'; }

export default async function (app: FastifyInstance) {
  app.get('/api/v1/billing', async (req) => {
    const ctx = staff(req); need(ctx, 'billing', 'view');
    const sub = await one<any>(`SELECT s.*, p.name plan_name, p.price_per_seat_cents, p.features, p.trial_days FROM subscriptions s JOIN plans p ON p.key=s.plan_key WHERE s.organization_id=$1`, [ctx.orgId]);
    if (!sub) throw notFound();
    const plans = await q<any>(`SELECT * FROM plans WHERE active ORDER BY sort, price_per_seat_cents, key`);
    const now = new Date(); const ym = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1, 2)}`;
    const estimate = await quoteMonth(ctx.orgId, ym);
    const invoices = await q<any>(`SELECT id, number, period_start, period_end, seat_days, avg_seats, subtotal_cents, discount_cents, tax_cents, total_cents, status, created_at, paid_at, due_at, failure_reason FROM saas_invoices WHERE organization_id=$1 ORDER BY period_start DESC LIMIT 24`, [ctx.orgId]);
    const seatsNow = await activeSeats(ctx.orgId);
    const lastMonthSeats = (await one<any>(`SELECT count(*)::int n FROM seat_usage WHERE organization_id=$1 AND started_at < date_trunc('month', now()) AND (ended_at IS NULL OR ended_at >= date_trunc('month', now()))`, [ctx.orgId])).n;
    const changes = await one<any>(`SELECT count(*) FILTER (WHERE started_at >= date_trunc('month', now()))::int started, count(*) FILTER (WHERE ended_at >= date_trunc('month', now()))::int ended FROM seat_usage WHERE organization_id=$1`, [ctx.orgId]);
    const paid12 = (await one<any>(`SELECT COALESCE(sum(total_cents),0)::bigint n FROM saas_invoices WHERE organization_id=$1 AND status='paid' AND period_start > now() - interval '12 months'`, [ctx.orgId])).n;
    return {
      subscription: { plan_key: sub.plan_key, plan_name: sub.plan_name, status: sub.status, comped: sub.comped, discount_pct: sub.discount_pct, tax_bp: sub.tax_bp, trial_ends_at: sub.trial_ends_at, grace_ends_at: sub.grace_ends_at, suspended_at: sub.suspended_at,
        current_period_start: sub.current_period_start, price_per_seat_cents: sub.price_per_seat_cents, addon_cents: sub.features?.addon_monthly_cents ?? 0, billing_email: sub.billing_email,
        card: hasCard(sub) ? { brand: sub.card_brand ?? 'Card', last4: sub.card_last4, exp: sub.card_exp, test_decline: sub.card_fails } : null },
      card_mode: stripe.stripePlatform() ? 'stripe' : IS_PROD ? 'unavailable' : 'simulated',
      plans, estimate, invoices, seats: { now: seatsNow, start_of_month: lastMonthSeats, started_this_month: changes.started, ended_this_month: changes.ended }, history: await seatHistory(ctx.orgId, 12), paid_12m_cents: paid12,
      editable: can(ctx, 'billing', 'edit'),
    };
  });
  app.get('/api/v1/billing/seats', async (req) => {
    const ctx = staff(req); need(ctx, 'billing', 'view');
    const lp = listParams(req);
    const where = ['s.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.status === 'active') where.push('s.ended_at IS NULL'); else if (lp.filters.status === 'ended') where.push('s.ended_at IS NOT NULL');
    if (lp.filters.month && /^\d{4}-\d{2}$/.test(lp.filters.month)) { params.push(lp.filters.month + '-01'); where.push(`s.started_at < ($${params.length}::date + interval '1 month') AND (s.ended_at IS NULL OR s.ended_at >= $${params.length}::date)`); }
    return paged({ select: `s.id, s.started_at, s.ended_at, s.worker_id, s.placement_id, c.first_name || ' ' || COALESCE(c.last_name,'') worker_name, co.name company_name, p.title, su.name started_by_name, eu.name ended_by_name,
        (LEAST(COALESCE(s.ended_at::date, current_date), current_date) - s.started_at::date + 1) days_active`,
      from: 'seat_usage s JOIN workers w ON w.id=s.worker_id JOIN candidates c ON c.id=w.candidate_id LEFT JOIN placements p ON p.id=s.placement_id LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users su ON su.id=s.started_by LEFT JOIN users eu ON eu.id=s.ended_by',
      where, params, lp, searchCols: ['c.first_name', 'c.last_name', 'co.name', 'p.title'], sortMap: { started_at: 's.started_at', ended_at: 's.ended_at', worker_name: 'c.first_name', company_name: 'co.name' }, defaultSort: 's.started_at DESC' });
  });
  app.get('/api/v1/billing/invoices/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'billing', 'view');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const inv = await one<any>(`SELECT * FROM saas_invoices WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!inv) throw notFound();
    const sub = await one<any>(`SELECT card_brand, card_last4, billing_email FROM subscriptions WHERE organization_id=$1`, [ctx.orgId]);
    const org = await one<any>(`SELECT o.name, b.support_email FROM organizations o LEFT JOIN organization_branding b ON b.organization_id=o.id WHERE o.id=$1`, [ctx.orgId]);
    const lines = (inv.lines?.length ? inv.lines : [{ label: `Worker seats — ${inv.seat_days} seat-days (avg ${inv.avg_seats} seats)`, quantity: Number(inv.avg_seats), amount_cents: inv.subtotal_cents }, ...(inv.discount_cents ? [{ label: inv.status === 'comped' ? 'Comped account (seats still metered)' : 'Discount', quantity: 1, amount_cents: -inv.discount_cents }] : []), ...(inv.tax_cents ? [{ label: 'Tax', quantity: 1, amount_cents: inv.tax_cents }] : [])]);
    return { ...inv, lines, bill_to: org?.name, billing_email: sub?.billing_email, card: sub?.card_last4 ? `${sub.card_brand ?? 'Card'} •••• ${sub.card_last4}` : null };
  });
  app.post('/api/v1/billing/invoices/:id/pay', async (req) => {
    const ctx = staff(req); need(ctx, 'billing', 'edit');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const inv = await one<any>(`SELECT * FROM saas_invoices WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!inv) throw notFound();
    if (!['open', 'failed'].includes(inv.status)) throw conflict(`This invoice is ${inv.status}`);
    const sub = await one<any>(`SELECT * FROM subscriptions WHERE organization_id=$1`, [ctx.orgId]);
    if (!hasCard(sub)) throw conflict('Add a payment method first');
    return chargeInvoice(inv.id, ctx);
  });

  // Real card: Stripe Checkout in setup mode (card details stay on Stripe). Returns the URL to open.
  app.post('/api/v1/billing/payment-method/checkout', async (req) => {
    const ctx = staff(req); need(ctx, 'billing', 'edit');
    if (!stripe.stripePlatform()) throw conflict('Card payments are not set up on this server yet');
    let sub = await one<any>(`SELECT * FROM subscriptions WHERE organization_id=$1`, [ctx.orgId]);
    if (!sub) throw notFound();
    if (!sub.stripe_customer_id) {
      const c = await stripe.createCustomer({ name: ctx.org.name, email: sub.billing_email || ctx.user.email, metadata: { organization_id: ctx.orgId } }, `customer:${ctx.orgId}`);
      await q(`UPDATE subscriptions SET stripe_customer_id=$2, updated_at=now() WHERE organization_id=$1`, [ctx.orgId, c.id]);
      sub = { ...sub, stripe_customer_id: c.id };
    }
    const back = `${originOf(req)}/settings/billing`;
    const s = await stripe.createSetupCheckout(sub.stripe_customer_id, `${back}?card_session={CHECKOUT_SESSION_ID}`, back, { organization_id: ctx.orgId });
    return { url: s.url };
  });
  // Back from Stripe: read the saved card, make it the default, and retry any failed invoices with it.
  app.get('/api/v1/billing/payment-method/checkout/:sessionId', async (req) => {
    const ctx = staff(req); need(ctx, 'billing', 'edit');
    const { sessionId } = req.params as { sessionId: string };
    if (!stripe.stripePlatform() || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw notFound();
    const sub = await one<any>(`SELECT * FROM subscriptions WHERE organization_id=$1`, [ctx.orgId]);
    const s = await stripe.getPlatformCheckoutSession(sessionId);
    if (s.metadata?.organization_id !== ctx.orgId || s.customer !== sub?.stripe_customer_id) throw notFound();
    const pm = s.setup_intent?.payment_method;
    if (s.status !== 'complete' || !pm?.id) return { ok: false, status: s.status };
    if (pm.id === sub.stripe_payment_method_id) return { ok: true, card: { brand: sub.card_brand, last4: sub.card_last4, exp: sub.card_exp }, retried: [] };
    await stripe.setDefaultPaymentMethod(sub.stripe_customer_id, pm.id);
    const card = pm.card ?? {};
    const brand = card.brand ? card.brand[0].toUpperCase() + card.brand.slice(1) : 'Card';
    const exp = card.exp_month ? `${pad(card.exp_month, 2)}/${String(card.exp_year).slice(-2)}` : null;
    await q(`UPDATE subscriptions SET stripe_payment_method_id=$2, card_brand=$3, card_last4=$4, card_exp=$5, card_fails=false, updated_at=now() WHERE organization_id=$1`, [ctx.orgId, pm.id, brand, card.last4 ?? null, exp]);
    await audit(ctx, 'billing.payment_method_updated', { type: 'subscription', id: ctx.orgId, label: ctx.org.name }, sub.card_last4 ? { card: `${sub.card_brand} •••• ${sub.card_last4}` } : null, { card: `${brand} •••• ${card.last4}`, via: 'stripe' });
    const failed = await q<any>(`SELECT id FROM saas_invoices WHERE organization_id=$1 AND status IN ('failed','open') AND total_cents > 0 ORDER BY period_start`, [ctx.orgId]);
    const retried = []; for (const f of failed) retried.push(await chargeInvoice(f.id, ctx));
    return { ok: true, card: { brand, last4: card.last4, exp }, retried };
  });

  app.post('/api/v1/billing/payment-method', async (req) => {
    const ctx = staff(req); need(ctx, 'billing', 'edit');
    if (stripe.stripePlatform() || IS_PROD) throw conflict('Cards are added on the secure Stripe page — refresh and click Add card');
    const b = z.object({ number: z.string().min(12).max(23), exp: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, 'Use MM/YY'), cvc: z.string().regex(/^\d{3,4}$/, '3 or 4 digits'), name: z.string().min(2).max(80) }).parse(req.body);
    const num = b.number.replace(/\D/g, '');
    if (num.length < 13 || !luhn(num)) throw fieldError({ number: 'This card number is not valid' });
    const [mm, yy] = b.exp.split('/').map(Number);
    if (new Date(Date.UTC(2000 + yy, mm, 0, 23, 59)) < new Date()) throw fieldError({ exp: 'This card has expired' });
    const fails = num === '4000000000000002';
    const before = await one<any>(`SELECT card_brand, card_last4 FROM subscriptions WHERE organization_id=$1`, [ctx.orgId]);
    // Only brand, last 4 and expiry are kept (simulated tokenization) — the full number and CVC are never stored.
    await q(`UPDATE subscriptions SET card_brand=$2, card_last4=$3, card_exp=$4, card_fails=$5, updated_at=now() WHERE organization_id=$1`, [ctx.orgId, brandOf(num), num.slice(-4), b.exp, fails]);
    await audit(ctx, 'billing.payment_method_updated', { type: 'subscription', id: ctx.orgId, label: ctx.org.name }, before?.card_last4 ? { card: `${before.card_brand} •••• ${before.card_last4}` } : null, { card: `${brandOf(num)} •••• ${num.slice(-4)}` });
    // Retry anything that failed (dunning) with the new card.
    const failed = await q<any>(`SELECT id FROM saas_invoices WHERE organization_id=$1 AND status IN ('failed') ORDER BY period_start`, [ctx.orgId]);
    const results = []; for (const f of failed) results.push(await chargeInvoice(f.id, ctx));
    return { ok: true, card: { brand: brandOf(num), last4: num.slice(-4), exp: b.exp }, retried: results };
  });
  app.patch('/api/v1/billing/contact', async (req) => {
    const ctx = staff(req); need(ctx, 'billing', 'edit');
    const b = z.object({ billing_email: z.string().email().nullable() }).parse(req.body);
    await q(`UPDATE subscriptions SET billing_email=$2, updated_at=now() WHERE organization_id=$1`, [ctx.orgId, b.billing_email]);
    await audit(ctx, 'billing.contact_updated', { type: 'subscription', id: ctx.orgId, label: ctx.org.name }, null, b);
    return { ok: true };
  });

  // Plan change (no charge now — the new price applies from the next monthly invoice). White Label turns on white-label settings; downgrading turns them off.
  app.post('/api/v1/billing/change-plan', async (req) => {
    const ctx = staff(req); need(ctx, 'billing', 'edit');
    const b = z.object({ plan_key: z.string() }).parse(req.body);
    const plan = await one<any>(`SELECT * FROM plans WHERE key=$1 AND active`, [b.plan_key]); if (!plan) throw badRequest('Unknown plan');
    const sub = await one<any>(`SELECT * FROM subscriptions WHERE organization_id=$1`, [ctx.orgId]);
    if (sub.plan_key === plan.key) throw conflict(`You are already on ${plan.name}`);
    if (plan.key === 'trial') throw conflict('You cannot switch back to a trial');
    if (sub.status === 'suspended') throw conflict('Pay the outstanding invoice before changing plans');
    if (!sub.comped && !hasCard(sub)) throw conflict('Add a payment method before upgrading', { needs_card: true });
    await tx(async (c) => {
      const status = sub.status === 'trialing' ? 'active' : sub.status;
      await c.query(`UPDATE subscriptions SET plan_key=$2, status=$3, trial_ends_at=CASE WHEN $3='active' THEN NULL ELSE trial_ends_at END, updated_at=now() WHERE organization_id=$1`, [ctx.orgId, plan.key, status]);
      const wl = plan.key === 'white_label' || plan.features?.white_label === true;
      await c.query(`INSERT INTO feature_flags (organization_id, key, enabled) VALUES ($1,'white_label',$2) ON CONFLICT (organization_id, key) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()`, [ctx.orgId, wl]);
      if (!wl) await c.query(`UPDATE organization_branding SET hide_powered_by=false, updated_at=now() WHERE organization_id=$1`, [ctx.orgId]);
      await audit(ctx, 'subscription.plan_changed', { type: 'subscription', id: ctx.orgId, label: ctx.org.name }, { plan: sub.plan_key, status: sub.status }, { plan: plan.key, status }, undefined, c);
    });
    await notifyPlatform(`${ctx.org.name} changed plan`, `${sub.plan_key} → ${plan.key} by ${ctx.user.name}`, `/platform/agencies/${ctx.orgId}`, 'billing');
    const others = (await usersWithRoles(ctx.orgId, ['owner', 'admin'])).filter(u => u !== ctx.userId);
    await notify(ctx.orgId, others, { event: 'billing.plan_changed', title: `Plan changed to ${plan.name}`, body: `${ctx.user.name} changed the VeyroApp plan.`, link: '/settings/billing' });
    await reactivateIfSettled(ctx.orgId, ctx);
    return { ok: true, plan: plan.key };
  });
}
