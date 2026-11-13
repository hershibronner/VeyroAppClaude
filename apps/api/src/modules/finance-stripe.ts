// STRIPE (real) — Connect OAuth for agencies, Checkout for invoice payments, refunds, signed webhooks and a
// reconciliation sync. Used when the server has STRIPE_SECRET_KEY + STRIPE_CONNECT_CLIENT_ID; otherwise the simulated
// adapter (adapters/payments.ts) keeps working in local dev.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { q, one, tx } from '../core/db';
import { staff, need } from '../core/context';
import { conflict } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify, usersWithRoles, subscribers } from '../core/notify';
import { signState, verifyState } from '../core/secrets';
import * as stripe from '../adapters/stripe';
import { applyPayment, balanceOf } from './_finance/invoices';
import { fmt, OPEN_INVOICE } from './_finance/common';
import { afterPayment } from './finance-invoices';

/** Origin the browser is on (portal.voicechart.app live, localhost:3100 through the Vite proxy locally). */
export const originOf = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

async function log(orgId: string, level: 'info' | 'warn' | 'error', message: string, meta: Record<string, unknown> = {}) {
  await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,'payments',$2,$3,$4)`, [orgId, level, message, JSON.stringify(meta)]);
}
async function setStatus(orgId: string, status: 'connected' | 'disconnected' | 'error', lastError: string | null, synced = false) {
  const prev = await one<any>(`SELECT status FROM integrations WHERE organization_id=$1 AND key='payments'`, [orgId]);
  await q(`UPDATE integrations SET status=$2, last_error=$3, provider='Stripe', last_sync_at=CASE WHEN $4::boolean THEN now() ELSE last_sync_at END, updated_at=now() WHERE organization_id=$1 AND key='payments'`, [orgId, status, lastError, synced]);
  if (status === 'error' && prev?.status !== 'error') {
    const ids = [...await usersWithRoles(orgId, ['owner', 'admin']), ...await subscribers(orgId, 'integration.error')];
    await notify(orgId, ids, { event: 'integration.error', title: 'Payments integration error', body: `Stripe: ${lastError}`, link: '/settings/integrations' });
  }
}
const needsReconnect = (e: unknown) => e instanceof stripe.StripeError && (e.status === 401 || e.status === 403 || e.code === 'account_invalid');

/** Records a completed Checkout Session as a payment on its invoice (idempotent: webhook, return page and sync can all call it). */
export async function applyCheckoutSession(orgId: string, s: any, source: 'webhook' | 'return' | 'sync') {
  if (s?.payment_status !== 'paid' || s?.metadata?.veyro_org !== orgId) return { applied: false as const, reason: 'not_paid' };
  const invoiceId = s.metadata?.invoice_id;
  const inv = invoiceId ? await one<any>(`SELECT * FROM invoices WHERE id=$1 AND organization_id=$2`, [invoiceId, orgId]) : null;
  if (!inv) { await log(orgId, 'error', `Stripe payment ${s.id} references an unknown invoice`, { session: s.id, source }); return { applied: false as const, reason: 'no_invoice' }; }
  const pi = typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const card = pi?.latest_charge?.payment_method_details?.card;
  const amount = Number(s.amount_total);
  const fromStatus = inv.status;
  try {
    const r = await tx(async c => {
      const out = await applyPayment(c, orgId, inv.id, { amount_cents: amount, method: 'card', card_brand: card?.brand ?? null, card_last4: card?.last4 ?? null, provider: 'stripe', provider_ref: pi?.id ?? s.payment_intent ?? s.id, idempotency_key: `stripe:${s.id}`, payer_email: s.customer_details?.email ?? null, allow_overpay: true, actorId: null });
      if (!out.duplicate) await activity({ orgId, userId: null }, 'invoice', inv.id, 'payment', `Card payment of ${fmt(amount, inv.currency)} received via Stripe${card ? ` (${card.brand} •••• ${card.last4})` : ''}`, null, { payment_id: out.payment.id, stripe_session: s.id }, c);
      return out;
    });
    if (!r.duplicate) {
      await afterPayment(orgId, r.invoice, r.payment, fromStatus);
      await log(orgId, 'info', `Payment received: ${fmt(amount, inv.currency)} for invoice ${inv.number}`, { session: s.id, payment_intent: pi?.id ?? s.payment_intent, source });
      await setStatus(orgId, 'connected', null, true);
    }
    return { applied: !r.duplicate, payment: r.payment, invoice: r.invoice };
  } catch (e: any) {
    // Money was taken in Stripe but the invoice can't take it (voided, already paid…) — surface it for a manual refund.
    await log(orgId, 'error', `Stripe payment ${pi?.id ?? s.id} (${fmt(amount, inv.currency)}) could not be applied to invoice ${inv.number}: ${e?.message ?? e}. Refund it in Stripe or apply it manually.`, { session: s.id, source });
    return { applied: false as const, reason: 'rejected' };
  }
}

/** Creates a Stripe Checkout Session for an invoice's open balance (or part of it) on the agency's account. */
export async function createInvoiceCheckout(req: FastifyRequest, inv: any, payToken: string, amountCents?: number, email?: string | null) {
  const conn = await stripe.stripeConnection(inv.organization_id);
  if (!conn) throw conflict('Online card payment is not set up for this agency yet');
  if (!OPEN_INVOICE.includes(inv.status)) throw conflict(inv.status === 'paid' ? 'This invoice is already paid in full' : 'This invoice is not open for payment');
  const balance = balanceOf(inv);
  const amount = Math.min(amountCents ?? balance, balance);
  if (amount < 50) throw conflict('The amount is below the card minimum');
  const back = `${originOf(req)}/pay/${payToken}`;
  try {
    const s = await stripe.createCheckoutSession(conn.external_account_id, {
      mode: 'payment', client_reference_id: inv.id, customer_email: email || undefined,
      line_items: [{ quantity: 1, price_data: { currency: String(inv.currency).toLowerCase(), unit_amount: amount, product_data: { name: `Invoice ${inv.number}`, description: inv.company_name ?? undefined } } }],
      metadata: { veyro_org: inv.organization_id, invoice_id: inv.id, invoice_number: inv.number },
      payment_intent_data: { description: `Invoice ${inv.number}`, metadata: { veyro_org: inv.organization_id, invoice_id: inv.id, invoice_number: inv.number } },
      success_url: `${back}?session_id={CHECKOUT_SESSION_ID}`, cancel_url: back,
    }, `checkout:${inv.id}:${amount}:${Math.floor(Date.now() / 60_000)}`);
    await log(inv.organization_id, 'info', `Checkout started for invoice ${inv.number} (${fmt(amount, inv.currency)})`, { session: s.id });
    return { url: s.url as string, session_id: s.id as string };
  } catch (e: any) {
    await log(inv.organization_id, 'error', `Could not start Stripe checkout for invoice ${inv.number}: ${e?.message ?? e}`);
    if (needsReconnect(e)) await setStatus(inv.organization_id, 'error', `Stripe rejected the request: ${e.message}`);
    throw conflict('Online payment is temporarily unavailable. Please try again later or contact us.');
  }
}

/** Return-page check: fetches the session from Stripe and records it if paid (covers a slow webhook). */
export async function confirmInvoiceCheckout(orgId: string, sessionId: string) {
  const conn = await stripe.stripeConnection(orgId);
  if (!conn || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  const s = await stripe.getCheckoutSession(conn.external_account_id, sessionId);
  const r = await applyCheckoutSession(orgId, s, 'return');
  const pay = await one<any>(`SELECT * FROM payments WHERE idempotency_key=$1 AND organization_id=$2`, [`stripe:${s.id}`, orgId]);
  return { session: s, payment: pay, applied: r.applied };
}

export async function stripeRefund(orgId: string, pay: any, amountCents: number, reason: string) {
  const conn = await stripe.stripeConnection(orgId);
  if (!conn) throw conflict('Stripe is not connected — reconnect it in Settings → Integrations to refund card payments');
  if (!String(pay.provider_ref ?? '').startsWith('pi_')) throw conflict('This payment has no Stripe payment reference to refund');
  try {
    const r = await stripe.createRefund(conn.external_account_id, pay.provider_ref, amountCents, { veyro_payment: pay.id, reason: reason.slice(0, 400) }, `refund:${pay.id}:${Number(pay.refunded_cents)}:${amountCents}`);
    await log(orgId, 'info', `Refund ${r.id} of ${fmt(amountCents, pay.currency)} sent to Stripe (${r.status})`, { payment_id: pay.id, refund: r.id });
    return { ref: r.id as string };
  } catch (e: any) {
    await log(orgId, 'error', `Stripe refund failed: ${e?.message ?? e}`, { payment_id: pay.id });
    throw conflict(`Stripe refused the refund: ${e?.message ?? e}`);
  }
}

export async function stripeTest(orgId: string) {
  const conn = await stripe.stripeConnection(orgId);
  if (!conn) return { ok: false, message: 'Stripe is not connected — click Connect Stripe first' };
  const t0 = Date.now();
  try {
    const a = await stripe.getAccount(conn.external_account_id);
    const name = stripe.accountName(a);
    await q(`UPDATE integration_credentials SET account_name=$2, updated_at=now() WHERE organization_id=$1 AND integration_key='payments'`, [orgId, name]);
    const message = `Connection test passed — ${name} (${a.id}) ${a.charges_enabled ? 'can take card payments' : 'cannot take card payments yet: finish account setup in Stripe'} · ${Date.now() - t0} ms`;
    await setStatus(orgId, 'connected', a.charges_enabled ? null : 'Card payments are not enabled on this Stripe account yet — finish setup in your Stripe dashboard', true);
    return { ok: true, message };
  } catch (e: any) {
    const message = `Connection test failed: ${e?.message ?? e}`;
    await setStatus(orgId, 'error', message);
    return { ok: false, message };
  }
}

/** Pulls the last 30 days of completed Checkout payments from Stripe and records any the webhook missed. */
export async function stripeSync(orgId: string) {
  const conn = await stripe.stripeConnection(orgId);
  if (!conn) return { ok: false, message: 'Stripe is not connected — click Connect Stripe first' };
  try {
    let checked = 0, recorded = 0, after: string | undefined;
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    for (let page = 0; page < 10; page++) {
      const res = await stripe.listCompletedCheckoutSessions(conn.external_account_id, since, after);
      for (const s of res.data) {
        if (s.metadata?.veyro_org !== orgId) continue;
        checked++;
        if ((await applyCheckoutSession(orgId, s, 'sync')).applied) recorded++;
      }
      if (!res.has_more || !res.data.length) break;
      after = res.data[res.data.length - 1].id;
    }
    await setStatus(orgId, 'connected', null, true);
    return { ok: true, message: `Sync completed — checked ${checked} Stripe payment${checked === 1 ? '' : 's'} from the last 30 days, ${recorded} new recorded` };
  } catch (e: any) {
    const message = `Sync failed: ${e?.message ?? e}`;
    await setStatus(orgId, needsReconnect(e) ? 'error' : 'connected', message);
    return { ok: false, message };
  }
}

export async function stripeDisconnect(orgId: string) {
  const conn = await stripe.stripeConnection(orgId);
  if (conn) await stripe.deauthorize(conn.external_account_id).catch(e => log(orgId, 'warn', `Stripe deauthorize call failed (${e?.message ?? e}) — the link was removed here anyway`));
  await stripe.deleteConnection(orgId);
  await setStatus(orgId, 'disconnected', null);
  return { ok: true, message: conn ? `Disconnected Stripe account ${conn.account_name ?? conn.external_account_id}` : 'Stripe disconnected' };
}

async function handleEvent(evt: any) {
  const account = evt.account as string | undefined;
  const orgId = account ? await stripe.orgForAccount(account) : null;
  if (!orgId) return 'ignored (unknown account)';
  if (await one(`SELECT 1 FROM stripe_events WHERE id=$1`, [evt.id])) return 'duplicate';
  const o = evt.data?.object ?? {};
  switch (evt.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      // Webhook payloads don't expand the charge; fetch it so the receipt shows the card.
      const s = o.payment_status === 'paid' ? await stripe.getCheckoutSession(account!, o.id).catch(() => o) : o;
      await applyCheckoutSession(orgId, s, 'webhook');
      break;
    }
    case 'checkout.session.async_payment_failed':
      await log(orgId, 'warn', `Stripe payment failed for invoice ${o.metadata?.invoice_number ?? ''}`.trim(), { session: o.id }); break;
    case 'charge.refunded':
      await log(orgId, 'info', `Stripe confirmed refund on ${o.payment_intent ?? o.id} (${fmt(Number(o.amount_refunded), String(o.currency).toUpperCase())} refunded in total)`, { charge: o.id }); break;
    case 'charge.dispute.created':
      await log(orgId, 'error', `Dispute opened on Stripe payment ${o.payment_intent ?? o.charge} (${fmt(Number(o.amount), String(o.currency).toUpperCase())}): ${o.reason}`, { dispute: o.id });
      await setStatus(orgId, 'connected', `A client disputed a card payment (${o.reason}) — respond in your Stripe dashboard`); break;
    case 'account.updated':
      await q(`UPDATE integration_credentials SET account_name=$2, updated_at=now() WHERE organization_id=$1 AND integration_key='payments'`, [orgId, stripe.accountName(o)]);
      await setStatus(orgId, 'connected', o.charges_enabled === false ? 'Card payments are not enabled on this Stripe account yet — finish setup in your Stripe dashboard' : null); break;
    case 'account.application.deauthorized':
      await stripe.deleteConnection(orgId);
      await setStatus(orgId, 'disconnected', 'The Stripe account was disconnected from the Stripe dashboard');
      await log(orgId, 'warn', 'Stripe account disconnected from the Stripe side'); break;
    default:
      return 'ignored (type)';
  }
  await q(`INSERT INTO stripe_events (id, organization_id, type) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [evt.id, orgId, evt.type]);
  return 'ok';
}

