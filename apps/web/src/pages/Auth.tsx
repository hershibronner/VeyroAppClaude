import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Eye, EyeOff } from 'lucide-react';
import { Button, Field } from '../components/ui';

const DEMO = [
  { email: 'owner@veyro.demo', who: 'Ava Stern', role: 'Owner · 2 agencies' },
  { email: 'recruiter@veyro.demo', who: 'Noah Kim', role: 'Recruiter' },
  { email: 'sales@veyro.demo', who: 'Lena Ortiz', role: 'Sales' },
  { email: 'finance@veyro.demo', who: 'Mark Chen', role: 'Finance / Payroll' },
  { email: 'am@veyro.demo', who: 'Priya Shah', role: 'Account Manager' },
  { email: 'client@veyro.demo', who: 'Dana Fox', role: 'Client · Brightline Dental' },
  { email: 'worker@veyro.demo', who: 'Jose Ramirez', role: 'Remote worker' },
  { email: 'candidate@veyro.demo', who: 'Maria Santos', role: 'Candidate' },
  { email: 'platform@veyro.demo', who: 'Platform Admin', role: 'VeyroApp staff' },
];

/** Where each kind of user lands after sign-in. */
export function landingFor(me: any): string {
  const ws = me?.workspace;
  if (!ws) return me?.isPlatformAdmin ? '/platform' : '/login';
  if (ws.role.kind === 'client') return '/portal/client';
  if (ws.role.kind === 'worker') return '/portal/worker/tracker';
  if (ws.role.kind === 'candidate') return '/portal/candidate';
  const k = ws.role.key;
  if (k === 'recruiter') return '/recruiting';
  if (k === 'sales') return '/crm/leads';
  if (k === 'finance') return '/finance';
  if (k === 'account_manager' || k === 'hr') return '/workforce/workers';
  return '/';
}

/** Whether emails really go out (Resend configured) or are captured in the Dev Outbox. Fetched once per page load. */
let modeReq: Promise<{ email_live: boolean }> | null = null;
export function useEmailLive() {
  const [live, setLive] = useState<boolean | null>(null);
  useEffect(() => {
    modeReq ??= api.get('/api/v1/auth/mode').catch(() => ({ email_live: false }));
    let on = true; modeReq.then(m => { if (on) setLive(m.email_live); }); return () => { on = false; };
  }, []);
  return live;
}
const DevOutboxLink = () => <a href="/dev/outbox" target="_blank" rel="noreferrer">Dev Outbox</a>;

/** VeyroApp asterisk mark — six rounded spokes. */
export const BrandMark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    {[0, 60, 120].map(a => <rect key={a} x="13.5" y="2" width="5" height="28" rx="2.5" fill="currentColor" transform={`rotate(${a} 16 16)`} />)}
  </svg>
);

export function AuthLayout({ children, lead = 'One workspace for your agency', title = 'Win clients, place talent, track time and run payroll — all in one place.' }: { children: ReactNode; lead?: string; title?: string }) {
  const live = useEmailLive();
  useEffect(() => {
    const id = 'lp-fonts';
    if (document.getElementById(id)) return;
    const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';
    document.head.appendChild(l);
  }, []);
  return (
    <div className="auth">
      <div className="auth-shell">
        <aside className="auth-brand">
          <i className="blob b1" /><i className="blob b2" /><i className="blob b3" /><i className="blob b4" /><i className="grain" />
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Link to="/home" aria-label="VeyroApp home" style={{ color: '#fff' }}><BrandMark className="mark" /></Link>
            <span className="mono">VeyroApp</span>
          </div>
          <div>
            <p className="lead">{lead}</p>
            <h2>{title}</h2>
            {live === false && <p className="foot">Local build · MAGA Hire is a demo tenant</p>}
          </div>
        </aside>
        <main className="auth-main">{children}</main>
      </div>
    </div>
  );
}

