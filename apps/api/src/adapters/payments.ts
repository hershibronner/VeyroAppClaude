// PaymentsAdapter (simulated Stripe). Test cards: 4242 4242 4242 4242 succeeds, 4000 0000 0000 0002 declines,
// 4000 0000 0000 9995 insufficient funds, 4000 0000 0000 0069 expired. Any other Luhn-valid number succeeds.
// Every charge/refund writes a simulated webhook event to integration_logs ('payments').
import crypto from 'node:crypto';
import { one, q, type Db, pool } from '../core/db';
import { conflict, badRequest } from '../core/errors';

export interface CardInput { number: string; exp: string; cvc: string; name?: string | null }
export type ChargeResult =
  | { ok: true; ref: string; brand: string; last4: string; eventId: string }
  | { ok: false; code: string; message: string; ref: string; brand: string; last4: string; eventId: string };

const DECLINES: Record<string, { code: string; message: string }> = {
  '4000000000000002': { code: 'card_declined', message: 'Your card was declined.' },
  '4000000000009995': { code: 'insufficient_funds', message: 'Your card has insufficient funds.' },
  '4000000000000069': { code: 'expired_card', message: 'Your card has expired.' },
};

export function cardBrand(n: string) {
  if (/^4/.test(n)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^6(011|5)/.test(n)) return 'discover';
  return 'card';
}
export function luhn(n: string) {
  let sum = 0, alt = false;
  for (let i = n.length - 1; i >= 0; i--) { let d = Number(n[i]); if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; }
  return sum % 10 === 0;
}

/** Validates card fields; returns field errors (shown inline on the checkout form). */
export function validateCard(c: CardInput, today = new Date()): Record<string, string> {
  const errs: Record<string, string> = {};
  const n = (c.number ?? '').replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(n) || !luhn(n)) errs.card_number = 'Enter a valid card number';
  const m = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec((c.exp ?? '').trim());
  if (!m) errs.exp = 'Use MM/YY';
  else {
    const mm = Number(m[1]); const yy = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    if (mm < 1 || mm > 12) errs.exp = 'Invalid month';
    else if (yy < today.getFullYear() || (yy === today.getFullYear() && mm < today.getMonth() + 1)) errs.exp = 'This card has expired';
  }
  if (!/^\d{3,4}$/.test((c.cvc ?? '').trim())) errs.cvc = 'Enter the 3–4 digit security code';
  return errs;
}

async function gate(db: Db, orgId: string) {
  // With real Stripe set up on the server, the 'payments' row tracks the real connection, not this simulator.
  if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CONNECT_CLIENT_ID) return;
  const i = await one<any>(`SELECT status FROM integrations WHERE organization_id=$1 AND key='payments'`, [orgId], db);
  if (i && i.status !== 'connected') {
    await log(db, orgId, 'error', 'Charge blocked: payments integration is disconnected', {});
    throw conflict('Online payments are temporarily unavailable. Please try again later or contact us.');
  }
}
async function log(db: Db, orgId: string, level: string, message: string, meta: Record<string, unknown>) {
  await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,'payments',$2,$3,$4)`, [orgId, level, message, JSON.stringify(meta)], db);
}

/** Simulated card charge. Never stores the full card number. */
export async function charge(orgId: string, input: { amountCents: number; currency: string; card: CardInput; idempotencyKey: string; description: string; metadata?: Record<string, unknown> }, db: Db = pool): Promise<ChargeResult> {
  await gate(db, orgId);
  const errs = validateCard(input.card);
  if (Object.keys(errs).length) throw badRequest('Please check your card details', errs);
  const n = input.card.number.replace(/[\s-]/g, '');
  const brand = cardBrand(n); const last4 = n.slice(-4);
  const ref = `ch_sim_${crypto.createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 20)}`;
  const eventId = `evt_sim_${crypto.randomBytes(10).toString('hex')}`;
  const decline = DECLINES[n];
  const meta = { event_id: eventId, charge: ref, amount: input.amountCents, currency: input.currency, brand, last4, idempotency_key: input.idempotencyKey, description: input.description, ...input.metadata };
  if (decline) {
    await log(db, orgId, 'warn', `Webhook charge.failed (${decline.code}) — ${input.description}`, { ...meta, type: 'charge.failed', failure_code: decline.code });
    return { ok: false, code: decline.code, message: decline.message, ref, brand, last4, eventId };
  }
  await log(db, orgId, 'info', `Webhook charge.succeeded — ${input.description}`, { ...meta, type: 'charge.succeeded' });
  await q(`UPDATE integrations SET last_sync_at=now(), last_error=NULL, updated_at=now() WHERE organization_id=$1 AND key='payments'`, [orgId], db);
  return { ok: true, ref, brand, last4, eventId };
}

/** Simulated refund of a previous charge. */
export async function refund(orgId: string, input: { chargeRef: string | null; amountCents: number; currency: string; reason: string }, db: Db = pool) {
  await gate(db, orgId);
  const ref = `re_sim_${crypto.randomBytes(10).toString('hex')}`;
  await log(db, orgId, 'info', `Webhook charge.refunded — ${input.reason}`, { type: 'charge.refunded', refund: ref, charge: input.chargeRef, amount: input.amountCents, currency: input.currency });
  return { ref };
}
