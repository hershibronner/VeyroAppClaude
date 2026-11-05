import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { LogOut, User, Home, Users, UserSearch, CalendarClock, ClipboardCheck, Receipt, FileText, MessageSquare, UserPlus, UserCog, Settings, Timer, Calendar, Wallet, Plane, ListTodo, Wrench, Gauge, GraduationCap, Bell, IdCard, Film, Send, BookOpenCheck, Gift, CalendarCheck, ArrowLeftRight, type LucideIcon } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Avatar, Menu } from '../components/ui';
import { WorkspaceLogo, ImpersonationBar, VeyroMark } from '../components/Shell';
import { realtime } from '../lib/realtime';
import { api } from '../lib/api';
import { toast } from '../lib/toast';

export type PortalKind = 'client' | 'worker' | 'candidate';
interface PortalNavItem { label: string; path: string; icon: LucideIcon; count?: 'notifications' }
export const PORTAL_LABEL: Record<PortalKind, string> = { client: 'Client portal', worker: 'Worker portal', candidate: 'Candidate portal' };
export const PORTAL_NAV: Record<PortalKind, PortalNavItem[]> = {
  client: [
    { label: 'Home', path: '', icon: Home }, { label: 'My Team', path: 'team', icon: Users }, { label: 'Candidates', path: 'candidates', icon: UserSearch }, { label: 'Interviews', path: 'interviews', icon: CalendarClock },
    { label: 'Timesheets', path: 'timesheets', icon: ClipboardCheck }, { label: 'Invoices', path: 'invoices', icon: Receipt }, { label: 'Documents', path: 'documents', icon: FileText }, { label: 'Messages', path: 'messages', icon: MessageSquare },
    { label: 'Request a Worker', path: 'request', icon: UserPlus }, { label: 'Users', path: 'users', icon: UserCog }, { label: 'Settings', path: 'settings', icon: Settings },
  ],
  worker: [
    { label: 'Today', path: '', icon: Home }, { label: 'Time Tracker', path: 'tracker', icon: Timer }, { label: 'Schedule', path: 'schedule', icon: Calendar }, { label: 'Timesheets', path: 'timesheets', icon: ClipboardCheck },
    { label: 'Pay & Payslips', path: 'pay', icon: Wallet }, { label: 'Expenses', path: 'expenses', icon: Receipt }, { label: 'Time-off', path: 'time-off', icon: Plane }, { label: 'Tasks', path: 'tasks', icon: ListTodo }, { label: 'Messages', path: 'messages', icon: MessageSquare },
    { label: 'Documents', path: 'documents', icon: FileText }, { label: 'Onboarding', path: 'onboarding', icon: Wrench }, { label: 'Performance', path: 'performance', icon: Gauge }, { label: 'Training', path: 'training', icon: GraduationCap },
    { label: 'Profile', path: 'profile', icon: IdCard }, { label: 'Notifications', path: 'notifications', icon: Bell, count: 'notifications' },
  ],
  candidate: [
    { label: 'Profile', path: '', icon: IdCard }, { label: 'Resume & Media', path: 'media', icon: Film }, { label: 'Applications', path: 'applications', icon: Send }, { label: 'Assessments', path: 'assessments', icon: BookOpenCheck },
    { label: 'Interviews', path: 'interviews', icon: CalendarClock }, { label: 'Offers', path: 'offers', icon: Gift }, { label: 'Documents', path: 'documents', icon: FileText }, { label: 'Availability', path: 'availability', icon: CalendarCheck }, { label: 'Messages', path: 'messages', icon: MessageSquare },
  ],
};

/** Tenant-branded chrome for client, worker and candidate portals (top header, not a sidebar). */
export function PortalShell({ kind }: { kind: PortalKind }) {
  const { me, logout, switchOrg } = useAuth();
  const loc = useLocation();
  const ws = me!.workspace!;
  const m = me!.memberships.find(x => x.id === ws.org.id)!;
  const [unread, setUnread] = useState(0);
  useEffect(() => { realtime.connect(ws.org.id); api.get('/api/v1/notifications?unread=1').then(r => setUnread(r.unread)).catch(() => {}); return realtime.on('notification', n => { setUnread(u => u + 1); toast.info(n.title); }); }, [ws.org.id]);
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);
  const base = `/portal/${kind}`;
  const others = me!.memberships.filter(x => x.id !== ws.org.id);
  const to = (n: PortalNavItem) => (n.path ? `${base}/${n.path}` : base);
  const count = (n: PortalNavItem) => (n.count === 'notifications' && unread > 0 ? unread : 0);
  const sub = ws.role.kind === 'client' && ws.companyId ? `${ws.role.name}` : ws.role.name;
  return (
    <div className="portal">
      <ImpersonationBar />
      <header className="portal-top">
        <div className="portal-top-in">
          <Link to={base} className="portal-brand">
            {m && <WorkspaceLogo m={m} size={36} />}
            <span style={{ minWidth: 0 }}><span className="portal-org truncate">{ws.branding?.logo_text ?? ws.org.name}</span><span className="portal-label truncate">{PORTAL_LABEL[kind]}</span></span>
          </Link>
          <nav className="portal-nav" aria-label="Portal">
            {PORTAL_NAV[kind].map(n => <NavLink key={n.path} end={n.path === ''} to={to(n)} className={({ isActive }) => (isActive ? 'active' : '')}>{n.label}{count(n) > 0 && <span className="portal-count">{count(n)}</span>}</NavLink>)}
          </nav>
          <div style={{ marginLeft: 'auto' }}>
            <Menu label="Account menu" trigger={<button className="user-chip" aria-label="Account menu"><Avatar name={me!.user.name} color={me!.user.avatar_color} size={30} /><span className="portal-user desktop-only"><span className="bold">{me!.user.name}</span><span className="tiny muted truncate">{sub}</span></span></button>} items={[
              { label: <span><div className="bold">{me!.user.name}</div><div className="small muted">{ws.role.name} · {ws.org.name}</div></span>, disabled: true },
              { sep: true },
              ...(kind === 'worker' ? [{ label: 'Profile', icon: <User size={16} />, onClick: () => (window.location.href = `${base}/profile`) }] : []),
              ...others.map(o => ({ label: `Switch to ${o.name}`, icon: <ArrowLeftRight size={16} />, onClick: () => switchOrg(o.id) })),
              { sep: true },
              { label: 'Sign out', icon: <LogOut size={16} />, onClick: logout },
            ]} />
          </div>
        </div>
        <nav className="portal-nav-m" aria-label="Portal sections">
          {PORTAL_NAV[kind].map(n => <NavLink key={n.path} end={n.path === ''} to={to(n)} className={({ isActive }) => (isActive ? 'active' : '')}><n.icon size={16} />{n.label}{count(n) > 0 && <span className="portal-count">{count(n)}</span>}</NavLink>)}
        </nav>
      </header>
      <main className="portal-content"><Outlet /></main>
      <footer className="portal-foot">
        <div className="portal-foot-in">
          <span>© {new Date().getFullYear()} {ws.org.name}{ws.branding?.support_email ? ` · ${ws.branding.support_email}` : ''}</span>
          {!ws.branding?.hide_powered_by && <span className="row" style={{ gap: 6 }}>Powered by <VeyroMark size={14} /> <b style={{ color: 'var(--text)' }}>VeyroApp</b></span>}
        </div>
      </footer>
    </div>
  );
}
