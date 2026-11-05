// Permission matrix: resource × action → scope. Enforced server-side on every request.
export const RESOURCES = [
  'leads', 'clients', 'contacts', 'opportunities', 'tasks', 'activities',
  'positions', 'candidates', 'submissions', 'interviews', 'assessments', 'offers',
  'workers', 'placements', 'onboarding', 'issues',
  'time', 'timesheets', 'screenshots', 'attendance', 'time_off',
  'rates', 'invoices', 'payments', 'payroll', 'payouts', 'commissions', 'margin',
  'messages', 'templates', 'documents', 'automation', 'analytics', 'reports',
  'settings', 'team', 'roles', 'audit', 'integrations', 'billing', 'imports', 'exports',
] as const;
export type Resource = (typeof RESOURCES)[number];
export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'view_comp'] as const;
export type Action = (typeof ACTIONS)[number];
export type Scope = 'all' | 'team' | 'assigned' | 'own' | 'none';
export type RoleMatrix = Partial<Record<Resource, Partial<Record<Action, Scope>>>>;

const ALL: Partial<Record<Action, Scope>> = { view: 'all', create: 'all', edit: 'all', delete: 'all', approve: 'all', export: 'all', view_comp: 'all' };
const RW: Partial<Record<Action, Scope>> = { view: 'all', create: 'all', edit: 'all', export: 'all' };
const RO: Partial<Record<Action, Scope>> = { view: 'all' };
const fill = (res: readonly Resource[], p: Partial<Record<Action, Scope>>): RoleMatrix => Object.fromEntries(res.map(r => [r, { ...p }]));

const CRM = ['leads', 'clients', 'contacts', 'opportunities', 'tasks', 'activities'] as const;
const REC = ['positions', 'candidates', 'submissions', 'interviews', 'assessments', 'offers'] as const;
const WF = ['workers', 'placements', 'onboarding', 'issues', 'time', 'timesheets', 'screenshots', 'attendance', 'time_off'] as const;
const FIN = ['rates', 'invoices', 'payments', 'payroll', 'payouts', 'commissions', 'margin'] as const;
const COMMS = ['messages', 'templates', 'documents'] as const;

export const AGENCY_ROLES: { key: string; name: string; matrix: RoleMatrix }[] = [
  { key: 'owner', name: 'Owner', matrix: fill(RESOURCES, ALL) },
  { key: 'admin', name: 'Admin', matrix: fill(RESOURCES, ALL) },
  { key: 'management', name: 'Management', matrix: { ...fill(RESOURCES, { ...RW, approve: 'all', view_comp: 'all' }), roles: RO, billing: RO, audit: RO } },
  { key: 'recruiter', name: 'Recruiter', matrix: {
    ...fill(['candidates', 'submissions', 'interviews', 'assessments'], { view: 'all', create: 'all', edit: 'assigned', export: 'none' }),
    positions: { view: 'assigned', create: 'none', edit: 'assigned' },
    offers: { view: 'assigned', create: 'assigned', edit: 'assigned' },
    clients: RO, contacts: RO, tasks: { view: 'own', create: 'all', edit: 'own' }, activities: { view: 'all', create: 'all' },
    workers: RO, placements: RO, onboarding: RO, messages: RW, templates: RO, documents: { view: 'all', create: 'all' }, analytics: RO,
  } },
  { key: 'sales', name: 'Sales', matrix: { ...fill(CRM, { ...RW, delete: 'own' }), positions: { view: 'all', create: 'all', edit: 'all' }, candidates: RO, messages: RW, templates: RO, documents: { view: 'all', create: 'all' }, analytics: RO, reports: RO, commissions: { view: 'own' } } },
  { key: 'account_manager', name: 'Account Manager', matrix: { ...fill(WF, { ...RW, approve: 'all' }), ...fill(['clients', 'contacts', 'tasks', 'activities'], RW), positions: RW, candidates: RO, submissions: RW, interviews: RW, offers: RO, leads: RO, opportunities: RO, rates: { view: 'all', view_comp: 'all' }, invoices: RO, margin: RO, messages: RW, templates: RO, documents: RW, analytics: RO, commissions: { view: 'own' } } },
  { key: 'hr', name: 'HR / Worker Manager', matrix: { ...fill(WF, { ...RW, approve: 'all' }), ...fill(COMMS, RW), candidates: RO, clients: RO, contacts: RO, tasks: RW, activities: RW, offers: RO } },
  { key: 'finance', name: 'Finance / Payroll', matrix: { ...fill(FIN, ALL), timesheets: { view: 'all', approve: 'all', export: 'all' }, time: RO, clients: RO, contacts: RO, workers: RO, placements: { view: 'all', view_comp: 'all' }, analytics: RO, reports: RW, exports: RW, documents: RW, tasks: RW, activities: RW, messages: RW, templates: RO, integrations: RO } },
  { key: 'support', name: 'Support', matrix: { ...fill([...CRM, ...REC, ...WF], RO), messages: RW, tasks: RW, documents: RO } },
  { key: 'viewer', name: 'Viewer', matrix: fill([...CRM, ...REC, 'workers', 'placements', 'analytics'], RO) },
];

export const CLIENT_ROLES = [
  { key: 'client_owner', name: 'Client Owner' },
  { key: 'client_manager', name: 'Client Manager' },
  { key: 'client_supervisor', name: 'Client Supervisor' },
  { key: 'client_finance', name: 'Client Finance' },
  { key: 'client_viewer', name: 'Client Viewer' },
];

export const COMP_FIELDS = ['pay_rate_cents', 'bill_rate_cents', 'pay_min_cents', 'pay_max_cents', 'bill_budget_cents', 'rate_min_cents', 'rate_target_cents', 'gross_cents', 'net_cents'];

export function scopeFor(matrix: RoleMatrix, resource: Resource, action: Action): Scope {
  return matrix[resource]?.[action] ?? 'none';
}

/** Removes compensation fields from a record when the viewer lacks view_comp. */
export function stripComp<T extends Record<string, unknown>>(row: T, canViewComp: boolean): T {
  if (canViewComp) return row;
  const out: Record<string, unknown> = { ...row };
  for (const k of Object.keys(out)) if (COMP_FIELDS.includes(k) || /(_rate_cents|pay_.*_cents|bill_.*_cents)$/.test(k)) out[k] = undefined;
  return out as T;
}
