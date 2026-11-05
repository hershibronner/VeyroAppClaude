// Shared helpers for INSIGHTS + OPS modules (dashboard, analytics, reports, automations, documents, search).
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../core/context';
import { can } from '../../core/context';
import { badRequest } from '../../core/errors';

export const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function todayIso(): string { return new Date().toISOString().slice(0, 10); }
export function addDaysIso(iso: string, n: number): string { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function daysBetween(a: string, b: string): number { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
export function monthStartIso(iso: string): string { return iso.slice(0, 8) + '01'; }
export function addMonthsIso(iso: string, n: number): string { const d = new Date(iso.slice(0, 8) + '01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
export function mondayOf(iso: string): string { const d = new Date(iso + 'T00:00:00Z'); return addDaysIso(iso, -((d.getUTCDay() + 6) % 7)); }

export interface Range { from: string; to: string; prevFrom: string; prevTo: string; days: number }
/** Reads ?from=&to= (YYYY-MM-DD). Defaults to the last `defDays` days. Also returns the equally long previous range. */
export function rangeOf(req: FastifyRequest, defDays = 182): Range {
  const qy = (req.query ?? {}) as Record<string, string>;
  const to = qy.to && ISO.test(qy.to) ? qy.to : todayIso();
  const from = qy.from && ISO.test(qy.from) ? qy.from : addDaysIso(to, -defDays + 1);
  if (from > to) throw badRequest('"from" must be before "to"');
  const days = daysBetween(from, to) + 1;
  if (days > 3700) throw badRequest('Date range is too long (max 10 years)');
  return { from, to, days, prevTo: addDaysIso(from, -1), prevFrom: addDaysIso(from, -days) };
}

export const pctDelta = (cur: number, prev: number | null | undefined): number | null => (prev ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : null);

/** Minutes divisor for a rate unit (mirrors @veyro/shared UNIT_MINUTES). */
export const UNIT_DIV = (col: string) => `(CASE ${col} WHEN 'day' THEN 480 WHEN 'week' THEN 2400 WHEN 'month' THEN 10400 ELSE 60 END)`;
/** FROM clause for approved (approved/locked) timesheet days joined to the effective-dated rate for each work date. */
export const APPROVED_DAYS = `timesheet_days td
  JOIN timesheets t ON t.id = td.timesheet_id AND t.status IN ('approved','locked')
  JOIN placements p ON p.id = td.placement_id
  JOIN placement_rates pr ON pr.placement_id = td.placement_id AND pr.effective_from <= td.work_date AND (pr.effective_to IS NULL OR td.work_date <= pr.effective_to)`;
export const REV_SQL = `COALESCE(round(sum(pr.bill_rate_cents * td.minutes::numeric / ${UNIT_DIV('pr.unit')})),0)::bigint`;
export const COST_SQL = `COALESCE(round(sum(pr.pay_rate_cents * td.minutes::numeric / ${UNIT_DIV('pr.unit')})),0)::bigint`;
/** Worked minutes of a time entry (ended − started − break − discarded idle); open entries count up to now. */
export const ENTRY_MIN = `GREATEST(0, (EXTRACT(EPOCH FROM (COALESCE(te.ended_at, now()) - te.started_at)) - te.break_seconds - te.discarded_idle_seconds) / 60)`;
/** Invoice statuses that count as revenue (issued, not void/draft). */
export const REVENUE_STATUSES = `('approved','sent','viewed','partially_paid','paid','overdue')`;
export const OPEN_AR_STATUSES = `('sent','viewed','partially_paid','overdue')`;
/** Candidate statuses that count as "in pipeline". */
export const PIPELINE_STATUSES = ['new_applicant', 'screening', 'assessment', 'recruiter_review', 'interview', 'qualified', 'submitted'];

/** Web links for records (agency app). */
export const LINK = {
  client: (id: string) => `/crm/clients/${id}`,
  lead: (id: string) => `/crm/leads/${id}`,
  company: (id: string, stage?: string | null) => (stage === 'client' || stage === 'inactive' ? `/crm/clients/${id}` : `/crm/leads/${id}`),
  contact: (id: string) => `/crm/contacts/${id}`,
  opportunity: (id: string) => `/crm/opportunities/${id}`,
  task: (id: string) => `/crm/tasks?task=${id}`,
  position: (id: string) => `/recruiting/positions/${id}`,
  candidate: (id: string) => `/recruiting/candidates/${id}`,
  worker: (id: string) => `/workforce/workers/${id}`,
  placement: (id: string) => `/workforce/placements/${id}`,
  timesheet: (id: string) => `/time/timesheets/${id}`,
  invoice: (id: string) => `/finance/invoices/${id}`,
  payroll_run: (id: string) => `/finance/payroll/${id}`,
  payout: (id: string) => `/finance/payouts/${id}`,
  document: (id: string) => `/documents/${id}`,
  thread: (id: string) => `/comms/inbox?thread=${id}`,
  offer: (_id: string) => `/recruiting/offers`,
  interview: (_id: string) => `/recruiting/interviews`,
  submission: (_id: string) => `/recruiting/submissions`,
};
export function linkFor(type: string | null | undefined, id: string | null | undefined, extra?: { stage?: string | null }): string | null {
  if (!type || !id) return null;
  if (type === 'company') return LINK.company(id, extra?.stage);
  const f = (LINK as Record<string, (id: string) => string>)[type];
  return f ? f(id) : null;
}

/** Which resource gates visibility of an entity type (activities, documents, search). */
export const ENTITY_RESOURCE: Record<string, string> = {
  company: 'clients', contact: 'contacts', opportunity: 'opportunities', task: 'tasks', position: 'positions', candidate: 'candidates',
  placement: 'placements', worker: 'workers', invoice: 'invoices', payroll_run: 'payroll', offer: 'offers', interview: 'interviews',
  submission: 'submissions', timesheet: 'timesheets', document: 'documents',
};
export function canSeeEntity(ctx: Ctx, type: string): boolean {
  const r = ENTITY_RESOURCE[type];
  if (!r) return true;
  if (type === 'company') return can(ctx, 'clients', 'view') || can(ctx, 'leads', 'view');
  return can(ctx, r as any, 'view');
}
export function visibleEntityTypes(ctx: Ctx): string[] { return Object.keys(ENTITY_RESOURCE).filter(t => canSeeEntity(ctx, t)); }

/** SQL expression that resolves a human label for (entity_type, entity_id) columns. */
export function entityLabelSql(typeCol: string, idCol: string): string {
  return `CASE ${typeCol}
    WHEN 'company' THEN (SELECT name FROM companies WHERE id=${idCol})
    WHEN 'contact' THEN (SELECT concat_ws(' ', first_name, last_name) FROM contacts WHERE id=${idCol})
    WHEN 'opportunity' THEN (SELECT name FROM opportunities WHERE id=${idCol})
    WHEN 'position' THEN (SELECT title FROM positions WHERE id=${idCol})
    WHEN 'candidate' THEN (SELECT concat_ws(' ', first_name, last_name) FROM candidates WHERE id=${idCol})
    WHEN 'worker' THEN (SELECT concat_ws(' ', xc.first_name, xc.last_name) FROM workers xw JOIN candidates xc ON xc.id=xw.candidate_id WHERE xw.id=${idCol})
    WHEN 'placement' THEN (SELECT concat_ws(' ', xc.first_name, xc.last_name) || ' · ' || xp.title FROM placements xp JOIN workers xw ON xw.id=xp.worker_id JOIN candidates xc ON xc.id=xw.candidate_id WHERE xp.id=${idCol})
    WHEN 'invoice' THEN (SELECT number FROM invoices WHERE id=${idCol})
    WHEN 'task' THEN (SELECT title FROM tasks WHERE id=${idCol})
    WHEN 'timesheet' THEN (SELECT 'Week of ' || to_char(week_start, 'Mon DD') FROM timesheets WHERE id=${idCol})
    WHEN 'offer' THEN (SELECT 'Offer · ' || concat_ws(' ', xc.first_name, xc.last_name) FROM offers xo JOIN candidates xc ON xc.id=xo.candidate_id WHERE xo.id=${idCol})
    WHEN 'interview' THEN (SELECT 'Interview · ' || concat_ws(' ', xc.first_name, xc.last_name) FROM interviews xi JOIN candidates xc ON xc.id=xi.candidate_id WHERE xi.id=${idCol})
    WHEN 'submission' THEN (SELECT 'Submission · ' || concat_ws(' ', xc.first_name, xc.last_name) FROM candidate_submissions xs JOIN candidates xc ON xc.id=xs.candidate_id WHERE xs.id=${idCol})
    WHEN 'payroll_run' THEN (SELECT 'Payroll ' || to_char(period_start,'Mon DD') || '–' || to_char(period_end,'Mon DD') FROM payroll_runs WHERE id=${idCol})
    WHEN 'document' THEN (SELECT name FROM documents WHERE id=${idCol})
    ELSE NULL END`;
}

/** Rows of [month 'YYYY-MM-01', label 'Mon'] for the last n months ending this month. */
export function lastMonths(n: number, endIso = todayIso()): { month: string; label: string }[] {
  const out = [];
  const end = monthStartIso(endIso);
  for (let i = n - 1; i >= 0; i--) {
    const m = addMonthsIso(end, -i);
    out.push({ month: m, label: new Date(m + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + (n > 12 ? ` ${m.slice(2, 4)}` : '') });
  }
  return out;
}
/** Month buckets covering [from, to]. */
export function monthsBetween(from: string, to: string): { month: string; label: string }[] {
  const out = [];
  let m = monthStartIso(from);
  const last = monthStartIso(to);
  const multiYear = from.slice(0, 4) !== to.slice(0, 4);
  while (m <= last && out.length < 130) {
    out.push({ month: m, label: new Date(m + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + (multiYear ? ` '${m.slice(2, 4)}` : '') });
    m = addMonthsIso(m, 1);
  }
  return out;
}
/** Bucket granularity for a range: day (≤31d), week (≤190d) or month. */
export function bucketOf(r: { days: number }): 'day' | 'week' | 'month' { return r.days <= 31 ? 'day' : r.days <= 190 ? 'week' : 'month'; }
export function bucketsBetween(from: string, to: string, unit: 'day' | 'week' | 'month'): { key: string; label: string; from: string; to: string }[] {
  if (unit === 'month') return monthsBetween(from, to).map(m => ({ key: m.month, label: m.label, from: m.month < from ? from : m.month, to: addDaysIso(addMonthsIso(m.month, 1), -1) > to ? to : addDaysIso(addMonthsIso(m.month, 1), -1) }));
  const out = [];
  let d = unit === 'week' ? mondayOf(from) : from;
  while (d <= to && out.length < 400) {
    const end = unit === 'week' ? addDaysIso(d, 6) : d;
    out.push({ key: d, label: new Date(d + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), from: d < from ? from : d, to: end > to ? to : end });
    d = addDaysIso(end, 1);
  }
  return out;
}

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
