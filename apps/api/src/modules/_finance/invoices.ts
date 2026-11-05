// Invoice domain service: generation from approved timesheet days, totals with recomputation history,
// payments, credits, refunds, write-offs. Pure DB work on an explicit client; side effects
// (emails, notifications, events) are done by the route layer after the transaction commits.
import crypto from 'node:crypto';
import { divRoundHalfUp, linesByRate, invoiceTotals, validatePayment, invoiceStatusAfterPayment, rateForDate, amountForMinutes, canTransition } from '@veyro/shared';
import { q, one, type Db } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSetting } from '../../core/settings';
import { ratesFor, nextNumber, OPEN_INVOICE, orgToday } from './common';
import { addDays } from '@veyro/shared';

export interface PreviewLine {
  kind: 'time' | 'adjustment';
  placement_id: string; worker_id: string; worker_name: string; title: string;
  rate_id: string | null; period_start: string; period_end: string; minutes: number; hours: number;
  unit: string; unit_price_cents: number; amount_cents: number; currency: string;
  timesheet_ids: string[]; day_ids: string[]; adjustment_ids: string[]; description: string;
}

/** Approved, un-invoiced timesheet days for a client and period, priced by the rate effective on each work date. */
export async function previewInvoice(db: Db, orgId: string, companyId: string, from: string, to: string, opts: { lock?: boolean; placementIds?: string[] } = {}) {
  if (from > to) throw badRequest('Period start must be before period end', { period_end: 'Must be on or after the start date' });
  const company = await one<any>(`SELECT * FROM companies WHERE id=$1 AND organization_id=$2`, [companyId, orgId], db);
  if (!company) throw notFound('Client not found');
  const params: unknown[] = [orgId, companyId, from, to];
  let plFilter = '';
  if (opts.placementIds?.length) { params.push(opts.placementIds); plFilter = `AND d.placement_id = ANY($${params.length})`; }
  const days = await q<any>(`SELECT d.id, d.placement_id, d.work_date, d.minutes, d.timesheet_id FROM timesheet_days d
      JOIN timesheets t ON t.id=d.timesheet_id JOIN placements p ON p.id=d.placement_id
      WHERE d.organization_id=$1 AND p.company_id=$2 AND t.status IN ('approved','locked') AND d.invoice_id IS NULL AND d.work_date BETWEEN $3 AND $4 AND d.minutes > 0 ${plFilter}
      ORDER BY d.work_date ${opts.lock ? 'FOR UPDATE OF d' : ''}`, params, db);
  const adjustments = await q<any>(`SELECT a.* FROM timesheet_adjustments a JOIN placements p ON p.id=a.placement_id
      WHERE a.organization_id=$1 AND p.company_id=$2 AND a.applied_invoice_id IS NULL AND a.work_date BETWEEN $3 AND $4 ${opts.placementIds?.length ? `AND a.placement_id = ANY($5)` : ''} ${opts.lock ? 'FOR UPDATE OF a' : ''}`, params, db);
  const plIds = [...new Set([...days.map(d => d.placement_id), ...adjustments.map(a => a.placement_id)])];
  const pls = plIds.length ? await q<any>(`SELECT p.id, p.title, p.worker_id, c.first_name, c.last_name FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates c ON c.id=w.candidate_id WHERE p.id = ANY($1)`, [plIds], db) : [];
  const rates = await ratesFor(db, orgId, plIds);
  const lines: PreviewLine[] = [];
  const problems: string[] = [];
  for (const p of pls.sort((a, b) => (a.first_name + a.last_name).localeCompare(b.first_name + b.last_name))) {
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
    const pDays = days.filter(d => d.placement_id === p.id);
    const pr = rates.get(p.id) ?? [];
    try {
      for (const l of linesByRate(pDays.map(d => ({ date: d.work_date, minutes: d.minutes })), pr, 'bill')) {
        const inLine = pDays.filter(d => d.work_date >= l.from && d.work_date <= l.to && rateForDate(pr, d.work_date)?.id === l.rateId);
        lines.push({ kind: 'time', placement_id: p.id, worker_id: p.worker_id, worker_name: name, title: p.title, rate_id: l.rateId, period_start: l.from, period_end: l.to, minutes: l.minutes, hours: Math.round((l.minutes / 60) * 100) / 100, unit: l.unit, unit_price_cents: l.rateCents, amount_cents: l.amountCents, currency: l.currency, timesheet_ids: [...new Set(inLine.map(d => d.timesheet_id))], day_ids: inLine.map(d => d.id), adjustment_ids: [], description: `${name} — ${p.title} (${l.from} to ${l.to})` });
      }
    } catch (e: any) { problems.push(`${name}: ${e.message}`); }
    for (const a of adjustments.filter(x => x.placement_id === p.id)) {
      const r = rateForDate(pr, a.work_date);
      if (!r) { problems.push(`${name}: no rate effective on ${a.work_date} for adjustment`); continue; }
      const amt = amountForMinutes(r.billRateCents, a.minutes_delta, r.unit);
      lines.push({ kind: 'adjustment', placement_id: p.id, worker_id: p.worker_id, worker_name: name, title: p.title, rate_id: r.id, period_start: a.work_date, period_end: a.work_date, minutes: a.minutes_delta, hours: Math.round((a.minutes_delta / 60) * 100) / 100, unit: r.unit, unit_price_cents: r.billRateCents, amount_cents: amt, currency: r.currency, timesheet_ids: [a.timesheet_id], day_ids: [], adjustment_ids: [a.id], description: `${name} — timesheet adjustment ${a.work_date}: ${a.reason}` });
    }
  }
  const settings = await getSetting<any>(orgId, 'invoice');
  const taxBp = company.tax_bp || settings.tax_bp || 0;
  const totals = invoiceTotals({ lineAmounts: lines.map(l => l.amount_cents), taxBp });
  const pending = await one<any>(`SELECT count(*)::int n, COALESCE(sum(t.total_minutes),0)::int minutes FROM timesheets t WHERE t.organization_id=$1 AND t.company_id=$2 AND t.status IN ('open','submitted') AND t.week_start <= $4 AND t.week_start + 6 >= $3`, [orgId, companyId, from, to], db);
  return { company: { id: company.id, name: company.name, currency: company.currency, payment_terms_days: company.payment_terms_days, tax_bp: taxBp }, period_start: from, period_end: to, lines, totals, tax_bp: taxBp, problems, pending_timesheets: pending!.n, pending_minutes: pending!.minutes };
}

