import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, ChevronsUpDown, Crown, LogOut, Menu as MenuIcon, Search, User, Plus, Check, ShieldAlert, Building2 } from 'lucide-react';
import { useAuth, type Membership } from '../lib/auth';
import { NAV, NAV_OTHER, moduleFor, isTabActive, type NavModule } from '../lib/nav';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { relTime } from '../lib/format';
import { toast } from '../lib/toast';
import { Avatar, Button, Dialog, Field, Menu, EmptyState, toBody } from './ui';
import { QuickCreateButton } from './QuickCreate';
import { GlobalSearch } from './GlobalSearch';

/** The VeyroApp four-point spark (brand-500). */
export function VeyroMark({ size = 24, color = 'var(--platform-blue)' }: { size?: number; color?: string }) {
  return <span className="mark" style={{ width: size, height: size, color }}><svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><path fill="currentColor" opacity=".95" d="M12 2.5 14 9l6.5-2-4.6 5 4.6 5-6.5-2L12 21.5 10 15l-6.5 2 4.6-5-4.6-5L10 9z" /></svg></span>;
}

export function WorkspaceLogo({ m, size = 32 }: { m: Pick<Membership, 'name' | 'primary_color' | 'logo_url' | 'logo_text'>; size?: number }) {
  return <span className="ws-logo" style={{ width: size, height: size, background: m.primary_color || 'var(--ink)' }}>{m.logo_url ? <img src={m.logo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (m.logo_text || m.name).split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()}</span>;
}

/** Workspace switcher card: lists memberships; switching keeps the session. */
export function WorkspaceSwitcher() {
  const { me, switchOrg } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ws = me!.workspace!;
  const current = me!.memberships.find(m => m.id === ws.org.id);
  const canCreate = ['owner', 'admin'].includes(ws.role.key);
  return (
    <div style={{ position: 'relative' }}>
      <button className="ws-switch" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Switch workspace">
        {current && <WorkspaceLogo m={current} />}
        <span style={{ flex: 1, minWidth: 0 }}><div className="ws-name truncate">{ws.org.name}</div><div className="ws-role">{ws.role.name}</div></span>
        <ChevronsUpDown size={16} color="var(--muted-2)" />
      </button>
      {open && (
        <div className="ws-menu" role="menu">
          <div className="tiny muted" style={{ padding: '4px 8px' }}>Your workspaces</div>
          {me!.memberships.map(m => (
            <button key={m.id} role="menuitem" onClick={async () => { setOpen(false); if (m.id !== ws.org.id) { await switchOrg(m.id); toast.success(`Switched to ${m.name}`); nav(m.role_kind === 'agency' ? '/' : `/portal/${m.role_kind}`); } }}>
              <WorkspaceLogo m={m} size={26} /><span style={{ flex: 1, minWidth: 0 }}><div className="truncate bold small">{m.name}</div><div className="tiny muted">{m.role_name}</div></span>{m.id === ws.org.id && <Check size={16} color="var(--primary)" />}
            </button>
          ))}
          {canCreate && <><div style={{ height: 1, background: 'var(--border-2)', margin: '4px 0' }} /><button onClick={() => { setOpen(false); setCreating(true); }}><Plus size={16} /> Create another agency</button></>}
        </div>
      )}
      <Dialog open={creating} onClose={() => setCreating(false)} title="Create another agency" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={name.trim().length < 2} onClick={async () => { setBusy(true); try { const o = await api.post('/api/v1/auth/create-agency', { name }); await switchOrg(o.id); setCreating(false); setName(''); nav('/'); toast.success(`${o.name} created — you are its Owner`); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Create agency</Button></>}>
        <p className="muted">A separate workspace with its own clients, workers, branding and billing. You can switch between agencies any time.</p>
        <Field label="Agency name"><input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Northwind Staffing" /></Field>
      </Dialog>
    </div>
  );
}

function visibleModules(mods: NavModule[], can: (r: string, a?: any) => boolean) {
  return mods.filter(m => !m.perm || m.perm.some(p => can(p)));
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can, me } = useAuth();
  const loc = useLocation();
  const current = moduleFor(loc.pathname);
  const isActive = (m: NavModule) => current.key === m.key;
  const counts = useApi<Record<string, number>>('/api/v1/nav-counts', [loc.pathname]).data ?? {};
  const item = (m: NavModule) => {
    const n = m.badge ? counts[m.badge] ?? 0 : 0;
    return <NavLink key={m.key} to={m.path} className={() => (isActive(m) ? 'active' : '')} aria-current={isActive(m) ? 'page' : undefined} onClick={onClose}><m.icon size={18} strokeWidth={1.9} /><span className="truncate" style={{ flex: 1 }}>{m.label}</span>{n > 0 && <span className="count" aria-label={`${n} need attention`}>{n > 99 ? '99+' : n}</span>}</NavLink>;
  };
  const sub = me!.workspace!.subscription;
  const isOwnerish = ['owner', 'admin'].includes(me!.workspace!.role.key);
  return (
    <>
      {open && <div className="overlay" style={{ zIndex: 110 }} onClick={onClose} />}
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Main navigation">
        <Link to="/" className="sidebar-logo" style={{ textDecoration: 'none' }} onClick={onClose}><VeyroMark /> VeyroApp</Link>
        <WorkspaceSwitcher />
        <div className="nav-groups">
          <div className="nav-label">Main menu</div>
          <nav className="nav" aria-label="Primary">{visibleModules(NAV, can).map(item)}</nav>
          <div className="nav-label other">Other</div>
          <nav className="nav" aria-label="Other">
            {NAV_OTHER.filter(m => m.key !== 'settings' || can('settings') || can('team')).map(item)}
            {me!.isPlatformAdmin && <NavLink to="/platform" onClick={onClose}><ShieldAlert size={18} strokeWidth={1.9} />Platform Control</NavLink>}
          </nav>
        </div>
        {isOwnerish && sub?.plan !== 'white_label' && (
          <div className="promo">
            <Crown size={20} color="var(--primary)" fill="currentColor" />
            <h4>Upgrade to White Label</h4>
            <p>Custom domain, branded portals and emails, and no "Powered by VeyroApp".</p>
            <Link to="/settings/billing" className="btn btn-primary btn-block" onClick={onClose}>Upgrade Now</Link>
          </div>
        )}
      </aside>
    </>
  );
}

function NotificationBell() {
  const nav = useNavigate();
  const { me } = useAuth();
  const state = useApi<{ rows: any[]; unread: number }>('/api/v1/notifications');
  const [open, setOpen] = useState(false);
  useEffect(() => realtime.on('notification', (n) => { state.setData(d => d ? { rows: [n, ...d.rows].slice(0, 50), unread: d.unread + 1 } : d); toast.info(n.title + (n.body ? ` — ${n.body}` : '')); }), [state]);
  useEffect(() => { if (me?.workspace) realtime.connect(me.workspace.org.id); }, [me?.workspace?.org.id]);
  const markAll = async () => { await api.post('/api/v1/notifications/read-all'); state.reload(); };
  const unread = state.data?.unread ?? 0;
  return (
    <div className="menu-wrap">
      <button className="icon-btn" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`} onClick={() => setOpen(o => !o)}><Bell size={18} fill={unread ? 'currentColor' : 'none'} />{unread > 0 && <span className="badge-dot">{unread > 99 ? '99+' : unread}</span>}</button>
      {open && <>
        {toBody(<div style={{ position: 'fixed', inset: 0, zIndex: 55 }} onClick={() => setOpen(false)} />)}
        <div className="menu" style={{ width: 'min(380px, calc(100vw - 24px))', maxHeight: 480, overflowY: 'auto', padding: 0, borderRadius: 16 }}>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}><b style={{ flex: 1, fontSize: 14 }}>Notifications</b><Button size="xs" variant="ghost" onClick={markAll} disabled={!unread}>Mark all read</Button></div>
          {!state.data?.rows.length ? <EmptyState title="You're all caught up" /> : state.data.rows.map(n => (
            <button key={n.id} style={{ alignItems: 'flex-start', borderRadius: 0, padding: '10px 14px', borderBottom: '1px solid var(--border-2)', background: n.read_at ? undefined : 'var(--primary-50)' }} onClick={async () => { setOpen(false); if (!n.read_at) { api.post(`/api/v1/notifications/${n.id}/read`).then(state.reload); } if (n.link) nav(n.link); }}>
              <span className="status-dot" style={{ background: n.read_at ? 'transparent' : 'var(--primary)', marginTop: 6 }} />
              <span style={{ flex: 1, minWidth: 0 }}><div className="bold small">{n.title}</div>{n.body && <div className="small muted truncate">{n.body}</div>}<div className="tiny muted">{relTime(n.created_at)}</div></span>
            </button>
          ))}
          <div style={{ padding: 8 }}><Button size="sm" variant="ghost" block onClick={() => { setOpen(false); nav('/comms/notifications'); }}>View all</Button></div>
        </div>
      </>}
    </div>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  return (
    <Menu label="Account menu" trigger={<button className="user-chip" aria-label="Account menu"><Avatar name={me!.user.name} color={me!.user.avatar_color} src={me!.user.avatar_url} size={32} /><span className="user-name">{me!.user.name}</span><ChevronDown size={14} color="var(--muted-2)" className="user-name" /></button>}
      items={[
        { label: <span><div className="bold">{me!.user.name}</div><div className="small muted">{me!.user.email}</div></span>, disabled: true },
        { sep: true },
        { label: 'My Profile', icon: <User size={16} />, onClick: () => nav('/profile') },
        { label: 'Agency settings', icon: <Building2 size={16} />, onClick: () => nav('/settings') },
        { sep: true },
        { label: 'Sign out', icon: <LogOut size={16} />, onClick: logout },
      ]} />
  );
}

export function ImpersonationBar() {
  const { me } = useAuth();
  if (!me?.impersonator) return null;
  return <div className="impersonation-bar"><ShieldAlert size={16} /> Support mode: {me.impersonator.name} is viewing as {me.user.name} ({me.workspace?.org.name}). All actions are audited.<Button size="xs" onClick={async () => { await api.post('/api/v1/platform/impersonation/end').catch(() => {}); window.location.href = '/platform'; }}>End support session</Button></div>;
}

export function TopBar({ onMenu, tabs }: { onMenu: () => void; tabs?: ReactNode }) {
  const loc = useLocation();
  const { can } = useAuth();
  const mod = moduleFor(loc.pathname);
  const [searchOpen, setSearchOpen] = useState(false);
  const navTo = useNavigate();
  const visibleTabs = mod.tabs.filter(t => !t.perm || can(t.perm[0], (t.perm[1] as any) ?? 'view'));
  const moreTabs = visibleTabs.filter(t => t.more);
  const activeMore = moreTabs.find(t => isTabActive(t, loc.pathname));
  const tabsRef = useRef<HTMLElement>(null);
  const [fade, setFade] = useState(false);
  // Keep the active tab visible and fade the edge when the strip still overflows (narrow screens).
  useEffect(() => {
    const el = tabsRef.current; if (!el) return;
    const measure = () => setFade(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
    el.querySelector('a.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure(); el.addEventListener('scroll', measure); window.addEventListener('resize', measure);
    return () => { el.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); };
  }, [loc.pathname, mod.key]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);
  return (
    <header className="topbar">
      <button className="icon-btn menu-toggle" aria-label="Open menu" onClick={onMenu}><MenuIcon size={20} /></button>
      <nav className={`subtabs ${fade ? 'fade' : ''}`} aria-label={`${mod.label} sections`} ref={tabsRef}>
        {tabs ?? visibleTabs.filter(t => !t.more).map(t => <Link key={t.path} to={t.path} className={isTabActive(t, loc.pathname) ? 'active' : ''} aria-current={isTabActive(t, loc.pathname) ? 'page' : undefined}>{t.label}</Link>)}
      </nav>
      {!tabs && moreTabs.length > 0 && (
        <Menu align="left" label={`More ${mod.label} sections`} trigger={<button className={`subtabs-more ${activeMore ? 'active' : ''}`} aria-haspopup="menu">{activeMore ? activeMore.label : 'More'}<ChevronDown size={14} /></button>}
          items={moreTabs.map(t => ({ label: t.label, icon: isTabActive(t, loc.pathname) ? <Check size={14} /> : <span style={{ width: 14 }} />, onClick: () => navTo(t.path) }))} />
      )}
      <div className="topbar-right">
        <button className="search-trigger desktop-search" onClick={() => setSearchOpen(true)} aria-label="Search (⌘K)"><Search size={16} /><span>Search…</span><kbd>⌘K</kbd></button>
        <button className="icon-btn mobile-search" aria-label="Search" onClick={() => setSearchOpen(true)}><Search size={18} /></button>
        <QuickCreateButton />
        <NotificationBell />
        <UserMenu />
      </div>
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}

/** Agency app shell: sidebar + top bar + routed content. Remounts per workspace so data never leaks across tenants. */
export function Shell() {
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => { setMenu(false); window.scrollTo(0, 0); }, [loc.pathname]);
  return (
    <div className="app-frame"><div className="app">
      <Sidebar open={menu} onClose={() => setMenu(false)} />
      <div className="main">
        <ImpersonationBar />
        <TopBar onMenu={() => setMenu(true)} />
        <main className="content" id="main"><Outlet /></main>
      </div>
    </div></div>
  );
}
