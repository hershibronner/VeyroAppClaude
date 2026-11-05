// FINANCE — payroll runs, payslips, payouts (simulated Wise), payroll overview, worker portal pay.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { allowedNext, addDays } from '@veyro/shared';
import { q, one, tx, pool } from '../core/db';
import { staff, auth, need, assertTransition, getOr404, can, redact, type Ctx } from '../core/context';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { getSetting, WEB_URL } from '../core/settings';
import { sendTemplate } from '../adapters/messaging';
import { publishOrg } from '../core/realtime';
import { submitBatch, schedule, retryItems, onPayoutItemFinal, onPayoutFinal } from '../adapters/payouts';
import { previewPayroll, createRun, recomputeItem, deleteRun } from './_finance/payroll';
import { lockTimesheets } from './_finance/invoices';
import { financeUsers, fmt, orgToday, periodFor, prevPeriod, nextPeriod, monthStart, monthEnd, addMonths, monthLabel, daysBetween, prettyDate, type Frequency } from './_finance/common';
import { payslipPdf } from './_finance/pdf';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const EDITABLE = ['calculated', 'review'];
const VISIBLE_TO_WORKER = ['approved', 'payment_initiated', 'paid', 'failed'];

async function payrollSettings(orgId: string) {
  const s = await getSetting<any>(orgId, 'payroll');
  return { frequency: (s.frequency ?? 'semi_monthly') as Frequency, offset: Number(s.pay_day_offset ?? 5), anchor: s.anchor_date ?? '2024-01-01' };
}

/** The period payroll is currently due for (oldest un-run period with approved unpaid time, else the current one). */
export async function duePeriod(orgId: string) {
  const s = await payrollSettings(orgId);
  const today = await orgToday(pool, orgId);
  const cur = periodFor(today, s.frequency, s.anchor);
  const runFor = (p: { start: string; end: string }) => one<any>(`SELECT * FROM payroll_runs WHERE organization_id=$1 AND period_start <= $3 AND period_end >= $2 ORDER BY created_at DESC LIMIT 1`, [orgId, p.start, p.end]);
  const unpaidIn = async (p: { start: string; end: string }) => (await one<any>(`SELECT count(*)::int n FROM timesheet_days d JOIN timesheets t ON t.id=d.timesheet_id WHERE d.organization_id=$1 AND d.payroll_item_id IS NULL AND t.status IN ('approved','locked') AND d.work_date BETWEEN $2 AND $3`, [orgId, p.start, p.end]))!.n;
  // A past period that still has approved time but no run is overdue; otherwise payroll is due for the current period.
  let pick = cur; let run: any = null;
  const p1 = prevPeriod(cur, s.frequency, s.anchor); const p2 = prevPeriod(p1, s.frequency, s.anchor);
  for (const p of [p2, p1]) if (!(await runFor(p)) && (await unpaidIn(p)) > 0) { pick = p; break; }
  if (pick === cur) { run = await runFor(cur); if (run?.status === 'paid') { pick = nextPeriod(cur, s.frequency, s.anchor); run = await runFor(pick); } }
  const payDate = run?.pay_date ?? addDays(pick.end, s.offset);
  const unpaid = await one<any>(`SELECT count(*)::int days, COALESCE(sum(d.minutes),0)::int minutes, count(DISTINCT d.placement_id)::int placements FROM timesheet_days d JOIN timesheets t ON t.id=d.timesheet_id WHERE d.organization_id=$1 AND d.payroll_item_id IS NULL AND t.status IN ('approved','locked') AND d.work_date BETWEEN $2 AND $3`, [orgId, pick.start, pick.end]);
  const pending = await one<any>(`SELECT count(*)::int n FROM timesheets WHERE organization_id=$1 AND status IN ('open','submitted','rejected') AND week_start <= $3 AND week_start + 6 >= $2`, [orgId, pick.start, pick.end]);
  return { frequency: s.frequency, period_start: pick.start, period_end: pick.end, pay_date: payDate, days_until_pay: daysBetween(today, payDate), today, run: run ? { id: run.id, status: run.status } : null, unpaid_minutes: unpaid!.minutes, unpaid_placements: unpaid!.placements, pending_timesheets: pending!.n };
}

function itemStatusSql() {
  return `COALESCE((SELECT x.status FROM payout_items x WHERE x.payroll_item_id=pi.id ORDER BY x.updated_at DESC LIMIT 1), CASE r.status WHEN 'paid' THEN 'paid' ELSE r.status END)`;
}