/** Whether "Continue with Google" is configured on the server. Fetched once per page load. */
let googleReq: Promise<{ enabled: boolean }> | null = null;
export function useGoogleEnabled() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    googleReq ??= api.get('/api/v1/auth/google/config').catch(() => ({ enabled: false }));
    let live = true; googleReq.then(r => { if (live) setOn(!!r.enabled); }); return () => { live = false; };
  }, []);
  return on;
}
const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);
/** "Continue with Google" with an "or" divider; renders nothing until Google is configured. */
export function GoogleButton({ intent, next, className }: { intent: 'signin' | 'signup'; next?: string | null; className?: string }) {
  const on = useGoogleEnabled();
  if (!on) return null;
  const href = `/api/v1/auth/google/start?intent=${intent}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  return (
    <div className={`google-wrap ${className ?? ''}`}>
      <div className="google-or"><span>or</span></div>
      <a className="google-btn" href={href}><GoogleG /> Continue with Google</a>
    </div>
  );
}

/** Password input with a show/hide toggle. */
function PasswordInput({ id, value, onChange, autoComplete }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw">
      <input id={id} className="input" type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={e => onChange(e.target.value)} required />
      <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button>
    </div>
  );
}

export function LoginPage() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [sp] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState(() => sp.get('mfa') === '1');
  const [err, setErr] = useState<string | null>(() => sp.get('google_error'));
  const [busy, setBusy] = useState(false);
  const live = useEmailLive();
  const finish = async () => { const me = await refresh(); nav(sp.get('next') || landingFor(me), { replace: true }); };
  const submit = async (e?: string, p?: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/api/v1/auth/login', { email: e ?? email, password: p ?? password });
      if (r.mfaRequired) { setMfa(true); return; }
      await finish();
    } catch (x) { setErr(x instanceof ApiError ? x.message : String(x)); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setErr(null);
    try { await api.post('/api/v1/auth/mfa', { code }); await finish(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <AuthLayout>
      <div className="auth-card">
        {!mfa ? (<>
          <BrandMark className="auth-mark" />
          <h1>Welcome back</h1>
          <div className="sub">Sign in to your workspace — leads, recruiting, placements, time and payroll, all in one place.</div>
          <form className="stack" style={{ gap: 14 }} onSubmit={ev => { ev.preventDefault(); submit(); }}>
            <Field label="Email" htmlFor="email"><input id="email" className="input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></Field>
            <Field label={<span className="row" style={{ justifyContent: 'space-between' }}>Password <Link to="/forgot-password" className="small" style={{ fontWeight: 500 }}>Forgot password?</Link></span>} htmlFor="password"><PasswordInput id="password" autoComplete="current-password" value={password} onChange={setPassword} /></Field>
            {err && <div className="err small" role="alert" style={{ color: 'var(--danger)' }}>{err}</div>}
            <Button type="submit" variant="primary" block loading={busy}>Sign in</Button>
          </form>
          <GoogleButton intent="signin" next={sp.get('next')} />
          <div className="demo">
            {/* One-click demo logins only in local builds; the live site never shows them. */}
            {live === false && <>
              <div className="demo-head"><b>Local demo</b><span className="muted">password <code>demo1234</code> · one click signs in</span></div>
              <div className="demo-grid">
                {DEMO.map(d => <button key={d.email} type="button" disabled={busy} onClick={() => { setEmail(d.email); setPassword('demo1234'); submit(d.email, 'demo1234'); }}><b>{d.who}</b>{d.role}</button>)}
              </div>
            </>}
            <div className="demo-links"><span>New to VeyroApp? <Link to="/register">Create your agency</Link></span>{live === false && <DevOutboxLink />}</div>
          </div>
        </>) : (<>
          <h1>Enter your code</h1>
          <div className="sub">We sent a 6-digit sign-in code to your email.{live === false && <> In this local build it's in the <DevOutboxLink />.</>}</div>
          <form className="stack" style={{ gap: 14 }} onSubmit={ev => { ev.preventDefault(); verify(); }}>
            <Field label="6-digit code" htmlFor="code"><input id="code" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
            {err && <div className="small" role="alert" style={{ color: 'var(--danger)' }}>{err}</div>}
            <Button type="submit" variant="primary" block loading={busy} disabled={code.length !== 6}>Verify and sign in</Button>
          </form>
        </>)}
      </div>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [v, setV] = useState({ agencyName: '', name: '', email: '', password: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null); setErrs({});
    try { await api.post('/api/v1/auth/register', v); await refresh(); nav('/', { replace: true }); }
    catch (x) { if (x instanceof ApiError) { setErrs(x.fields ?? {}); setErr(x.message); } } finally { setBusy(false); }
  };
  const f = (k: keyof typeof v, label: string, type = 'text', ac?: string) => <Field label={label} htmlFor={k} error={errs[k]}><input id={k} className={`input ${errs[k] ? 'invalid' : ''}`} type={type} autoComplete={ac} value={v[k]} onChange={e => setV(s => ({ ...s, [k]: e.target.value }))} /></Field>;
  return (
    <AuthLayout>
      <div className="auth-card">
        <BrandMark className="auth-mark" />
        <h1>Create your agency</h1>
        <div className="sub">Start a 14-day trial. $29/month per active worker after that — client users and candidates are free.</div>
        <form className="stack" style={{ gap: 14 }} onSubmit={e => { e.preventDefault(); submit(); }}>
          {f('agencyName', 'Agency name', 'text', 'organization')}
          {f('name', 'Your name', 'text', 'name')}
          {f('email', 'Work email', 'email', 'email')}
          {f('password', 'Password (8+ characters)', 'password', 'new-password')}
          {err && !Object.keys(errs).length && <div className="small" role="alert" style={{ color: 'var(--danger)' }}>{err}</div>}
          <Button type="submit" variant="primary" block loading={busy}>Create agency</Button>
        </form>
        <div className="small mt-3">Already have an account? <Link to="/login">Sign in</Link></div>
      </div>
    </AuthLayout>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useEmailLive();
  return (
    <AuthLayout>
      <div className="auth-card">
        <BrandMark className="auth-mark" />
        <h1>Reset your password</h1>
        {sent ? <div className="sub">If an account exists for <b>{email}</b>, a reset link is on its way. {live === false ? <>In this local build, open the <DevOutboxLink /> to find it.</> : <>Check your inbox (and spam folder). The link works for 1 hour.</>}</div> : (<>
          <div className="sub">Enter your email and we'll send you a reset link.</div>
          <form className="stack" style={{ gap: 14 }} onSubmit={async e => { e.preventDefault(); setBusy(true); try { await api.post('/api/v1/auth/forgot', { email }); setSent(true); } finally { setBusy(false); } }}>
            <Field label="Email" htmlFor="email"><input id="email" className="input" type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
            <Button type="submit" variant="primary" block loading={busy}>Send reset link</Button>
          </form>
        </>)}
        <div className="small mt-3"><Link to="/login">Back to sign in</Link></div>
      </div>
    </AuthLayout>
  );
}

export function ResetPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout>
      <div className="auth-card">
        <BrandMark className="auth-mark" />
        <h1>Choose a new password</h1>
        <div className="sub">All other sessions will be signed out.</div>
        <form className="stack" style={{ gap: 14 }} onSubmit={async e => { e.preventDefault(); setBusy(true); setErr(null); try { await api.post('/api/v1/auth/reset', { token: sp.get('token'), password: pw }); nav('/login?reset=1'); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } }}>
          <Field label="New password" htmlFor="pw" error={err}><input id="pw" className="input" type="password" autoComplete="new-password" minLength={8} required value={pw} onChange={e => setPw(e.target.value)} /></Field>
          <Button type="submit" variant="primary" block loading={busy}>Update password</Button>
        </form>
      </div>
    </AuthLayout>
  );
}

export function AcceptInvitePage() {
  const { token } = useParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [inv, setInv] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/api/v1/auth/invitations/${token}`).then(i => { setInv(i); setName(i.name ?? ''); }).catch(e => setErr(e.message)); }, [token]);
  const accept = async () => { setBusy(true); setErr(null); try { await api.post(`/api/v1/auth/invitations/${token}/accept`, { name, password: pw }); const me = await refresh(); nav(landingFor(me), { replace: true }); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } };
  return (
    <AuthLayout>
      <div className="auth-card">
        {!inv ? <><h1>Invitation</h1><div className="sub">{err ?? 'Loading…'}</div></> : inv.status !== 'pending' ? <><h1>Invitation {inv.status}</h1><div className="sub">This invitation can no longer be used. Ask {inv.org_name} to send a new one.</div><Link to="/login">Go to sign in</Link></> : (<>
          <div className="row mb-2"><span className="ws-logo" style={{ background: inv.primary_color }}>{(inv.logo_text ?? inv.org_name).slice(0, 2).toUpperCase()}</span><b>{inv.org_name}</b></div>
          <h1>Join {inv.org_name}</h1>
          <div className="sub">You were invited as <b>{inv.role_name}</b> ({inv.email}).</div>
          <form className="stack" style={{ gap: 14 }} onSubmit={e => { e.preventDefault(); accept(); }}>
            {!inv.existing && <Field label="Your name" htmlFor="nm"><input id="nm" className="input" value={name} onChange={e => setName(e.target.value)} required /></Field>}
            <Field label={inv.existing ? 'Your existing password' : 'Create a password (8+ characters)'} htmlFor="pw" error={err}><input id="pw" className="input" type="password" minLength={8} required value={pw} onChange={e => setPw(e.target.value)} /></Field>
            <Button type="submit" variant="primary" block loading={busy}>Accept invitation</Button>
          </form>
        </>)}
      </div>
    </AuthLayout>
  );
}
