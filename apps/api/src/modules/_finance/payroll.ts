// Payroll domain service: runs per period with idempotency key payroll:<start>:<end>.
// Approved, unpaid timesheet days → computePayroll (regular + OT at the rate effective on each date)
// + bonuses / commissions / reimbursements / leave pay − deductions / advances = net.
// Approved, reimbursable expenses (expenses table) dated on/before the period end and not yet attached to a
// payroll item are pulled in as 'reimbursement' earnings (one row per expense; expenses.payroll_item_id marks them).
import { computePayroll, rateForDate, amountForMinutes, addDays, isoDow } from '@veyro/shared';
import { q, one, type Db } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSetting } from '../../core/settings';
import { ratesFor, type Frequency } from './common';

export interface PayrollPreviewItem {
  worker_id: string; worker_name: string; employee_code: string | null; placement_id: string; title: string; company_id: string; company_name: string; currency: string;
  regular_minutes: number; ot_minutes: number; regular_cents: number; ot_cents: number; lines: unknown[];
  earnings: { kind: string; description: string; amount_cents: number; expense_id?: string }[]; deductions: { kind: string; description: string; amount_cents: number }[];
  earnings_cents: number; deductions_cents: number; gross_cents: number; net_cents: number;
  day_ids: string[]; timesheet_ids: string[]; adjustment_ids: string[]; expense_ids: string[];
}

/** Approved reimbursable expenses not yet in a payroll run, dated on/before `end`, with the placement they are paid under. */
async function payableExpenses(db: Db, orgId: string, end: string, lock: boolean) {
  const rows = await q<any>(`SELECT e.id, e.worker_id, e.category, e.description, e.expense_date, e.amount_cents, e.currency,
      COALESCE(e.placement_id, (SELECT p.id FROM placements p WHERE p.worker_id=e.worker_id AND p.organization_id=e.organization_id ORDER BY (p.status='active') DESC, p.start_date DESC LIMIT 1)) pl_id
    FROM expenses e WHERE e.organization_id=$1 AND e.worker_id IS NOT NULL AND e.reimbursable_to_worker AND e.status IN ('approved','invoiced')
      AND e.payroll_item_id IS NULL AND e.expense_date <= $2 ORDER BY e.expense_date, e.created_at ${lock ? 'FOR UPDATE OF e' : ''}`, [orgId, end], db);
  return rows.filter(r => r.pl_id);
}

export const payrollKey = (start: string, end: string) => `payroll:${start}:${end}`;

function eachDate(from: string, to: string) { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }

