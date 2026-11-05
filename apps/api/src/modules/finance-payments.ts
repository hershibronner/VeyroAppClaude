// FINANCE — payments, refunds, AR aging & collections, reconciliation, accounting sync,
// public pay page (simulated Stripe checkout) and the client portal invoices.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { q, one, tx, pool } from '../core/db';
import { staff, auth, need, getOr404 } from '../core/context';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { listParams, paged } from '../core/list';
import { rateLimit } from '../core/ratelimit';
import { WEB_URL } from '../core/settings';
import { charge, refund } from '../adapters/payments';
import { syncEntity, type SyncEntity } from '../adapters/accounting';
import { applyPayment, refundPayment, balanceOf } from './_finance/invoices';
import { fmt, orgToday, orgBranding, billingContact, OPEN_INVOICE, daysBetween } from './_finance/common';
import { invoicePdf } from './_finance/pdf';
import { afterPayment } from './finance-invoices';

const BUCKETS = [
  { key: 'current', label: 'Current', test: (d: number) => d <= 0 },
  { key: '1_30', label: '1–30 days', test: (d: number) => d >= 1 && d <= 30 },
  { key: '31_60', label: '31–60 days', test: (d: number) => d >= 31 && d <= 60 },
  { key: '61_90', label: '61–90 days', test: (d: number) => d >= 61 && d <= 90 },
  { key: '90_plus', label: '90+ days', test: (d: number) => d > 90 },
];

const cardBody = z.object({ card_number: z.string().min(12, 'Enter your card number').max(23), exp: z.string().min(4, 'Use MM/YY').max(7), cvc: z.string().min(3, 'Enter the security code').max(4), name: z.string().trim().min(2, 'Enter the name on the card').max(120), email: z.string().email('Enter a valid email').optional().or(z.literal('')), amount_cents: z.number().int().positive().optional(), idempotency_key: z.string().min(8).max(100).optional() });

/** Charges a card through the simulated Stripe adapter and applies the payment (shared by public page). */
async function payByCard(orgId: string, inv: any, b: z.infer<typeof cardBody>, actorId: string | null) {
  const balance = balanceOf(inv);
  if (!OPEN_INVOICE.includes(inv.status)) throw conflict(inv.status === 'paid' ? 'This invoice is already paid in full' : 'This invoice is not open for payment');
  const amount = b.amount_cents ?? balance;
  if (amount > balance) throw badRequest(`You can pay at most ${fmt(balance, inv.currency)} (the open balance)`, { amount_cents: 'Exceeds open balance' });
  const key = b.idempotency_key ? `pay:${inv.id}:${b.idempotency_key}` : `pay:${inv.id}:${crypto.randomUUID()}`;
  const dup = await one<any>(`SELECT * FROM payments WHERE idempotency_key=$1`, [key]);
  if (dup) return { payment: dup, invoice: await one<any>(`SELECT * FROM invoices WHERE id=$1`, [inv.id]), duplicate: true };
  const res = await charge(orgId, { amountCents: amount, currency: inv.currency, card: { number: b.card_number, exp: b.exp, cvc: b.cvc, name: b.name }, idempotencyKey: key, description: `Invoice ${inv.number}`, metadata: { invoice_id: inv.id } });
  const r = await tx(async c => {
    const out = await applyPayment(c, orgId, inv.id, { amount_cents: amount, method: 'card', status: res.ok ? 'succeeded' : 'failed', card_brand: res.brand, card_last4: res.last4, provider: 'stripe-sim', provider_ref: res.ref, failure_reason: res.ok ? null : res.message, idempotency_key: key, payer_email: b.email || null, actorId });
    await activity({ orgId, userId: actorId }, 'invoice', inv.id, 'payment', res.ok ? `Card payment of ${fmt(amount, inv.currency)} received (${res.brand} •••• ${res.last4})` : `Card payment declined (${res.brand} •••• ${res.last4}): ${res.message}`, null, { payment_id: out.payment.id }, c);
    return out;
  });
  if (res.ok && !r.duplicate) await afterPayment(orgId, r.invoice, r.payment, inv.status);
  return { ...r, declined: !res.ok, message: res.ok ? null : res.message };
}

