// INSIGHTS: analytics dashboards (executive, recruiting, sales, finance, workforce). Every endpoint takes ?from=&to=.
import type { FastifyInstance } from 'fastify';
import { q, one } from '../core/db';
import { staff, need, can, canViewComp, scopeOf, type Ctx } from '../core/context';
import { notFound } from '../core/errors';
import {
  rangeOf, pctDelta, bucketOf, bucketsBetween, num,
  APPROVED_DAYS, REV_SQL, COST_SQL, ENTRY_MIN, REVENUE_STATUSES, OPEN_AR_STATUSES, LINK, type Range,
} from './_insights/common';

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const drill = (path: string, r: { from: string; to: string }, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams({ from: r.from, to: r.to, ...extra });
  return `${path}${path.includes('?') ? '&' : '?'}${p.toString()}`;
};

async function revenue(org: string, from: string, to: string, companyId?: string) {
  return num((await one<any>(`SELECT COALESCE(sum(total_cents),0)::bigint v FROM invoices WHERE organization_id=$1 AND status IN ${REVENUE_STATUSES} AND issue_date BETWEEN $2::date AND $3::date ${companyId ? 'AND company_id=$4' : ''}`, companyId ? [org, from, to, companyId] : [org, from, to]))?.v);
}
async function payroll(org: string, from: string, to: string) {
  return num((await one<any>(`SELECT COALESCE(sum(pi.gross_cents),0)::bigint v FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id WHERE pi.organization_id=$1 AND r.pay_date BETWEEN $2::date AND $3::date`, [org, from, to]))?.v);
}
async function margin(org: string, from: string, to: string) {
  const r = await one<any>(`SELECT ${REV_SQL} rev, ${COST_SQL} cost, COALESCE(sum(td.minutes),0)::bigint minutes FROM ${APPROVED_DAYS} WHERE td.organization_id=$1 AND td.work_date BETWEEN $2::date AND $3::date`, [org, from, to]);
  const rev = num(r?.rev), cost = num(r?.cost);
  return { rev, cost, profit: rev - cost, pct: rev ? Math.round(((rev - cost) / rev) * 1000) / 10 : null, minutes: num(r?.minutes) };
}
function kpi(key: string, label: string, value: number, prev: number | null, format: 'num' | 'money' | 'pct' | 'hours', to: string, opts: { invert?: boolean; pts?: boolean } = {}) {
  return { key, label, value, prev, format, to, invert: opts.invert, delta: prev === null ? null : opts.pts ? Math.round((value - prev) * 10) / 10 : pctDelta(value, prev), deltaLabel: opts.pts ? 'pts vs previous period' : 'vs previous period' };
}

/** Series of revenue / payroll / profit per bucket. */
async function moneySeries(ctx: Ctx, r: Range) {
  const unit = bucketOf(r) === 'day' ? 'week' : bucketOf(r);
  const buckets = bucketsBetween(r.from, r.to, unit);
  const trunc = unit === 'week' ? 'week' : 'month';
  const rev = await q<any>(`SELECT date_trunc('${trunc}', issue_date)::date::text k, sum(total_cents)::bigint v FROM invoices WHERE organization_id=$1 AND status IN ${REVENUE_STATUSES} AND issue_date BETWEEN $2::date AND $3::date GROUP BY 1`, [ctx.orgId, r.from, r.to]);
  const pay = can(ctx, 'payroll', 'view') ? await q<any>(`SELECT date_trunc('${trunc}', rr.pay_date)::date::text k, sum(pi.gross_cents)::bigint v FROM payroll_items pi JOIN payroll_runs rr ON rr.id=pi.run_id WHERE pi.organization_id=$1 AND rr.pay_date BETWEEN $2::date AND $3::date GROUP BY 1`, [ctx.orgId, r.from, r.to]) : [];
  const mg = await q<any>(`SELECT date_trunc('${trunc}', td.work_date)::date::text k, ${REV_SQL} rev, ${COST_SQL} cost FROM ${APPROVED_DAYS} WHERE td.organization_id=$1 AND td.work_date BETWEEN $2::date AND $3::date GROUP BY 1`, [ctx.orgId, r.from, r.to]);
  return buckets.map(b => {
    const m = mg.find(x => x.k === b.key);
    const br = num(m?.rev), bc = num(m?.cost);
    return { label: b.label, from: b.from, to: b.to, revenue: num(rev.find(x => x.k === b.key)?.v), payroll: can(ctx, 'payroll', 'view') ? num(pay.find(x => x.k === b.key)?.v) : null, profit: br - bc, margin: br ? Math.round(((br - bc) / br) * 1000) / 10 : null, link: drill('/finance/invoices', b) };
  });
}