export async function previewPayroll(db: Db, orgId: string, start: string, end: string, opts: { lock?: boolean } = {}) {
  if (start > end) throw badRequest('Period start must be before period end', { period_end: 'Must be on or after the start date' });
  const days = await q<any>(`SELECT d.id, d.placement_id, d.work_date, d.minutes, d.timesheet_id FROM timesheet_days d JOIN timesheets t ON t.id=d.timesheet_id
      WHERE d.organization_id=$1 AND t.status IN ('approved','locked') AND d.payroll_item_id IS NULL AND d.work_date BETWEEN $2 AND $3 AND d.minutes > 0 ORDER BY d.work_date ${opts.lock ? 'FOR UPDATE OF d' : ''}`, [orgId, start, end], db);
  const adjustments = await q<any>(`SELECT * FROM timesheet_adjustments WHERE organization_id=$1 AND applied_payroll_run_id IS NULL AND work_date BETWEEN $2 AND $3 ${opts.lock ? 'FOR UPDATE' : ''}`, [orgId, start, end], db);
  const leave = await q<any>(`SELECT r.*, p.id pl_id FROM time_off_requests r JOIN placements p ON p.worker_id=r.worker_id AND p.organization_id=r.organization_id AND (r.placement_id IS NULL OR r.placement_id=p.id)
      WHERE r.organization_id=$1 AND r.status='approved' AND r.kind <> 'unpaid' AND r.start_date <= $3 AND r.end_date >= $2 AND p.start_date <= $3 AND (p.end_date IS NULL OR p.end_date >= $2)`, [orgId, start, end], db);
  const expenses = await payableExpenses(db, orgId, end, !!opts.lock);
  const plIds = [...new Set([...days.map(d => d.placement_id), ...adjustments.map(a => a.placement_id), ...leave.map(l => l.pl_id), ...expenses.map(e => e.pl_id)])];
  if (!plIds.length) return { period_start: start, period_end: end, items: [] as PayrollPreviewItem[], problems: [] as string[], totals: { gross_cents: 0, net_cents: 0, workers: 0, minutes: 0 }, pending_timesheets: await pendingTimesheets(db, orgId, start, end) };
  const pls = await q<any>(`SELECT p.id, p.title, p.worker_id, p.company_id, p.start_date, p.end_date, p.schedule_days, p.weekly_hours, co.name company_name, c.first_name, c.last_name, w.employee_code FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates c ON c.id=w.candidate_id JOIN companies co ON co.id=p.company_id WHERE p.id = ANY($1)`, [plIds], db);
  const rates = await ratesFor(db, orgId, plIds);
  const items: PayrollPreviewItem[] = []; const problems: string[] = [];
  for (const p of pls.sort((a, b) => (a.first_name + a.last_name).localeCompare(b.first_name + b.last_name))) {
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
    const pr = rates.get(p.id) ?? [];
    const pDays = days.filter(d => d.placement_id === p.id);
    let calc;
    try { calc = computePayroll(pDays.map(d => ({ date: d.work_date, minutes: d.minutes })), pr); }
    catch (e: any) { problems.push(`${name}: ${e.message}`); continue; }
    const earnings: PayrollPreviewItem['earnings'] = []; const deductions: PayrollPreviewItem['deductions'] = [];
    const pAdj = adjustments.filter(a => a.placement_id === p.id);
    for (const a of pAdj) {
      const r = rateForDate(pr, a.work_date);
      if (!r) { problems.push(`${name}: no rate on ${a.work_date} for adjustment`); continue; }
      const amt = amountForMinutes(r.payRateCents, Math.abs(a.minutes_delta), r.unit);
      if (a.minutes_delta >= 0) earnings.push({ kind: 'adjustment', description: `Timesheet adjustment ${a.work_date} (+${(a.minutes_delta / 60).toFixed(2)}h): ${a.reason}`, amount_cents: amt });
      else deductions.push({ kind: 'adjustment', description: `Timesheet adjustment ${a.work_date} (${(a.minutes_delta / 60).toFixed(2)}h): ${a.reason}`, amount_cents: amt });
    }
    // Paid leave: scheduled days inside approved leave with no worked minutes, at the pay rate effective that day.
    const worked = new Set(pDays.map(d => d.work_date));
    const perDay = Math.round(((p.weekly_hours ?? 40) * 60) / Math.max(1, (p.schedule_days ?? [1, 2, 3, 4, 5]).length));
    for (const l of leave.filter(x => x.pl_id === p.id)) {
      const from = [l.start_date, start, p.start_date].sort().at(-1)!; const to = [l.end_date, end, p.end_date ?? end].sort()[0];
      let total = 0; let n = 0;
      for (const d of eachDate(from, to)) {
        if (!(p.schedule_days ?? []).includes(isoDow(d)) || worked.has(d)) continue;
        const r = rateForDate(pr, d); if (!r) continue;
        total += amountForMinutes(r.payRateCents, perDay, r.unit); n++;
      }
      if (total > 0) earnings.push({ kind: 'leave_pay', description: `Paid ${l.kind} leave — ${n} day(s) ${from} to ${to}`, amount_cents: total });
    }
    // Approved expense reimbursements (same currency as the placement's pay).
    const payCurrency = pr[0]?.currency ?? 'USD';
    const pExp = expenses.filter(e => e.pl_id === p.id && e.currency === payCurrency);
    for (const e of pExp) earnings.push({ kind: 'reimbursement', description: `Expense reimbursement ${e.expense_date} (${e.category}): ${e.description}`.slice(0, 200), amount_cents: Number(e.amount_cents), expense_id: e.id });
    if (!pDays.length && !earnings.length && !deductions.length) continue;
    const eSum = earnings.reduce((a, e) => a + e.amount_cents, 0); const dSum = deductions.reduce((a, e) => a + e.amount_cents, 0);
    const gross = calc.grossTimeCents + eSum;
    items.push({ worker_id: p.worker_id, worker_name: name, employee_code: p.employee_code, placement_id: p.id, title: p.title, company_id: p.company_id, company_name: p.company_name, currency: pr[0]?.currency ?? 'USD',
      regular_minutes: calc.regularMinutes, ot_minutes: calc.otMinutes, regular_cents: calc.regularCents, ot_cents: calc.otCents, lines: calc.lines,
      earnings, deductions, earnings_cents: eSum, deductions_cents: dSum, gross_cents: gross, net_cents: Math.max(0, gross - dSum),
      day_ids: pDays.map(d => d.id), timesheet_ids: [...new Set([...pDays.map(d => d.timesheet_id), ...pAdj.map(a => a.timesheet_id)])], adjustment_ids: pAdj.map(a => a.id), expense_ids: pExp.map(e => e.id) });
  }
  return { period_start: start, period_end: end, items, problems, totals: { gross_cents: items.reduce((a, i) => a + i.gross_cents, 0), net_cents: items.reduce((a, i) => a + i.net_cents, 0), workers: new Set(items.map(i => i.worker_id)).size, minutes: items.reduce((a, i) => a + i.regular_minutes + i.ot_minutes, 0) }, pending_timesheets: await pendingTimesheets(db, orgId, start, end) };
}