export default async function (app: FastifyInstance) {
  // Start Stripe Connect OAuth: returns the stripe.com URL the browser should go to.
  app.post('/api/v1/integrations/payments/stripe/connect', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'edit');
    if (!stripe.stripePlatform()) throw conflict('Stripe is not available on this server yet');
    const state = signState({ org: ctx.orgId, user: ctx.userId });
    return { url: stripe.authorizeUrl(state, `${originOf(req)}/api/v1/integrations/stripe/callback`) };
  });

  // Stripe redirects the browser here after the agency approves (or cancels).
  app.get('/api/v1/integrations/stripe/callback', { config: { public: true } }, async (req, reply) => {
    const qy = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const back = (status: string, message?: string) => reply.redirect(`/settings/integrations?stripe=${status}${message ? `&message=${encodeURIComponent(message.slice(0, 200))}` : ''}`);
    const st = verifyState<{ org: string; user: string }>(qy.state ?? '');
    if (!st) return back('error', 'The Stripe connection link expired — please try again');
    if (req.ctx && req.ctx.userId !== st.user) return back('error', 'You were signed in as a different user — please try again');
    if (qy.error) { await log(st.org, 'warn', `Stripe connection cancelled: ${qy.error_description ?? qy.error}`); return back('cancelled', qy.error_description ?? 'Connection cancelled'); }
    if (!qy.code) return back('error', 'Stripe did not return an authorization code');
    try {
      const tok = await stripe.exchangeCode(qy.code);
      const acct = await stripe.getAccount(tok.stripe_user_id).catch(() => null);
      const name = acct ? stripe.accountName(acct) : tok.stripe_user_id;
      await stripe.saveConnection(st.org, tok, name, st.user);
      await setStatus(st.org, 'connected', acct && acct.charges_enabled === false ? 'Card payments are not enabled on this Stripe account yet — finish setup in your Stripe dashboard' : null, true);
      const user = await one<any>(`SELECT id, name FROM users WHERE id=$1`, [st.user]);
      await log(st.org, 'info', `Connected Stripe account ${name} (${tok.stripe_user_id}, ${tok.livemode ? 'live' : 'test'} mode)`, { by: user?.name, action: 'connect' });
      await audit({ orgId: st.org, userId: st.user, user: user ?? undefined, impersonatorId: null, ip: req.ip } as any, 'integration.connect', { type: 'integration', id: 'payments', label: 'Stripe' }, null, { account: tok.stripe_user_id, livemode: tok.livemode });
      return back('connected');
    } catch (e: any) {
      await log(st.org, 'error', `Stripe connection failed: ${e?.message ?? e}`);
      return back('error', e?.message ?? 'Stripe connection failed');
    }
  });

  // Connect webhook (one endpoint for every connected account). Needs the raw body to check the signature.
  app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    sub.post('/api/v1/webhooks/stripe', { config: { public: true } }, async (req, reply) => {
      const secret = stripe.stripePlatform()?.webhookSecret;
      if (!secret) return reply.status(503).send({ error: 'Stripe webhooks are not configured' });
      let evt: any;
      try { evt = stripe.verifyWebhook(req.body as Buffer, req.headers['stripe-signature'] as string, secret); }
      catch (e: any) { return reply.status(400).send({ error: e.message }); }
      const result = await handleEvent(evt);
      return { received: true, result };
    });
  });
}
