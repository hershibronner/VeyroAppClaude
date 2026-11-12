import { lazy, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, type RouteObject } from 'react-router-dom';
import { Activity, Bell, Building2, CreditCard, Flag, Gauge, HeartPulse, KeyRound, LayoutDashboard, LifeBuoy, LogOut, Menu as MenuIcon, Settings, ShieldAlert, ShieldCheck, Tags, Users } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { useApi, useInterval } from '../../lib/hooks';
import { relTime } from '../../lib/format';
import { Avatar, Button, EmptyState, Menu, PermissionDenied } from '../../components/ui';
import { VeyroMark, ImpersonationBar } from '../../components/Shell';
import { CommandSearch } from './CommandSearch';
import '../settings/settings.css';

const Overview = lazy(() => import('./Overview'));
const Agencies = lazy(() => import('./Agencies'));
const AgencyDetail = lazy(() => import('./AgencyDetail'));
const Invoices = lazy(() => import('./Revenue').then(m => ({ default: m.InvoicesPage })));
const Seats = lazy(() => import('./Revenue').then(m => ({ default: m.SeatsPage })));
const Plans = lazy(() => import('./Revenue').then(m => ({ default: m.PlansPage })));
const Flags = lazy(() => import('./Ops').then(m => ({ default: m.FlagsPage })));
const Providers = lazy(() => import('./Ops').then(m => ({ default: m.ProvidersPage })));
const System = lazy(() => import('./Ops').then(m => ({ default: m.SystemPage })));
const Security = lazy(() => import('./Ops').then(m => ({ default: m.SecurityPage })));
const Tickets = lazy(() => import('./Helpdesk'));
const Impersonation = lazy(() => import('./Support').then(m => ({ default: m.ImpersonationPage })));
const Admins = lazy(() => import('./Admins').then(m => ({ default: m.AdminsPage })));
const PlatformSettings = lazy(() => import('./Admins').then(m => ({ default: m.SettingsPage })));
const ApiReference = lazy(() => import('../settings/ApiDocs').then(m => ({ default: () => <PublicDocs><m.ApiReference standalone /></PublicDocs> })));

const NAV = [
  { group: 'Overview', items: [{ to: '/platform', label: 'Control center', icon: LayoutDashboard, end: true }] },
  { group: 'Customers', items: [{ to: '/platform/agencies', label: 'Agencies', icon: Building2 }, { to: '/platform/invoices', label: 'Subscriptions & invoices', icon: CreditCard }, { to: '/platform/seats', label: 'Seat usage', icon: Users }, { to: '/platform/plans', label: 'Plans & pricing', icon: Tags }, { to: '/platform/flags', label: 'Feature flags', icon: Flag }] },
  { group: 'Support', items: [{ to: '/platform/tickets', label: 'Support tickets', icon: LifeBuoy }, { to: '/platform/impersonation', label: 'Impersonation', icon: ShieldAlert }] },
  { group: 'Operations', items: [{ to: '/platform/providers', label: 'Provider health', icon: HeartPulse }, { to: '/platform/system', label: 'System health', icon: Gauge }, { to: '/platform/security', label: 'Audit & security', icon: ShieldCheck }] },
  { group: 'Platform', items: [{ to: '/platform/admins', label: 'Platform admins', icon: KeyRound }, { to: '/platform/settings', label: 'Platform settings', icon: Settings }] },
];

/** Sidebar badge for a nav item, from /platform/nav-counts. */
function badgeFor(to: string, c: any): { value: number; tone: string; title: string } | null {
  if (!c) return null;
  if (to === '/platform/tickets' && c.tickets) return { value: c.tickets, tone: c.my_tickets ? 'hot' : '', title: `${c.tickets} open ticket(s) waiting on VeyroApp${c.my_tickets ? `, ${c.my_tickets} assigned to you` : ''}` };
  if (to === '/platform/invoices' && c.failed_invoices) return { value: c.failed_invoices, tone: 'hot', title: `${c.failed_invoices} failed invoice(s)` };
  if (to === '/platform/impersonation' && c.sessions) return { value: c.sessions, tone: 'warn', title: `${c.sessions} support session(s) active` };
  if (to === '/platform/system' && c.failed_jobs) return { value: c.failed_jobs, tone: 'hot', title: `${c.failed_jobs} failed job(s) in 24h` };
  return null;
}

function Splash() { return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><div className="muted"><span className="spinner" /> Loading…</div></div>; }

