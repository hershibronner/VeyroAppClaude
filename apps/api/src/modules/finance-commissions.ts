// FINANCE — commission rules & entitlements (calculated vs approved vs settled), margin analysis, finance overview.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { grossMargin } from '@veyro/shared';
import { q, one, tx, pool } from '../core/db';
import { staff, need, scopeOf, getOr404, can, canViewComp, type Ctx } from '../core/context';
import { badRequest, conflict, forbidden, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { submitBatch, schedule, onPayoutItemFinal } from '../adapters/payouts';
import { computeEntitlements, economics, rollup } from './_finance/margin';
import { fmt, orgToday, monthStart, monthEnd, addMonths, monthLabel, financeUsers } from './_finance/common';
import { duePeriod } from './finance-payroll';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const tier = z.object({ upToCents: z.number().int().positive().nullable(), pctBp: z.number().int().min(0).max(10000) });
const ruleBody = z.object({
  name: z.string().trim().min(2, 'Name is required').max(120), description: z.string().max(500).nullable().optional(),
  applies_to: z.enum(['recruiter', 'sales', 'account_manager']), kind: z.enum(['pct_gp', 'fixed', 'tiered']),
  pct_bp: z.number().int().min(1).max(10000).nullable().optional(), fixed_cents: z.number().int().positive().nullable().optional(),
  months_limit: z.number().int().min(1).max(120).nullable().optional(), tiers: z.array(tier).min(1).nullable().optional(),
  user_id: z.string().uuid().nullable().optional(), active: z.boolean().optional(),
}).superRefine((v, c) => {
  if (v.kind === 'pct_gp' && !v.pct_bp) c.addIssue({ code: 'custom', path: ['pct_bp'], message: 'Percentage is required' });
  if (v.kind === 'fixed' && !v.fixed_cents) c.addIssue({ code: 'custom', path: ['fixed_cents'], message: 'Amount is required' });
  if (v.kind === 'tiered' && !v.tiers?.length) c.addIssue({ code: 'custom', path: ['tiers'], message: 'Add at least one tier' });
});

function commissionScope(ctx: Ctx) { return scopeOf(ctx, 'commissions', 'view'); }

export default async function (app: FastifyInstance) {
  // Commission payouts settle entitlements when the transfer is paid.
  onPayoutItemFinal(async (orgId, item, payout) => {
    if (payout.kind !== 'commission') return;
    if (item.status === 'paid') {
      const rows = await q<any>(`UPDATE commission_entitlements SET status='settled', settled_cents=COALESCE(approved_cents, calculated_cents), settled_at=now(), settled_via='payout' WHERE organization_id=$1 AND payout_item_id=$2 AND status='approved' RETURNING *`, [orgId, item.id]);
      if (item.user_id && rows.length) await notify(orgId, [item.user_id], { event: 'commission.paid', title: `Commission paid: ${fmt(Number(item.amount_cents), item.currency)}`, body: `${rows.length} entitlement(s) settled via Wise (${item.provider_ref})`, link: '/finance/commissions' });
    } else if (item.status === 'failed') {
      await notify(orgId, await financeUsers(orgId), { event: 'payout.failed', title: 'Commission payout failed', body: item.failure_reason, link: `/finance/payouts/${payout.id}` });
    }
  });

  // ── Rules ──
  app.get('/api/v1/commissions/rules', async (req) => {
    const ctx = staff(req); need(ctx, 'commissions', 'view');
    const rows = await q<any>(`SELECT r.*, u.name user_name, (SELECT count(*)::int FROM commission_entitlements e WHERE e.rule_id=r.id) entitlements, (SELECT COALESCE(sum(calculated_cents),0)::bigint FROM commission_entitlements e WHERE e.rule_id=r.id) calculated_cents FROM commission_rules r LEFT JOIN users u ON u.id=r.user_id WHERE r.organization_id=$1 ORDER BY r.active DESC, r.name`, [ctx.orgId]);
    return { rows, total: rows.length, page: 1, pageSize: rows.length };
  });
  app.post('/api/v1/commissions/rules', async (req) => {
    const ctx = staff(req); need(ctx, 'commissions', 'create');
    const b = ruleBody.parse(req.body);
    const r = await one<any>(`INSERT INTO commission_rules (organization_id, name, description, applies_to, kind, pct_bp, fixed_cents, months_limit, tiers, user_id, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.orgId, b.name, b.description ?? null, b.applies_to, b.kind, b.kind === 'pct_gp' ? b.pct_bp : null, b.kind === 'fixed' ? b.fixed_cents : null, b.months_limit ?? null, b.kind === 'tiered' ? JSON.stringify(b.tiers) : null, b.user_id ?? null, b.active ?? true]);
    await audit(ctx, 'commission_rule.created', { type: 'commission_rule', id: r.id, label: r.name }, undefined, b);
    return { rule: r };
  });
  app.patch('/api/v1/commissions/rules/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'commissions', 'edit');
    const { id } = req.params as { id: string };
    const before = await getOr404<any>('commission_rules', ctx, id);
    const b = ruleBody.parse({ ...before, tiers: before.tiers ?? undefined, ...(req.body as object) });
    const r = await one<any>(`UPDATE commission_rules SET name=$3, description=$4, applies_to=$5, kind=$6, pct_bp=$7, fixed_cents=$8, months_limit=$9, tiers=$10, user_id=$11, active=$12 WHERE id=$1 AND organization_id=$2 RETURNING *`,
      [id, ctx.orgId, b.name, b.description ?? null, b.applies_to, b.kind, b.kind === 'pct_gp' ? b.pct_bp : null, b.kind === 'fixed' ? b.fixed_cents : null, b.months_limit ?? null, b.kind === 'tiered' ? JSON.stringify(b.tiers) : null, b.user_id ?? null, b.active ?? true]);
    await audit(ctx, 'commission_rule.updated', { type: 'commission_rule', id, label: r.name }, before, r);
    return { rule: r };
  });
  app.delete('/api/v1/commissions/rules/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'commissions', 'delete');
    const { id } = req.params as { id: string };
    const rule = await getOr404<any>('commission_rules', ctx, id);
    const used = await one<any>(`SELECT count(*)::int n FROM commission_entitlements WHERE rule_id=$1`, [id]);
    if (used!.n) { await q(`UPDATE commission_rules SET active=false WHERE id=$1`, [id]); await audit(ctx, 'commission_rule.deactivated', { type: 'commission_rule', id, label: rule.name }, { active: true }, { active: false }); return { deactivated: true }; }
    await q(`DELETE FROM commission_rules WHERE id=$1`, [id]);
    await audit(ctx, 'commission_rule.deleted', { type: 'commission_rule', id, label: rule.name }, rule, undefined);
    return { deleted: true };
  });

  // ── Entitlements ──
  app.get('/api/v1/commissions', async (req) => {
    const ctx = staff(req); const scope = need(ctx, 'commissions', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId]; const where = ['e.organization_id=$1'];
    if (scope === 'own' || scope === 'assigned') { params.push(ctx.userId); where.push(`e.user_id=$${params.length}`); }
    if (f.status) { params.push(f.status); where.push(`e.status=$${params.length}`); }
    if (f.user_id) { params.push(f.user_id); where.push(`e.user_id=$${params.length}`); }
    if (f.rule_id) { params.push(f.rule_id); where.push(`e.rule_id=$${params.length}`); }
    if (f.month && /^\d{4}-\d{2}$/.test(f.month)) { params.push(f.month + '-01'); where.push(`e.period_start=$${params.length}`); }
    const base = { from: `commission_entitlements e JOIN commission_rules r ON r.id=e.rule_id JOIN users u ON u.id=e.user_id LEFT JOIN placements p ON p.id=e.placement_id LEFT JOIN workers w ON w.id=p.worker_id LEFT JOIN candidates c ON c.id=w.candidate_id LEFT JOIN companies co ON co.id=p.company_id`, where, params };
    const res = await paged({ select: `e.*, r.name rule_name, r.applies_to, r.kind rule_kind, u.name user_name, p.title, c.first_name || ' ' || COALESCE(c.last_name,'') worker_name, co.name company_name, au.name approved_by_name`,
      ...base, from: base.from + ' LEFT JOIN users au ON au.id=e.approved_by', lp, searchCols: ['u.name', 'c.first_name', 'c.last_name', 'co.name', 'r.name'],
      sortMap: { period_start: 'e.period_start', calculated_cents: 'e.calculated_cents', user_name: 'u.name', gp_cents: 'e.gp_cents', status: 'e.status' }, defaultSort: 'e.period_start DESC, u.name' });
    const totals = await one<any>(`SELECT COALESCE(sum(e.calculated_cents),0)::bigint calculated, COALESCE(sum(e.approved_cents),0)::bigint approved, COALESCE(sum(e.settled_cents),0)::bigint settled,
        COALESCE(sum(e.calculated_cents) FILTER (WHERE e.status='calculated'),0)::bigint awaiting_approval, COALESCE(sum(e.approved_cents) FILTER (WHERE e.status='approved'),0)::bigint awaiting_settlement, count(*)::int n
      FROM ${base.from} WHERE ${where.join(' AND ')}`, params);
    return { ...res, totals, scope };
  });

  app.get('/api/v1/commissions/summary', async (req) => {
    const ctx = staff(req); const scope = need(ctx, 'commissions', 'view');
    const params: unknown[] = [ctx.orgId]; let own = '';
    if (scope === 'own' || scope === 'assigned') { params.push(ctx.userId); own = `AND e.user_id=$2`; }
    const byUser = await q<any>(`SELECT u.id, u.name, sum(e.calculated_cents)::bigint calculated_cents, COALESCE(sum(e.approved_cents),0)::bigint approved_cents, sum(e.settled_cents)::bigint settled_cents, count(*)::int entitlements FROM commission_entitlements e JOIN users u ON u.id=e.user_id WHERE e.organization_id=$1 ${own} GROUP BY u.id, u.name ORDER BY calculated_cents DESC`, params);
    const byMonth = await q<any>(`SELECT to_char(e.period_start,'YYYY-MM-DD') AS month, sum(e.calculated_cents)::bigint calculated_cents, COALESCE(sum(e.approved_cents),0)::bigint approved_cents, sum(e.settled_cents)::bigint settled_cents FROM commission_entitlements e WHERE e.organization_id=$1 ${own} GROUP BY 1 ORDER BY 1`, params);
    return { by_user: byUser, by_month: byMonth.map(m => ({ ...m, label: monthLabel(m.month) })) };
  });

  app.post('/api/v1/commissions/compute', async (req) => {
    const ctx = staff(req); need(ctx, 'commissions', 'create');
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM') }).parse(req.body);
    const r = await tx(c => computeEntitlements(c, ctx.orgId, month + '-01'));
    await audit(ctx, 'commissions.computed', { type: 'commission_period', label: month }, undefined, r);
    return r;
  });

  async function approveOne(c: any, ctx: Ctx, id: string, amount?: number | null, note?: string | null) {
    const e = await one<any>(`SELECT * FROM commission_entitlements WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, ctx.orgId], c);
    if (!e) throw notFound();
    if (e.status !== 'calculated') throw conflict(`Only calculated entitlements can be approved (this one is ${e.status})`);
    if (e.user_id === ctx.userId && !['owner', 'admin'].includes(ctx.role.key)) throw forbidden('You cannot approve your own commission');
    const approved = amount ?? Number(e.calculated_cents);
    if (approved < 0) throw badRequest('Approved amount cannot be negative');
    const r = await one<any>(`UPDATE commission_entitlements SET status='approved', approved_cents=$2, approved_by=$3, approved_at=now(), note=COALESCE($4, note) WHERE id=$1 RETURNING *`, [id, approved, ctx.userId, note ?? null], c);
    await audit(ctx, 'commission.approved', { type: 'commission_entitlement', id, label: `${e.period_start}` }, { status: e.status, calculated_cents: e.calculated_cents }, { status: 'approved', approved_cents: approved }, note ?? undefined, c);
    return r;
  }
  app.post('/api/v1/commissions/:id/approve', async (req) => {
    const ctx = staff(req); need(ctx, 'commissions', 'approve');
    const b = z.object({ approved_cents: z.number().int().min(0).nullable().optional(), note: z.string().max(500).nullable().optional() }).parse(req.body ?? {});
    const r = await tx(c => approveOne(c, ctx, (req.params as any).id, b.approved_cents, b.note));
    await notify(ctx.orgId, [r.user_id].filter(u => u !== ctx.userId), { event: 'commission.approved', title: `Commission approved: ${fmt(Number(r.approved_cents))}`, body: `Period ${r.period_start}`, link: '/finance/commissions' });
    return { entitlement: r };
  });
  app.post('/api/v1/commissions/approve', async (req) => {
    const ctx = staff(req); need(ctx, 'commissions', 'approve');
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1) }).parse(req.body);
    const rows = await tx(async c => { const out = []; for (const id of ids) out.push(await approveOne(c, ctx, id)); return out; });
    const byUser = new Map<string, number>(); for (const r of rows) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + Number(r.approved_cents));
    for (const [u, cents] of byUser) if (u !== ctx.userId) await notify(ctx.orgId, [u], { event: 'commission.approved', title: `Commission approved: ${fmt(cents)}`, link: '/finance/commissions' });
    return { approved: rows.length };
  });
  app.post('/api/v1/commissions/:id/reject', async (req) => {
    const ctx = staff(req); need(ctx, 'commissions', 'approve');
    const { reason } = z.object({ reason: z.string().trim().min(3, 'A reason is required') }).parse(req.body);
    const { id } = req.params as { id: string };
    const e = await getOr404<any>('commission_entitlements', ctx, id);
    if (!['calculated', 'approved'].includes(e.status)) throw conflict(`Cannot reject a ${e.status} entitlement`);
    const r = await one<any>(`UPDATE commission_entitlements SET status='rejected', note=$2 WHERE id=$1 RETURNING *`, [id, reason]);
    await audit(ctx, 'commission.rejected', { type: 'commission_entitlement', id }, { status: e.status }, { status: 'rejected' }, reason);
    return { entitlement: r };
  });

  // Settle approved entitlements: via a separate (simulated Wise) commission payout, or mark as settled through payroll/outside.
  app.post('/api/v1/commissions/settle', async (req) => {
    const ctx = staff(req); need(ctx, 'commissions', 'approve'); need(ctx, 'payouts', 'create');
    const b = z.object({ ids: z.array(z.string().uuid()).min(1), method: z.enum(['payout', 'manual']), reason: z.string().max(500).optional() }).parse(req.body);
    if (b.method === 'manual' && !b.reason?.trim()) throw badRequest('Say how it was paid', { reason: 'Required for manual settlement' });
    const rows = await q<any>(`SELECT * FROM commission_entitlements WHERE organization_id=$1 AND id = ANY($2)`, [ctx.orgId, b.ids]);
    if (rows.length !== b.ids.length) throw notFound();
    const bad = rows.filter(r => r.status !== 'approved' || r.payout_item_id);
    if (bad.length) throw conflict('Only approved entitlements that are not already in a payout can be settled');
    if (b.method === 'manual') {
      await tx(async c => {
        await q(`UPDATE commission_entitlements SET status='settled', settled_cents=approved_cents, settled_at=now(), settled_via='manual', note=$2 WHERE id = ANY($1)`, [b.ids, b.reason], c);
        await audit(ctx, 'commission.settled', { type: 'commission_entitlement', label: `${rows.length} entitlement(s)` }, undefined, { ids: b.ids, total_cents: rows.reduce((a, r) => a + Number(r.approved_cents), 0), method: 'manual' }, b.reason, c);
      });
      return { settled: rows.length, method: 'manual' };
    }
    const byUser = new Map<string, any[]>(); for (const r of rows) (byUser.get(r.user_id) ?? byUser.set(r.user_id, []).get(r.user_id)!).push(r);
    const key = `commission:${[...b.ids].sort().join(',').slice(0, 60)}:${b.ids.length}`;
    const res = await tx(async c => {
      const batch = await submitBatch(c, ctx.orgId, { kind: 'commission', idempotencyKey: key, currency: 'USD', items: [...byUser.entries()].map(([u, list]) => ({ user_id: u, amount_cents: list.reduce((a, r) => a + Number(r.approved_cents), 0) })), actorId: ctx.userId });
      if (!batch.duplicate) {
        const items = await q<any>(`SELECT id, user_id FROM payout_items WHERE payout_id=$1`, [batch.payout.id], c);
        for (const it of items) await q(`UPDATE commission_entitlements SET payout_item_id=$1 WHERE id = ANY($2) AND user_id=$3`, [it.id, b.ids, it.user_id], c);
        await audit(ctx, 'commission.payout_initiated', { type: 'payout', id: batch.payout.id }, undefined, { ids: b.ids, total_cents: batch.payout.total_cents }, undefined, c);
      }
      return batch;
    });
    if (!res.duplicate) await schedule(ctx.orgId, res.payout.id);
    return { payout: res.payout, duplicate: res.duplicate, method: 'payout' };
  });

  // ── Margin ──
  app.get('/api/v1/margin', async (req) => {
    const ctx = staff(req); need(ctx, 'margin', 'view');
    if (!canViewComp(ctx, 'margin')) throw forbidden('Your role cannot view compensation and margin details');
    const qs = req.query as Record<string, string>;
    const today = await orgToday(pool, ctx.orgId);
    const to = qs.to ?? today; const from = qs.from ?? addMonths(monthStart(today), -5);
    const group = (qs.group_by ?? 'client') as 'placement' | 'worker' | 'client' | 'account_manager' | 'team' | 'month';
    const rows = await economics(pool, ctx.orgId, from, to, { billedOnly: qs.basis === 'billed', companyId: qs.company_id || null });
    const keyers: Record<string, [(r: any) => string, (r: any) => string]> = {
      placement: [r => r.placement_id, r => `${r.worker_name} — ${r.title} (${r.company_name})`], worker: [r => r.worker_id, r => r.worker_name], client: [r => r.company_id, r => r.company_name],
      account_manager: [r => r.account_manager_id ?? 'none', r => r.account_manager_name ?? 'Unassigned'], team: [r => r.recruiter_team ?? 'none', r => r.recruiter_team ?? 'No team'], month: [r => r.month, r => monthLabel(r.month) + ' ' + r.month.slice(0, 4)],
    };
    const [k, l] = keyers[group] ?? keyers.client;
    let groups = rollup(rows, k as any, l);
    const search = (qs.search ?? '').toLowerCase();
    if (search) groups = groups.filter(g => g.label.toLowerCase().includes(search));
    const sortKey = (qs.sort ?? (group === 'month' ? 'key' : 'gp_cents')) as keyof (typeof groups)[number];
    groups.sort((a: any, b: any) => (qs.dir === 'asc' ? 1 : -1) * (typeof a[sortKey] === 'string' ? String(a[sortKey]).localeCompare(String(b[sortKey])) : Number(a[sortKey]) - Number(b[sortKey])));
    const tot = rows.reduce((a, r) => ({ revenue: a.revenue + r.revenue_cents, cost: a.cost + r.cost_cents, minutes: a.minutes + r.minutes }), { revenue: 0, cost: 0, minutes: 0 });
    const gm = grossMargin(tot.revenue, tot.cost);
    const trend = rollup(rows, r => r.month, r => monthLabel(r.month)).sort((a, b) => String(a.key).localeCompare(String(b.key)));
    const page = Math.max(1, Number(qs.page) || 1), pageSize = Math.min(500, Number(qs.pageSize) || 25);
    return { from, to, group_by: group, totals: { revenue_cents: tot.revenue, cost_cents: tot.cost, gp_cents: gm.gpCents, margin_pct: gm.marginPct, minutes: tot.minutes }, trend, rows: groups.slice((page - 1) * pageSize, page * pageSize), total: groups.length, page, pageSize };
  });

  // ── Finance overview ──
  app.get('/api/v1/finance/overview', async (req) => {
    const ctx = staff(req);
    if (!['invoices', 'payroll', 'rates', 'commissions', 'margin'].some(r => can(ctx, r as any, 'view'))) throw notFound();
    const months = Math.min(24, Math.max(3, Number((req.query as any).months) || 6));
    const today = await orgToday(pool, ctx.orgId);
    const ms = monthStart(today); const from = addMonths(ms, -(months - 1));
    const comp = canViewComp(ctx, 'margin') && can(ctx, 'margin', 'view');
    const econ = comp ? await economics(pool, ctx.orgId, addMonths(from, -1), today) : [];
    const byMonth = rollup(econ, r => r.month, r => monthLabel(r.month));
    const mk = (m: string) => byMonth.find(x => x.key === m) ?? { revenue_cents: 0, cost_cents: 0, gp_cents: 0, margin_pct: 0, minutes: 0 };
    const cur = mk(ms), prev = mk(addMonths(ms, -1));
    const d = (a: number, b: number) => (b ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null);
    const trend = Array.from({ length: months }, (_, i) => { const m = addMonths(from, i); const x = mk(m); return { month: m, label: monthLabel(m), revenue: x.revenue_cents, cost: x.cost_cents, margin: x.gp_cents, margin_pct: x.margin_pct }; });
    const inv = can(ctx, 'invoices', 'view') ? await one<any>(`SELECT COALESCE(sum(total_cents-paid_cents) FILTER (WHERE status IN ('sent','viewed','partially_paid','overdue')),0)::bigint ar, count(*) FILTER (WHERE status='overdue')::int overdue_n, COALESCE(sum(total_cents-paid_cents) FILTER (WHERE status='overdue'),0)::bigint overdue_cents,
        count(*) FILTER (WHERE status='draft')::int drafts, count(*) FILTER (WHERE status='approved')::int approved, COALESCE(sum(total_cents) FILTER (WHERE status NOT IN ('void','draft') AND issue_date >= $2),0)::bigint invoiced_month,
        COALESCE(sum(total_cents) FILTER (WHERE status NOT IN ('void','draft') AND issue_date >= $3 AND issue_date < $2),0)::bigint invoiced_prev,
        count(*) FILTER (WHERE status IN ('sent','viewed','partially_paid') AND due_date BETWEEN $4::date AND $4::date + 7)::int due_soon_n, COALESCE(sum(total_cents-paid_cents) FILTER (WHERE status IN ('sent','viewed','partially_paid') AND due_date BETWEEN $4::date AND $4::date + 7),0)::bigint due_soon_cents
      FROM invoices WHERE organization_id=$1`, [ctx.orgId, ms, addMonths(ms, -1), today]) : null;
    const prevAr = can(ctx, 'invoices', 'view') ? await one<any>(`SELECT COALESCE(sum(i.total_cents - COALESCE((SELECT sum(p.amount_cents - p.refunded_cents) FROM payments p WHERE p.invoice_id=i.id AND p.status IN ('succeeded','refunded') AND p.received_at < $2::date),0)),0)::bigint ar FROM invoices i WHERE i.organization_id=$1 AND i.status NOT IN ('draft','approved','void','written_off') AND i.issue_date < $2::date`, [ctx.orgId, ms]) : null;
    const unbilled = can(ctx, 'invoices', 'view') ? await one<any>(`SELECT COALESCE(sum(d.minutes),0)::int minutes, count(DISTINCT p.company_id)::int clients FROM timesheet_days d JOIN timesheets t ON t.id=d.timesheet_id JOIN placements p ON p.id=d.placement_id WHERE d.organization_id=$1 AND d.invoice_id IS NULL AND t.status IN ('approved','locked') AND d.minutes > 0`, [ctx.orgId]) : null;
    const payroll = can(ctx, 'payroll', 'view') ? await duePeriod(ctx.orgId) : null;
    const failedPayouts = can(ctx, 'payouts', 'view') ? await one<any>(`SELECT count(*)::int n, COALESCE(sum(amount_cents),0)::bigint cents, (SELECT payout_id FROM payout_items WHERE organization_id=$1 AND status='failed' ORDER BY updated_at DESC LIMIT 1) payout_id FROM payout_items WHERE organization_id=$1 AND status='failed'`, [ctx.orgId]) : null;
    const syncFailed = can(ctx, 'invoices', 'view') ? await one<any>(`SELECT count(*)::int n FROM (SELECT DISTINCT ON (entity_type, entity_id) status FROM accounting_sync_log WHERE organization_id=$1 ORDER BY entity_type, entity_id, created_at DESC) x WHERE status='failed'`, [ctx.orgId]) : null;
    const commissions = can(ctx, 'commissions', 'view') && scopeOf(ctx, 'commissions', 'view') === 'all' ? await one<any>(`SELECT COALESCE(sum(calculated_cents) FILTER (WHERE status='calculated'),0)::bigint awaiting, count(*) FILTER (WHERE status='calculated')::int awaiting_n FROM commission_entitlements WHERE organization_id=$1`, [ctx.orgId]) : null;
    const byClient = rollup(econ.filter(r => r.month >= from), r => r.company_id, r => r.company_name).sort((a, b) => b.gp_cents - a.gp_cents).slice(0, 8);
    const aging = can(ctx, 'invoices', 'view') ? await q<any>(`SELECT CASE WHEN $2::date - due_date <= 0 THEN 'current' WHEN $2::date - due_date <= 30 THEN '1_30' WHEN $2::date - due_date <= 60 THEN '31_60' WHEN $2::date - due_date <= 90 THEN '61_90' ELSE '90_plus' END bucket, sum(total_cents-paid_cents)::bigint cents, count(*)::int n FROM invoices WHERE organization_id=$1 AND status IN ('sent','viewed','partially_paid','overdue') GROUP BY 1`, [ctx.orgId, today]) : [];
    return {
      today, month: ms, months, comp,
      kpis: {
        revenue: comp ? { value: cur.revenue_cents, delta: d(cur.revenue_cents, prev.revenue_cents) } : null,
        payroll_cost: comp ? { value: cur.cost_cents, delta: d(cur.cost_cents, prev.cost_cents) } : null,
        gross_margin: comp ? { value: cur.gp_cents, pct: cur.margin_pct, delta: d(cur.gp_cents, prev.gp_cents), prev_pct: prev.margin_pct } : null,
        ar: inv ? { value: Number(inv.ar), delta: prevAr ? d(Number(inv.ar), Number(prevAr.ar)) : null, overdue_cents: Number(inv.overdue_cents), overdue_n: inv.overdue_n } : null,
        invoiced: inv ? { value: Number(inv.invoiced_month), delta: d(Number(inv.invoiced_month), Number(inv.invoiced_prev)) } : null,
      },
      trend: comp ? trend : [], by_client: comp ? byClient : [],
      aging: ['current', '1_30', '31_60', '61_90', '90_plus'].map(k => ({ key: k, label: { current: 'Current', '1_30': '1–30', '31_60': '31–60', '61_90': '61–90', '90_plus': '90+' }[k], value: Number(aging.find(a => a.bucket === k)?.cents ?? 0), count: aging.find(a => a.bucket === k)?.n ?? 0 })),
      attention: { invoices: inv ? { drafts: inv.drafts, approved: inv.approved, overdue_n: inv.overdue_n, overdue_cents: Number(inv.overdue_cents), due_soon_n: inv.due_soon_n, due_soon_cents: Number(inv.due_soon_cents) } : null, unbilled, payroll, failed_payouts: failedPayouts, sync_failed: syncFailed?.n ?? null, commissions },
    };
  });
}

export { monthEnd };
