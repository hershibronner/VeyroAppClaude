// Report Builder engine: a whitelisted entity/field catalogue compiled to parameterised SQL (never interpolates user input).
import { q, one } from '../../core/db';
import { badRequest, forbidden } from '../../core/errors';
import { ENTRY_MIN } from './common';

export type FieldType = 'text' | 'number' | 'money' | 'date' | 'minutes' | 'bool';
export interface FieldDef { key: string; label: string; sql: string; type: FieldType; comp?: boolean; options?: string[] }
export interface EntityDef { key: string; label: string; from: string; where: string; perm: [string, string]; perms?: [string, string][]; dateField: string; fields: FieldDef[]; link?: string; scopeSql?: string }

const name = (a: string) => `concat_ws(' ', ${a}.first_name, ${a}.last_name)`;
export const ENTITIES: EntityDef[] = [
  { key: 'candidates', label: 'Candidates', from: 'candidates c LEFT JOIN users su ON su.id=c.sourced_by', where: 'c.organization_id=$1 AND c.archived_at IS NULL', perm: ['candidates', 'view'], dateField: 'created_at', link: '/recruiting/candidates/{id}',
    fields: [
      { key: 'name', label: 'Name', sql: name('c'), type: 'text' }, { key: 'email', label: 'Email', sql: 'c.email', type: 'text' }, { key: 'country', label: 'Country', sql: 'c.country', type: 'text' },
      { key: 'source', label: 'Source', sql: 'c.source', type: 'text' }, { key: 'status', label: 'Status', sql: 'c.status', type: 'text', options: ['new_applicant', 'screening', 'assessment', 'recruiter_review', 'interview', 'qualified', 'talent_pool', 'submitted', 'hired', 'on_hold', 'future', 'rejected', 'withdrawn', 'blacklisted'] },
      { key: 'headline', label: 'Headline', sql: 'c.headline', type: 'text' }, { key: 'years_experience', label: 'Years experience', sql: 'c.years_experience', type: 'number' },
      { key: 'sourced_by', label: 'Sourced by', sql: 'su.name', type: 'text' }, { key: 'availability', label: 'Availability', sql: 'c.availability_status', type: 'text' },
      { key: 'rate_target', label: 'Target rate', sql: 'c.rate_target_cents', type: 'money', comp: true }, { key: 'created_at', label: 'Created', sql: 'c.created_at::date', type: 'date' },
    ] },
  { key: 'applications', label: 'Applications', from: 'applications a JOIN candidates c ON c.id=a.candidate_id LEFT JOIN positions pos ON pos.id=a.position_id LEFT JOIN companies co ON co.id=pos.company_id LEFT JOIN users ru ON ru.id=a.recruiter_id', where: 'a.organization_id=$1', perm: ['candidates', 'view'], dateField: 'created_at', link: '/recruiting/candidates/{candidate_id}',
    fields: [
      { key: 'candidate', label: 'Candidate', sql: name('c'), type: 'text' }, { key: 'position', label: 'Position', sql: `COALESCE(pos.title, 'General application')`, type: 'text' }, { key: 'client', label: 'Client', sql: 'co.name', type: 'text' },
      { key: 'source', label: 'Source', sql: 'a.source', type: 'text' }, { key: 'status', label: 'Status', sql: 'a.status', type: 'text', options: ['new', 'reviewed', 'advanced', 'rejected'] }, { key: 'recruiter', label: 'Recruiter', sql: 'ru.name', type: 'text' },
      { key: 'country', label: 'Country', sql: 'c.country', type: 'text' }, { key: 'created_at', label: 'Applied', sql: 'a.created_at::date', type: 'date' },
    ] },
  { key: 'positions', label: 'Positions', from: 'positions p LEFT JOIN companies co ON co.id=p.company_id', where: 'p.organization_id=$1 AND p.archived_at IS NULL', perm: ['positions', 'view'], dateField: 'created_at', link: '/recruiting/positions/{id}',
    scopeSql: `EXISTS (SELECT 1 FROM position_recruiter_assignments pra WHERE pra.position_id=p.id AND pra.user_id=$USER AND pra.unassigned_at IS NULL)`,
    fields: [
      { key: 'title', label: 'Title', sql: 'p.title', type: 'text' }, { key: 'client', label: 'Client', sql: 'co.name', type: 'text' }, { key: 'status', label: 'Status', sql: 'p.status', type: 'text', options: ['draft', 'open', 'on_hold', 'filled', 'closed'] },
      { key: 'urgency', label: 'Urgency', sql: 'p.urgency', type: 'text' }, { key: 'openings', label: 'Openings', sql: 'p.openings', type: 'number' }, { key: 'filled', label: 'Filled', sql: 'p.filled', type: 'number' },
      { key: 'employment_type', label: 'Employment type', sql: 'p.employment_type', type: 'text' }, { key: 'bill_budget', label: 'Bill budget', sql: 'p.bill_budget_cents', type: 'money', comp: true }, { key: 'created_at', label: 'Created', sql: 'p.created_at::date', type: 'date' },
    ] },
  { key: 'companies', label: 'Companies (leads & clients)', from: 'companies co LEFT JOIN users ou ON ou.id=co.owner_id LEFT JOIN users am ON am.id=co.account_manager_id', where: 'co.organization_id=$1 AND co.archived_at IS NULL', perm: ['clients', 'view'], perms: [['leads', 'view']], dateField: 'created_at', link: '/crm/companies/{id}',
    fields: [
      { key: 'name', label: 'Name', sql: 'co.name', type: 'text' }, { key: 'stage', label: 'Stage', sql: 'co.stage', type: 'text', options: ['lead', 'qualified', 'client', 'inactive'] }, { key: 'lead_status', label: 'Lead status', sql: 'co.lead_status', type: 'text' },
      { key: 'source', label: 'Source', sql: 'co.source', type: 'text' }, { key: 'industry', label: 'Industry', sql: 'co.industry', type: 'text' }, { key: 'country', label: 'Country', sql: 'co.country', type: 'text' },
      { key: 'owner', label: 'Owner', sql: 'ou.name', type: 'text' }, { key: 'account_manager', label: 'Account manager', sql: 'am.name', type: 'text' }, { key: 'lead_score', label: 'Lead score', sql: 'co.lead_score', type: 'number' },
      { key: 'est_monthly_value', label: 'Est. monthly value', sql: 'co.est_monthly_value_cents', type: 'money' }, { key: 'created_at', label: 'Created', sql: 'co.created_at::date', type: 'date' },
    ] },
  { key: 'opportunities', label: 'Opportunities', from: 'opportunities o LEFT JOIN companies co ON co.id=o.company_id LEFT JOIN users ou ON ou.id=o.owner_id', where: 'o.organization_id=$1 AND o.archived_at IS NULL', perm: ['opportunities', 'view'], dateField: 'created_at', link: '/crm/opportunities/{id}',
    fields: [
      { key: 'name', label: 'Name', sql: 'o.name', type: 'text' }, { key: 'company', label: 'Company', sql: 'co.name', type: 'text' }, { key: 'stage', label: 'Stage', sql: 'o.stage', type: 'text', options: ['new', 'discovery', 'proposal', 'negotiation', 'won', 'lost'] },
      { key: 'owner', label: 'Owner', sql: 'ou.name', type: 'text' }, { key: 'source', label: 'Source', sql: 'o.source', type: 'text' }, { key: 'value', label: 'Value', sql: 'o.value_cents', type: 'money' },
      { key: 'probability', label: 'Probability %', sql: 'o.probability', type: 'number' }, { key: 'expected_close', label: 'Expected close', sql: 'o.expected_close', type: 'date' }, { key: 'created_at', label: 'Created', sql: 'o.created_at::date', type: 'date' },
    ] },
  { key: 'placements', label: 'Placements', from: 'placements p JOIN workers w ON w.id=p.worker_id JOIN candidates c ON c.id=w.candidate_id JOIN companies co ON co.id=p.company_id LEFT JOIN users am ON am.id=p.account_manager_id LEFT JOIN users ru ON ru.id=p.recruiter_id', where: 'p.organization_id=$1', perm: ['placements', 'view'], dateField: 'start_date', link: '/workforce/placements/{id}',
    fields: [
      { key: 'worker', label: 'Worker', sql: name('c'), type: 'text' }, { key: 'client', label: 'Client', sql: 'co.name', type: 'text' }, { key: 'title', label: 'Title', sql: 'p.title', type: 'text' },
      { key: 'status', label: 'Status', sql: 'p.status', type: 'text', options: ['onboarding', 'active', 'on_leave', 'notice', 'ended'] }, { key: 'start_date', label: 'Start date', sql: 'p.start_date', type: 'date' }, { key: 'end_date', label: 'End date', sql: 'p.end_date', type: 'date' },
      { key: 'weekly_hours', label: 'Weekly hours', sql: 'p.weekly_hours', type: 'number' }, { key: 'account_manager', label: 'Account manager', sql: 'am.name', type: 'text' }, { key: 'recruiter', label: 'Recruiter', sql: 'ru.name', type: 'text' },
      { key: 'country', label: 'Worker country', sql: 'c.country', type: 'text' },
      { key: 'bill_rate', label: 'Current bill rate', sql: `(SELECT bill_rate_cents FROM placement_rates r WHERE r.placement_id=p.id ORDER BY effective_from DESC LIMIT 1)`, type: 'money', comp: true },
      { key: 'pay_rate', label: 'Current pay rate', sql: `(SELECT pay_rate_cents FROM placement_rates r WHERE r.placement_id=p.id ORDER BY effective_from DESC LIMIT 1)`, type: 'money', comp: true },
    ] },
  { key: 'time_entries', label: 'Time entries', from: 'time_entries te JOIN workers w ON w.id=te.worker_id JOIN candidates c ON c.id=w.candidate_id JOIN placements p ON p.id=te.placement_id JOIN companies co ON co.id=p.company_id', where: 'te.organization_id=$1', perm: ['time', 'view'], perms: [['timesheets', 'view']], dateField: 'work_date',
    fields: [
      { key: 'worker', label: 'Worker', sql: name('c'), type: 'text' }, { key: 'client', label: 'Client', sql: 'co.name', type: 'text' }, { key: 'work_date', label: 'Work date', sql: 'te.work_date', type: 'date' },
      { key: 'minutes', label: 'Hours', sql: `round(${ENTRY_MIN})::int`, type: 'minutes' }, { key: 'source', label: 'Source', sql: 'te.source', type: 'text' }, { key: 'memo', label: 'Memo', sql: 'te.memo', type: 'text' },
    ] },
  { key: 'timesheets', label: 'Timesheets', from: 'timesheets t JOIN workers w ON w.id=t.worker_id JOIN candidates c ON c.id=w.candidate_id JOIN companies co ON co.id=t.company_id', where: 't.organization_id=$1', perm: ['timesheets', 'view'], dateField: 'week_start', link: '/time/timesheets/{id}',
    fields: [
      { key: 'worker', label: 'Worker', sql: name('c'), type: 'text' }, { key: 'client', label: 'Client', sql: 'co.name', type: 'text' }, { key: 'week_start', label: 'Week of', sql: 't.week_start', type: 'date' },
      { key: 'status', label: 'Status', sql: 't.status', type: 'text', options: ['open', 'submitted', 'approved', 'rejected', 'locked'] }, { key: 'total_minutes', label: 'Hours', sql: 't.total_minutes', type: 'minutes' },
    ] },
  { key: 'attendance', label: 'Attendance events', from: 'attendance_events ae JOIN workers w ON w.id=ae.worker_id JOIN candidates c ON c.id=w.candidate_id LEFT JOIN placements p ON p.id=ae.placement_id LEFT JOIN companies co ON co.id=p.company_id', where: 'ae.organization_id=$1', perm: ['attendance', 'view'], dateField: 'work_date',
    fields: [
      { key: 'worker', label: 'Worker', sql: name('c'), type: 'text' }, { key: 'client', label: 'Client', sql: 'co.name', type: 'text' }, { key: 'work_date', label: 'Date', sql: 'ae.work_date', type: 'date' },
      { key: 'kind', label: 'Kind', sql: 'ae.kind', type: 'text', options: ['on_time', 'late', 'absent', 'early_leave', 'screen_declined', 'time_off'] }, { key: 'minutes', label: 'Minutes late', sql: 'ae.minutes', type: 'number' },
    ] },
  { key: 'invoices', label: 'Invoices', from: 'invoices i JOIN companies co ON co.id=i.company_id', where: 'i.organization_id=$1', perm: ['invoices', 'view'], dateField: 'issue_date', link: '/finance/invoices/{id}',
    fields: [
      { key: 'number', label: 'Number', sql: 'i.number', type: 'text' }, { key: 'client', label: 'Client', sql: 'co.name', type: 'text' }, { key: 'status', label: 'Status', sql: 'i.status', type: 'text', options: ['draft', 'approved', 'sent', 'viewed', 'partially_paid', 'paid', 'overdue', 'written_off', 'void'] },
      { key: 'issue_date', label: 'Issue date', sql: 'i.issue_date', type: 'date' }, { key: 'due_date', label: 'Due date', sql: 'i.due_date', type: 'date' }, { key: 'total', label: 'Total', sql: 'i.total_cents', type: 'money' },
      { key: 'paid', label: 'Paid', sql: 'i.paid_cents', type: 'money' }, { key: 'balance', label: 'Balance', sql: '(i.total_cents - i.paid_cents)', type: 'money' }, { key: 'currency', label: 'Currency', sql: 'i.currency', type: 'text' },
    ] },
  { key: 'payroll_items', label: 'Payroll items', from: 'payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id JOIN workers w ON w.id=pi.worker_id JOIN candidates c ON c.id=w.candidate_id LEFT JOIN companies co ON co.id=pi.company_id', where: 'pi.organization_id=$1', perm: ['payroll', 'view'], dateField: 'pay_date',
    fields: [
      { key: 'worker', label: 'Worker', sql: name('c'), type: 'text' }, { key: 'client', label: 'Client', sql: 'co.name', type: 'text' }, { key: 'pay_date', label: 'Pay date', sql: 'r.pay_date', type: 'date' },
      { key: 'run_status', label: 'Run status', sql: 'r.status', type: 'text' }, { key: 'regular_minutes', label: 'Regular hours', sql: 'pi.regular_minutes', type: 'minutes' }, { key: 'ot_minutes', label: 'OT hours', sql: 'pi.ot_minutes', type: 'minutes' },
      { key: 'gross', label: 'Gross', sql: 'pi.gross_cents', type: 'money', comp: true }, { key: 'net', label: 'Net', sql: 'pi.net_cents', type: 'money', comp: true },
    ] },
  { key: 'tasks', label: 'Tasks', from: 'tasks t LEFT JOIN users cu ON cu.id=t.created_by', where: 't.organization_id=$1 AND t.archived_at IS NULL', perm: ['tasks', 'view'], dateField: 'created_at',
    fields: [
      { key: 'title', label: 'Title', sql: 't.title', type: 'text' }, { key: 'status', label: 'Status', sql: 't.status', type: 'text', options: ['open', 'in_progress', 'done', 'cancelled'] }, { key: 'priority', label: 'Priority', sql: 't.priority', type: 'text', options: ['low', 'medium', 'high', 'urgent'] },
      { key: 'due_date', label: 'Due date', sql: 't.due_date', type: 'date' }, { key: 'assignee', label: 'Assignee', sql: `(SELECT string_agg(u.name, ', ') FROM task_assignees ta JOIN users u ON u.id=ta.user_id WHERE ta.task_id=t.id)`, type: 'text' },
      { key: 'related_type', label: 'Related to', sql: 't.related_type', type: 'text' }, { key: 'created_by', label: 'Created by', sql: 'cu.name', type: 'text' }, { key: 'created_at', label: 'Created', sql: 't.created_at::date', type: 'date' },
    ] },
  { key: 'documents', label: 'Documents', from: 'documents d', where: 'd.organization_id=$1 AND d.archived_at IS NULL', perm: ['documents', 'view'], dateField: 'created_at', link: '/documents/{id}',
    fields: [
      { key: 'name', label: 'Name', sql: 'd.name', type: 'text' }, { key: 'category', label: 'Category', sql: 'd.category', type: 'text' }, { key: 'visibility', label: 'Visibility', sql: 'd.visibility', type: 'text' },
      { key: 'verification', label: 'Verification', sql: 'd.verification', type: 'text' }, { key: 'signature_status', label: 'Signature', sql: 'd.signature_status', type: 'text' }, { key: 'expires_at', label: 'Expires', sql: 'd.expires_at', type: 'date' },
      { key: 'created_at', label: 'Uploaded', sql: 'd.created_at::date', type: 'date' },
    ] },
];

