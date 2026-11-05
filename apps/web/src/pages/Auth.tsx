import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
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

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <div>
          <div className="wordmark">VeyroApp</div>
          <p>Run your staffing company. Clients, candidates, placements, time, and billing in one workspace.</p>
        </div>
        <p className="foot">Local build · MAGA Hire is a demo tenant</p>
      </aside>
      <main className="auth-main"><div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>{children}</div></main>
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
  const [mfa, setMfa] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
          <h1>Sign in</h1>
          <div className="sub">Use your workspace account.</div>
          <form className="stack" style={{ gap: 14 }} onSubmit={ev => { ev.preventDefault(); submit(); }}>
            <Field label="Email" htmlFor="email"><input id="email" className="input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></Field>
            <Field label={<span className="row" style={{ justifyContent: 'space-between' }}>Password <Link to="/forgot-password" className="small" style={{ fontWeight: 500 }}>Forgot password?</Link></span>} htmlFor="password"><input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></Field>
            {err && <div className="err small" role="alert" style={{ color: 'var(--danger)' }}>{err}</div>}
            <Button type="submit" variant="primary" block loading={busy}>Sign in</Button>
          </form>
          <div className="demo">
            <div className="demo-head"><b>Local demo</b><span className="muted">password <code>demo1234</code> · one click signs in</span></div>
            <div className="demo-grid">
              {DEMO.map(d => <button key={d.email} type="button" disabled={busy} onClick={() => { setEmail(d.email); setPassword('demo1234'); submit(d.email, 'demo1234'); }}><b>{d.who}</b>{d.role}</button>)}
            </div>
            <div className="demo-links"><Link to="/register">Create a new agency</Link><a href="/dev/outbox" target="_blank" rel="noreferrer">Dev Outbox</a></div>
          </div>
        </>) : (<>
          <h1>Enter your code</h1>
          <div className="sub">We sent a 6-digit sign-in code to your email. In this local build it's in the <a href="/dev/outbox" target="_blank" rel="noreferrer">Dev Outbox</a>.</div>
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
  return (
    <AuthLayout>
      <div className="auth-card">
        <h1>Reset your password</h1>
        {sent ? <div className="sub">If an account exists for <b>{email}</b>, a reset link is on its way. In this local build, open the <a href="/dev/outbox" target="_blank" rel="noreferrer">Dev Outbox</a> to find it.</div> : (<>
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