async function pendingTimesheets(db: Db, orgId: string, start: string, end: string) {
  return Number((await one<any>(`SELECT count(*)::int n FROM timesheets WHERE organization_id=$1 AND status IN ('open','submitted','rejected') AND week_start <= $3 AND week_start + 6 >= $2`, [orgId, start, end], db))!.n);
}

/**
 * Creates (or returns) the run for a period. Idempotent: the same period key returns the existing run
 * and never pays the same timesheet day twice (timesheet_days.payroll_item_id).
 */
export async function createRun(db: Db, orgId: string, actorId: string | null, input: { period_start: string; period_end: string; pay_date?: string | null; frequency?: Frequency; notes?: string | null }) {
  const key = payrollKey(input.period_start, input.period_end);
  const existing = await one<any>(`SELECT * FROM payroll_runs WHERE organization_id=$1 AND idempotency_key=$2`, [orgId, key], db);
  if (existing) return { run: existing, existing: true };
  const overlap = await one<any>(`SELECT * FROM payroll_runs WHERE organization_id=$1 AND period_start <= $3 AND period_end >= $2`, [orgId, input.period_start, input.period_end], db);
  if (overlap) throw conflict(`This period overlaps the existing payroll run ${overlap.period_start} – ${overlap.period_end}`);
  const settings = await getSetting<any>(orgId, 'payroll');
  const pv = await previewPayroll(db, orgId, input.period_start, input.period_end, { lock: true });
  if (pv.problems.length) throw conflict(`Cannot price some approved time: ${pv.problems.join('; ')}`);
  if (!pv.items.length) throw badRequest('There is no approved, unpaid time in this period yet. Approve timesheets first or pick another period.');
  const ins = await q<any>(`INSERT INTO payroll_runs (organization_id, period_start, period_end, frequency, pay_date, status, idempotency_key, currency, total_gross_cents, total_net_cents, worker_count, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,'calculated',$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING *`,
    [orgId, input.period_start, input.period_end, input.frequency ?? settings.frequency ?? 'semi_monthly', input.pay_date || addDays(input.period_end, Number(settings.pay_day_offset ?? 5)), key, pv.items[0].currency, pv.totals.gross_cents, pv.totals.net_cents, pv.totals.workers, input.notes ?? null, actorId], db);
  if (!ins.length) return { run: (await one<any>(`SELECT * FROM payroll_runs WHERE organization_id=$1 AND idempotency_key=$2`, [orgId, key], db))!, existing: true };
  const run = ins[0];
  const seq = Number((await one<any>(`SELECT count(*)::int n FROM payroll_items WHERE organization_id=$1`, [orgId], db))!.n);
  let k = 0;
  for (const it of pv.items) {
    k++;
    const item = (await q<any>(`INSERT INTO payroll_items (organization_id, run_id, worker_id, placement_id, company_id, regular_minutes, ot_minutes, regular_cents, ot_cents, earnings_cents, deductions_cents, gross_cents, net_cents, currency, lines, timesheet_ids, payslip_number)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [orgId, run.id, it.worker_id, it.placement_id, it.company_id, it.regular_minutes, it.ot_minutes, it.regular_cents, it.ot_cents, it.earnings_cents, it.deductions_cents, it.gross_cents, it.net_cents, it.currency, JSON.stringify(it.lines), it.timesheet_ids, `PS-${input.period_start.replace(/-/g, '').slice(2)}-${String(seq + k).padStart(4, '0')}`], db))[0];
    for (const e of it.earnings) {
      const er = (await q<any>(`INSERT INTO payroll_earnings (organization_id, payroll_item_id, kind, description, amount_cents) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, item.id, e.kind, e.description, e.amount_cents], db))[0];
      if (e.expense_id) {
        const upd = await q<any>(`UPDATE expenses SET payroll_item_id=$1, payroll_earning_id=$2, updated_at=now() WHERE id=$3 AND organization_id=$4 AND payroll_item_id IS NULL RETURNING id`, [item.id, er.id, e.expense_id, orgId], db);
        if (!upd.length) throw conflict('An expense was reimbursed by another run at the same time — refresh and try again');
      }
    }
    for (const d of it.deductions) await q(`INSERT INTO payroll_deductions (organization_id, payroll_item_id, kind, description, amount_cents) VALUES ($1,$2,$3,$4,$5)`, [orgId, item.id, d.kind, d.description, d.amount_cents], db);
    if (it.day_ids.length) {
      const upd = await q<any>(`UPDATE timesheet_days SET payroll_item_id=$1 WHERE id = ANY($2) AND payroll_item_id IS NULL RETURNING id`, [item.id, it.day_ids], db);
      if (upd.length !== it.day_ids.length) throw conflict('Some timesheet days were paid by another run at the same time — refresh and try again');
    }
    if (it.adjustment_ids.length) await q(`UPDATE timesheet_adjustments SET applied_payroll_run_id=$1 WHERE id = ANY($2)`, [run.id, it.adjustment_ids], db);
  }
  await q(`UPDATE timesheets SET payroll_run_id=$1 WHERE id = ANY($2) AND payroll_run_id IS NULL`, [run.id, [...new Set(pv.items.flatMap(i => i.timesheet_ids))]], db);
  return { run, existing: false };
}