export interface ManualLine { kind: 'manual' | 'reimbursement' | 'adjustment'; description: string; quantity: number; unit_price_cents: number; taxable?: boolean; placement_id?: string | null }

/** Creates a Draft invoice from approved time (+ optional manual lines). Marks timesheet_days.invoice_id. */
export async function createInvoice(db: Db, orgId: string, actorId: string | null, input: { company_id: string; period_start: string; period_end: string; due_date?: string | null; notes?: string | null; placement_ids?: string[]; manual_lines?: ManualLine[]; discount_cents?: number; previous_balance_cents?: number; include_time?: boolean }) {
  const includeTime = input.include_time !== false;
  const pv = await previewInvoice(db, orgId, input.company_id, input.period_start, input.period_end, { lock: true, placementIds: input.placement_ids });
  if (pv.problems.length && includeTime) throw conflict(`Cannot price some approved time: ${pv.problems.join('; ')}`);
  const timeLines = includeTime ? pv.lines : [];
  if (!timeLines.length && !input.manual_lines?.length) throw badRequest('There is no approved, un-invoiced time for this client and period. Add a manual line or choose another period.');
  const settings = await getSetting<any>(orgId, 'invoice');
  const issue = await orgToday(db, orgId);
  const terms = pv.company.payment_terms_days ?? settings.terms_days ?? 15;
  const number = await nextNumber(db, orgId, 'invoices', settings.prefix || 'INV');
  const inv = (await q<any>(`INSERT INTO invoices (organization_id, company_id, number, period_start, period_end, issue_date, due_date, status, currency, tax_bp, discount_cents, previous_balance_cents, notes, pay_token, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [orgId, input.company_id, number, input.period_start, input.period_end, issue, input.due_date || addDays(issue, terms), pv.company.currency || 'USD', pv.tax_bp, input.discount_cents ?? 0, input.previous_balance_cents ?? 0, input.notes ?? null, crypto.randomBytes(16).toString('hex'), actorId], db))[0];
  let sort = 0;
  for (const l of timeLines) {
    await q(`INSERT INTO invoice_lines (organization_id, invoice_id, kind, placement_id, worker_id, rate_id, description, period_start, period_end, minutes, quantity, unit_price_cents, amount_cents, taxable, timesheet_ids, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15)`,
      [orgId, inv.id, l.kind, l.placement_id, l.worker_id, l.rate_id, l.description, l.period_start, l.period_end, l.minutes, (l.minutes / 60).toFixed(2), l.unit_price_cents, l.amount_cents, l.timesheet_ids, sort++], db);
    if (l.day_ids.length) await q(`UPDATE timesheet_days SET invoice_id=$1 WHERE id = ANY($2) AND invoice_id IS NULL`, [inv.id, l.day_ids], db);
    if (l.adjustment_ids.length) await q(`UPDATE timesheet_adjustments SET applied_invoice_id=$1 WHERE id = ANY($2)`, [inv.id, l.adjustment_ids], db);
  }
  for (const m of input.manual_lines ?? []) await insertManualLine(db, orgId, inv.id, m, sort++);
  if (timeLines.length) await q(`UPDATE timesheets SET invoice_id=$1 WHERE id = ANY($2) AND invoice_id IS NULL`, [inv.id, [...new Set(timeLines.flatMap(l => l.timesheet_ids))]], db);
  return recompute(db, orgId, inv.id, timeLines.length ? 'Generated from approved timesheets' : 'Created with manual lines', actorId);
}

export async function insertManualLine(db: Db, orgId: string, invoiceId: string, m: ManualLine, sort?: number) {
  if (!m.description?.trim()) throw badRequest('Description is required', { description: 'Required' });
  const qty = Math.round(Number(m.quantity ?? 1) * 100);
  if (!Number.isFinite(qty) || qty === 0) throw badRequest('Quantity must be a non-zero number', { quantity: 'Invalid quantity' });
  const amount = divRoundHalfUp(qty * m.unit_price_cents, 100); // quantity has 2 decimals; half-up at the line level
  const s = sort ?? Number((await one<any>(`SELECT COALESCE(max(sort),-1)+1 n FROM invoice_lines WHERE invoice_id=$1`, [invoiceId], db))!.n);
  return (await q<any>(`INSERT INTO invoice_lines (organization_id, invoice_id, kind, placement_id, description, quantity, unit_price_cents, amount_cents, taxable, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [orgId, invoiceId, m.kind, m.placement_id ?? null, m.description.trim(), (qty / 100).toFixed(2), m.unit_price_cents, amount, m.kind === 'reimbursement' ? false : m.taxable !== false, s], db))[0];
}

/**
 * Recomputes totals from lines + adjustments and writes an invoice_total_history row
 * (invariant: total is never stored without recomputation history).
 * total = Σ lines + tax − discount − credits + late fee + previous balance; non-taxable lines are excluded from the tax base.
 */
export async function recompute(db: Db, orgId: string, invoiceId: string, reason: string, actorId: string | null) {
  const inv = await one<any>(`SELECT * FROM invoices WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [invoiceId, orgId], db);
  if (!inv) throw notFound();
  const lines = await q<any>(`SELECT amount_cents, taxable FROM invoice_lines WHERE invoice_id=$1`, [invoiceId], db);
  const credits = Number((await one<any>(`SELECT COALESCE(sum(amount_cents),0)::bigint n FROM credit_notes WHERE organization_id=$1 AND applied_invoice_id=$2 AND kind IN ('credit','overpayment')`, [orgId, invoiceId], db))!.n);
  const taxable = lines.filter(l => l.taxable).map(l => Number(l.amount_cents));
  const nonTaxable = lines.filter(l => !l.taxable).reduce((a, l) => a + Number(l.amount_cents), 0);
  const t = invoiceTotals({ lineAmounts: taxable, taxBp: inv.tax_bp, discountCents: Number(inv.discount_cents), creditCents: credits, lateFeeCents: Number(inv.late_fee_cents), previousBalanceCents: Number(inv.previous_balance_cents) });
  const subtotal = t.subtotalCents + nonTaxable;
  const total = t.totalCents + nonTaxable;
  if (total < 0) throw badRequest('Discounts and credits cannot exceed the invoice amount');
  let status = inv.status;
  const paid = Number(inv.paid_cents);
  if (OPEN_INVOICE.includes(status) && paid >= total && total > 0) status = 'paid';
  const upd = (await q<any>(`UPDATE invoices SET subtotal_cents=$2, tax_cents=$3, credit_cents=$4, total_cents=$5, status=$6, paid_at=CASE WHEN $6='paid' AND paid_at IS NULL THEN now() ELSE paid_at END, updated_at=now() WHERE id=$1 RETURNING *`, [invoiceId, subtotal, t.taxCents, credits, total, status], db))[0];
  await q(`INSERT INTO invoice_total_history (organization_id, invoice_id, subtotal_cents, tax_cents, total_cents, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [orgId, invoiceId, subtotal, t.taxCents, total, reason, actorId], db);
  return upd;
}

export function balanceOf(inv: { total_cents: number | string; paid_cents: number | string }) { return Number(inv.total_cents) - Number(inv.paid_cents); }

/** Applies a (successful) payment to an invoice under a row lock. Enforces Σ payments ≤ total unless overpayment credit is explicit. */
export async function applyPayment(db: Db, orgId: string, invoiceId: string, p: { amount_cents: number; method: string; status?: 'succeeded' | 'failed'; card_brand?: string | null; card_last4?: string | null; provider?: string; provider_ref?: string | null; failure_reason?: string | null; idempotency_key?: string | null; payer_email?: string | null; received_at?: string | null; allow_overpay?: boolean; actorId: string | null }) {
  if (p.idempotency_key) {
    const existing = await one<any>(`SELECT * FROM payments WHERE idempotency_key=$1 AND organization_id=$2`, [p.idempotency_key, orgId], db);
    if (existing) return { payment: existing, invoice: await one<any>(`SELECT * FROM invoices WHERE id=$1`, [existing.invoice_id], db), duplicate: true, overpaid_cents: 0, credit: null as any };
  }
  const inv = await one<any>(`SELECT * FROM invoices WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [invoiceId, orgId], db);
  if (!inv) throw notFound();
  if (!OPEN_INVOICE.includes(inv.status)) throw conflict(inv.status === 'paid' ? 'This invoice is already paid in full' : `Invoice is ${inv.status.replace('_', ' ')} — only sent, viewed, partially paid or overdue invoices can take payments`);
  const receipt = `RCPT-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  if (p.status === 'failed') {
    const payment = (await q<any>(`INSERT INTO payments (organization_id, invoice_id, company_id, amount_cents, currency, method, status, card_brand, card_last4, provider, provider_ref, failure_reason, idempotency_key, payer_email, created_by) VALUES ($1,$2,$3,$4,$5,$6,'failed',$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [orgId, invoiceId, inv.company_id, p.amount_cents, inv.currency, p.method, p.card_brand ?? null, p.card_last4 ?? null, p.provider ?? 'stripe-sim', p.provider_ref ?? null, p.failure_reason ?? 'Declined', p.idempotency_key ?? null, p.payer_email ?? null, p.actorId], db))[0];
    return { payment, invoice: inv, duplicate: false, overpaid_cents: 0, credit: null as any };
  }
  const v = validatePayment(Number(inv.total_cents), Number(inv.paid_cents), p.amount_cents, !!p.allow_overpay);
  if (!v.ok) throw badRequest(v.error, { amount_cents: v.error });
  const payment = (await q<any>(`INSERT INTO payments (organization_id, invoice_id, company_id, amount_cents, currency, method, status, card_brand, card_last4, provider, provider_ref, idempotency_key, receipt_number, payer_email, received_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,'succeeded',$7,$8,$9,$10,$11,$12,$13,COALESCE($14::timestamptz, now()),$15) RETURNING *`,
    [orgId, invoiceId, inv.company_id, p.amount_cents, inv.currency, p.method, p.card_brand ?? null, p.card_last4 ?? null, p.provider ?? (p.method === 'card' ? 'stripe-sim' : 'manual'), p.provider_ref ?? null, p.idempotency_key ?? null, receipt, p.payer_email ?? null, p.received_at ?? null, p.actorId], db))[0];
  const applied = p.amount_cents - v.overpaidCents;
  const newPaid = Number(inv.paid_cents) + applied;
  const next = invoiceStatusAfterPayment(Number(inv.total_cents), newPaid);
  if (next !== inv.status && !canTransition('invoice', inv.status, next)) throw conflict(`Cannot move invoice from ${inv.status} to ${next}`);
  const upd = (await q<any>(`UPDATE invoices SET paid_cents=$2, status=$3, paid_at=CASE WHEN $3='paid' THEN now() ELSE paid_at END, updated_at=now() WHERE id=$1 RETURNING *`, [invoiceId, newPaid, next], db))[0];
  let credit = null;
  if (v.overpaidCents > 0) {
    const number = await nextNumber(db, orgId, 'credit_notes', 'CN');
    credit = (await q<any>(`INSERT INTO credit_notes (organization_id, company_id, invoice_id, number, kind, amount_cents, currency, reason, payment_id, created_by) VALUES ($1,$2,$3,$4,'overpayment',$5,$6,$7,$8,$9) RETURNING *`,
      [orgId, inv.company_id, invoiceId, number, v.overpaidCents, inv.currency, `Overpayment on ${inv.number} (receipt ${receipt}) — available credit`, payment.id, p.actorId], db))[0];
  }
  return { payment, invoice: upd, duplicate: false, overpaid_cents: v.overpaidCents, credit };
}

/** Credit note applied to an invoice: reduces its total (recomputed with history). */
export async function creditInvoice(db: Db, orgId: string, invoiceId: string, amount: number, reason: string, actorId: string | null) {
  const inv = await one<any>(`SELECT * FROM invoices WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [invoiceId, orgId], db);
  if (!inv) throw notFound();
  if (['paid', 'written_off', 'void'].includes(inv.status)) throw conflict(`Cannot credit an invoice that is ${inv.status.replace('_', ' ')}`);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Credit amount must be positive', { amount_cents: 'Must be positive' });
  if (amount > balanceOf(inv)) throw badRequest(`Credit exceeds the open balance of ${(balanceOf(inv) / 100).toFixed(2)}`, { amount_cents: 'Exceeds open balance' });
  const number = await nextNumber(db, orgId, 'credit_notes', 'CN');
  const cn = (await q<any>(`INSERT INTO credit_notes (organization_id, company_id, invoice_id, number, kind, amount_cents, currency, reason, applied_invoice_id, created_by) VALUES ($1,$2,$3,$4,'credit',$5,$6,$7,$3,$8) RETURNING *`, [orgId, inv.company_id, invoiceId, number, amount, inv.currency, reason, actorId], db))[0];
  const updated = await recompute(db, orgId, invoiceId, `Credit note ${number}: ${reason}`, actorId);
  return { credit: cn, invoice: updated };
}

/** Write-off: separate credit_notes record for the open balance; status → Written Off. */
export async function writeOff(db: Db, orgId: string, invoiceId: string, reason: string, actorId: string | null) {
  const inv = await one<any>(`SELECT * FROM invoices WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [invoiceId, orgId], db);
  if (!inv) throw notFound();
  if (!canTransition('invoice', inv.status, 'written_off')) throw conflict(`Cannot write off an invoice that is ${inv.status.replace('_', ' ')}`);
  const bal = balanceOf(inv);
  const number = await nextNumber(db, orgId, 'credit_notes', 'CN');
  const cn = (await q<any>(`INSERT INTO credit_notes (organization_id, company_id, invoice_id, number, kind, amount_cents, currency, reason, created_by) VALUES ($1,$2,$3,$4,'write_off',$5,$6,$7,$8) RETURNING *`, [orgId, inv.company_id, invoiceId, number, bal, inv.currency, reason, actorId], db))[0];
  const upd = (await q<any>(`UPDATE invoices SET status='written_off', written_off_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [invoiceId], db))[0];
  return { credit: cn, invoice: upd, before: inv };
}

/** Refund (part of) a payment: separate credit_notes record; invoice paid amount and status are reconciled. */
export async function refundPayment(db: Db, orgId: string, paymentId: string, amount: number, reason: string, actorId: string | null, providerRef: string | null) {
  const pay = await one<any>(`SELECT * FROM payments WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [paymentId, orgId], db);
  if (!pay) throw notFound();
  if (pay.status !== 'succeeded') throw conflict('Only succeeded payments can be refunded');
  const refundable = Number(pay.amount_cents) - Number(pay.refunded_cents);
  if (!Number.isInteger(amount) || amount <= 0 || amount > refundable) throw badRequest(`Refund must be between 0.01 and ${(refundable / 100).toFixed(2)}`, { amount_cents: 'Invalid refund amount' });
  const inv = await one<any>(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [pay.invoice_id], db);
  const number = await nextNumber(db, orgId, 'credit_notes', 'CN');
  const cn = (await q<any>(`INSERT INTO credit_notes (organization_id, company_id, invoice_id, number, kind, amount_cents, currency, reason, payment_id, created_by) VALUES ($1,$2,$3,$4,'refund',$5,$6,$7,$8,$9) RETURNING *`, [orgId, pay.company_id ?? inv.company_id, pay.invoice_id, number, amount, pay.currency, reason, paymentId, actorId], db))[0];
  const fully = Number(pay.refunded_cents) + amount >= Number(pay.amount_cents);
  const payment = (await q<any>(`UPDATE payments SET refunded_cents=refunded_cents+$2, status=CASE WHEN $3 THEN 'refunded' ELSE status END, provider_ref=COALESCE(provider_ref,$4) WHERE id=$1 RETURNING *`, [paymentId, amount, fully, providerRef], db))[0];
  const newPaid = Math.max(0, Number(inv.paid_cents) - amount);
  const today = await orgToday(db, orgId);
  // Reconcile status from balance (system transition, recorded on the timeline by the caller).
  let status = inv.status;
  if (!['written_off', 'void'].includes(inv.status)) status = newPaid >= Number(inv.total_cents) ? 'paid' : newPaid > 0 ? 'partially_paid' : inv.due_date < today ? 'overdue' : 'sent';
  const invoice = (await q<any>(`UPDATE invoices SET paid_cents=$2, status=$3, paid_at=CASE WHEN $3='paid' THEN paid_at ELSE NULL END, updated_at=now() WHERE id=$1 RETURNING *`, [inv.id, newPaid, status], db))[0];
  return { credit: cn, payment, invoice };
}

/** Voids a draft and releases its timesheet days so they can be invoiced again. */
export async function voidInvoice(db: Db, orgId: string, invoiceId: string) {
  const inv = await one<any>(`SELECT * FROM invoices WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [invoiceId, orgId], db);
  if (!inv) throw notFound();
  if (!canTransition('invoice', inv.status, 'void')) throw conflict('Only draft invoices can be voided — use a credit note or write-off for issued invoices');
  await q(`UPDATE timesheet_days SET invoice_id=NULL WHERE invoice_id=$1`, [invoiceId], db);
  await q(`UPDATE timesheet_adjustments SET applied_invoice_id=NULL WHERE applied_invoice_id=$1`, [invoiceId], db);
  await q(`UPDATE timesheets SET invoice_id=NULL WHERE invoice_id=$1`, [invoiceId], db);
  await q(`UPDATE expenses SET invoice_id=NULL, invoice_line_id=NULL, invoiced_at=NULL, status=CASE WHEN status='invoiced' THEN (CASE WHEN reimbursed_at IS NOT NULL THEN 'reimbursed' ELSE 'approved' END) ELSE status END, updated_at=now() WHERE invoice_id=$1`, [invoiceId], db);
  return (await q<any>(`UPDATE invoices SET status='void', updated_at=now() WHERE id=$1 RETURNING *`, [invoiceId], db))[0];
}

/** Locks approved timesheets whose every day is invoiced on a paid/written-off invoice AND paid in a paid payroll run. */
export async function lockTimesheets(db: Db, orgId: string, timesheetIds: string[]) {
  if (!timesheetIds.length) return 0;
  const r = await q<any>(`UPDATE timesheets t SET status='locked', locked_at=now(), updated_at=now()
    WHERE t.organization_id=$1 AND t.id = ANY($2) AND t.status='approved'
      AND NOT EXISTS (SELECT 1 FROM timesheet_days d WHERE d.timesheet_id=t.id AND (d.invoice_id IS NULL OR d.payroll_item_id IS NULL))
      AND NOT EXISTS (SELECT 1 FROM timesheet_days d JOIN invoices i ON i.id=d.invoice_id WHERE d.timesheet_id=t.id AND i.status NOT IN ('paid','written_off'))
      AND NOT EXISTS (SELECT 1 FROM timesheet_days d JOIN payroll_items pi ON pi.id=d.payroll_item_id JOIN payroll_runs r ON r.id=pi.run_id WHERE d.timesheet_id=t.id AND r.status <> 'paid')
    RETURNING t.id`, [orgId, timesheetIds], db);
  return r.length;
}
export async function timesheetIdsForInvoice(db: Db, invoiceId: string): Promise<string[]> {
  return (await q<any>(`SELECT DISTINCT timesheet_id FROM timesheet_days WHERE invoice_id=$1`, [invoiceId], db)).map(r => r.timesheet_id);
}