export default async function (app: FastifyInstance) {
  // ── Executive ──
  app.get('/api/v1/analytics/executive', async (req) => {
    const ctx = staff(req);
    need(ctx, 'analytics', 'view');
    const r = rangeOf(req);
    const org = ctx.orgId;
    const kpis = [];
    const money_ = can(ctx, 'invoices', 'view');
    if (money_) {
      kpis.push(kpi('revenue', 'Revenue', await revenue(org, r.from, r.to), await revenue(org, r.prevFrom, r.prevTo), 'money', drill('/finance/invoices', r)));
      if (can(ctx, 'payroll', 'view')) kpis.push(kpi('payroll', 'Payroll', await payroll(org, r.from, r.to), await payroll(org, r.prevFrom, r.prevTo), 'money', drill('/finance/payroll', r), { invert: true }));
      const m = await margin(org, r.from, r.to), pm = await margin(org, r.prevFrom, r.prevTo);
      kpis.push(kpi('gross_profit', 'Gross Profit', m.profit, pm.profit, 'money', drill('/finance/margin', r)));
      kpis.push(kpi('margin_pct', 'Gross Margin %', m.pct ?? 0, pm.pct, 'pct', drill('/finance/margin', r), { pts: true }));
    }
    const pl = await one<any>(`SELECT count(*) FILTER (WHERE start_date BETWEEN $2::date AND $3::date)::int cur, count(*) FILTER (WHERE start_date BETWEEN $4::date AND $5::date)::int prev,
      count(*) FILTER (WHERE status IN ('active','on_leave','notice'))::int active FROM placements WHERE organization_id=$1`, [org, r.from, r.to, r.prevFrom, r.prevTo]);
    if (can(ctx, 'placements', 'view')) kpis.push(kpi('new_placements', 'New Placements', pl.cur, pl.prev, 'num', drill('/workforce/placements', r)));
    const hrs = await one<any>(`SELECT COALESCE(sum(td.minutes) FILTER (WHERE td.work_date BETWEEN $2::date AND $3::date),0)::bigint cur, COALESCE(sum(td.minutes) FILTER (WHERE td.work_date BETWEEN $4::date AND $5::date),0)::bigint prev FROM timesheet_days td JOIN timesheets t ON t.id=td.timesheet_id AND t.status IN ('approved','locked') WHERE td.organization_id=$1`, [org, r.from, r.to, r.prevFrom, r.prevTo]);
    if (can(ctx, 'timesheets', 'view') || can(ctx, 'time', 'view')) kpis.push(kpi('approved_hours', 'Approved Hours', num(hrs.cur), num(hrs.prev), 'hours', drill('/time/timesheets', r, { status: 'approved' })));
    const cl = await one<any>(`SELECT count(*) FILTER (WHERE converted_at::date BETWEEN $2::date AND $3::date)::int cur, count(*) FILTER (WHERE converted_at::date BETWEEN $4::date AND $5::date)::int prev FROM companies WHERE organization_id=$1`, [org, r.from, r.to, r.prevFrom, r.prevTo]);
    if (can(ctx, 'clients', 'view')) kpis.push(kpi('new_clients', 'New Clients', cl.cur, cl.prev, 'num', drill('/crm/clients', r)));
    const ap = await one<any>(`SELECT count(*) FILTER (WHERE created_at::date BETWEEN $2::date AND $3::date)::int cur, count(*) FILTER (WHERE created_at::date BETWEEN $4::date AND $5::date)::int prev FROM applications WHERE organization_id=$1`, [org, r.from, r.to, r.prevFrom, r.prevTo]);
    if (can(ctx, 'candidates', 'view')) kpis.push(kpi('applications', 'Applications', ap.cur, ap.prev, 'num', drill('/recruiting/applications', r)));

    const series = money_ ? await moneySeries(ctx, r) : [];
    const unit = bucketOf(r) === 'day' ? 'week' : bucketOf(r);
    const hc = bucketsBetween(r.from, r.to, unit);
    const headcount = can(ctx, 'placements', 'view') ? await Promise.all(hc.map(async b => ({ label: b.label, from: b.from, to: b.to,
      value: num((await one<any>(`SELECT count(*)::int n FROM placements WHERE organization_id=$1 AND activated_at IS NOT NULL AND start_date <= $2::date AND COALESCE(ended_at::date, end_date, '9999-12-31') >= $2::date`, [org, b.to]))?.n),
      link: drill('/workforce/placements', b) }))) : [];
    const topClients = money_ ? (await q<any>(`SELECT co.id, co.name, sum(i.total_cents)::bigint rev, count(*)::int invoices FROM invoices i JOIN companies co ON co.id=i.company_id WHERE i.organization_id=$1 AND i.status IN ${REVENUE_STATUSES} AND i.issue_date BETWEEN $2::date AND $3::date GROUP BY co.id, co.name ORDER BY rev DESC LIMIT 8`, [org, r.from, r.to])).map(x => ({ id: x.id, label: x.name, value: num(x.rev), invoices: x.invoices, link: LINK.client(x.id) })) : [];
    return { range: r, kpis, series, headcount, topClients, showMoney: money_, showPayroll: can(ctx, 'payroll', 'view') };
  });

  // ── Recruiting ──
  app.get('/api/v1/analytics/recruiting', async (req) => {
    const ctx = staff(req);
    need(ctx, 'analytics', 'view');
    if (!can(ctx, 'candidates', 'view')) throw notFound();
    const r = rangeOf(req);
    const group = (['recruiter', 'source', 'position', 'client', 'country'] as const).find(g => g === (req.query as any).group) ?? 'recruiter';
    const params = [ctx.orgId, r.from, r.to];
    const ev = `WITH ev AS (
      SELECT 'applied' st, a.candidate_id, a.position_id, COALESCE(a.recruiter_id, c0.sourced_by) actor, a.created_at at FROM applications a JOIN candidates c0 ON c0.id=a.candidate_id WHERE a.organization_id=$1 AND a.created_at::date BETWEEN $2::date AND $3::date
      UNION ALL SELECT 'submitted', s.candidate_id, s.position_id, s.submitted_by, s.created_at FROM candidate_submissions s WHERE s.organization_id=$1 AND s.created_at::date BETWEEN $2::date AND $3::date
      UNION ALL SELECT 'interviewed', i.candidate_id, i.position_id, i.created_by, i.scheduled_at FROM interviews i WHERE i.organization_id=$1 AND i.status <> 'cancelled' AND i.scheduled_at::date BETWEEN $2::date AND $3::date
      UNION ALL SELECT 'offered', o.candidate_id, o.position_id, o.created_by, o.created_at FROM offers o WHERE o.organization_id=$1 AND o.created_at::date BETWEEN $2::date AND $3::date
      UNION ALL SELECT 'hired', w.candidate_id, p.position_id, p.recruiter_id, p.created_at FROM placements p JOIN workers w ON w.id=p.worker_id WHERE p.organization_id=$1 AND p.created_at::date BETWEEN $2::date AND $3::date
    )`;
    const g: Record<string, [string, string]> = {
      recruiter: ['ev.actor::text', `COALESCE(u.name, 'Unattributed')`],
      source: [`COALESCE(NULLIF(c.source,''), 'unknown')`, `COALESCE(NULLIF(c.source,''), 'Unknown')`],
      position: ['pos.id::text', `COALESCE(pos.title, 'General application')`],
      client: ['co.id::text', `COALESCE(co.name, 'No client')`],
      country: [`COALESCE(c.country, '—')`, `COALESCE(c.country, 'Unknown')`],
    };
    const rows = await q<any>(`${ev} SELECT ${g[group][0]} k, ${g[group][1]} label,
      count(*) FILTER (WHERE st='applied')::int applied, count(*) FILTER (WHERE st='submitted')::int submitted, count(DISTINCT ev.candidate_id) FILTER (WHERE st='interviewed')::int interviewed,
      count(*) FILTER (WHERE st='offered')::int offered, count(*) FILTER (WHERE st='hired')::int hired
      FROM ev LEFT JOIN candidates c ON c.id=ev.candidate_id LEFT JOIN positions pos ON pos.id=ev.position_id LEFT JOIN companies co ON co.id=pos.company_id LEFT JOIN users u ON u.id=ev.actor
      GROUP BY 1,2 ORDER BY applied DESC, hired DESC LIMIT 50`, params);
    const link = (k: string | null) => {
      if (!k) return null;
      if (group === 'recruiter') return drill('/recruiting/candidates', r, { recruiter: k });
      if (group === 'source') return drill('/recruiting/candidates', r, { source: k });
      if (group === 'position') return LINK.position(k);
      if (group === 'client') return LINK.client(k);
      return drill('/recruiting/candidates', r, { country: k });
    };
    const totals = await one<any>(`${ev} SELECT count(*) FILTER (WHERE st='applied')::int applied, count(*) FILTER (WHERE st='submitted')::int submitted, count(DISTINCT candidate_id) FILTER (WHERE st='interviewed')::int interviewed, count(*) FILTER (WHERE st='offered')::int offered, count(*) FILTER (WHERE st='hired')::int hired FROM ev`, params);
    const tth = await one<any>(`SELECT round(avg(p.created_at::date - fa.first_at::date))::int days FROM placements p JOIN workers w ON w.id=p.worker_id JOIN LATERAL (SELECT min(created_at) first_at FROM applications a WHERE a.candidate_id=w.candidate_id) fa ON fa.first_at IS NOT NULL WHERE p.organization_id=$1 AND p.created_at::date BETWEEN $2::date AND $3::date`, params);
    const unit = bucketOf(r);
    const b = bucketsBetween(r.from, r.to, unit);
    const trunc = unit;
    const trend = await q<any>(`SELECT date_trunc('${trunc}', created_at)::date::text k, count(*)::int n FROM applications WHERE organization_id=$1 AND created_at::date BETWEEN $2::date AND $3::date GROUP BY 1`, params);
    return {
      range: r, group,
      funnel: [
        { key: 'applied', label: 'Applied', value: totals.applied, link: drill('/recruiting/applications', r) },
        { key: 'submitted', label: 'Submitted', value: totals.submitted, link: drill('/recruiting/submissions', r) },
        { key: 'interviewed', label: 'Interviewed', value: totals.interviewed, link: drill('/recruiting/interviews', r) },
        { key: 'offered', label: 'Offered', value: totals.offered, link: drill('/recruiting/offers', r) },
        { key: 'hired', label: 'Hired', value: totals.hired, link: drill('/workforce/placements', r) },
      ],
      kpis: [
        kpi('applied', 'Applications', totals.applied, null, 'num', drill('/recruiting/applications', r)),
        kpi('submitted', 'Submissions', totals.submitted, null, 'num', drill('/recruiting/submissions', r)),
        kpi('hired', 'Hires', totals.hired, null, 'num', drill('/workforce/placements', r)),
        { key: 'conversion', label: 'Application → Hire', value: totals.applied ? Math.round((totals.hired / totals.applied) * 1000) / 10 : 0, prev: null, delta: null, format: 'pct', to: drill('/workforce/placements', r), deltaLabel: tth?.days !== null && tth?.days !== undefined ? `Avg ${tth.days} days to hire` : 'No hires in range' },
      ],
      rows: rows.map(x => ({ ...x, conversion: x.applied ? Math.round((x.hired / x.applied) * 1000) / 10 : null, link: link(x.k) })),
      trend: b.map(x => ({ label: x.label, from: x.from, to: x.to, value: num(trend.find(t => t.k === x.key)?.n), link: drill('/recruiting/applications', x) })),
    };
  });

  // ── Sales: lead source → opportunity → placement → revenue → profit ──
  app.get('/api/v1/analytics/sales', async (req) => {
    const ctx = staff(req);
    need(ctx, 'analytics', 'view');
    if (!can(ctx, 'leads', 'view') && !can(ctx, 'clients', 'view')) throw notFound();
    const r = rangeOf(req, 365);
    const group = (['source', 'owner', 'campaign', 'industry'] as const).find(g => g === (req.query as any).group) ?? 'source';
    const showMoney = can(ctx, 'invoices', 'view');
    const gk: Record<string, [string, string]> = {
      source: [`COALESCE(NULLIF(co.source,''),'unknown')`, `COALESCE(NULLIF(co.source,''),'Unknown')`],
      owner: [`co.owner_id::text`, `COALESCE(u.name,'Unassigned')`],
      campaign: [`COALESCE(NULLIF(co.campaign,''),'none')`, `COALESCE(NULLIF(co.campaign,''),'No campaign')`],
      industry: [`COALESCE(NULLIF(co.industry,''),'unknown')`, `COALESCE(NULLIF(co.industry,''),'Unknown')`],
    };
    const rows = await q<any>(`SELECT ${gk[group][0]} k, ${gk[group][1]} label,
      count(*)::int leads,
      count(*) FILTER (WHERE co.lead_status IN ('qualified','converted') OR co.stage IN ('qualified','client','inactive'))::int qualified,
      count(*) FILTER (WHERE co.stage IN ('client','inactive'))::int clients,
      COALESCE(sum((SELECT count(*) FROM opportunities o WHERE o.company_id=co.id)),0)::int opportunities,
      COALESCE(sum((SELECT count(*) FROM opportunities o WHERE o.company_id=co.id AND o.stage='won')),0)::int won,
      COALESCE(sum((SELECT COALESCE(sum(value_cents),0) FROM opportunities o WHERE o.company_id=co.id AND o.stage='won')),0)::bigint won_value,
      COALESCE(sum((SELECT count(*) FROM placements p WHERE p.company_id=co.id)),0)::int placements,
      COALESCE(sum((SELECT COALESCE(sum(total_cents),0) FROM invoices i WHERE i.company_id=co.id AND i.status IN ${REVENUE_STATUSES} AND i.issue_date BETWEEN $2::date AND $3::date)),0)::bigint revenue
      FROM companies co LEFT JOIN users u ON u.id=co.owner_id WHERE co.organization_id=$1 AND co.archived_at IS NULL AND co.created_at::date <= $3::date AND (co.created_at::date >= $2::date OR co.stage IN ('client','inactive'))
      GROUP BY 1,2 ORDER BY leads DESC LIMIT 50`, [ctx.orgId, r.from, r.to]);
    const profit = showMoney ? await q<any>(`SELECT ${gk[group][0]} k, ${REV_SQL} rev, ${COST_SQL} cost FROM ${APPROVED_DAYS} JOIN companies co ON co.id=p.company_id LEFT JOIN users u ON u.id=co.owner_id WHERE td.organization_id=$1 AND td.work_date BETWEEN $2::date AND $3::date GROUP BY 1`, [ctx.orgId, r.from, r.to]) : [];
    const out = rows.map(x => {
      const pr = profit.find(p => p.k === x.k);
      const link = group === 'source' ? drill('/crm/leads', r, { source: x.k }) : group === 'owner' ? drill('/crm/leads', r, { owner: x.k ?? '' }) : group === 'campaign' ? drill('/crm/leads', r, { campaign: x.k }) : drill('/crm/leads', r, { industry: x.k });
      return { ...x, won_value: showMoney ? num(x.won_value) : null, revenue: showMoney ? num(x.revenue) : null, profit: showMoney ? num(pr?.rev) - num(pr?.cost) : null, win_rate: x.opportunities ? Math.round((x.won / x.opportunities) * 1000) / 10 : null, link };
    });
    const t = out.reduce((a, x) => ({ leads: a.leads + x.leads, qualified: a.qualified + x.qualified, opportunities: a.opportunities + x.opportunities, won: a.won + x.won, clients: a.clients + x.clients, placements: a.placements + x.placements, revenue: a.revenue + (x.revenue ?? 0), profit: a.profit + (x.profit ?? 0) }), { leads: 0, qualified: 0, opportunities: 0, won: 0, clients: 0, placements: 0, revenue: 0, profit: 0 });
    const opp = await q<any>(`SELECT stage, count(*)::int n, COALESCE(sum(value_cents),0)::bigint v FROM opportunities WHERE organization_id=$1 AND archived_at IS NULL AND created_at::date BETWEEN $2::date AND $3::date GROUP BY 1`, [ctx.orgId, r.from, r.to]);
    return {
      range: r, group, showMoney, rows: out,
      funnel: [
        { key: 'leads', label: 'Leads', value: t.leads, link: drill('/crm/leads', r) },
        { key: 'qualified', label: 'Qualified', value: t.qualified, link: drill('/crm/leads', r, { status: 'qualified' }) },
        { key: 'opportunities', label: 'Opportunities', value: t.opportunities, link: drill('/crm/opportunities', r) },
        { key: 'won', label: 'Won', value: t.won, link: drill('/crm/opportunities', r, { stage: 'won' }) },
        { key: 'placements', label: 'Placements', value: t.placements, link: drill('/workforce/placements', r) },
      ],
      totals: { ...t, revenue: showMoney ? t.revenue : null, profit: showMoney ? t.profit : null },
      opportunityStages: opp.map(o => ({ label: o.stage.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()), key: o.stage, value: o.n, amount: showMoney ? num(o.v) : null, link: drill('/crm/opportunities', r, { stage: o.stage }) })),
    };
  });

  // ── Finance (permissioned) ──
  app.get('/api/v1/analytics/finance', async (req) => {
    const ctx = staff(req);
    need(ctx, 'analytics', 'view');
    if (!can(ctx, 'invoices', 'view')) throw notFound();
    const r = rangeOf(req);
    const org = ctx.orgId;
    const m = await margin(org, r.from, r.to), pm = await margin(org, r.prevFrom, r.prevTo);
    const kpis = [
      kpi('revenue', 'Revenue', await revenue(org, r.from, r.to), await revenue(org, r.prevFrom, r.prevTo), 'money', drill('/finance/invoices', r)),
      ...(can(ctx, 'payroll', 'view') ? [kpi('payroll', 'Payroll', await payroll(org, r.from, r.to), await payroll(org, r.prevFrom, r.prevTo), 'money', drill('/finance/payroll', r), { invert: true })] : []),
      kpi('gross_profit', 'Gross Profit', m.profit, pm.profit, 'money', drill('/finance/margin', r)),
      kpi('margin_pct', 'Gross Margin %', m.pct ?? 0, pm.pct, 'pct', drill('/finance/margin', r), { pts: true }),
    ];
    const series = await moneySeries(ctx, r);
    const aging = await one<any>(`SELECT
      COALESCE(sum(total_cents-paid_cents) FILTER (WHERE due_date >= current_date),0)::bigint current,
      COALESCE(sum(total_cents-paid_cents) FILTER (WHERE current_date - due_date BETWEEN 1 AND 30),0)::bigint d30,
      COALESCE(sum(total_cents-paid_cents) FILTER (WHERE current_date - due_date BETWEEN 31 AND 60),0)::bigint d60,
      COALESCE(sum(total_cents-paid_cents) FILTER (WHERE current_date - due_date BETWEEN 61 AND 90),0)::bigint d90,
      COALESCE(sum(total_cents-paid_cents) FILTER (WHERE current_date - due_date > 90),0)::bigint d90p
      FROM invoices WHERE organization_id=$1 AND status IN ${OPEN_AR_STATUSES}`, [org]);
    const ar = [
      { key: 'current', label: 'Current', value: num(aging.current), link: '/finance/ar?aging=current' },
      { key: '1-30', label: '1–30 days', value: num(aging.d30), link: '/finance/ar?aging=1-30' },
      { key: '31-60', label: '31–60 days', value: num(aging.d60), link: '/finance/ar?aging=31-60' },
      { key: '61-90', label: '61–90 days', value: num(aging.d90), link: '/finance/ar?aging=61-90' },
      { key: '90+', label: '90+ days', value: num(aging.d90p), link: '/finance/ar?aging=90%2B' },
    ];
    const byClient = (await q<any>(`SELECT co.id, co.name, ${REV_SQL} rev, ${COST_SQL} cost, COALESCE(sum(td.minutes),0)::bigint minutes FROM ${APPROVED_DAYS} JOIN companies co ON co.id=p.company_id WHERE td.organization_id=$1 AND td.work_date BETWEEN $2::date AND $3::date GROUP BY co.id, co.name ORDER BY 3 DESC LIMIT 15`, [org, r.from, r.to]))
      .map(x => ({ id: x.id, label: x.name, revenue: num(x.rev), cost: num(x.cost), profit: num(x.rev) - num(x.cost), minutes: num(x.minutes), margin: num(x.rev) ? Math.round(((num(x.rev) - num(x.cost)) / num(x.rev)) * 1000) / 10 : null, link: LINK.client(x.id) }));
    const comp = canViewComp(ctx);
    const byWorker = comp ? (await q<any>(`SELECT w.id, concat_ws(' ', c.first_name, c.last_name) name, co.name company, ${REV_SQL} rev, ${COST_SQL} cost, COALESCE(sum(td.minutes),0)::bigint minutes FROM ${APPROVED_DAYS} JOIN workers w ON w.id=p.worker_id JOIN candidates c ON c.id=w.candidate_id JOIN companies co ON co.id=p.company_id WHERE td.organization_id=$1 AND td.work_date BETWEEN $2::date AND $3::date GROUP BY w.id, c.first_name, c.last_name, co.name ORDER BY 4 DESC LIMIT 15`, [org, r.from, r.to]))
      .map(x => ({ id: x.id, label: x.name, sub: x.company, revenue: num(x.rev), cost: num(x.cost), profit: num(x.rev) - num(x.cost), minutes: num(x.minutes), margin: num(x.rev) ? Math.round(((num(x.rev) - num(x.cost)) / num(x.rev)) * 1000) / 10 : null, link: LINK.worker(x.id) })) : null;
    let commissions = null;
    if (can(ctx, 'commissions', 'view')) {
      const own = scopeOf(ctx, 'commissions', 'view') === 'own';
      commissions = (await q<any>(`SELECT u.id, u.name, count(*)::int n, COALESCE(sum(e.calculated_cents),0)::bigint calculated, COALESCE(sum(COALESCE(e.approved_cents,0)) FILTER (WHERE e.status IN ('approved','settled')),0)::bigint approved, COALESCE(sum(e.settled_cents),0)::bigint settled
        FROM commission_entitlements e JOIN users u ON u.id=e.user_id WHERE e.organization_id=$1 AND e.period_start <= $3::date AND e.period_end >= $2::date ${own ? 'AND e.user_id=$4' : ''} GROUP BY u.id, u.name ORDER BY calculated DESC`, own ? [org, r.from, r.to, ctx.userId] : [org, r.from, r.to]))
        .map(x => ({ id: x.id, label: x.name, entitlements: x.n, calculated: num(x.calculated), approved: num(x.approved), settled: num(x.settled), link: drill('/finance/commissions', r, { user: x.id }) }));
    }
    return { range: r, kpis, series, ar, arTotal: ar.reduce((a, x) => a + x.value, 0), byClient, byWorker, commissions, showPayroll: can(ctx, 'payroll', 'view') };
  });

  // ── Workforce ──
  app.get('/api/v1/analytics/workforce', async (req) => {
    const ctx = staff(req);
    need(ctx, 'analytics', 'view');
    if (!can(ctx, 'workers', 'view') && !can(ctx, 'placements', 'view')) throw notFound();
    const r = rangeOf(req, 91);
    const org = ctx.orgId;
    const unit = bucketOf(r);
    const buckets = bucketsBetween(r.from, r.to, unit);
    const params = [org, r.from, r.to];
    const att = await q<any>(`SELECT date_trunc('${unit}', work_date)::date::text k, count(*) FILTER (WHERE kind='late')::int late, count(*) FILTER (WHERE kind='absent')::int absent, count(*) FILTER (WHERE kind='on_time')::int on_time FROM attendance_events WHERE organization_id=$1 AND work_date BETWEEN $2::date AND $3::date GROUP BY 1`, params);
    const hrs = await q<any>(`SELECT date_trunc('${unit}', te.work_date)::date::text k, round(sum(${ENTRY_MIN}))::bigint m FROM time_entries te WHERE te.organization_id=$1 AND te.work_date BETWEEN $2::date AND $3::date GROUP BY 1`, params);
    const appr = await q<any>(`SELECT date_trunc('${unit}', td.work_date)::date::text k, sum(td.minutes)::bigint m FROM timesheet_days td JOIN timesheets t ON t.id=td.timesheet_id AND t.status IN ('approved','locked') WHERE td.organization_id=$1 AND td.work_date BETWEEN $2::date AND $3::date GROUP BY 1`, params);
    const series = buckets.map(b => {
      const a = att.find(x => x.k === b.key);
      return { label: b.label, from: b.from, to: b.to, late: a?.late ?? 0, absent: a?.absent ?? 0, on_time: a?.on_time ?? 0, tracked: num(hrs.find(x => x.k === b.key)?.m), approved: num(appr.find(x => x.k === b.key)?.m), link: drill('/time/attendance', b) };
    });
    // Utilization = tracked minutes / scheduled minutes (weekly_hours prorated over the days each placement was live in the range).
    const util = await q<any>(`WITH live AS (
        SELECT p.id, p.company_id, p.worker_id, p.weekly_hours,
          GREATEST(0, LEAST($3::date, COALESCE(p.ended_at::date, p.end_date, $3::date)) - GREATEST($2::date, p.start_date) + 1) days
        FROM placements p WHERE p.organization_id=$1 AND p.activated_at IS NOT NULL AND p.start_date <= $3::date AND COALESCE(p.ended_at::date, p.end_date, '9999-12-31') >= $2::date)
      SELECT co.id, co.name, round(sum(l.weekly_hours * 60.0 * l.days / 7))::bigint scheduled,
        COALESCE((SELECT round(sum(${ENTRY_MIN})) FROM time_entries te WHERE te.organization_id=$1 AND te.work_date BETWEEN $2::date AND $3::date AND te.placement_id = ANY(array_agg(l.id))),0)::bigint tracked,
        count(*)::int placements
      FROM live l JOIN companies co ON co.id=l.company_id GROUP BY co.id, co.name ORDER BY scheduled DESC`, params);
    const utilRows = util.map(u => ({ id: u.id, label: u.name, scheduled: num(u.scheduled), tracked: num(u.tracked), placements: u.placements, value: num(u.scheduled) ? Math.round((num(u.tracked) / num(u.scheduled)) * 1000) / 10 : 0, link: LINK.client(u.id) }));
    const totSched = utilRows.reduce((a, u) => a + u.scheduled, 0), totTracked = utilRows.reduce((a, u) => a + u.tracked, 0);
    const turnover = await one<any>(`SELECT count(*) FILTER (WHERE status='ended' AND COALESCE(ended_at::date, end_date) BETWEEN $2::date AND $3::date)::int ended,
      count(*) FILTER (WHERE start_date BETWEEN $2::date AND $3::date AND activated_at IS NOT NULL)::int started,
      count(*) FILTER (WHERE activated_at IS NOT NULL AND start_date <= $2::date AND COALESCE(ended_at::date, end_date, '9999-12-31') >= $2::date)::int at_start,
      count(*) FILTER (WHERE activated_at IS NOT NULL AND start_date <= $3::date AND COALESCE(ended_at::date, end_date, '9999-12-31') >= $3::date)::int at_end
      FROM placements WHERE organization_id=$1`, params);
    const avgHead = (turnover.at_start + turnover.at_end) / 2;
    const reasons = await q<any>(`SELECT COALESCE(NULLIF(end_reason,''),'Not recorded') label, count(*)::int value FROM placements WHERE organization_id=$1 AND status='ended' AND COALESCE(ended_at::date, end_date) BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY 2 DESC`, params);
    const lateWorkers = await q<any>(`SELECT w.id, concat_ws(' ', c.first_name, c.last_name) name, count(*) FILTER (WHERE a.kind='late')::int late, count(*) FILTER (WHERE a.kind='absent')::int absent, round(avg(a.minutes) FILTER (WHERE a.kind='late'))::int avg_late FROM attendance_events a JOIN workers w ON w.id=a.worker_id JOIN candidates c ON c.id=w.candidate_id WHERE a.organization_id=$1 AND a.work_date BETWEEN $2::date AND $3::date AND a.kind IN ('late','absent') GROUP BY w.id, c.first_name, c.last_name ORDER BY count(*) DESC LIMIT 10`, params);
    const totLate = series.reduce((a, s) => a + s.late, 0), totAbsent = series.reduce((a, s) => a + s.absent, 0);
    const totTr = series.reduce((a, s) => a + s.tracked, 0), totAp = series.reduce((a, s) => a + s.approved, 0);
    return {
      range: r, unit, series,
      kpis: [
        kpi('tracked', 'Tracked Hours', totTr, null, 'hours', drill('/time/timesheets', r)),
        kpi('approved', 'Approved Hours', totAp, null, 'hours', drill('/time/timesheets', r, { status: 'approved' })),
        { key: 'utilization', label: 'Utilization', value: totSched ? Math.round((totTracked / totSched) * 1000) / 10 : 0, prev: null, delta: null, format: 'pct', to: drill('/workforce/placements', r, { status: 'active' }), deltaLabel: 'tracked vs scheduled hours' },
        { key: 'turnover', label: 'Turnover', value: avgHead ? Math.round((turnover.ended / avgHead) * 1000) / 10 : 0, prev: null, delta: null, format: 'pct', to: drill('/workforce/placements', r, { status: 'ended' }), deltaLabel: `${turnover.ended} ended · ${turnover.started} started`, invert: true },
        kpi('late', 'Late Arrivals', totLate, null, 'num', drill('/time/attendance', r, { kind: 'late' }), { invert: true }),
        kpi('absent', 'Absences', totAbsent, null, 'num', drill('/time/attendance', r, { kind: 'absent' }), { invert: true }),
      ],
      utilization: utilRows, turnover: { ...turnover, avgHeadcount: avgHead, reasons },
      lateWorkers: lateWorkers.map(x => ({ ...x, link: LINK.worker(x.id) })),
    };
  });
}