export interface ReportFilter { field: string; op: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'last_days' | 'between' | 'empty' | 'not_empty'; value?: unknown }
export interface ReportDef { entity: string; fields: string[]; filters: ReportFilter[]; group_by?: string | null; metric?: string | null; chart?: string; sort?: string | null; dir?: 'asc' | 'desc' }
export interface Viewer { orgId: string; userId: string; can: (res: string, act: string) => boolean; scope: (res: string, act: string) => string; comp: boolean }

export function entityFor(v: Viewer, key: string): EntityDef {
  const e = ENTITIES.find(x => x.key === key);
  if (!e) throw badRequest('Unknown report entity');
  if (!v.can(e.perm[0], e.perm[1]) && !(e.perms ?? []).some(p => v.can(p[0], p[1]))) throw forbidden(`Your role cannot report on ${e.label.toLowerCase()}`);
  return e;
}
export function catalogue(v: Viewer) {
  return ENTITIES.filter(e => v.can(e.perm[0], e.perm[1]) || (e.perms ?? []).some(p => v.can(p[0], p[1])))
    .map(e => ({ key: e.key, label: e.label, dateField: e.dateField, fields: e.fields.filter(f => !f.comp || v.comp).map(({ sql: _s, ...f }) => f) }));
}

// Older saved definitions used column-style names; map them to catalogue keys.
const ALIASES: Record<string, Record<string, string>> = { invoices: { company: 'client', total_cents: 'total', paid_cents: 'paid' }, time_entries: { hours: 'minutes', company: 'client' }, placements: { company: 'client' } };
export function normalizeDef(d: ReportDef): ReportDef {
  const a = ALIASES[d.entity] ?? {};
  const m = (k: string) => a[k] ?? k;
  const metric = d.metric && d.metric !== 'count' ? `${d.metric.split(':')[0]}:${m(d.metric.split(':')[1] ?? '')}` : d.metric;
  const [g, gran] = (d.group_by ?? '').split(':');
  return { ...d, fields: (d.fields ?? []).map(m), filters: (d.filters ?? []).map(f => ({ ...f, field: m(f.field) })), group_by: d.group_by ? (gran ? `${m(g)}:${gran}` : m(g)) : null, metric };
}

