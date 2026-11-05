// FINANCE — effective-dated placement rates (CONTRACTS §6). Any change = new row + audit; never overwrite past economics.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { planRateInsert, grossMargin } from '@veyro/shared';
import { q, one, tx, pool } from '../core/db';
import { staff, need, canViewComp, redact, getOr404, type Ctx } from '../core/context';
import { badRequest, conflict } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { financeUsers, fmt, orgToday } from './_finance/common';

const rateBody = z.object({
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date'),
  pay_rate_cents: z.number().int().positive('Pay rate must be positive'),
  bill_rate_cents: z.number().int().positive('Bill rate must be positive'),
  currency: z.string().length(3).optional(),
  unit: z.enum(['hour', 'day', 'week', 'month']).optional(),
  ot_multiplier_bp: z.number().int().min(10000).max(30000).optional(),
  ot_threshold_minutes: z.number().int().min(0).max(10080).optional(),
  reason: z.string().trim().min(3, 'Give a short reason (it is audited)').max(500),
});

function withMargin(r: any) { const gm = grossMargin(Number(r.bill_rate_cents), Number(r.pay_rate_cents)); return { ...r, margin_cents: gm.gpCents, margin_pct: gm.marginPct }; }
function stripRate(ctx: Ctx, r: any) { const out = redact(ctx, r); if (!canViewComp(ctx)) { delete out.margin_cents; delete out.margin_pct; } return out; }

export async function createRate(db: any, ctx: Pick<Ctx, 'orgId' | 'userId'>, placementId: string, body: z.infer<typeof rateBody>) {
  const p = await one<any>(`SELECT * FROM placements WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [placementId, ctx.orgId], db);
  if (!p) throw badRequest('Placement not found');
  if (body.effective_from < p.start_date) throw badRequest(`Rates cannot start before the placement start date (${p.start_date})`, { effective_from: 'Before placement start' });
  const existing = await q<any>(`SELECT * FROM placement_rates WHERE placement_id=$1 ORDER BY effective_from`, [placementId], db);
  let plan;
  try { plan = planRateInsert(existing.map(r => ({ id: r.id, effectiveFrom: r.effective_from, effectiveTo: r.effective_to })), body.effective_from); }
  catch (e: any) { throw conflict(e.message); }
  const prior = plan.closeId ? existing.find(r => r.id === plan.closeId) : existing.at(-1);
  if (plan.closeId) await q(`UPDATE placement_rates SET effective_to=$2 WHERE id=$1`, [plan.closeId, plan.closeAt], db);
  const row = (await q<any>(`INSERT INTO placement_rates (organization_id, placement_id, effective_from, effective_to, pay_rate_cents, bill_rate_cents, currency, unit, ot_multiplier_bp, ot_threshold_minutes, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [ctx.orgId, placementId, body.effective_from, plan.newTo, body.pay_rate_cents, body.bill_rate_cents, body.currency ?? prior?.currency ?? 'USD', body.unit ?? prior?.unit ?? 'hour', body.ot_multiplier_bp ?? prior?.ot_multiplier_bp ?? 15000, body.ot_threshold_minutes ?? prior?.ot_threshold_minutes ?? 2400, body.reason, ctx.userId], db))[0];
  const touched = await one<any>(`SELECT count(*) FILTER (WHERE invoice_id IS NOT NULL)::int invoiced, count(*) FILTER (WHERE payroll_item_id IS NOT NULL)::int paid FROM timesheet_days WHERE placement_id=$1 AND work_date >= $2 ${plan.newTo ? 'AND work_date <= $3' : ''}`, plan.newTo ? [placementId, body.effective_from, plan.newTo] : [placementId, body.effective_from], db);
  return { rate: row, prior: prior ?? null, placement: p, already_invoiced_days: touched!.invoiced, already_paid_days: touched!.paid };
}

