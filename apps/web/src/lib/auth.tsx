import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrf, setUnauthorizedHandler } from './api';

export interface Membership { id: string; name: string; slug: string; role_key: string; role_name: string; role_kind: string; logo_text: string | null; primary_color: string; accent_color: string; logo_url: string | null }
export interface Workspace {
  org: { id: string; name: string; slug: string };
  role: { id: string; key: string; name: string; kind: 'agency' | 'client' | 'worker' | 'candidate' };
  recruitingScope: 'all' | 'team' | 'assigned';
  team: string | null;
  perms: Record<string, string>;
  companyId: string | null; workerId: string | null; candidateId: string | null;
  branding: { logo_text: string | null; primary_color: string; accent_color: string; logo_url: string | null; hide_powered_by: boolean; email_sender_name: string | null; support_email: string | null } | null;
  flags: Record<string, boolean>;
  subscription: { plan: string; plan_name: string; status: string; comped: boolean; trial_ends_at: string | null } | null;
  personalLinkToken: string | null;
}
export interface Me {
  user: { id: string; name: string; email: string; phone: string | null; avatar_color: string | null; avatar_url: string | null; mfa_enabled: boolean };
  csrf: string; isPlatformAdmin: boolean; impersonator: { name: string; email: string } | null;
  memberships: Membership[]; workspace: Workspace | null;
}
type Action = 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'export' | 'view_comp';
interface AuthCtx {
  me: Me | null; loading: boolean; switching: boolean;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  can: (resource: string, action?: Action) => boolean;
  scope: (resource: string, action?: Action) => string;
}
const Ctx = createContext<AuthCtx>(null as any);

/** Staff app stays platform blue; client/worker/candidate portals re-tint the brand scale to the tenant color. */
function applyBranding(ws: Workspace | null) {
  const root = document.documentElement;
  const tenant = ws && ws.role.kind !== 'agency' ? ws.branding?.primary_color : null;
  const keys = ['--primary', '--primary-600', '--primary-700', '--primary-50', '--primary-100', '--primary-200'];
  if (!tenant) { keys.forEach(k => root.style.removeProperty(k)); return; }
  root.style.setProperty('--primary', tenant);
  root.style.setProperty('--primary-600', shade(tenant, -0.14));
  root.style.setProperty('--primary-700', shade(tenant, -0.28));
  root.style.setProperty('--primary-50', mix(tenant, 0.07));
  root.style.setProperty('--primary-100', mix(tenant, 0.15));
  root.style.setProperty('--primary-200', mix(tenant, 0.30));
}
function hexToRgb(h: string) { const m = h.replace('#', ''); const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function shade(h: string, p: number) { const [r, g, b] = hexToRgb(h); const f = (c: number) => Math.round(Math.min(255, Math.max(0, c + c * p))); return `rgb(${f(r)}, ${f(g)}, ${f(b)})`; }
function mix(h: string, a: number) { const [r, g, b] = hexToRgb(h); const f = (c: number) => Math.round(255 - (255 - c) * a); return `rgb(${f(r)}, ${f(g)}, ${f(b)})`; }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const m = await api.get<Me>('/api/v1/auth/me');
      if (!m.user) { setMe(null); applyBranding(null); return null; }
      setCsrf(m.csrf); setMe(m); applyBranding(m.workspace);
      return m;
    } catch { setMe(null); applyBranding(null); return null; } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); setUnauthorizedHandler(() => { setMe(null); }); }, [refresh]);
  const logout = useCallback(async () => { await api.post('/api/v1/auth/logout').catch(() => {}); setMe(null); applyBranding(null); window.location.href = '/login'; }, []);
  const switchOrg = useCallback(async (orgId: string) => {
    setSwitching(true); // unmounts tenant UI so no data from the previous tenant can flash
    try {
      const m = await api.post<Me>('/api/v1/auth/switch', { organizationId: orgId });
      setCsrf(m.csrf); applyBranding(m.workspace); setMe(m);
      const kind = m.workspace?.role.kind;
      window.history.replaceState(null, '', kind === 'client' ? '/portal/client' : kind === 'worker' ? '/portal/worker' : kind === 'candidate' ? '/portal/candidate' : '/');
    } finally { setSwitching(false); }
  }, []);
  const value = useMemo<AuthCtx>(() => ({
    me, loading, switching, refresh, logout, switchOrg,
    scope: (resource, action = 'view') => (me?.workspace?.role.kind === 'agency' ? me.workspace.perms[`${resource}:${action}`] ?? 'none' : 'none'),
    can: (resource, action = 'view') => me?.workspace?.role.kind === 'agency' && (me.workspace.perms[`${resource}:${action}`] ?? 'none') !== 'none',
  }), [me, loading, switching, refresh, logout, switchOrg]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useAuth() { return useContext(Ctx); }
/** Convenience: the active workspace (throws only if used outside an authenticated shell). */
export function useWorkspace(): Workspace { const { me } = useAuth(); return me!.workspace!; }
