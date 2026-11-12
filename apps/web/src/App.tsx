import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, type RouteObject } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import { PortalShell, type PortalKind } from './portals/PortalShell';
import { LoginPage, ForgotPage, ResetPage, AcceptInvitePage, landingFor } from './pages/Auth';
import { Boundary, EmptyState, LoadingBlock, Button } from './components/ui';
import { Link } from 'react-router-dom';
import { OnboardingChecklist } from './modules/onboarding/Checklist';

const ProfilePage = lazy(() => import('./pages/Profile'));
const SignupPage = lazy(() => import('./pages/Signup'));
const PendingApproval = lazy(() => import('./pages/PendingApproval'));
const LandingPage = lazy(() => import('./pages/Landing'));

// Area route manifests (each area owns src/modules/<area>/{index,portal,public}.tsx and lazy-loads its pages).
const areaMods = import.meta.glob<{ routes?: RouteObject[] }>('./modules/*/index.tsx', { eager: true });
const portalMods = import.meta.glob<{ portalRoutes?: Partial<Record<PortalKind, RouteObject[]>> }>('./modules/*/portal.tsx', { eager: true });
const publicMods = import.meta.glob<{ publicRoutes?: RouteObject[] }>('./modules/*/public.tsx', { eager: true });
const AGENCY_ROUTES = Object.values(areaMods).flatMap(m => m.routes ?? []);
const PUBLIC_ROUTES = Object.values(publicMods).flatMap(m => m.publicRoutes ?? []);
const portalRoutes = (k: PortalKind) => Object.values(portalMods).flatMap(m => m.portalRoutes?.[k] ?? []);

function Splash() { return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><div className="muted"><span className="spinner" /> Loading workspace…</div></div>; }

function RequireAuth({ kind, children }: { kind: 'agency' | PortalKind; children: ReactNode }) {
  const { me, loading, switching } = useAuth();
  const loc = useLocation();
  if (loading || switching) return <Splash />;
  if (!me) return <Navigate to={loc.pathname === '/' && !loc.search ? '/home' : `/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (!me.workspace) return <Navigate to={me.isPlatformAdmin ? '/platform' : '/login'} replace />;
  if (me.workspace.role.kind !== kind) return <Navigate to={landingFor(me)} replace />;
  // Self-serve agencies wait for VeyroApp approval (support mode / impersonation still sees the workspace).
  const approval = (me.workspace as any).approval?.status;
  if (kind === 'agency' && approval && approval !== 'approved' && !me.impersonator) return <Suspense fallback={<Splash />}><PendingApproval /></Suspense>;
  return <>{children}</>;
}

function NotFound() {
  return <EmptyState title="Page not found" text="The page you are looking for does not exist or was moved." action={<Link to="/"><Button>Go home</Button></Link>} />;
}

const renderRoutes = (rs: RouteObject[]) => rs.map((r, i) => (
  <Route key={(r.path ?? '') + i} path={r.path} index={r.index as any} element={<Boundary label="This page"><Suspense fallback={<LoadingBlock rows={6} />}>{r.element}</Suspense></Boundary>}>
    {r.children && renderRoutes(r.children)}
  </Route>
));

export default function App() {
  const { me } = useAuth();
  const orgKey = me?.workspace?.org.id ?? 'none';
  return (
    <Routes key={orgKey}>
      <Route path="/home" element={<Suspense fallback={<div style={{ minHeight: '100vh', background: '#000' }} />}><LandingPage /></Suspense>} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<Suspense fallback={<Splash />}><SignupPage /></Suspense>} />
      <Route path="/signup" element={<Navigate to="/register" replace />} />
      <Route path="/forgot-password" element={<ForgotPage />} />
      <Route path="/reset-password" element={<ResetPage />} />
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
      {renderRoutes(PUBLIC_ROUTES)}
      {(['client', 'worker', 'candidate'] as PortalKind[]).map(k => (
        <Route key={k} path={`/portal/${k}`} element={<RequireAuth kind={k}><PortalShell kind={k} /></RequireAuth>}>
          {renderRoutes(portalRoutes(k))}
          <Route path="*" element={<NotFound />} />
        </Route>
      ))}
      <Route path="/" element={<RequireAuth kind="agency"><Shell /><OnboardingChecklist /></RequireAuth>}>
        {renderRoutes(AGENCY_ROUTES)}
        <Route path="profile" element={<Suspense fallback={<LoadingBlock />}><ProfilePage /></Suspense>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