/** Compiles a definition to SQL. Returns rows + column metadata. */
export async function runReport(v: Viewer, d0: ReportDef, opts: { limit?: number; offset?: number } = {}) {
  const d = normalizeDef(d0);
  const e = entityFor(v, d.entity);
  const fieldOf = (k: string) => {
    const f = e.fields.find(x => x.key === k);
    if (!f) throw badRequest(`Unknown field "${k}"`);
    if (f.comp && !v.comp) throw forbidden('Your role cannot view compensation fields');
    return f;
  };
  const params: unknown[] = [v.orgId];
  const where = [e.where];
  if (e.scopeSql && v.scope(e.perm[0], e.perm[1]) === 'assigned') { params.push(v.userId); where.push(e.scopeSql.replace('$USER', `$${params.length}`)); }
  for (const f of d.filters ?? []) {
    const fd = fieldOf(f.field);
    const col = fd.sql;
    const val = (x: unknown) => { params.push(fd.type === 'money' && typeof x === 'number' ? Math.round(x) : x); return `$${params.length}`; };
    const cast = fd.type === 'date' ? '::date' : fd.type === 'text' ? '::text' : '::numeric';
    switch (f.op) {
      case 'eq': where.push(`${col} = ${val(f.value)}${cast}`); break;
      case 'neq': where.push(`${col} IS DISTINCT FROM ${val(f.value)}${cast}`); break;
      case 'contains': where.push(`${col}::text ILIKE ${val(`%${String(f.value ?? '')}%`)}`); break;
      case 'gt': where.push(`${col} > ${val(f.value)}${cast}`); break;
      case 'gte': where.push(`${col} >= ${val(f.value)}${cast}`); break;
      case 'lt': where.push(`${col} < ${val(f.value)}${cast}`); break;
      case 'lte': where.push(`${col} <= ${val(f.value)}${cast}`); break;
      case 'in': { const arr = Array.isArray(f.value) ? f.value.map(String) : String(f.value ?? '').split(',').map(s => s.trim()).filter(Boolean); params.push(arr); where.push(`${col}::text = ANY($${params.length}::text[])`); break; }
      case 'last_days': { const n = Math.max(1, Math.min(3650, Number(f.value) || 30)); params.push(n); where.push(`${col}::date >= current_date - $${params.length}::int`); break; }
      case 'between': { const [a, b] = Array.isArray(f.value) ? f.value : []; if (a) where.push(`${col} >= ${val(a)}${cast}`); if (b) where.push(`${col} <= ${val(b)}${cast}`); break; }
      case 'empty': where.push(`(${col} IS NULL OR ${col}::text = '')`); break;
      case 'not_empty': where.push(`(${col} IS NOT NULL AND ${col}::text <> '')`); break;
      default: throw badRequest('Unknown filter operator');
    }
  }
  const w = where.join(' AND ');
  const limit = Math.min(5000, opts.limit ?? 500);
  if (d.group_by) {
    const [gk, gran] = d.group_by.split(':');
    const gf = fieldOf(gk);
    const gexpr = gf.type === 'date' && ['day', 'week', 'month', 'year'].includes(gran ?? '') ? `date_trunc('${gran}', ${gf.sql})::date` : gf.sql;
    const metric = d.metric || 'count';
    let mexpr = 'count(*)';
    let mtype: FieldType = 'number';
    let mlabel = 'Count';
    if (metric !== 'count') {
      const [agg, mk] = metric.split(':');
      if (!['sum', 'avg', 'min', 'max'].includes(agg)) throw badRequest('Unknown metric');
      const mf = fieldOf(mk);
      if (!['number', 'money', 'minutes'].includes(mf.type)) throw badRequest('Metric field must be numeric');
      mexpr = `${agg}(${mf.sql})`;
      mtype = mf.type;
      mlabel = agg === 'sum' ? (/^total/i.test(mf.label) ? mf.label : `Total ${mf.label.toLowerCase()}`) : `${agg === 'avg' ? 'Average' : agg === 'min' ? 'Min' : 'Max'} ${mf.label.toLowerCase()}`;
    }
    const isDate = gf.type === 'date';
    const rows = await q<any>(`SELECT ${gexpr} AS g, round(${mexpr}::numeric, 2) AS v, count(*)::int n FROM ${e.from} WHERE ${w} GROUP BY 1 ORDER BY ${isDate ? '1 ASC NULLS LAST' : '2 DESC NULLS LAST'} LIMIT ${limit}`, params);
    return {
      entity: e.key, grouped: true,
      columns: [{ key: 'label', label: gf.label + (gran && isDate ? ` (${gran})` : ''), type: isDate ? 'date' : 'text' }, { key: 'value', label: mlabel, type: mtype }, ...(metric !== 'count' ? [{ key: 'count', label: 'Records', type: 'number' as FieldType }] : [])],
      rows: rows.map(r => ({ label: r.g === null || r.g === undefined || r.g === '' ? '(empty)' : String(r.g), raw: r.g, value: Number(r.v), count: r.n })),
      total: rows.length,
    };
  }
  const fields = (d.fields?.length ? d.fields : e.fields.filter(f => !f.comp || v.comp).slice(0, 6).map(f => f.key)).map(fieldOf);
  const idCol = e.from.split(' ')[1];
  const sel = [`${idCol}.id AS _id`, ...(e.link?.includes('{candidate_id}') ? [`${idCol}.candidate_id AS _candidate_id`] : []), ...fields.map(f => `${f.sql} AS "f_${f.key}"`)].join(', ');
  const sortF = d.sort ? fields.find(f => f.key === d.sort) : null;
  const order = sortF ? `"f_${sortF.key}" ${d.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST` : `${e.fields.find(f => f.key === e.dateField)?.sql ?? `${idCol}.id`} DESC NULLS LAST`;
  const total = (await one<any>(`SELECT count(*)::int n FROM ${e.from} WHERE ${w}`, params))!.n;
  const rows = await q<any>(`SELECT ${sel} FROM ${e.from} WHERE ${w} ORDER BY ${order} LIMIT ${limit} OFFSET ${Math.max(0, opts.offset ?? 0)}`, params);
  return {
    entity: e.key, grouped: false,
    columns: fields.map(f => ({ key: f.key, label: f.label, type: f.type })),
    rows: rows.map(r => {
      const o: Record<string, unknown> = { id: r._id, link: e.link ? e.link.replace('{id}', r._id).replace('{candidate_id}', r._candidate_id ?? '') : null };
      for (const f of fields) o[f.key] = r[`f_${f.key}`];
      return o;
    }),
    total,
  };
}