/** Recomputes an item's earnings/deductions/gross/net and the run totals. */
export async function recomputeItem(db: Db, orgId: string, itemId: string) {
  const it = await one<any>(`SELECT * FROM payroll_items WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [itemId, orgId], db);
  if (!it) throw notFound();
  const e = Number((await one<any>(`SELECT COALESCE(sum(amount_cents),0)::bigint n FROM payroll_earnings WHERE payroll_item_id=$1`, [itemId], db))!.n);
  const d = Number((await one<any>(`SELECT COALESCE(sum(amount_cents),0)::bigint n FROM payroll_deductions WHERE payroll_item_id=$1`, [itemId], db))!.n);
  const gross = Number(it.regular_cents) + Number(it.ot_cents) + e;
  if (d > gross) throw badRequest('Deductions cannot exceed gross pay', { amount_cents: 'Exceeds gross pay' });
  await q(`UPDATE payroll_items SET earnings_cents=$2, deductions_cents=$3, gross_cents=$4, net_cents=$5 WHERE id=$1`, [itemId, e, d, gross, gross - d], db);
  await recomputeRun(db, orgId, it.run_id);
}
export async function recomputeRun(db: Db, orgId: string, runId: string) {
  return one<any>(`UPDATE payroll_runs r SET total_gross_cents=x.g, total_net_cents=x.n, worker_count=x.w, updated_at=now() FROM (SELECT COALESCE(sum(gross_cents),0) g, COALESCE(sum(net_cents),0) n, count(DISTINCT worker_id) w FROM payroll_items WHERE run_id=$1) x WHERE r.id=$1 AND r.organization_id=$2 RETURNING r.*`, [runId, orgId], db);
}

/** Deletes a not-yet-approved run and releases its timesheet days. */
export async function deleteRun(db: Db, orgId: string, runId: string) {
  const run = await one<any>(`SELECT * FROM payroll_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [runId, orgId], db);
  if (!run) throw notFound();
  if (!['calculated', 'review'].includes(run.status)) throw conflict('Only calculated or in-review runs can be discarded');
  await q(`UPDATE timesheet_days SET payroll_item_id=NULL WHERE payroll_item_id IN (SELECT id FROM payroll_items WHERE run_id=$1)`, [runId], db);
  await q(`UPDATE expenses SET payroll_item_id=NULL, payroll_earning_id=NULL, updated_at=now() WHERE payroll_item_id IN (SELECT id FROM payroll_items WHERE run_id=$1)`, [runId], db);
  await q(`UPDATE timesheet_adjustments SET applied_payroll_run_id=NULL WHERE applied_payroll_run_id=$1`, [runId], db);
  await q(`UPDATE timesheets SET payroll_run_id=NULL WHERE payroll_run_id=$1`, [runId], db);
  await q(`DELETE FROM payroll_runs WHERE id=$1`, [runId], db);
  return run;
}
