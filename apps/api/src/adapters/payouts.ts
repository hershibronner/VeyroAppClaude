// PayoutsAdapter (simulated Wise). A batch moves Initiated → Processing → Paid / Partially failed / Failed
// over ~10–30 seconds via background jobs. Each item settles independently with a configurable failure
// chance (integrations.config.failure_rate, default 0.08; retries fail at a third of that).
// The batch idempotency key (UNIQUE) prevents duplicate submission.
import crypto from 'node:crypto';
import { canTransition } from '@veyro/shared';
import { one, q, type Db, pool } from '../core/db';
import { conflict } from '../core/errors';
import { registerJob, enqueue } from '../jobs/queue';
import { publishOrg } from '../core/realtime';

const FAILURES = [
  'Recipient bank rejected transfer: account holder name mismatch',
  'Recipient account closed or invalid',
  'Transfer held for compliance review — resubmit with updated recipient details',
];

type ItemHook = (orgId: string, item: any, payout: any) => Promise<void>;
type BatchHook = (orgId: string, payout: any, items: any[]) => Promise<void>;
const itemHooks: ItemHook[] = []; const batchHooks: BatchHook[] = [];
/** Called once per item when it reaches paid/failed. */
export function onPayoutItemFinal(fn: ItemHook) { itemHooks.push(fn); }
/** Called once per batch when every item is final. */
export function onPayoutFinal(fn: BatchHook) { batchHooks.push(fn); }