const fmtVal = (v: unknown, t: FieldType): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (t === 'money') return (Number(v) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  if (t === 'minutes') return `${(Number(v) / 60).toFixed(1)}h`;
  if (t === 'date') return String(v instanceof Date ? v.toISOString().slice(0, 10) : v).slice(0, 10);
  return String(v);
};
export function toCsvRows(res: Awaited<ReturnType<typeof runReport>>): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const raw = (v: unknown, t: FieldType) => (v === null || v === undefined ? '' : t === 'money' ? (Number(v) / 100).toFixed(2) : t === 'minutes' ? (Number(v) / 60).toFixed(2) : t === 'date' ? fmtVal(v, t) : String(v));
  const cols = res.columns;
  return [cols.map(c => esc(c.label + (c.type === 'minutes' ? ' (hours)' : ''))).join(','), ...res.rows.map((r: any) => cols.map(c => esc(raw(r[c.key], c.type as FieldType))).join(','))].join('\n');
}
/** Plain-text table for emails (Dev Outbox). */
export function toTextTable(res: Awaited<ReturnType<typeof runReport>>, max = 40): string {
  const cols = res.columns;
  const lines = res.rows.slice(0, max).map((r: any) => cols.map(c => fmtVal(r[c.key], c.type as FieldType)).join('  |  '));
  const head = cols.map(c => c.label).join('  |  ');
  return [head, '-'.repeat(Math.min(80, head.length + 8)), ...lines, res.rows.length > max ? `… and ${res.rows.length - max} more rows` : '', `${res.total} ${res.grouped ? 'groups' : 'records'} in total.`].filter(Boolean).join('\n');
}