async function publicInvoice(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound('This payment link is invalid or has expired');
  const inv = await one<any>(`SELECT i.*, co.name company_name FROM invoices i JOIN companies co ON co.id=i.company_id WHERE i.pay_token=$1 AND i.status NOT IN ('draft','approved','void')`, [token]);
  if (!inv) throw notFound('This payment link is invalid or has expired');
  return inv;
}

function clientCtx(req: any) {
  const ctx = auth(req);
  if (ctx.role.kind !== 'client' || !ctx.companyId) throw notFound();
  return ctx;
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/payments', async (req) => {
    const ctx = staff(req); need(ctx, 'payments', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId]; const where = ['p.organization_id=$1'];
    if (f.status) { params.push(f.status); where.push(`p.status=$${params.length}`); }
    if (f.method) { params.push(f.method); where.push(`p.method=$${params.length}`); }
    if (f.company_id) { params.push(f.company_id); where.push(`p.company_id=$${params.length}`); }
    if (f.from) { params.push(f.from); where.push(`p.received_at >= $${params.length}::date`); }
    if (f.to) { params.push(f.to); where.push(`p.received_at < $${params.length}::date + 1`); }
    return paged({
      select: `p.*, i.number invoice_number, co.name company_name, u.name created_by_name, (SELECT status FROM accounting_sync_log s WHERE s.entity_type='payment' AND s.entity_id=p.id ORDER BY created_at DESC LIMIT 1) sync_status`,
      from: `payments p JOIN invoices i ON i.id=p.invoice_id LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users u ON u.id=p.created_by`, where, params, lp,
      searchCols: ['i.number', 'co.name', 'p.receipt_number', 'p.provider_ref'], sortMap: { received_at: 'p.received_at', amount_cents: 'p.amount_cents', company_name: 'co.name' }, defaultSort: 'p.received_at DESC',
    });
  });

  app.post('/api/v1/payments/:id/refund', async (req) => {
    const ctx = staff(req); need(ctx, 'payments', 'edit');
    const { id } = req.params as { id: string };
    const b = z.object({ amount_cents: z.number().int().positive('Amount must be positive'), reason: z.string().trim().min(3, 'A reason is required') }).parse(req.body);
    const pay = await getOr404<any>('payments', ctx, id);
    const ext = pay.method === 'card' ? await refund(ctx.orgId, { chargeRef: pay.provider_ref, amountCents: b.amount_cents, currency: pay.currency, reason: b.reason }) : { ref: null };
    const r = await tx(async c => {
      const res = await refundPayment(c, ctx.orgId, id, b.amount_cents, b.reason, ctx.userId, ext.ref);
      await activity(ctx, 'invoice', pay.invoice_id, 'payment', `Refund ${res.credit.number} of ${fmt(b.amount_cents, pay.currency)} issued`, b.reason, { payment_id: id }, c);
      await audit(ctx, 'payment.refunded', { type: 'payment', id, label: pay.receipt_number ?? id }, { refunded_cents: pay.refunded_cents }, { refunded_cents: res.payment.refunded_cents, invoice_status: res.invoice.status }, b.reason, c);
      return res;
    });
    return r;
  });

  // AR aging (Current / 1–30 / 31–60 / 61–90 / 90+) by client.
  app.get('/api/v1/finance/ar', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'view');
    const today = await orgToday(pool, ctx.orgId);
    const rows = await q<any>(`SELECT i.id, i.number, i.company_id, co.name company_name, i.due_date, i.issue_date, i.status, i.total_cents, i.paid_cents, i.currency, co.account_manager_id, am.name account_manager_name,
        (SELECT max(created_at) FROM activities a WHERE a.entity_type='invoice' AND a.entity_id=i.id AND a.kind='email') last_reminder_at
      FROM invoices i JOIN companies co ON co.id=i.company_id LEFT JOIN users am ON am.id=co.account_manager_id WHERE i.organization_id=$1 AND i.status IN ('sent','viewed','partially_paid','overdue')`, [ctx.orgId]);
    const byClient = new Map<string, any>();
    const totals: Record<string, number> = Object.fromEntries(BUCKETS.map(b => [b.key, 0]));
    const counts: Record<string, number> = Object.fromEntries(BUCKETS.map(b => [b.key, 0]));
    const invoices = rows.map(r => ({ ...r, balance_cents: balanceOf(r), days_past_due: daysBetween(r.due_date, today) }));
    for (const r of invoices) {
      const b = BUCKETS.find(x => x.test(r.days_past_due))!;
      totals[b.key] += r.balance_cents; counts[b.key]++;
      const c = byClient.get(r.company_id) ?? { id: r.company_id, company_id: r.company_id, company_name: r.company_name, account_manager_name: r.account_manager_name, total_cents: 0, invoices: 0, oldest_days: 0, ...Object.fromEntries(BUCKETS.map(x => [x.key, 0])) };
      c[b.key] += r.balance_cents; c.total_cents += r.balance_cents; c.invoices++; c.oldest_days = Math.max(c.oldest_days, r.days_past_due);
      byClient.set(r.company_id, c);
    }
    const dso = await one<any>(`SELECT COALESCE(avg(EXTRACT(epoch FROM (paid_at - issue_date::timestamptz))/86400) FILTER (WHERE paid_at IS NOT NULL AND issue_date >= $2::date - 90),0)::float dso FROM invoices WHERE organization_id=$1`, [ctx.orgId, today]);
    return {
      today, buckets: BUCKETS.map(b => ({ key: b.key, label: b.label, amount_cents: totals[b.key], count: counts[b.key] })),
      total_cents: Object.values(totals).reduce((a, b) => a + b, 0), overdue_cents: totals['1_30'] + totals['31_60'] + totals['61_90'] + totals['90_plus'], dso_days: Math.round(dso!.dso * 10) / 10,
      clients: [...byClient.values()].sort((a, b) => b.total_cents - a.total_cents),
      collections: invoices.filter(i => i.days_past_due > 0).sort((a, b) => b.days_past_due - a.days_past_due),
    };
  });

  // Payments vs invoices reconciliation.
  app.get('/api/v1/payments/reconciliation', async (req) => {
    const ctx = staff(req); need(ctx, 'payments', 'view');
    const { from, to } = req.query as { from?: string; to?: string };
    const today = await orgToday(pool, ctx.orgId);
    const f = from ?? today.slice(0, 8) + '01'; const t = to ?? today;
    const rows = await q<any>(`SELECT i.id, i.number, i.status, co.name company_name, i.issue_date, i.total_cents, i.paid_cents, i.currency,
        COALESCE((SELECT sum(amount_cents - refunded_cents) FROM payments p WHERE p.invoice_id=i.id AND p.status IN ('succeeded','refunded')),0)::bigint payments_cents,
        COALESCE((SELECT sum(amount_cents) FROM credit_notes n WHERE n.invoice_id=i.id AND n.kind='overpayment'),0)::bigint overpaid_cents,
        (SELECT count(*)::int FROM payments p WHERE p.invoice_id=i.id AND p.status='failed') failed_attempts,
        (SELECT status FROM accounting_sync_log s WHERE s.entity_type='invoice' AND s.entity_id=i.id ORDER BY created_at DESC LIMIT 1) sync_status
      FROM invoices i JOIN companies co ON co.id=i.company_id WHERE i.organization_id=$1 AND i.status NOT IN ('draft','void') AND i.issue_date BETWEEN $2 AND $3 ORDER BY i.issue_date DESC, i.number DESC`, [ctx.orgId, f, t]);
    const out = rows.map(r => {
      const net = Number(r.payments_cents) - Number(r.overpaid_cents);
      const diff = net - Number(r.paid_cents);
      return { ...r, applied_cents: net, difference_cents: diff, matched: diff === 0 && (r.status !== 'paid' || Number(r.paid_cents) >= Number(r.total_cents)), balance_cents: balanceOf(r) };
    });
    return { from: f, to: t, rows: out, summary: { invoices: out.length, invoiced_cents: out.reduce((a, r) => a + Number(r.total_cents), 0), collected_cents: out.reduce((a, r) => a + Number(r.payments_cents), 0), open_cents: out.reduce((a, r) => a + (['written_off'].includes(r.status) ? 0 : r.balance_cents), 0), mismatches: out.filter(r => !r.matched).length, unsynced: out.filter(r => r.sync_status !== 'synced').length } };
  });

  // Accounting (simulated QuickBooks)
  app.get('/api/v1/accounting/log', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'view');
    const lp = listParams(req);
    const params: unknown[] = [ctx.orgId]; const where = ['s.organization_id=$1', `s.created_at = (SELECT max(created_at) FROM accounting_sync_log x WHERE x.entity_type=s.entity_type AND x.entity_id=s.entity_id)`];
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`s.status=$${params.length}`); }
    if (lp.filters.entity_type) { params.push(lp.filters.entity_type); where.push(`s.entity_type=$${params.length}`); }
    return paged({
      select: `s.*, COALESCE(i.number, pi.number, cn.number) ref_number, COALESCE(co.name, pco.name, cco.name) company_name, COALESCE(i.total_cents, p.amount_cents, cn.amount_cents) amount_cents, COALESCE(i.id, p.invoice_id, cn.invoice_id) invoice_id`,
      from: `accounting_sync_log s LEFT JOIN invoices i ON s.entity_type='invoice' AND i.id=s.entity_id LEFT JOIN companies co ON co.id=i.company_id
        LEFT JOIN payments p ON s.entity_type='payment' AND p.id=s.entity_id LEFT JOIN invoices pi ON pi.id=p.invoice_id LEFT JOIN companies pco ON pco.id=p.company_id
        LEFT JOIN credit_notes cn ON s.entity_type='credit_note' AND cn.id=s.entity_id LEFT JOIN companies cco ON cco.id=cn.company_id`,
      where, params, lp, searchCols: ['i.number', 'pi.number', 'co.name', 'pco.name', 's.external_id', 's.error'], sortMap: { created_at: 's.created_at', status: 's.status' }, defaultSort: 's.created_at DESC',
    });
  });

  app.get('/api/v1/accounting/summary', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'view');
    const integ = await one<any>(`SELECT status, provider, last_sync_at, last_error FROM integrations WHERE organization_id=$1 AND key='accounting'`, [ctx.orgId]);
    const s = await one<any>(`SELECT count(*) FILTER (WHERE status='synced')::int synced, count(*) FILTER (WHERE status='failed')::int failed FROM (SELECT DISTINCT ON (entity_type, entity_id) status FROM accounting_sync_log WHERE organization_id=$1 ORDER BY entity_type, entity_id, created_at DESC) x`, [ctx.orgId]);
    const pending = await one<any>(`SELECT (SELECT count(*)::int FROM invoices i WHERE i.organization_id=$1 AND i.status NOT IN ('draft','void') AND NOT EXISTS (SELECT 1 FROM accounting_sync_log s WHERE s.entity_id=i.id AND s.status='synced'))
      + (SELECT count(*)::int FROM payments p WHERE p.organization_id=$1 AND p.status <> 'failed' AND NOT EXISTS (SELECT 1 FROM accounting_sync_log s WHERE s.entity_id=p.id AND s.status='synced')) n`, [ctx.orgId]);
    return { integration: integ, synced: s!.synced, failed: s!.failed, pending: pending!.n };
  });

  app.post('/api/v1/accounting/sync', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const b = z.object({ entity_type: z.enum(['invoice', 'payment', 'credit_note']).optional(), entity_id: z.string().uuid().optional(), all_pending: z.boolean().optional(), failed_only: z.boolean().optional() }).parse(req.body);
    let targets: { type: SyncEntity; id: string }[] = [];
    if (b.entity_type && b.entity_id) {
      const table = b.entity_type === 'invoice' ? 'invoices' : b.entity_type === 'payment' ? 'payments' : 'credit_notes';
      await getOr404(table, ctx, b.entity_id);
      targets = [{ type: b.entity_type, id: b.entity_id }];
    } else if (b.all_pending || b.failed_only) {
      const cond = b.failed_only ? `(SELECT status FROM accounting_sync_log s WHERE s.entity_id=x.id ORDER BY created_at DESC LIMIT 1)='failed'` : `NOT EXISTS (SELECT 1 FROM accounting_sync_log s WHERE s.entity_id=x.id AND s.status='synced')`;
      const inv = await q<any>(`SELECT id FROM invoices x WHERE organization_id=$1 AND status NOT IN ('draft','void') AND ${cond} LIMIT 200`, [ctx.orgId]);
      const pay = await q<any>(`SELECT id FROM payments x WHERE organization_id=$1 AND status <> 'failed' AND ${cond} LIMIT 200`, [ctx.orgId]);
      const cns = await q<any>(`SELECT id FROM credit_notes x WHERE organization_id=$1 AND ${cond} LIMIT 200`, [ctx.orgId]);
      targets = [...inv.map(r => ({ type: 'invoice' as const, id: r.id })), ...pay.map(r => ({ type: 'payment' as const, id: r.id })), ...cns.map(r => ({ type: 'credit_note' as const, id: r.id }))];
    } else throw badRequest('Choose a record to sync or all_pending');
    let synced = 0, failed = 0;
    for (const t of targets) { const r = await syncEntity(ctx.orgId, t.type, t.id); if (r.log.status === 'synced') synced++; else failed++; }
    if (targets.length > 1) await audit(ctx, 'accounting.sync', { type: 'integration', label: 'QuickBooks (simulated)' }, undefined, { attempted: targets.length, synced, failed });
    return { attempted: targets.length, synced, failed };
  });

  app.post('/api/v1/accounting/log/:id/retry', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const { id } = req.params as { id: string };
    const log = await getOr404<any>('accounting_sync_log', ctx, id);
    return syncEntity(ctx.orgId, log.entity_type, log.entity_id);
  });

  // ── Public pay page (no login, rate-limited) ──
  app.get('/api/v1/public/pay/:token', { config: { public: true } }, async (req) => {
    const { token } = req.params as { token: string };
    await rateLimit(`pay-view:${req.ip}`, 120, 60);
    const inv = await publicInvoice(token);
    if (inv.status === 'sent') {
      await q(`UPDATE invoices SET status='viewed', viewed_at=now(), updated_at=now() WHERE id=$1 AND status='sent'`, [inv.id]);
      await activity({ orgId: inv.organization_id, userId: null }, 'invoice', inv.id, 'status', `Invoice ${inv.number} viewed by the client`, `From the online payment page (${req.ip})`);
      inv.status = 'viewed';
    } else if (!inv.viewed_at) await q(`UPDATE invoices SET viewed_at=now() WHERE id=$1`, [inv.id]);
    const brand = await orgBranding(pool, inv.organization_id);
    const lines = await q<any>(`SELECT description, kind, minutes, quantity, unit_price_cents, amount_cents FROM invoice_lines WHERE invoice_id=$1 ORDER BY sort`, [inv.id]);
    const payments = await q<any>(`SELECT amount_cents, refunded_cents, currency, method, status, card_brand, card_last4, receipt_number, received_at, failure_reason FROM payments WHERE invoice_id=$1 ORDER BY received_at DESC`, [inv.id]);
    const contact = await billingContact(pool, inv.organization_id, inv.company_id);
    return {
      org: { name: brand.name, logo_text: brand.logo_text, primary_color: brand.primary_color, accent_color: brand.accent_color, support_email: brand.support_email, hide_powered_by: brand.hide_powered_by },
      invoice: { number: inv.number, status: inv.status, issue_date: inv.issue_date, due_date: inv.due_date, period_start: inv.period_start, period_end: inv.period_end, currency: inv.currency, subtotal_cents: inv.subtotal_cents, tax_bp: inv.tax_bp, tax_cents: inv.tax_cents, discount_cents: inv.discount_cents, credit_cents: inv.credit_cents, late_fee_cents: inv.late_fee_cents, previous_balance_cents: inv.previous_balance_cents, total_cents: inv.total_cents, paid_cents: inv.paid_cents, balance_cents: balanceOf(inv), company_name: inv.company_name, notes: inv.notes },
      lines, payments, payable: OPEN_INVOICE.includes(inv.status) && balanceOf(inv) > 0, contact_email: contact?.email ?? null,
      test_cards: [{ number: '4242 4242 4242 4242', result: 'Succeeds' }, { number: '4000 0000 0000 0002', result: 'Declined' }, { number: '4000 0000 0000 9995', result: 'Insufficient funds' }],
    };
  });

  app.get('/api/v1/public/pay/:token/pdf', { config: { public: true } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    await rateLimit(`pay-pdf:${req.ip}`, 60, 60);
    const inv = await publicInvoice(token);
    const pdf = await invoicePdf(pool, inv.organization_id, inv.id);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${pdf.filename}"`).send(pdf.buffer);
  });

  app.post('/api/v1/public/pay/:token', { config: { public: true } }, async (req) => {
    const { token } = req.params as { token: string };
    await rateLimit(`pay:${req.ip}`, 10, 60);
    await rateLimit(`pay-token:${token.slice(0, 64)}`, 20, 3600);
    const inv = await publicInvoice(token);
    const b = cardBody.parse(req.body);
    const r = await payByCard(inv.organization_id, inv, b, req.ctx && req.ctx.orgId === inv.organization_id ? req.ctx.userId : null);
    const p = r.payment;
    return { status: p.status, declined: p.status === 'failed', message: p.status === 'failed' ? p.failure_reason : null, duplicate: r.duplicate,
      receipt: p.status === 'succeeded' ? { number: p.receipt_number, amount_cents: p.amount_cents, currency: p.currency, card_brand: p.card_brand, card_last4: p.card_last4, received_at: p.received_at, emailed_to: p.payer_email ?? (await billingContact(pool, inv.organization_id, inv.company_id))?.email ?? null } : null,
      invoice: { number: r.invoice.number, status: r.invoice.status, total_cents: r.invoice.total_cents, paid_cents: r.invoice.paid_cents, balance_cents: balanceOf(r.invoice) } };
  });

  // ── Client portal: invoices & pay now ──
  app.get('/api/v1/portal/client/invoices', async (req) => {
    const ctx = clientCtx(req);
    const lp = listParams(req);
    const today = await orgToday(pool, ctx.orgId);
    const params: unknown[] = [ctx.orgId, ctx.companyId, today]; const where = ['i.organization_id=$1', 'i.company_id=$2', '$3::date IS NOT NULL', `i.status NOT IN ('draft','approved','void')`];
    if (lp.filters.status === 'open') where.push(`i.status IN ('sent','viewed','partially_paid','overdue')`);
    else if (lp.filters.status) { params.push(lp.filters.status); where.push(`i.status=$${params.length}`); }
    const res = await paged({
      select: `i.id, i.number, i.status, i.issue_date, i.due_date, i.period_start, i.period_end, i.currency, i.total_cents, i.paid_cents, (i.total_cents - i.paid_cents) balance_cents, i.pay_token, CASE WHEN i.status IN ('sent','viewed','partially_paid','overdue') AND i.due_date < $3 THEN $3 - i.due_date ELSE 0 END days_overdue`,
      from: 'invoices i', where, params, lp, searchCols: ['i.number'], sortMap: { issue_date: 'i.issue_date', due_date: 'i.due_date', total_cents: 'i.total_cents', number: 'i.number' }, defaultSort: 'i.issue_date DESC',
    });
    const open = await one<any>(`SELECT count(*)::int n, COALESCE(sum(total_cents-paid_cents),0)::bigint cents, count(*) FILTER (WHERE status='overdue')::int overdue, min(due_date) next_due FROM invoices WHERE organization_id=$1 AND company_id=$2 AND status IN ('sent','viewed','partially_paid','overdue')`, [ctx.orgId, ctx.companyId]);
    return { ...res, rows: res.rows.map(r => ({ ...r, pay_url: OPEN_INVOICE.includes(r.status) ? `/pay/${r.pay_token}` : null, pay_token: undefined })), summary: { open_count: open!.n, open_cents: open!.cents, overdue_count: open!.overdue, next_due: open!.next_due } };
  });

  async function clientInvoice(ctx: any, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const inv = await one<any>(`SELECT * FROM invoices WHERE id=$1 AND organization_id=$2 AND company_id=$3 AND status NOT IN ('draft','approved','void')`, [id, ctx.orgId, ctx.companyId]);
    if (!inv) throw notFound();
    return inv;
  }

  app.get('/api/v1/portal/client/invoices/:id', async (req) => {
    const ctx = clientCtx(req);
    const inv = await clientInvoice(ctx, (req.params as any).id);
    const lines = await q<any>(`SELECT l.id, l.kind, l.description, l.period_start, l.period_end, l.minutes, l.quantity, l.unit_price_cents, l.amount_cents, c.first_name || ' ' || COALESCE(c.last_name,'') worker_name FROM invoice_lines l LEFT JOIN workers w ON w.id=l.worker_id LEFT JOIN candidates c ON c.id=w.candidate_id WHERE l.invoice_id=$1 ORDER BY l.sort`, [inv.id]);
    const payments = await q<any>(`SELECT id, amount_cents, refunded_cents, currency, method, status, card_brand, card_last4, receipt_number, received_at FROM payments WHERE invoice_id=$1 AND status <> 'failed' ORDER BY received_at DESC`, [inv.id]);
    const credits = await q<any>(`SELECT number, kind, amount_cents, currency, reason, created_at FROM credit_notes WHERE organization_id=$1 AND (invoice_id=$2 OR applied_invoice_id=$2) ORDER BY created_at DESC`, [ctx.orgId, inv.id]);
    const { pay_token, created_by, approved_by, accounting_external_id, ...safe } = inv;
    return { invoice: { ...safe, balance_cents: balanceOf(inv), pay_url: OPEN_INVOICE.includes(inv.status) ? `/pay/${pay_token}` : null }, lines, payments, credit_notes: credits };
  });

  app.get('/api/v1/portal/client/invoices/:id/pdf', async (req, reply) => {
    const ctx = clientCtx(req);
    const inv = await clientInvoice(ctx, (req.params as any).id);
    const pdf = await invoicePdf(pool, ctx.orgId, inv.id);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${pdf.filename}"`).send(pdf.buffer);
  });

  // "Pay now" from the portal: returns the hosted checkout link (the same simulated Stripe page).
  app.post('/api/v1/portal/client/invoices/:id/pay', async (req) => {
    const ctx = clientCtx(req);
    if (ctx.role.key === 'client_viewer') throw notFound();
    const inv = await clientInvoice(ctx, (req.params as any).id);
    if (!OPEN_INVOICE.includes(inv.status)) throw conflict('This invoice is not open for payment');
    return { pay_url: `/pay/${inv.pay_token}`, absolute_url: `${WEB_URL}/pay/${inv.pay_token}` };
  });
}