async function runDetail(ctx: Ctx, id: string) {
  const run = await one<any>(`SELECT r.*, cu.name created_by_name, au.name approved_by_name FROM payroll_runs r LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users au ON au.id=r.approved_by WHERE r.id=$1 AND r.organization_id=$2`, [id, ctx.orgId]);
  if (!run) throw notFound();
  const items = await q<any>(`SELECT pi.*, ${itemStatusSql()} pay_status, c.first_name || ' ' || COALESCE(c.last_name,'') worker_name, w.employee_code, w.payout_account_label, co.name company_name, p.title,
      (SELECT x.failure_reason FROM payout_items x WHERE x.payroll_item_id=pi.id ORDER BY x.updated_at DESC LIMIT 1) failure_reason,
      COALESCE((SELECT json_agg(e ORDER BY e.kind) FROM payroll_earnings e WHERE e.payroll_item_id=pi.id), '[]') earnings,
      COALESCE((SELECT json_agg(d ORDER BY d.kind) FROM payroll_deductions d WHERE d.payroll_item_id=pi.id), '[]') deductions
    FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id JOIN workers w ON w.id=pi.worker_id JOIN candidates c ON c.id=w.candidate_id LEFT JOIN companies co ON co.id=pi.company_id LEFT JOIN placements p ON p.id=pi.placement_id
    WHERE pi.run_id=$1 ORDER BY c.first_name, c.last_name`, [id]);
  const payouts = await q<any>(`SELECT p.*, (SELECT count(*)::int FROM payout_items i WHERE i.payout_id=p.id) items, (SELECT count(*)::int FROM payout_items i WHERE i.payout_id=p.id AND i.status='paid') paid_items, (SELECT count(*)::int FROM payout_items i WHERE i.payout_id=p.id AND i.status='failed') failed_items FROM payouts p WHERE p.run_id=$1 ORDER BY p.created_at DESC`, [id]);
  return { run: redact(ctx, run, 'payroll'), items: items.map(i => redact(ctx, i, 'payroll')), payouts, allowed: allowedNext('payroll_run', run.status), can: { edit: can(ctx, 'payroll', 'edit'), approve: can(ctx, 'payroll', 'approve'), payout: can(ctx, 'payouts', 'create') } };
}

async function startPayout(ctx: Ctx, runId: string) {
  const run = await getOr404<any>('payroll_runs', ctx, runId);
  const key = `payout:${runId}`;
  const existing = await one<any>(`SELECT * FROM payouts WHERE idempotency_key=$1`, [key]);
  if (existing) return { payout: existing, duplicate: true, run };
  assertTransition('payroll_run', run.status, 'payment_initiated');
  const items = await q<any>(`SELECT id, worker_id, net_cents, currency FROM payroll_items WHERE run_id=$1`, [runId]);
  const r = await tx(async c => {
    const b = await submitBatch(c, ctx.orgId, { kind: 'payroll', runId, idempotencyKey: key, currency: run.currency, items: items.map(i => ({ payroll_item_id: i.id, worker_id: i.worker_id, amount_cents: Number(i.net_cents), currency: i.currency })), actorId: ctx.userId });
    if (!b.duplicate) {
      await q(`UPDATE payroll_runs SET status='payment_initiated', updated_at=now() WHERE id=$1`, [runId], c);
      await activity(ctx, 'payroll_run', runId, 'status', `Payout batch submitted to Wise (${items.length} transfers, ${fmt(Number(b.payout.total_cents), run.currency)})`, null, { payout_id: b.payout.id }, c);
      await audit(ctx, 'payout.initiated', { type: 'payroll_run', id: runId, label: `${run.period_start} – ${run.period_end}` }, { status: run.status }, { status: 'payment_initiated', payout_id: b.payout.id, total_cents: b.payout.total_cents }, undefined, c);
    }
    return b;
  });
  if (!r.duplicate) await schedule(ctx.orgId, r.payout.id);
  publishOrg(ctx.orgId, 'payout', { id: r.payout.id, status: r.payout.status });
  return { ...r, run };
}