function PlatformShell() {
  const { me, loading, logout, switchOrg } = useAuth();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const counts = useApi<any>(me?.isPlatformAdmin && !me.impersonator ? '/api/v1/platform/nav-counts' : null, [me?.isPlatformAdmin]);
  useInterval(() => { if (me?.isPlatformAdmin) counts.reload(); }, 30000);
  useEffect(() => { setOpen(false); window.scrollTo(0, 0); if (me?.isPlatformAdmin) counts.reload(); }, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading) return <Splash />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (me.impersonator) return <div style={{ minHeight: '100vh', background: 'var(--bg)' }}><ImpersonationBar /><EmptyState icon={<ShieldAlert size={22} />} title="You are in support mode" text={`End the support session as ${me.user.name} to return to the Platform Control Center.`} /></div>;
  if (!me.isPlatformAdmin) return <div style={{ minHeight: '100vh', background: 'var(--bg)', paddingTop: 80 }}><PermissionDenied text="The Platform Control Center is only available to VeyroApp platform admins." /><div style={{ textAlign: 'center' }}><Link to="/" className="btn">Back to my workspace</Link></div></div>;
  return (
    <div className="st-pshell">
      {open && <div className="overlay" style={{ zIndex: 110 }} onClick={() => setOpen(false)} />}
      <aside className={`st-pside ${open ? 'open' : ''}`} aria-label="Platform navigation">
        <Link to="/platform" className="logo" style={{ textDecoration: 'none' }}><VeyroMark /> VeyroApp <span className="tiny" style={{ color: '#9D7BFF', fontWeight: 600, marginLeft: 2 }}>PLATFORM</span></Link>
        {NAV.map(g => <div key={g.group}><div className="lbl">{g.group}</div><nav>{g.items.map(i => { const n = badgeFor(i.to, counts.data); return <NavLink key={i.to} to={i.to} end={(i as any).end} className={({ isActive }) => (isActive ? 'active' : '')}><i.icon size={17} /><span style={{ flex: 1 }}>{i.label}</span>{n ? <em className={`st-nbadge ${n.tone}`} title={n.title}>{n.value}</em> : null}</NavLink>; })}</nav></div>)}
        <div style={{ marginTop: 'auto', padding: 16 }} className="tiny">Signed in as platform staff. Tenant branding never applies here.</div>
      </aside>
      <div className="st-pmain">
        <header className="st-ptop">
          <button className="icon-btn st-pmenu" aria-label="Open menu" onClick={() => setOpen(true)}><MenuIcon size={20} /></button>
          <span className="bold st-ptitle">Platform Control Center</span>
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}><CommandSearch pages={NAV.flatMap(g => g.items.map(i => ({ to: i.to, label: i.label, group: g.group })))} /></div>
          <PlatformBell />
          {me.workspace && <Link to="/" className="btn btn-sm desktop-only">Open {me.workspace.org.name}</Link>}
          <Menu label="Account menu" trigger={<button className="user-chip" aria-label="Account menu"><Avatar name={me.user.name} color={me.user.avatar_color} size={30} /><span className="user-name desktop-only">{me.user.name}</span></button>} items={[
            { label: <span><div className="bold">{me.user.name}</div><div className="small muted">{me.user.email}</div></span>, disabled: true }, { sep: true },
            ...me.memberships.map(m => ({ label: `Open ${m.name}`, icon: <Building2 size={16} />, onClick: async () => { if (me.workspace?.org.id !== m.id) await switchOrg(m.id); window.location.href = m.role_kind === 'agency' ? '/' : `/portal/${m.role_kind}`; } })),
            { label: 'Sign out', icon: <LogOut size={16} />, onClick: logout },
          ]} />
        </header>
        <main className="st-pcontent"><Outlet /></main>
      </div>
    </div>
  );
}

function PlatformBell() {
  const st = useApi<{ rows: any[]; unread: number }>('/api/v1/platform/notifications');
  const [open, setOpen] = useState(false);
  useInterval(() => st.reload(), 30000);
  const unread = st.data?.unread ?? 0;
  return (
    <div className="menu-wrap">
      <button className="icon-btn" aria-label={`Platform notifications${unread ? ` (${unread} unread)` : ''}`} onClick={() => setOpen(o => !o)}><Bell size={20} />{unread > 0 && <span className="badge-dot">{unread > 99 ? '99+' : unread}</span>}</button>
      {open && <><div style={{ position: 'fixed', inset: 0, zIndex: 55 }} onClick={() => setOpen(false)} />
        <div className="menu" style={{ width: 360, maxHeight: 460, overflowY: 'auto', padding: 0 }}>
          <div className="row" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-2)' }}><b style={{ flex: 1 }}>Platform activity</b><Button size="xs" variant="ghost" disabled={!unread} onClick={async () => { await api.post('/api/v1/platform/notifications/read-all'); st.reload(); }}>Mark all read</Button></div>
          {!st.data?.rows.length ? <EmptyState icon={<Activity size={22} />} title="No activity yet" /> : st.data.rows.map(n => (
            <Link key={n.id} to={n.link ?? '/platform'} onClick={() => setOpen(false)} style={{ display: 'block', padding: '10px 14px', borderBottom: '1px solid var(--border-2)', textDecoration: 'none', color: 'inherit', background: n.read_at ? undefined : 'var(--primary-50)' }}>
              <div className="bold small">{n.title}</div>{n.body && <div className="small muted truncate">{n.body}</div>}<div className="tiny muted">{relTime(n.created_at)}</div>
            </Link>
          ))}
        </div></>}
    </div>
  );
}

function PublicDocs({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: '100vh', background: 'var(--bg)' }}><header className="st-ptop"><Link to="/" className="row" style={{ gap: 10, textDecoration: 'none', color: 'var(--text)' }}><VeyroMark /> <b>VeyroApp API</b></Link><span style={{ flex: 1 }} /><a className="btn btn-sm" href="/api/v1/docs/openapi.json" download="veyroapp-openapi.json">openapi.json</a></header><main className="st-pcontent" style={{ maxWidth: 1180, margin: '0 auto' }}>{children}</main></div>;
}

export const publicRoutes: RouteObject[] = [
  { path: '/platform', element: <PlatformShell />, children: [
    { index: true, element: <Overview /> },
    { path: 'agencies', element: <Agencies /> },
    { path: 'agencies/:id', element: <AgencyDetail /> },
    { path: 'invoices', element: <Invoices /> },
    { path: 'seats', element: <Seats /> },
    { path: 'plans', element: <Plans /> },
    { path: 'flags', element: <Flags /> },
    { path: 'providers', element: <Providers /> },
    { path: 'system', element: <System /> },
    { path: 'security', element: <Security /> },
    { path: 'tickets', element: <Tickets /> },
    { path: 'impersonation', element: <Impersonation /> },
    { path: 'admins', element: <Admins /> },
    { path: 'settings', element: <PlatformSettings /> },
    { path: '*', element: <EmptyState title="Page not found" text="This Platform Control Center page does not exist." /> },
  ] },
  { path: '/docs/api', element: <ApiReference /> },
];