async function log(db: Db, orgId: string, level: string, message: string, meta: Record<string, unknown>) {
  await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,'payouts',$2,$3,$4)`, [orgId, level, message, JSON.stringify(meta)], db);
}

export interface PayoutItemInput { payroll_item_id?: string | null; worker_id?: string | null; user_id?: string | null; amount_cents: number; currency?: string }

/** Creates a payout batch. Returns the existing batch (duplicate: true) when the idempotency key was already used. */
export async function submitBatch(db: Db, orgId: string, input: { kind: 'payroll' | 'commission'; runId?: string | null; idempotencyKey: string; currency: string; items: PayoutItemInput[]; actorId: string | null }) {
  const existing = await one<any>(`SELECT * FROM payouts WHERE idempotency_key=$1`, [input.idempotencyKey], db);
  if (existing) {
    if (existing.organization_id !== orgId) throw conflict('Idempotency key already used');
    return { payout: existing, duplicate: true };
  }
  const integ = await one<any>(`SELECT status FROM integrations WHERE organization_id=$1 AND key='payouts'`, [orgId], db);
  if (integ && integ.status !== 'connected') {
    await log(db, orgId, 'error', 'Payout batch blocked: payouts integration is disconnected', { idempotency_key: input.idempotencyKey });
    throw conflict('The payouts integration (Wise) is disconnected — reconnect it in Settings → Integrations, then try again.');
  }
  const items = input.items.filter(i => i.amount_cents > 0);
  if (!items.length) throw conflict('Nothing to pay out — every amount is zero');
  const total = items.reduce((a, i) => a + i.amount_cents, 0);
  const payout = (await q<any>(`INSERT INTO payouts (organization_id, run_id, kind, status, idempotency_key, total_cents, currency, initiated_by) VALUES ($1,$2,$3,'initiated',$4,$5,$6,$7) RETURNING *`, [orgId, input.runId ?? null, input.kind, input.idempotencyKey, total, input.currency, input.actorId], db))[0];
  for (const i of items) await q(`INSERT INTO payout_items (organization_id, payout_id, payroll_item_id, worker_id, user_id, amount_cents, currency, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`, [orgId, payout.id, i.payroll_item_id ?? null, i.worker_id ?? null, i.user_id ?? null, i.amount_cents, i.currency ?? input.currency], db);
  await log(db, orgId, 'info', `Batch ${payout.id.slice(0, 8)} submitted: ${items.length} transfers`, { payout_id: payout.id, total_cents: total, idempotency_key: input.idempotencyKey });
  return { payout, duplicate: false };
}

/** Schedules processing for a batch (call after the creating transaction commits). */
export async function schedule(orgId: string, payoutId: string) {
  await enqueue('payouts.advance', { payoutId }, { orgId, runAt: new Date(Date.now() + 3000) });
}

/** Moves failed items back into the queue (failed → retried → processing). */
export async function retryItems(db: Db, orgId: string, payoutId: string, itemIds?: string[]) {
  const failed = await q<any>(`SELECT * FROM payout_items WHERE organization_id=$1 AND payout_id=$2 AND status='failed' ${itemIds?.length ? 'AND id = ANY($3)' : ''} FOR UPDATE`, itemIds?.length ? [orgId, payoutId, itemIds] : [orgId, payoutId], db);
  if (!failed.length) throw conflict('There are no failed transfers to retry in this batch');
  await q(`UPDATE payout_items SET status='retried', failure_reason=NULL, updated_at=now() WHERE id = ANY($1)`, [failed.map(f => f.id)], db);
  await q(`UPDATE payouts SET status='processing', completed_at=NULL WHERE id=$1`, [payoutId], db);
  await log(db, orgId, 'info', `Retrying ${failed.length} failed transfer(s) in batch ${payoutId.slice(0, 8)}`, { payout_id: payoutId, items: failed.map(f => f.id) });
  return failed.length;
}

registerJob('payouts.advance', async ({ payoutId }, job) => {
  const orgId = job.orgId!;
  const payout = await one<any>(`SELECT * FROM payouts WHERE id=$1 AND organization_id=$2`, [payoutId, orgId]);
  if (!payout) return;
  if (payout.status === 'initiated') await q(`UPDATE payouts SET status='processing' WHERE id=$1`, [payoutId]);
  else if (payout.status !== 'processing') return;
  const items = await q<any>(`UPDATE payout_items SET status='processing', attempts=attempts+1, updated_at=now() WHERE payout_id=$1 AND status IN ('pending','retried') RETURNING *`, [payoutId]);
  for (const it of items) {
    const delay = 8000 + Math.floor(Math.random() * 20000);
    await enqueue('payouts.item', { itemId: it.id }, { orgId, runAt: new Date(Date.now() + delay), dedupeKey: `payout-item:${it.id}:${it.attempts}` });
  }
  await log(pool, orgId, 'info', `Batch ${payoutId.slice(0, 8)} processing (${items.length} transfer(s))`, { payout_id: payoutId });
  publishOrg(orgId, 'payout', { id: payoutId, status: 'processing' });
});

registerJob('payouts.item', async ({ itemId }, job) => {
  const orgId = job.orgId!;
  const it = await one<any>(`SELECT * FROM payout_items WHERE id=$1 AND organization_id=$2`, [itemId, orgId]);
  if (!it || it.status !== 'processing') return;
  const integ = await one<any>(`SELECT status, config FROM integrations WHERE organization_id=$1 AND key='payouts'`, [orgId]);
  const rate = Number(integ?.config?.failure_rate ?? 0.08);
  const fail = integ?.status !== 'connected' || Math.random() < (it.attempts > 1 ? rate / 3 : rate);
  const to = fail ? 'failed' : 'paid';
  if (!canTransition('payout_item', it.status, to)) return;
  const reason = integ?.status !== 'connected' ? 'Payouts integration disconnected during processing' : FAILURES[Math.floor(Math.random() * FAILURES.length)];
  const upd = await one<any>(`UPDATE payout_items SET status=$2, provider_ref=CASE WHEN $2='paid' THEN $3 ELSE provider_ref END, failure_reason=CASE WHEN $2='failed' THEN $4 ELSE NULL END, updated_at=now() WHERE id=$1 AND status='processing' RETURNING *`, [itemId, to, `wise_tr_${crypto.randomBytes(5).toString('hex')}`, reason]);
  if (!upd) return;
  const payout = await one<any>(`SELECT * FROM payouts WHERE id=$1`, [upd.payout_id]);
  await log(pool, orgId, fail ? 'error' : 'info', fail ? `Transfer failed: ${reason}` : `Transfer ${upd.provider_ref} paid`, { payout_id: upd.payout_id, item_id: itemId, amount_cents: upd.amount_cents });
  publishOrg(orgId, 'payout', { id: upd.payout_id, item_id: itemId, status: to });
  for (const h of itemHooks) { try { await h(orgId, upd, payout); } catch (e: any) { console.error('[payout item hook]', e?.message ?? e); } }
  // Finalise the batch when every item is settled.
  const all = await q<any>(`SELECT * FROM payout_items WHERE payout_id=$1`, [upd.payout_id]);
  if (all.some(i => !['paid', 'failed'].includes(i.status))) return;
  const status = all.every(i => i.status === 'paid') ? 'paid' : all.every(i => i.status === 'failed') ? 'failed' : 'partially_failed';
  const fin = await one<any>(`UPDATE payouts SET status=$2, completed_at=now() WHERE id=$1 AND status='processing' RETURNING *`, [upd.payout_id, status]);
  if (!fin) return;
  await log(pool, orgId, status === 'paid' ? 'info' : 'warn', `Batch ${fin.id.slice(0, 8)} ${status.replace('_', ' ')}`, { payout_id: fin.id });
  publishOrg(orgId, 'payout', { id: fin.id, status });
  for (const h of batchHooks) { try { await h(orgId, fin, all); } catch (e: any) { console.error('[payout batch hook]', e?.message ?? e); } }
});