export default async function (app: FastifyInstance) {
  // ── Payout lifecycle hooks (simulated Wise callbacks) ──
  onPayoutItemFinal(async (orgId, item, payout) => {
    if (payout.kind !== 'payroll' || item.status !== 'paid' || !item.payroll_item_id) return;
    const it = await one<any>(`SELECT pi.*, r.period_start, r.period_end, w.user_id, c.first_name, c.email FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id JOIN workers w ON w.id=pi.worker_id JOIN candidates c ON c.id=w.candidate_id WHERE pi.id=$1`, [item.payroll_item_id]);
    if (!it) return;
    const period = `${prettyDate(it.period_start)} – ${prettyDate(it.period_end)}`;
    if (it.user_id) await notify(orgId, [it.user_id], { event: 'payslip_ready', title: `Your payslip for ${period} is ready`, body: `Net pay ${fmt(Number(it.net_cents), it.currency)} has been sent to your payout account.`, link: '/portal/worker/pay' });
    if (it.email) await sendTemplate(orgId, 'payslip_ready', it.email, { worker: { firstName: it.first_name }, period, net: fmt(Number(it.net_cents), it.currency), link: `${WEB_URL}/portal/worker/pay` }, { related: { type: 'worker', id: it.worker_id } });
  });
  onPayoutFinal(async (orgId, payout, items) => {
    if (payout.kind !== 'payroll' || !payout.run_id) return;
    const run = await one<any>(`SELECT * FROM payroll_runs WHERE id=$1`, [payout.run_id]);
    if (!run || run.status !== 'payment_initiated') return;
    const failed = items.filter(i => i.status === 'failed');
    const sys = { orgId, userId: null, user: { id: '', name: 'Wise (simulated)', email: '', avatar_color: null }, impersonatorId: null, ip: '' } as any;
    if (!failed.length) {
      await q(`UPDATE payroll_runs SET status='paid', paid_at=now(), updated_at=now() WHERE id=$1`, [run.id]);
      await activity({ orgId, userId: null }, 'payroll_run', run.id, 'status', `Payroll ${run.period_start} – ${run.period_end} paid`, `${items.length} transfers completed`);
      const ts = (await q<any>(`SELECT DISTINCT d.timesheet_id FROM timesheet_days d JOIN payroll_items pi ON pi.id=d.payroll_item_id WHERE pi.run_id=$1`, [run.id])).map(r => r.timesheet_id);
      await lockTimesheets(pool, orgId, ts);
      await notify(orgId, await financeUsers(orgId), { event: 'payroll.paid', title: `Payroll ${prettyDate(run.period_start)} – ${prettyDate(run.period_end)} paid`, body: `${items.length} workers paid ${fmt(Number(payout.total_cents), payout.currency)}`, link: `/finance/payroll/${run.id}` });
      await emit(orgId, 'payroll.paid', { run_id: run.id, period_start: run.period_start, period_end: run.period_end, total_cents: payout.total_cents });
    } else {
      await q(`UPDATE payroll_runs SET status='failed', updated_at=now() WHERE id=$1`, [run.id]);
      const names = await q<any>(`SELECT c.first_name || ' ' || COALESCE(c.last_name,'') n, w.id worker_id FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.id = ANY($1)`, [failed.map(f => f.worker_id)]);
      await activity({ orgId, userId: null }, 'payroll_run', run.id, 'status', `${failed.length} payout(s) failed`, failed.map(f => f.failure_reason).join('; '));
      await audit(sys, 'payout.failed', { type: 'payout', id: payout.id, label: `${run.period_start} – ${run.period_end}` }, undefined, { failed: failed.length, workers: names.map(n => n.n) });
      await notify(orgId, await financeUsers(orgId), { event: 'payout.failed', title: `${failed.length} payout${failed.length > 1 ? 's' : ''} failed`, body: `${names.map(n => n.n).join(', ')} — ${failed[0].failure_reason}. Retry from the payout batch.`, link: `/finance/payouts/${payout.id}` });
      for (const f of failed) await emit(orgId, 'payout.failed', { payout_id: payout.id, payout_item_id: f.id, run_id: run.id, worker_id: f.worker_id, worker_name: names.find(n => n.worker_id === f.worker_id)?.n, amount_cents: f.amount_cents, reason: f.failure_reason });
    }
    publishOrg(orgId, 'payout', { id: payout.id, run_id: run.id, status: payout.status });
  });

  // ── Overview (Humaine-style Payroll Overview) ──
  app.get('/api/v1/payroll/overview', async (req) => {
    const ctx = staff(req); need(ctx, 'payroll', 'view');
    const qs = req.query as { months?: string; month?: string; dist_months?: string };
    const months = Math.min(24, Math.max(3, Number(qs.months) || 6));
    const distMonths = Math.min(24, Math.max(1, Number(qs.dist_months) || months));
    const due = await duePeriod(ctx.orgId);
    const month = qs.month && /^\d{4}-\d{2}$/.test(qs.month) ? qs.month + '-01' : monthStart(due.today);
    const prevM = addMonths(month, -1);
    const kpi = async (ms: string) => one<any>(`SELECT COALESCE(sum(pi.gross_cents),0)::bigint total, COALESCE(sum(pi.net_cents) FILTER (WHERE ${itemStatusSql()}='paid'),0)::bigint paid_net,
        count(DISTINCT pi.worker_id) FILTER (WHERE ${itemStatusSql()}='paid')::int employees_paid, count(DISTINCT pi.worker_id)::int employees
      FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id WHERE r.organization_id=$1 AND r.period_end BETWEEN $2 AND $3`, [ctx.orgId, ms, monthEnd(ms)]);
    const [cur, prev] = [await kpi(month), await kpi(prevM)];
    const avg = (k: any) => (k.employees_paid ? Math.round(Number(k.paid_net) / k.employees_paid) : 0);
    const delta = (a: number, b: number) => (b ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null);
    const from = addMonths(monthStart(due.today), -(months - 1));
    const trendRows = await q<any>(`SELECT to_char(date_trunc('month', r.period_end), 'YYYY-MM-DD') m, sum(pi.gross_cents)::bigint gross, sum(pi.net_cents)::bigint net, count(DISTINCT pi.worker_id)::int workers FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id WHERE r.organization_id=$1 AND r.period_end >= $2 GROUP BY 1`, [ctx.orgId, from]);
    const trend = Array.from({ length: months }, (_, i) => { const m = addMonths(from, i); const r = trendRows.find(x => x.m === m); return { month: m, label: monthLabel(m), value: Number(r?.gross ?? 0), net: Number(r?.net ?? 0), workers: r?.workers ?? 0 }; });
    const dFrom = addMonths(monthStart(due.today), -(distMonths - 1));
    const dist = await q<any>(`SELECT co.id company_id, co.name label, sum(pi.gross_cents)::bigint value, count(DISTINCT pi.worker_id)::int workers FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id JOIN companies co ON co.id=pi.company_id WHERE r.organization_id=$1 AND r.period_end >= $2 GROUP BY co.id, co.name ORDER BY value DESC`, [ctx.orgId, dFrom]);
    const top = dist.slice(0, 7).map(d => ({ ...d, value: Number(d.value) }));
    const rest = dist.slice(7);
    if (rest.length) top.push({ company_id: null, label: `Other (${rest.length})`, value: rest.reduce((a, d) => a + Number(d.value), 0), workers: rest.reduce((a, d) => a + d.workers, 0) });
    const actions = await one<any>(`SELECT count(*) FILTER (WHERE status IN ('calculated','review'))::int to_review, count(*) FILTER (WHERE status='approved')::int to_pay, count(*) FILTER (WHERE status='failed')::int failed FROM payroll_runs WHERE organization_id=$1`, [ctx.orgId]);
    const failedPayouts = await one<any>(`SELECT count(*)::int n FROM payout_items WHERE organization_id=$1 AND status='failed'`, [ctx.orgId]);
    return {
      due, month, actions: { ...actions, failed_payout_items: failedPayouts!.n },
      kpis: {
        total_payroll: { value: Number(cur!.total), prev: Number(prev!.total), delta: delta(Number(cur!.total), Number(prev!.total)) },
        employees_paid: { value: cur!.employees_paid, of: cur!.employees, prev: prev!.employees_paid, delta: delta(cur!.employees_paid, prev!.employees_paid) },
        average_pay: { value: avg(cur), prev: avg(prev), delta: delta(avg(cur), avg(prev)) },
      },
      trend, distribution: top, distribution_months: distMonths, months,
    };
  });

  app.get('/api/v1/payroll/next-period', async (req) => { const ctx = staff(req); need(ctx, 'payroll', 'view'); return duePeriod(ctx.orgId); });

  app.post('/api/v1/payroll/preview', async (req) => {
    const ctx = staff(req); need(ctx, 'payroll', 'create');
    const b = z.object({ period_start: date, period_end: date }).parse(req.body);
    const existing = await one<any>(`SELECT id, status FROM payroll_runs WHERE organization_id=$1 AND idempotency_key=$2`, [ctx.orgId, `payroll:${b.period_start}:${b.period_end}`]);
    const pv = await previewPayroll(pool, ctx.orgId, b.period_start, b.period_end);
    const s = await payrollSettings(ctx.orgId);
    return { ...pv, existing_run: existing, pay_date: addDays(b.period_end, s.offset), frequency: s.frequency, items: pv.items.map(i => ({ ...i, day_ids: undefined, id: i.placement_id })) };
  });

  app.get('/api/v1/payroll/runs', async (req) => {
    const ctx = staff(req); need(ctx, 'payroll', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId]; const where = ['r.organization_id=$1'];
    if (f.status === 'open') where.push(`r.status IN ('calculated','review','approved','payment_initiated','failed')`);
    else if (f.status) { params.push(f.status); where.push(`r.status=$${params.length}`); }
    if (f.from) { params.push(f.from); where.push(`r.period_end >= $${params.length}`); }
    if (f.to) { params.push(f.to); where.push(`r.period_end <= $${params.length}`); }
    const res = await paged({
      select: `r.*, u.name approved_by_name, (SELECT status FROM payouts p WHERE p.run_id=r.id ORDER BY created_at DESC LIMIT 1) payout_status, (SELECT id FROM payouts p WHERE p.run_id=r.id ORDER BY created_at DESC LIMIT 1) payout_id,
        (SELECT count(*)::int FROM payout_items x JOIN payouts p ON p.id=x.payout_id WHERE p.run_id=r.id AND x.status='failed') failed_items, (SELECT COALESCE(sum(regular_minutes+ot_minutes),0)::int FROM payroll_items i WHERE i.run_id=r.id) minutes`,
      from: `payroll_runs r LEFT JOIN users u ON u.id=r.approved_by`, where, params, lp, searchCols: ['r.idempotency_key', 'r.status'],
      sortMap: { period_start: 'r.period_start', pay_date: 'r.pay_date', total_gross_cents: 'r.total_gross_cents', total_net_cents: 'r.total_net_cents', worker_count: 'r.worker_count', status: 'r.status' }, defaultSort: 'r.period_start DESC',
    });
    return { ...res, rows: res.rows.map(r => redact(ctx, r, 'payroll')) };
  });

  app.post('/api/v1/payroll/runs', async (req) => {
    const ctx = staff(req); need(ctx, 'payroll', 'create');
    const b = z.object({ period_start: date, period_end: date, pay_date: date.nullable().optional(), notes: z.string().max(1000).nullable().optional() }).parse(req.body);
    const s = await payrollSettings(ctx.orgId);
    const r = await tx(async c => {
      const res = await createRun(c, ctx.orgId, ctx.userId, { ...b, frequency: s.frequency });
      if (!res.existing) {
        await activity(ctx, 'payroll_run', res.run.id, 'status', `Payroll calculated for ${b.period_start} – ${b.period_end}`, `${res.run.worker_count} workers · gross ${fmt(Number(res.run.total_gross_cents), res.run.currency)}`, {}, c);
        await audit(ctx, 'payroll.calculated', { type: 'payroll_run', id: res.run.id, label: `${b.period_start} – ${b.period_end}` }, undefined, { total_gross_cents: res.run.total_gross_cents, total_net_cents: res.run.total_net_cents, worker_count: res.run.worker_count, idempotency_key: res.run.idempotency_key }, undefined, c);
      }
      return res;
    });
    return { run: redact(ctx, r.run, 'payroll'), existing: r.existing };
  });

  app.get('/api/v1/payroll/runs/:id', async (req) => { const ctx = staff(req); need(ctx, 'payroll', 'view'); return runDetail(ctx, (req.params as any).id); });

  const transition = (path: string, to: string, perm: 'edit' | 'approve', label: string, auditAction?: string) => app.post(`/api/v1/payroll/runs/:id/${path}`, async (req) => {
    const ctx = staff(req); need(ctx, 'payroll', perm);
    const { id } = req.params as { id: string };
    const run = await getOr404<any>('payroll_runs', ctx, id);
    assertTransition('payroll_run', run.status, to);
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    const upd = await tx(async c => {
      const r = await one<any>(`UPDATE payroll_runs SET status=$2, approved_by=CASE WHEN $2='approved' THEN $3::uuid ELSE approved_by END, approved_at=CASE WHEN $2='approved' THEN now() ELSE approved_at END, updated_at=now() WHERE id=$1 RETURNING *`, [id, to, ctx.userId], c);
      await activity(ctx, 'payroll_run', id, 'status', `${label} (${run.period_start} – ${run.period_end})`, reason ?? null, {}, c);
      if (auditAction) await audit(ctx, auditAction, { type: 'payroll_run', id, label: `${run.period_start} – ${run.period_end}` }, { status: run.status }, { status: to, total_net_cents: run.total_net_cents, worker_count: run.worker_count }, reason, c);
      return r;
    });
    if (to === 'approved') {
      await notify(ctx.orgId, (await financeUsers(ctx.orgId)).filter(u => u !== ctx.userId), { event: 'payroll.approved', title: `Payroll approved: ${prettyDate(run.period_start)} – ${prettyDate(run.period_end)}`, body: `${ctx.user.name} approved ${run.worker_count} payslips, net ${fmt(Number(run.total_net_cents), run.currency)}`, link: `/finance/payroll/${id}` });
      await emit(ctx.orgId, 'payroll.approved', { run_id: id, period_start: run.period_start, period_end: run.period_end, total_net_cents: run.total_net_cents, approved_by: ctx.userId });
    }
    return { run: upd };
  });
  transition('submit', 'review', 'edit', 'Payroll submitted for review');
  transition('send-back', 'calculated', 'edit', 'Payroll sent back to calculated');
  transition('approve', 'approved', 'approve', 'Payroll approved', 'payroll.approved');

  app.delete('/api/v1/payroll/runs/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'payroll', 'delete');
    const { id } = req.params as { id: string };
    await getOr404('payroll_runs', ctx, id);
    const run = await tx(async c => { const r = await deleteRun(c, ctx.orgId, id); await audit(ctx, 'payroll.discarded', { type: 'payroll_run', id, label: `${r.period_start} – ${r.period_end}` }, { status: r.status, total_net_cents: r.total_net_cents }, undefined, 'Discarded before approval; timesheet days released', c); return r; });
    return { ok: true, period_start: run.period_start, period_end: run.period_end };
  });

  // Earnings / deductions on an item (bonus, commission, reimbursement, leave pay; advance, equipment, other).
  const adj = z.object({ kind: z.string(), description: z.string().trim().min(2, 'Add a short description').max(200), amount_cents: z.number().int().positive('Amount must be positive') });
  for (const [table, kinds] of [['payroll_earnings', ['bonus', 'commission', 'reimbursement', 'leave_pay', 'adjustment']], ['payroll_deductions', ['advance', 'equipment', 'other', 'adjustment']]] as const) {
    const path = table === 'payroll_earnings' ? 'earnings' : 'deductions';
    app.post(`/api/v1/payroll/runs/:id/items/:itemId/${path}`, async (req) => {
      const ctx = staff(req); need(ctx, 'payroll', 'edit');
      const { id, itemId } = req.params as { id: string; itemId: string };
      const run = await getOr404<any>('payroll_runs', ctx, id);
      if (!EDITABLE.includes(run.status)) throw conflict('Earnings and deductions can only change before approval');
      const b = adj.parse(req.body);
      if (!(kinds as readonly string[]).includes(b.kind)) throw badRequest('Unknown type', { kind: `Use one of: ${kinds.join(', ')}` });
      const item = await one<any>(`SELECT * FROM payroll_items WHERE id=$1 AND run_id=$2`, [itemId, id]);
      if (!item) throw notFound();
      await tx(async c => {
        await q(`INSERT INTO ${table} (organization_id, payroll_item_id, kind, description, amount_cents) VALUES ($1,$2,$3,$4,$5)`, [ctx.orgId, itemId, b.kind, b.description, b.amount_cents], c);
        await recomputeItem(c, ctx.orgId, itemId);
        await activity(ctx, 'payroll_run', id, 'system', `${path === 'earnings' ? 'Added' : 'Deducted'} ${b.kind.replace('_', ' ')} ${fmt(b.amount_cents)}: ${b.description}`, null, { item_id: itemId }, c);
        await audit(ctx, `payroll.${path}.added`, { type: 'payroll_run', id, label: `${run.period_start} – ${run.period_end}` }, undefined, { item_id: itemId, ...b }, undefined, c);
      });
      return runDetail(ctx, id);
    });
    app.delete(`/api/v1/payroll/runs/:id/${path}/:rowId`, async (req) => {
      const ctx = staff(req); need(ctx, 'payroll', 'edit');
      const { id, rowId } = req.params as { id: string; rowId: string };
      const run = await getOr404<any>('payroll_runs', ctx, id);
      if (!EDITABLE.includes(run.status)) throw conflict('Earnings and deductions can only change before approval');
      await tx(async c => {
        const row = await one<any>(`DELETE FROM ${table} t USING payroll_items pi WHERE t.id=$1 AND pi.id=t.payroll_item_id AND pi.run_id=$2 RETURNING t.*`, [rowId, id], c);
        if (!row) throw notFound();
        // Removing an expense reimbursement releases the expense so it is picked up by the next run.
        if (table === 'payroll_earnings') await q(`UPDATE expenses SET payroll_item_id=NULL, payroll_earning_id=NULL, updated_at=now() WHERE payroll_earning_id=$1 AND organization_id=$2`, [row.id, ctx.orgId], c);
        await recomputeItem(c, ctx.orgId, row.payroll_item_id);
        await activity(ctx, 'payroll_run', id, 'system', `Removed ${row.kind.replace('_', ' ')} ${fmt(Number(row.amount_cents))}: ${row.description ?? ''}`, null, {}, c);
      });
      return runDetail(ctx, id);
    });
  }

  app.post('/api/v1/payroll/runs/:id/payout', async (req) => {
    const ctx = staff(req); need(ctx, 'payouts', 'create');
    const r = await startPayout(ctx, (req.params as any).id);
    return { payout: r.payout, duplicate: r.duplicate };
  });

  // Payroll List (items across runs)
  app.get('/api/v1/payroll/items', async (req) => {
    const ctx = staff(req); need(ctx, 'payroll', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId]; const where = ['pi.organization_id=$1'];
    if (f.run_id) { params.push(f.run_id); where.push(`pi.run_id=$${params.length}`); }
    if (f.company_id) { params.push(f.company_id); where.push(`pi.company_id=$${params.length}`); }
    if (f.worker_id) { params.push(f.worker_id); where.push(`pi.worker_id=$${params.length}`); }
    if (f.from) { params.push(f.from); where.push(`r.period_end >= $${params.length}`); }
    if (f.to) { params.push(f.to); where.push(`r.period_end <= $${params.length}`); }
    if (f.month && /^\d{4}-\d{2}$/.test(f.month)) { params.push(f.month + '-01'); where.push(`r.period_end BETWEEN $${params.length}::date AND ($${params.length}::date + interval '1 month' - interval '1 day')::date`); }
    if (f.status) { params.push(f.status); where.push(`${itemStatusSql()}=$${params.length}`); }
    const res = await paged({
      select: `pi.id, pi.run_id, pi.worker_id, pi.company_id, pi.regular_minutes, pi.ot_minutes, pi.regular_cents, pi.ot_cents, pi.earnings_cents, pi.deductions_cents, pi.gross_cents, pi.net_cents, pi.currency, pi.payslip_number,
        r.period_start, r.period_end, r.pay_date, r.status run_status, ${itemStatusSql()} status, c.first_name || ' ' || COALESCE(c.last_name,'') worker_name, w.employee_code, co.name company_name, p.title`,
      from: `payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id JOIN workers w ON w.id=pi.worker_id JOIN candidates c ON c.id=w.candidate_id LEFT JOIN companies co ON co.id=pi.company_id LEFT JOIN placements p ON p.id=pi.placement_id`,
      where, params, lp, searchCols: ['c.first_name', 'c.last_name', 'co.name', 'w.employee_code', 'pi.payslip_number', 'p.title'],
      sortMap: { worker_name: 'c.first_name', company_name: 'co.name', period_start: 'r.period_start', pay_date: 'r.pay_date', gross_cents: 'pi.gross_cents', net_cents: 'pi.net_cents', hours: '(pi.regular_minutes+pi.ot_minutes)' }, defaultSort: 'r.period_start DESC, c.first_name',
    });
    return { ...res, rows: res.rows.map(r => redact(ctx, r, 'payroll')) };
  });

  app.get('/api/v1/payroll/items/:id/payslip', async (req, reply) => {
    const ctx = staff(req); need(ctx, 'payroll', 'view');
    const { id } = req.params as { id: string };
    await getOr404('payroll_items', ctx, id);
    const pdf = await payslipPdf(pool, ctx.orgId, id);
    return reply.type('application/pdf').header('content-disposition', `${(req.query as any).download ? 'attachment' : 'inline'}; filename="${pdf.filename}"`).send(pdf.buffer);
  });

  app.post('/api/v1/payroll/items/:id/send-payslip', async (req) => {
    const ctx = staff(req); need(ctx, 'payroll', 'edit');
    const { id } = req.params as { id: string };
    await getOr404('payroll_items', ctx, id);
    const it = await one<any>(`SELECT pi.*, r.period_start, r.period_end, r.status run_status, w.user_id, c.first_name, c.email FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id JOIN workers w ON w.id=pi.worker_id JOIN candidates c ON c.id=w.candidate_id WHERE pi.id=$1`, [id]);
    if (!VISIBLE_TO_WORKER.includes(it.run_status)) throw conflict('Approve the payroll run before sending payslips');
    const period = `${prettyDate(it.period_start)} – ${prettyDate(it.period_end)}`;
    if (it.user_id) await notify(ctx.orgId, [it.user_id], { event: 'payslip_ready', title: `Your payslip for ${period} is ready`, body: `Net pay ${fmt(Number(it.net_cents), it.currency)}`, link: '/portal/worker/pay' });
    if (!it.email && !it.user_id) throw conflict('This worker has no email or portal account');
    if (it.email) await sendTemplate(ctx.orgId, 'payslip_ready', it.email, { worker: { firstName: it.first_name }, period, net: fmt(Number(it.net_cents), it.currency), link: `${WEB_URL}/portal/worker/pay` }, { related: { type: 'worker', id: it.worker_id } });
    await activity(ctx, 'payroll_run', it.run_id, 'email', `Payslip ${it.payslip_number ?? ''} sent to ${it.email ?? 'worker portal'}`);
    return { ok: true, sent_to: it.email };
  });

  // ── Payouts ──
  app.get('/api/v1/payouts', async (req) => {
    const ctx = staff(req); need(ctx, 'payouts', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId]; const where = ['p.organization_id=$1'];
    if (f.status) { params.push(f.status); where.push(`p.status=$${params.length}`); }
    if (f.kind) { params.push(f.kind); where.push(`p.kind=$${params.length}`); }
    if (f.has_failed === 'true') where.push(`EXISTS (SELECT 1 FROM payout_items x WHERE x.payout_id=p.id AND x.status='failed')`);
    return paged({
      select: `p.*, r.period_start, r.period_end, u.name initiated_by_name, (SELECT count(*)::int FROM payout_items x WHERE x.payout_id=p.id) items, (SELECT count(*)::int FROM payout_items x WHERE x.payout_id=p.id AND x.status='paid') paid_items, (SELECT count(*)::int FROM payout_items x WHERE x.payout_id=p.id AND x.status='failed') failed_items`,
      from: `payouts p LEFT JOIN payroll_runs r ON r.id=p.run_id LEFT JOIN users u ON u.id=p.initiated_by`, where, params, lp, searchCols: ['p.idempotency_key', 'p.status', 'p.kind'],
      sortMap: { created_at: 'p.created_at', total_cents: 'p.total_cents', status: 'p.status' }, defaultSort: 'p.created_at DESC',
    });
  });

  app.get('/api/v1/payouts/simulation', async (req) => {
    const ctx = staff(req); need(ctx, 'payouts', 'view');
    const i = await one<any>(`SELECT status, provider, config, last_sync_at FROM integrations WHERE organization_id=$1 AND key='payouts'`, [ctx.orgId]);
    return { status: i?.status ?? 'connected', provider: i?.provider ?? 'Wise (simulated)', failure_rate: Number(i?.config?.failure_rate ?? 0.08), last_sync_at: i?.last_sync_at ?? null };
  });
  app.put('/api/v1/payouts/simulation', async (req) => {
    const ctx = staff(req); need(ctx, 'payouts', 'edit');
    const { failure_rate } = z.object({ failure_rate: z.number().min(0).max(1) }).parse(req.body);
    const before = await one<any>(`SELECT config FROM integrations WHERE organization_id=$1 AND key='payouts'`, [ctx.orgId]);
    await q(`UPDATE integrations SET config = config || jsonb_build_object('failure_rate', $2::float), updated_at=now() WHERE organization_id=$1 AND key='payouts'`, [ctx.orgId, failure_rate]);
    await audit(ctx, 'payouts.simulation_changed', { type: 'integration', label: 'Wise (simulated)' }, { failure_rate: before?.config?.failure_rate ?? 0.08 }, { failure_rate });
    return { failure_rate };
  });

  app.get('/api/v1/payouts/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'payouts', 'view');
    const { id } = req.params as { id: string };
    const p = await one<any>(`SELECT p.*, r.period_start, r.period_end, r.status run_status, u.name initiated_by_name FROM payouts p LEFT JOIN payroll_runs r ON r.id=p.run_id LEFT JOIN users u ON u.id=p.initiated_by WHERE p.id=$1 AND p.organization_id=$2`, [id, ctx.orgId]);
    if (!p) throw notFound();
    const items = await q<any>(`SELECT i.*, COALESCE(c.first_name || ' ' || COALESCE(c.last_name,''), su.name) payee_name, w.payout_account_label, w.employee_code, pi.payslip_number
      FROM payout_items i LEFT JOIN workers w ON w.id=i.worker_id LEFT JOIN candidates c ON c.id=w.candidate_id LEFT JOIN users su ON su.id=i.user_id LEFT JOIN payroll_items pi ON pi.id=i.payroll_item_id WHERE i.payout_id=$1 ORDER BY payee_name`, [id]);
    const logs = await q<any>(`SELECT * FROM integration_logs WHERE organization_id=$1 AND integration_key='payouts' AND meta->>'payout_id'=$2 ORDER BY created_at DESC LIMIT 100`, [ctx.orgId, id]);
    return { payout: p, items, logs, can: { retry: can(ctx, 'payouts', 'create') } };
  });

  app.post('/api/v1/payouts/:id/retry', async (req) => {
    const ctx = staff(req); need(ctx, 'payouts', 'create');
    const { id } = req.params as { id: string };
    const p = await getOr404<any>('payouts', ctx, id);
    const { item_ids } = z.object({ item_ids: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});
    const n = await tx(async c => {
      const n = await retryItems(c, ctx.orgId, id, item_ids);
      if (p.run_id) {
        const run = await one<any>(`SELECT * FROM payroll_runs WHERE id=$1`, [p.run_id], c);
        if (run?.status === 'failed') { assertTransition('payroll_run', 'failed', 'payment_initiated'); await q(`UPDATE payroll_runs SET status='payment_initiated', updated_at=now() WHERE id=$1`, [p.run_id], c); }
        await activity(ctx, 'payroll_run', p.run_id, 'status', `Retrying ${n} failed payout(s)`, null, { payout_id: id }, c);
      }
      await audit(ctx, 'payout.retried', { type: 'payout', id, label: p.idempotency_key }, undefined, { items: n }, undefined, c);
      return n;
    });
    await schedule(ctx.orgId, id);
    publishOrg(ctx.orgId, 'payout', { id, status: 'processing' });
    return { retried: n };
  });

  // ── Worker portal: Pay & Payslips ──
  function workerCtx(req: any) { const ctx = auth(req); if (ctx.role.kind !== 'worker' || !ctx.workerId) throw notFound(); return ctx; }

  app.get('/api/v1/portal/worker/pay', async (req) => {
    const ctx = workerCtx(req);
    const today = await orgToday(pool, ctx.orgId);
    const items = await q<any>(`SELECT pi.id, pi.payslip_number, pi.regular_minutes, pi.ot_minutes, pi.regular_cents, pi.ot_cents, pi.earnings_cents, pi.deductions_cents, pi.gross_cents, pi.net_cents, pi.currency, r.period_start, r.period_end, r.pay_date, ${itemStatusSql()} status, co.name company_name, p.title,
        (SELECT x.failure_reason FROM payout_items x WHERE x.payroll_item_id=pi.id ORDER BY x.updated_at DESC LIMIT 1) failure_reason
      FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id LEFT JOIN companies co ON co.id=pi.company_id LEFT JOIN placements p ON p.id=pi.placement_id
      WHERE pi.organization_id=$1 AND pi.worker_id=$2 AND r.status = ANY($3) ORDER BY r.period_start DESC`, [ctx.orgId, ctx.workerId, VISIBLE_TO_WORKER]);
    const year = today.slice(0, 4);
    const ytdRows = items.filter(i => i.period_start.startsWith(year));
    const unpaid = await one<any>(`SELECT COALESCE(sum(d.minutes),0)::int minutes, count(*)::int days FROM timesheet_days d JOIN timesheets t ON t.id=d.timesheet_id JOIN placements p ON p.id=d.placement_id WHERE d.organization_id=$1 AND p.worker_id=$2 AND d.payroll_item_id IS NULL AND t.status IN ('approved','locked')`, [ctx.orgId, ctx.workerId]);
    const w = await one<any>(`SELECT payout_method, payout_account_label, employee_code FROM workers WHERE id=$1`, [ctx.workerId]);
    const due = await duePeriod(ctx.orgId);
    return {
      ytd: { year, gross_cents: ytdRows.reduce((a, i) => a + Number(i.gross_cents), 0), net_cents: ytdRows.reduce((a, i) => a + Number(i.net_cents), 0), minutes: ytdRows.reduce((a, i) => a + i.regular_minutes + i.ot_minutes, 0), payslips: ytdRows.length },
      last: items[0] ?? null, approved_unpaid_minutes: unpaid!.minutes, next_pay_date: due.pay_date, next_period: { start: due.period_start, end: due.period_end },
      payout: { method: w?.payout_method ?? 'wise', account_label: w?.payout_account_label ?? null, employee_code: w?.employee_code ?? null },
      payslips: items,
    };
  });

  app.get('/api/v1/portal/worker/pay/payslips/:id/pdf', async (req, reply) => {
    const ctx = workerCtx(req);
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const it = await one<any>(`SELECT pi.id FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id WHERE pi.id=$1 AND pi.organization_id=$2 AND pi.worker_id=$3 AND r.status = ANY($4)`, [id, ctx.orgId, ctx.workerId, VISIBLE_TO_WORKER]);
    if (!it) throw notFound();
    const pdf = await payslipPdf(pool, ctx.orgId, id);
    return reply.type('application/pdf').header('content-disposition', `${(req.query as any).download ? 'attachment' : 'inline'}; filename="${pdf.filename}"`).send(pdf.buffer);
  });
}
