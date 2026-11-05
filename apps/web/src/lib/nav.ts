import { LayoutDashboard, Target, Briefcase, Users, MonitorDot, Wallet, MessagesSquare, FileText, BarChart3, Bot, AppWindow, Settings, HelpCircle, type LucideIcon } from 'lucide-react';

/** `also`: extra path prefixes that keep this tab highlighted (e.g. Margin under "Rates & Margin"). */
export interface SubTab { label: string; path: string; perm?: [string, string?]; exact?: boolean; also?: string[]; /** Not in the design's tab list: shown under the top bar's "More" menu. */ more?: boolean }
export interface NavModule { key: string; label: string; icon: LucideIcon; path: string; match: string; tabs: SubTab[]; perm?: string[]; badge?: 'leads' | 'timesheets' | 'inbox' }

// Sidebar + top-bar tabs, as in the design handoff (labels and order). `more` tabs keep existing, working screens
// reachable (Assessments, Issues, Payouts, extra analytics and settings pages) under the top bar's "More" menu.
export const NAV: NavModule[] = [
  { key: 'home', label: 'Dashboard', icon: LayoutDashboard, path: '/', match: '/', tabs: [{ label: 'Overview', path: '/', exact: true }, { label: 'My Tasks', path: '/my-tasks' }, { label: 'Needs Attention', path: '/attention' }] },
  { key: 'crm', label: 'Leads & CRM', icon: Target, path: '/crm/leads', match: '/crm', badge: 'leads', perm: ['leads', 'clients', 'contacts', 'opportunities'], tabs: [
    { label: 'Leads', path: '/crm/leads', perm: ['leads'] }, { label: 'Clients', path: '/crm/clients', perm: ['clients'], also: ['/crm/companies'] }, { label: 'Contacts', path: '/crm/contacts', perm: ['contacts'] },
    { label: 'Opportunities', path: '/crm/opportunities', perm: ['opportunities'] }, { label: 'Tasks', path: '/crm/tasks', perm: ['tasks'] }, { label: 'Activities', path: '/crm/activities', perm: ['activities'] }] },
  { key: 'recruiting', label: 'Recruiting', icon: Briefcase, path: '/recruiting', match: '/recruiting', perm: ['positions', 'candidates'], tabs: [
    { label: 'Overview', path: '/recruiting', exact: true }, { label: 'Positions', path: '/recruiting/positions' }, { label: 'Candidates', path: '/recruiting/candidates' },
    { label: 'Applications', path: '/recruiting/applications' }, { label: 'Submissions', path: '/recruiting/submissions' }, { label: 'Interviews', path: '/recruiting/interviews' },
    { label: 'Offers', path: '/recruiting/offers' }, { label: 'Talent Pool', path: '/recruiting/talent-pool' }, { label: 'Sourcing', path: '/recruiting/my-sourced' },
    { label: 'Assessments', path: '/recruiting/assessments', more: true }] },
  { key: 'workforce', label: 'Workforce', icon: Users, path: '/workforce/workers', match: '/workforce', perm: ['workers', 'placements'], tabs: [
    { label: 'Directory', path: '/workforce/workers', also: ['/workforce/active', '/workforce/pending', '/workforce/available', '/workforce/on-leave', '/workforce/inactive'] },
    { label: 'Placements', path: '/workforce/placements' }, { label: 'Onboarding', path: '/workforce/onboarding' }, { label: 'Compliance', path: '/workforce/compliance' },
    { label: 'Time Off', path: '/workforce/time-off' }, { label: 'Issues', path: '/workforce/issues', more: true }] },
  { key: 'time', label: 'Remote Team', icon: MonitorDot, path: '/time/live', match: '/time', badge: 'timesheets', perm: ['time', 'timesheets', 'screenshots'], tabs: [
    { label: 'Live Status', path: '/time/live' }, { label: 'Screenshots', path: '/time/screenshots' }, { label: 'Timesheets', path: '/time/timesheets' }, { label: 'Attendance', path: '/time/attendance' },
    { label: 'Apps & Activity', path: '/time/activity' }, { label: 'Manual Time', path: '/time/manual' }, { label: 'Clock In', path: '/time/clock' }] },
  { key: 'finance', label: 'Payroll & Finance', icon: Wallet, path: '/finance', match: '/finance', perm: ['invoices', 'payroll', 'rates', 'commissions'], tabs: [
    { label: 'Overview', path: '/finance', exact: true }, { label: 'Payroll', path: '/finance/payroll' }, { label: 'Invoices', path: '/finance/invoices' }, { label: 'Payments', path: '/finance/ar' },
    { label: 'Rates & Margin', path: '/finance/rates', also: ['/finance/margin'] }, { label: 'Commissions', path: '/finance/commissions' }, { label: 'Expenses', path: '/finance/expenses' },
    { label: 'Payouts', path: '/finance/payouts', more: true }] },
  { key: 'comms', label: 'Communications', icon: MessagesSquare, path: '/comms/inbox', match: '/comms', badge: 'inbox', perm: ['messages'], tabs: [
    { label: 'Inbox', path: '/comms/inbox' }, { label: 'Notifications', path: '/comms/notifications' }, { label: 'Templates', path: '/comms/templates' }] },
  { key: 'documents', label: 'Documents', icon: FileText, path: '/documents', match: '/documents', perm: ['documents'], tabs: [
    { label: 'Library', path: '/documents', exact: true }, { label: 'Templates', path: '/documents/templates' }, { label: 'Signatures', path: '/documents/signatures' }, { label: 'Compliance', path: '/documents/compliance' }] },
  { key: 'analytics', label: 'Reports & Analytics', icon: BarChart3, path: '/analytics', match: '/analytics', perm: ['analytics'], tabs: [
    { label: 'Overview', path: '/analytics', exact: true }, { label: 'Recruiting', path: '/analytics/recruiting' }, { label: 'Financial', path: '/analytics/finance' }, { label: 'Report Builder', path: '/analytics/reports' },
    { label: 'Sales', path: '/analytics/sales', more: true }, { label: 'Workforce', path: '/analytics/workforce', more: true }] },
  { key: 'automation', label: 'Automation', icon: Bot, path: '/automation', match: '/automation', perm: ['automation'], tabs: [
    { label: 'Workflows', path: '/automation', exact: true }, { label: 'Run History', path: '/automation/runs' }] },
];
export const NAV_OTHER: NavModule[] = [
  { key: 'portals', label: 'Portals', icon: AppWindow, path: '/portals', match: '/portals', tabs: [{ label: 'Portals', path: '/portals' }] },
  { key: 'settings', label: 'Settings', icon: Settings, path: '/settings', match: '/settings', tabs: [
    { label: 'General', path: '/settings', exact: true }, { label: 'Team & Permissions', path: '/settings/team' }, { label: 'Onboarding Templates', path: '/settings/onboarding' },
    { label: 'Integrations', path: '/settings/integrations' }, { label: 'Billing & Plan', path: '/settings/billing' }, { label: 'Time Tracking', path: '/settings/monitoring' },
    { label: 'Audit Log', path: '/settings/audit' }, { label: 'My Profile', path: '/settings/profile' },
    { label: 'Roles', path: '/settings/roles', more: true }, { label: 'Portals', path: '/settings/portals', more: true }, { label: 'AI', path: '/settings/ai', more: true }, { label: 'Equipment', path: '/settings/equipment', more: true },
    { label: 'Payroll', path: '/settings/payroll', more: true }, { label: 'Invoices', path: '/settings/invoices', more: true }, { label: 'Custom Fields', path: '/settings/custom-fields', more: true },
    { label: 'Notifications', path: '/settings/notifications', more: true }, { label: 'Import Center', path: '/settings/import', more: true }, { label: 'API & Webhooks', path: '/settings/api', more: true }] },
  { key: 'help', label: 'Help Center', icon: HelpCircle, path: '/help', match: '/help', tabs: [{ label: 'Help Center', path: '/help', exact: true }, { label: 'Support Tickets', path: '/help/tickets' }] },
];
export const ALL_NAV = [...NAV, ...NAV_OTHER];

/** Routes that render inside another module's shell (aliases keep old deep links working). */
const PATH_OWNER: [string, string][] = [['/profile', 'settings'], ['/time/time-off', 'workforce']];

export function moduleFor(pathname: string): NavModule {
  const owner = PATH_OWNER.find(([p]) => pathname === p || pathname.startsWith(p + '/'));
  if (owner) return ALL_NAV.find(m => m.key === owner[1])!;
  if (pathname === '/my-tasks' || pathname === '/attention') return NAV[0];
  const sorted = [...ALL_NAV].filter(m => m.match !== '/').sort((a, b) => b.match.length - a.match.length);
  return sorted.find(m => pathname === m.match || pathname.startsWith(m.match + '/')) ?? NAV[0];
}

export function isTabActive(t: SubTab, pathname: string): boolean {
  const hit = (p: string, exact?: boolean) => (exact ? pathname === p : pathname === p || pathname.startsWith(p + '/'));
  return hit(t.path, t.exact) || (t.also ?? []).some(p => hit(p)) || (t.path === '/settings/profile' && pathname === '/profile') || (t.path === '/workforce/time-off' && pathname === '/time/time-off');
}
