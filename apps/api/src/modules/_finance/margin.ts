// Margin & commissions. Gross margin = billed − worker cost of the same approved days.
// Revenue per day uses the bill rate effective that day (linesByRate, half-up per line);
// cost uses computePayroll (regular + OT at the effective pay rate).
import { linesByRate, computePayroll, computeCommission, grossMargin, sumCents } from '@veyro/shared';
import { q, one, type Db } from '../../core/db';
import { ratesFor, monthStart, monthEnd } from './common';

export interface EconRow {
  placement_id: string; month: string; title: string; worker_id: string; worker_name: string; company_id: string; company_name: string;
  account_manager_id: string | null; account_manager_name: string | null; recruiter_id: string | null; recruiter_name: string | null; recruiter_team: string | null; sales_id: string | null;
  start_date: string; minutes: number; revenue_cents: number; cost_cents: number; gp_cents: number; margin_pct: number; currency: string;
}

export async function economics(db: Db, orgId: string, from: string, to: string, opts: { billedOnly?: boolean; companyId?: string | null; placementId?: string | null } = {}): Promise<EconRow[]> {
  const params: unknown[] = [orgId, from, to];
  const where = [`d.organization_id=$1`, `d.work_date BETWEEN $2 AND $3`, `t.status IN ('approved','locked')`, `d.minutes > 0`];
  if (opts.billedOnly) where.push(`d.invoice_id IS NOT NULL AND EXISTS (SELECT 1 FROM invoices i WHERE i.id=d.invoice_id AND i.status <> 'void')`);
  if (opts.companyId) { params.push(opts.companyId); where.push(`p.company_id=$${params.length}`); }
  if (opts.placementId) { params.push(opts.placementId); where.push(`p.id=$${params.length}`); }
  const days = await q<any>(`SELECT d.placement_id, d.work_date, d.minutes FROM timesheet_days d JOIN timesheets t ON t.id=d.timesheet_id JOIN placements p ON p.id=d.placement_id WHERE ${where.join(' AND ')}`, params, db);
  if (!days.length) return [];
  const plIds = [...new Set(days.map(d => d.placement_id))];
  const pls = await q<any>(`SELECT p.id, p.title, p.worker_id, p.company_id, p.start_date, p.account_manager_id, p.recruiter_id, p.sales_id, co.name company_name, c.first_name, c.last_name, am.name am_name, rc.name rc_name,
      (SELECT m.team FROM organization_memberships m WHERE m.user_id=p.recruiter_id AND m.organization_id=p.organization_id LIMIT 1) rc_team
    FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates c ON c.id=w.candidate_id JOIN companies co ON co.id=p.company_id
    LEFT JOIN users am ON am.id=p.account_manager_id LEFT JOIN users rc ON rc.id=p.recruiter_id WHERE p.id = ANY($1)`, [plIds], db);
  const rates = await ratesFor(db, orgId, plIds);
  const out: EconRow[] = [];
  for (const p of pls) {
    const pr = rates.get(p.id) ?? [];
    const byMonth = new Map<string, { date: string; minutes: number }[]>();
    for (const d of days) if (d.placement_id === p.id) { const m = monthStart(d.work_date); (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push({ date: d.work_date, minutes: d.minutes }); }
    for (const [month, md] of byMonth) {
      let revenue = 0, cost = 0;
      try { revenue = sumCents(linesByRate(md, pr, 'bill').map(l => l.amountCents)); cost = computePayroll(md, pr).grossTimeCents; } catch { continue; }
      const gm = grossMargin(revenue, cost);
      out.push({ placement_id: p.id, month, title: p.title, worker_id: p.worker_id, worker_name: [p.first_name, p.last_name].filter(Boolean).join(' '), company_id: p.company_id, company_name: p.company_name,
        account_manager_id: p.account_manager_id, account_manager_name: p.am_name, recruiter_id: p.recruiter_id, recruiter_name: p.rc_name, recruiter_team: p.rc_team, sales_id: p.sales_id, start_date: p.start_date,
        minutes: md.reduce((a, x) => a + x.minutes, 0), revenue_cents: revenue, cost_cents: cost, gp_cents: gm.gpCents, margin_pct: gm.marginPct, currency: pr[0]?.currency ?? 'USD' });
    }
  }
  return out;
}

export function rollup<K extends string>(rows: EconRow[], keyOf: (r: EconRow) => K, labelOf: (r: EconRow) => string) {
  const m = new Map<K, { key: K; label: string; revenue_cents: number; cost_cents: number; minutes: number; placements: Set<string> }>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = m.get(k) ?? { key: k, label: labelOf(r), revenue_cents: 0, cost_cents: 0, minutes: 0, placements: new Set<string>() };
    g.revenue_cents += r.revenue_cents; g.cost_cents += r.cost_cents; g.minutes += r.minutes; g.placements.add(r.placement_id);
    m.set(k, g);
  }
  return [...m.values()].map(g => { const gm = grossMargin(g.revenue_cents, g.cost_cents); return { id: String(g.key), key: g.key, label: g.label, revenue_cents: g.revenue_cents, cost_cents: g.cost_cents, gp_cents: gm.gpCents, margin_pct: gm.marginPct, minutes: g.minutes, placements: g.placements.size }; });
}