export default async function (app: FastifyInstance) {
  // Org-wide current rates (one row per placement).
  app.get('/api/v1/rates', async (req) => {
    const ctx = staff(req); need(ctx, 'rates', 'view');
    const lp = listParams(req);
    const today = await orgToday(pool, ctx.orgId);
    const params: unknown[] = [ctx.orgId, today]; const where = ['p.organization_id = $1'];
    if (lp.filters.company_id) { params.push(lp.filters.company_id); where.push(`p.company_id = $${params.length}`); }
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`p.status = $${params.length}`); }
    else where.push(`p.status <> 'ended'`);
    if (lp.filters.changed === 'recent') where.push(`r.effective_from >= $2::date - 90`);
    const res = await paged({
      select: `p.id, p.id placement_id, p.title, p.status, p.start_date, co.id company_id, co.name company_name, c.first_name || ' ' || COALESCE(c.last_name,'') worker_name, w.id worker_id, am.name account_manager_name,
        r.id rate_id, r.effective_from, r.effective_to, r.pay_rate_cents, r.bill_rate_cents, r.currency, r.unit, r.ot_multiplier_bp, r.ot_threshold_minutes,
        (SELECT count(*)::int FROM placement_rates x WHERE x.placement_id=p.id) rate_count,
        (SELECT min(effective_from) FROM placement_rates x WHERE x.placement_id=p.id AND x.effective_from > GREATEST($2::date, r.effective_from)) next_change`,
      from: `placements p JOIN workers w ON w.id=p.worker_id JOIN candidates c ON c.id=w.candidate_id JOIN companies co ON co.id=p.company_id LEFT JOIN users am ON am.id=p.account_manager_id
        LEFT JOIN LATERAL (SELECT * FROM placement_rates x WHERE x.placement_id=p.id ORDER BY (x.effective_from <= $2 AND (x.effective_to IS NULL OR x.effective_to >= $2)) DESC, x.effective_from DESC LIMIT 1) r ON true`,
      where, params, lp, searchCols: ['c.first_name', 'c.last_name', 'co.name', 'p.title'],
      sortMap: { worker_name: 'c.first_name', company_name: 'co.name', pay_rate_cents: 'r.pay_rate_cents', bill_rate_cents: 'r.bill_rate_cents', effective_from: 'r.effective_from', margin_pct: '(r.bill_rate_cents - r.pay_rate_cents)::float / NULLIF(r.bill_rate_cents,0)', rate_count: 'rate_count' },
      defaultSort: 'r.effective_from DESC',
    });
    return { ...res, rows: res.rows.map(r => stripRate(ctx, withMargin(r))) };
  });

  // Rate change history (timeline across all placements).
  app.get('/api/v1/rates/history', async (req) => {
    const ctx = staff(req); need(ctx, 'rates', 'view');
    const lp = listParams(req);
    const params: unknown[] = [ctx.orgId]; const where = ['r.organization_id=$1'];
    if (lp.filters.placement_id) { params.push(lp.filters.placement_id); where.push(`r.placement_id=$${params.length}`); }
    if (lp.filters.company_id) { params.push(lp.filters.company_id); where.push(`p.company_id=$${params.length}`); }
    const res = await paged({
      select: `r.*, p.title, co.name company_name, c.first_name || ' ' || COALESCE(c.last_name,'') worker_name, u.name created_by_name,
        (SELECT row_to_json(x) FROM (SELECT pay_rate_cents, bill_rate_cents FROM placement_rates y WHERE y.placement_id=r.placement_id AND y.effective_from < r.effective_from ORDER BY effective_from DESC LIMIT 1) x) previous`,
      from: `placement_rates r JOIN placements p ON p.id=r.placement_id JOIN workers w ON w.id=p.worker_id JOIN candidates c ON c.id=w.candidate_id JOIN companies co ON co.id=p.company_id LEFT JOIN users u ON u.id=r.created_by`,
      where, params, lp, searchCols: ['c.first_name', 'c.last_name', 'co.name', 'r.reason'],
      sortMap: { created_at: 'r.created_at', effective_from: 'r.effective_from' }, defaultSort: 'r.created_at DESC',
    });
    const comp = canViewComp(ctx);
    return { ...res, rows: res.rows.map(r => { const out = stripRate(ctx, withMargin(r)); if (!comp) out.previous = null; return out; }) };
  });

  app.get('/api/v1/placements/:id/rates', async (req) => {
    const ctx = staff(req); need(ctx, 'rates', 'view');
    const { id } = req.params as { id: string };
    const p = await getOr404<any>('placements', ctx, id);
    const today = await orgToday(pool, ctx.orgId);
    const rows = await q<any>(`SELECT r.*, u.name created_by_name,
        (SELECT count(*)::int FROM timesheet_days d WHERE d.placement_id=r.placement_id AND d.work_date >= r.effective_from AND (r.effective_to IS NULL OR d.work_date <= r.effective_to) AND d.invoice_id IS NOT NULL) invoiced_days,
        (SELECT count(*)::int FROM timesheet_days d WHERE d.placement_id=r.placement_id AND d.work_date >= r.effective_from AND (r.effective_to IS NULL OR d.work_date <= r.effective_to) AND d.payroll_item_id IS NOT NULL) paid_days
      FROM placement_rates r LEFT JOIN users u ON u.id=r.created_by WHERE r.placement_id=$1 AND r.organization_id=$2 ORDER BY r.effective_from DESC`, [id, ctx.orgId]);
    const rates = rows.map(r => ({ ...stripRate(ctx, withMargin(r)), is_current: r.effective_from <= today && (!r.effective_to || r.effective_to >= today), is_future: r.effective_from > today }));
    return { placement: { id: p.id, title: p.title, status: p.status, start_date: p.start_date, end_date: p.end_date }, rates, can_view_comp: canViewComp(ctx), can_edit: ctx.perms['rates:create'] !== undefined && ctx.perms['rates:create'] !== 'none', today };
  });

  app.post('/api/v1/placements/:id/rates', async (req) => {
    const ctx = staff(req); need(ctx, 'rates', 'create'); if (!canViewComp(ctx)) need(ctx, 'rates', 'view_comp');
    const { id } = req.params as { id: string };
    await getOr404('placements', ctx, id);
    const body = rateBody.parse(req.body);
    const r = await tx(async c => {
      const res = await createRate(c, ctx, id, body);
      await audit(ctx, 'rate.created', { type: 'placement', id, label: res.placement.title }, res.prior ? { effective_from: res.prior.effective_from, pay_rate_cents: res.prior.pay_rate_cents, bill_rate_cents: res.prior.bill_rate_cents } : null, { effective_from: res.rate.effective_from, effective_to: res.rate.effective_to, pay_rate_cents: res.rate.pay_rate_cents, bill_rate_cents: res.rate.bill_rate_cents, unit: res.rate.unit, currency: res.rate.currency }, body.reason, c);
      await activity(ctx, 'placement', id, 'rate', `Rate change effective ${res.rate.effective_from}: pay ${fmt(res.rate.pay_rate_cents, res.rate.currency)}/${res.rate.unit}, bill ${fmt(res.rate.bill_rate_cents, res.rate.currency)}/${res.rate.unit}`, body.reason, { rate_id: res.rate.id }, c);
      return res;
    });
    const p = await one<any>(`SELECT p.*, co.name company_name, c.first_name || ' ' || COALESCE(c.last_name,'') worker_name FROM placements p JOIN companies co ON co.id=p.company_id JOIN workers w ON w.id=p.worker_id JOIN candidates c ON c.id=w.candidate_id WHERE p.id=$1`, [id]);
    await notify(ctx.orgId, [...await financeUsers(ctx.orgId), p.account_manager_id].filter(u => u !== ctx.userId), { event: 'rate.changed', title: `Rate change: ${p.worker_name} (${p.company_name})`, body: `Effective ${r.rate.effective_from} — pay ${fmt(r.rate.pay_rate_cents, r.rate.currency)}, bill ${fmt(r.rate.bill_rate_cents, r.rate.currency)} per ${r.rate.unit}. ${body.reason}`, link: `/workforce/placements/${id}` });
    await emit(ctx.orgId, 'rate.changed', { placement_id: id, worker_id: p.worker_id, worker_name: p.worker_name, company_id: p.company_id, company_name: p.company_name, account_manager_id: p.account_manager_id, recruiter_id: p.recruiter_id, rate_id: r.rate.id, effective_from: r.rate.effective_from });
    const warnings: string[] = [];
    if (r.already_invoiced_days || r.already_paid_days) warnings.push(`${r.already_invoiced_days} invoiced and ${r.already_paid_days} paid day(s) fall in this period; existing invoices and payroll keep their original amounts. Use an invoice credit/adjustment if a correction is needed.`);
    if (body.bill_rate_cents < body.pay_rate_cents) warnings.push('Bill rate is below pay rate — this placement will run at a loss.');
    return { rate: withMargin(r.rate), warnings };
  });
}