function monthsBetween(a: string, b: string) { return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7))); }

/**
 * Computes commission entitlements for one month from billed revenue − worker cost of the same approved days.
 * Upserts rows still in 'calculated' status; approved/settled/rejected rows are never changed.
 */
export async function computeEntitlements(db: Db, orgId: string, month: string) {
  const ms = monthStart(month); const me = monthEnd(ms);
  const rules = await q<any>(`SELECT * FROM commission_rules WHERE organization_id=$1 AND active`, [orgId], db);
  const rows = await economics(db, orgId, ms, me, { billedOnly: true });
  let created = 0, updated = 0, unchanged = 0;
  for (const r of rows) {
    for (const rule of rules) {
      const userId = rule.applies_to === 'recruiter' ? r.recruiter_id : rule.applies_to === 'sales' ? r.sales_id : r.account_manager_id;
      if (!userId || (rule.user_id && rule.user_id !== userId)) continue;
      const amount = computeCommission({ kind: rule.kind, pctBp: rule.pct_bp ?? undefined, fixedCents: rule.fixed_cents != null ? Number(rule.fixed_cents) : undefined, monthsLimit: rule.months_limit, tiers: rule.tiers ?? undefined },
        r.gp_cents, { monthsSinceStart: monthsBetween(r.start_date, ms), isFirstPeriod: monthStart(r.start_date) === ms });
      if (!amount) continue;
      const ex = await one<any>(`SELECT * FROM commission_entitlements WHERE rule_id=$1 AND user_id=$2 AND placement_id=$3 AND period_start=$4`, [rule.id, userId, r.placement_id, ms], db);
      if (!ex) {
        await q(`INSERT INTO commission_entitlements (organization_id, rule_id, user_id, placement_id, period_start, period_end, revenue_cents, cost_cents, gp_cents, calculated_cents, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'calculated')`, [orgId, rule.id, userId, r.placement_id, ms, me, r.revenue_cents, r.cost_cents, r.gp_cents, amount], db);
        created++;
      } else if (ex.status === 'calculated' && (Number(ex.calculated_cents) !== amount || Number(ex.revenue_cents) !== r.revenue_cents || Number(ex.cost_cents) !== r.cost_cents)) {
        await q(`UPDATE commission_entitlements SET revenue_cents=$2, cost_cents=$3, gp_cents=$4, calculated_cents=$5 WHERE id=$1`, [ex.id, r.revenue_cents, r.cost_cents, r.gp_cents, amount], db);
        updated++;
      } else unchanged++;
    }
  }
  return { period_start: ms, period_end: me, created, updated, unchanged, placements: rows.length };
}
