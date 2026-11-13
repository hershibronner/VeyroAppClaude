// Agency sign-up — "workspace builder": a live preview of the agency's VeyroApp workspace (left) fills in as the
// owner completes five short stages (right). Submitting creates the account in "pending approval".
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, ImagePlus, FileCheck2, Lock, Mail, User, Building2, Globe, Phone, MapPin, Sparkles, MailCheck } from 'lucide-react';
import { api, ApiError, setCsrf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BrandMark, GoogleButton } from './Auth';
import './signup.css';

const INDUSTRIES = ['Dental', 'Medical', 'Real estate', 'Insurance', 'E-commerce', 'Legal', 'Accounting', 'Marketing', 'Customer support', 'Tech / IT', 'Home services', 'Logistics'];
const TEAM = [['just_me', 'Just me'], ['2-5', '2–5'], ['6-20', '6–20'], ['21+', '21+']];
const WORKERS = [['starting', 'None yet'], ['1-10', '1–10'], ['11-50', '11–50'], ['51+', '51+']];
const SOFTWARE = ['Excel / Google Sheets', 'Bullhorn', 'Recruit CRM', 'Zoho Recruit', 'Other software', 'Nothing yet'];
const COLORS = ['#345CFF', '#7044FF', '#0EA5E9', '#10B981', '#F59E0B', '#E11D48', '#111827'];
const STAGES = [
  { key: 'account', label: 'Your account', sub: 'Name, email and password' },
  { key: 'business', label: 'Your business', sub: 'Name and where you are' },
  { key: 'agency', label: 'How you work', sub: 'Team, placements, industries' },
  { key: 'brand', label: 'Your brand', sub: 'Logo and color' },
  { key: 'verify', label: 'Verification', sub: 'Registration document' },
];

function strength(pw: string) { let s = 0; if (pw.length >= 8) s++; if (pw.length >= 12) s++; if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++; if (/\d/.test(pw)) s++; if (/[^A-Za-z0-9]/.test(pw)) s++; return Math.min(4, s); }
const STRENGTH = ['Too short', 'Weak', 'Okay', 'Strong', 'Very strong'];

function F({ label, icon, error, hint, children }: { label: string; icon?: ReactNode; error?: string; hint?: ReactNode; children: ReactNode }) {
  return <label className={`wb-field ${error ? 'bad' : ''}`}><span className="wb-label">{label}</span><span className="wb-input">{icon && <i>{icon}</i>}{children}</span>{error ? <small className="wb-err">{error}</small> : hint ? <small>{hint}</small> : null}</label>;
}
function Pills({ options, value, onChange, multi }: { options: (string | string[])[]; value: string | string[]; onChange: (v: any) => void; multi?: boolean }) {
  return <div className="wb-pills">{options.map(o => { const [k, l] = Array.isArray(o) ? o : [o, o]; const on = multi ? (value as string[]).includes(k) : value === k; return (
    <button key={k} type="button" className={on ? 'on' : ''} aria-pressed={on} onClick={() => onChange(multi ? (on ? (value as string[]).filter(x => x !== k) : [...(value as string[]), k]) : k)}>{on && <Check size={13} />}{l}</button>); })}</div>;
}

function CodeBoxes({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => { refs.current[Math.min(value.length, 5)]?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const put = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return;
    const next = (value.slice(0, i) + digits).slice(0, 6);
    onChange(next); refs.current[Math.min(next.length, 5)]?.focus();
  };
  return (
    <div className="wb-code" onPaste={e => { const d = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6); if (d) { e.preventDefault(); onChange(d); refs.current[Math.min(d.length, 5)]?.focus(); } }}>
      {Array.from({ length: 6 }, (_, i) => (
        <input key={i} ref={el => { refs.current[i] = el; }} inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'} maxLength={6} aria-label={`Digit ${i + 1}`} disabled={disabled}
          className={value[i] ? 'filled' : ''} value={value[i] ?? ''} onChange={e => put(i, e.target.value)}
          onKeyDown={e => { if (e.key === 'Backspace') { e.preventDefault(); const n = value.slice(0, value[i] ? i : Math.max(0, i - 1)); onChange(n); refs.current[Math.max(0, n.length)]?.focus(); } }} />
      ))}
    </div>
  );
}

/** The verified-email hand-off from the Google callback (in the URL hash). Read once and kept, so a remount still has it. */
let googleHandoff: { token: string; email: string; name: string } | null = null;
function takeGoogleHandoff() {
  const h = new URLSearchParams(window.location.hash.slice(1));
  if (h.get('google') === '1' && h.get('token') && h.get('email')) {
    googleHandoff = { token: h.get('token')!, email: h.get('email')!, name: h.get('name') || '' };
    window.history.replaceState(null, '', window.location.pathname);
  }
  return googleHandoff;
}

export default function SignupPage() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [v, setV] = useState({ name: '', email: '', agencyName: '', password: '', phone: '', website: '', country: '', team_size: '', active_workers: '', industries: [] as string[], previous_software: '', legal_name: '', registration_number: '', color: COLORS[0] });
  const set = (k: keyof typeof v, val: any) => { setV(s => ({ ...s, [k]: val })); setErrs(e => ({ ...e, [k]: '' })); if (k === 'email') { setCodeSent(false); setCode(''); setToken(null); } };
  const [stage, setStage] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [showPw, setShowPw] = useState(false);
  const [logo, setLogo] = useState<File | null>(null);
  const [doc, setDoc] = useState<File | null>(null);
  const logoUrl = useMemo(() => (logo ? URL.createObjectURL(logo) : null), [logo]);
  useEffect(() => () => { if (logoUrl) URL.revokeObjectURL(logoUrl); }, [logoUrl]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Email verification (6-digit code) — required before the account can be created.
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [verifiedEmail, setVerifiedEmail] = useState('');
  const [devOutbox, setDevOutbox] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  useEffect(() => { if (resendIn <= 0) return; const t = setTimeout(() => setResendIn(n => n - 1), 1000); return () => clearTimeout(t); }, [resendIn]);
  // Back from "Continue with Google": the email is already verified, so prefill it and skip the code + password.
  const [viaGoogle, setViaGoogle] = useState(false);
  useEffect(() => {
    const qp = new URLSearchParams(window.location.search).get('google_error');
    if (qp) setErr(qp);
    const g = takeGoogleHandoff();
    if (!g) return;
    setV(s => ({ ...s, email: g.email, name: s.name || g.name }));
    setToken(g.token); setVerifiedEmail(g.email.toLowerCase()); setViaGoogle(true);
  }, []);
  const pw = strength(v.password);
  const biz = v.agencyName.trim() || 'Your agency';

  const check = (i: number) => {
    const e: Record<string, string> = {};
    if (i === 0) { if (v.name.trim().length < 2) e.name = 'Enter your name'; if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) e.email = 'Enter a valid email'; if (v.password.length < 8 && !(viaGoogle && !v.password)) e.password = 'Use at least 8 characters'; }
    if (i === 1) { if (v.agencyName.trim().length < 2) e.agencyName = 'Enter your business name'; if (!v.country.trim()) e.country = 'Enter your country'; }
    if (i === 2) { if (!v.team_size) e.team_size = 'Pick your team size'; if (!v.active_workers) e.active_workers = 'Pick one'; }
    setErrs(e); return !Object.keys(e).length;
  };
  const sendCode = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.post<any>('/api/v1/auth/signup/send-code', { email: v.email.trim(), name: v.name.trim() }); if (r.token) { setToken(r.token); setVerifiedEmail(v.email.trim().toLowerCase()); setDir(1); setStage(1); return; } setCodeSent(true); setCode(''); setDevOutbox(!!r.dev_outbox); setResendIn(45); }
    catch (x) { const msg = x instanceof ApiError ? x.message : 'Could not send the code'; if (/email|account/i.test(msg)) setErrs({ email: msg }); else setErr(msg); }
    finally { setBusy(false); }
  };
  const verifyCode = async (c = code) => {
    if (!/^\d{6}$/.test(c)) { setErr('Enter the 6-digit code from the email'); return false; }
    setBusy(true); setErr(null);
    try { const r = await api.post<any>('/api/v1/auth/signup/verify-code', { email: v.email.trim(), code: c }); setToken(r.token); setVerifiedEmail(v.email.trim().toLowerCase()); return true; }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not check the code'); setCode(''); return false; }
    finally { setBusy(false); }
  };
  const go = async (to: number) => {
    if (to > stage && !check(stage)) return;
    if (stage === 0 && to > 0 && !(token && verifiedEmail === v.email.trim().toLowerCase())) {
      if (!codeSent) { await sendCode(); return; }
      if (!(await verifyCode())) return;
    }
    setDir(to > stage ? 1 : -1); setStage(to); setErr(null);
  };
  const submit = async () => {
    for (let i = 0; i < 3; i++) if (!check(i)) { setDir(-1); setStage(i); return; }
    setBusy(true); setErr(null);
    try {
      const { color, ...body } = v;
      await api.post('/api/v1/auth/register', { ...body, verification_token: token, agencyName: v.agencyName.trim(), name: v.name.trim(), email: v.email.trim() });
      // The new session has its own CSRF token; fetch it without re-rendering the app (which would remount this page).
      const fresh = await api.get<{ csrf: string }>('/api/v1/auth/me'); setCsrf(fresh.csrf);
      await api.put('/api/v1/onboarding/application/brand', { primary_color: color }).catch(() => {});
      if (logo || doc) {
        const fd = new FormData();
        if (logo) fd.append('logo', logo, logo.name);
        if (doc) fd.append('registration', doc, doc.name);
        await api.upload('/api/v1/onboarding/application/files', fd).catch(() => { /* can be re-sent from the pending screen */ });
      }
      await refresh();
      nav('/', { replace: true });
    } catch (x) {
      const msg = x instanceof ApiError ? x.message : 'Something went wrong — please try again.';
      setErr(msg);
      if (/email|verif/i.test(msg)) { setErrs({ email: msg }); setToken(null); setCodeSent(false); setDir(-1); setStage(0); }
    } finally { setBusy(false); }
  };
  const last = stage === STAGES.length - 1;
  const pct = Math.round((stage / (STAGES.length - 1)) * 100);

  return (
    <div className="wb-page">
    <div className="wb" style={{ ['--brand' as any]: v.color }}>
      {/* ── Steps ── */}
      <aside className="wb-side">
        <i className="blob b1" /><i className="blob b2" /><i className="blob b3" /><i className="blob b4" /><i className="grain" />
        <div className="wb-side-top"><BrandMark className="wb-mark" /><b>VeyroApp</b><span className="wb-tag">for staffing agencies</span></div>
        <div className="wb-intro">
          <h2>Set up your agency in a few minutes.</h2>
          <p>Five short steps to get your workspace ready.</p>
        </div>
        <ol className="wb-stages">{STAGES.map((s, i) => (
          <li key={s.key} className={i < stage ? 'done' : i === stage ? 'now' : ''}>
            <button type="button" onClick={() => i < stage && go(i)} disabled={i > stage}><span className="dot">{i < stage ? <Check size={14} /> : i + 1}</span><span><b>{s.label}</b><small>{s.sub}</small></span></button>
          </li>))}</ol>
        <div className="wb-side-foot"><Lock size={13} /> Every agency is reviewed by our team before going live.</div>
      </aside>

      {/* ── Form ── */}
      <main className="wb-main">
        <div className="wb-top"><div className="wb-meter"><i style={{ width: `${pct}%` }} /></div><Link to="/login">Have an account? <b>Sign in</b></Link></div>
        <div key={stage} className={`wb-stage ${dir === 1 ? 'fwd' : 'back'}`}>
          <span className="wb-kicker">Step {stage + 1} of {STAGES.length}</span>
          {stage === 0 && codeSent && !token && <>
            <h1>Check your email</h1>
            <p className="wb-lead">We sent a 6-digit code to <b>{v.email.trim()}</b>. Enter it below to confirm it's you.</p>
            <CodeBoxes value={code} onChange={c => { setCode(c); setErr(null); if (c.length === 6) verifyCode(c).then(ok => ok && (setDir(1), setStage(1))); }} disabled={busy} />
            {devOutbox && <div className="wb-summary"><MailCheck size={15} /><span>Real emails aren't switched on here yet — open the <a href="/dev/outbox" target="_blank" rel="noreferrer">Dev Outbox</a> to see the code.</span></div>}
            <div className="wb-links"><button type="button" className="wb-linkbtn" disabled={resendIn > 0 || busy} onClick={sendCode}>{resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}</button><button type="button" className="wb-linkbtn" onClick={() => { setCodeSent(false); setCode(''); }}>Use a different email</button></div>
          </>}
          {stage === 0 && (!codeSent || token) && <>
            {token && <div className="wb-verified"><MailCheck size={15} /> {v.email.trim()} confirmed</div>}
            <h1>Create your agency account</h1><p className="wb-lead">You'll use this to sign in and manage your team.</p>
            <F label="Full name" icon={<User size={16} />} error={errs.name}><input autoFocus autoComplete="name" value={v.name} onChange={e => set('name', e.target.value)} placeholder="Jane Smith" /></F>
            <F label="Work email" icon={<Mail size={16} />} error={errs.email} hint="We'll email you here when your account is approved."><input type="email" autoComplete="email" value={v.email} onChange={e => set('email', e.target.value)} placeholder="jane@youragency.com" /></F>
            {!viaGoogle && <>
            <F label="Password" icon={<Lock size={16} />} error={errs.password}>
              <input type={showPw ? 'text' : 'password'} autoComplete="new-password" value={v.password} onChange={e => set('password', e.target.value)} placeholder="At least 8 characters" />
              <button type="button" className="wb-eye" onClick={() => setShowPw(s => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </F>
            {v.password && <div className={`wb-strength s${pw}`}><i /><i /><i /><i /><span>{STRENGTH[pw]}</span></div>}
            </>}
            {viaGoogle && <div className="wb-summary"><MailCheck size={15} /><span>Signed in with Google — no password needed. You can add one later with "Forgot password".</span></div>}
            {!token && <GoogleButton intent="signup" className="wb-google" />}
          </>}
          {stage === 1 && <>
            <h1>Tell us about your business</h1><p className="wb-lead">Your clients and candidates will see this name.</p>
            <F label="Business name" icon={<Building2 size={16} />} error={errs.agencyName}><input autoFocus autoComplete="organization" value={v.agencyName} onChange={e => set('agencyName', e.target.value)} placeholder="Magahire" /></F>
            <div className="wb-two">
              <F label="Country" icon={<MapPin size={16} />} error={errs.country}><input autoComplete="country-name" value={v.country} onChange={e => set('country', e.target.value)} placeholder="United States" /></F>
              <F label="Phone (optional)" icon={<Phone size={16} />}><input type="tel" autoComplete="tel" value={v.phone} onChange={e => set('phone', e.target.value)} placeholder="+1 555 123 4567" /></F>
            </div>
            <F label="Website (optional)" icon={<Globe size={16} />}><input autoComplete="url" value={v.website} onChange={e => set('website', e.target.value)} placeholder="youragency.com" /></F>
          </>}
          {stage === 2 && <>
            <h1>How does {biz} work today?</h1><p className="wb-lead">This helps us set up your workspace — it's not a test.</p>
            <div className="wb-group"><span className="wb-label">Internal team size</span><Pills options={TEAM} value={v.team_size} onChange={x => set('team_size', x)} />{errs.team_size && <small className="wb-err">{errs.team_size}</small>}</div>
            <div className="wb-group"><span className="wb-label">VAs / remote staff placed right now</span><Pills options={WORKERS} value={v.active_workers} onChange={x => set('active_workers', x)} />{errs.active_workers && <small className="wb-err">{errs.active_workers}</small>}</div>
            <div className="wb-group"><span className="wb-label">Industries you staff for <em>optional</em></span><Pills multi options={INDUSTRIES} value={v.industries} onChange={x => set('industries', x)} /></div>
            <div className="wb-group"><span className="wb-label">What you use today <em>optional</em></span><Pills options={SOFTWARE} value={v.previous_software} onChange={x => set('previous_software', x)} /></div>
          </>}
          {stage === 3 && <>
            <h1>Make it yours</h1><p className="wb-lead">Your logo appears on your client portal, application pages and emails. Watch the preview on the left.</p>
            <label className={`wb-upload ${logo ? 'has' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setLogo(f); }}>
              <input type="file" hidden accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) { if (f.size > 5 * 1024 * 1024) setErr('Logo must be under 5 MB'); else setLogo(f); } e.target.value = ''; }} />
              {logoUrl ? <img src={logoUrl} alt="Your logo" /> : <span className="wb-up-ic"><ImagePlus size={22} /></span>}
              <span><b>{logo ? logo.name : 'Upload your logo'}</b><small>{logo ? 'Click to replace' : 'PNG, JPG or SVG · drag & drop works too'}</small></span>
            </label>
            <div className="wb-group"><span className="wb-label">Brand color</span><div className="wb-swatches">{COLORS.map(c => <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={v.color === c} className={v.color === c ? 'on' : ''} style={{ background: c }} onClick={() => set('color', c)} />)}</div></div>
          </>}
          {stage === 4 && <>
            <h1>Verify your business</h1><p className="wb-lead">Optional, but agencies with a registration document are approved fastest.</p>
            <label className={`wb-upload ${doc ? 'has' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setDoc(f); }}>
              <input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" onChange={e => { const f = e.target.files?.[0]; if (f) { if (f.size > 15 * 1024 * 1024) setErr('Document must be under 15 MB'); else setDoc(f); } e.target.value = ''; }} />
              <span className="wb-up-ic">{doc ? <Check size={22} /> : <FileCheck2 size={22} />}</span>
              <span><b>{doc ? doc.name : 'Business registration or incorporation certificate'}</b><small>{doc ? 'Click to replace' : 'PDF, image or Word · up to 15 MB'}</small></span>
            </label>
            <div className="wb-two">
              <F label="Legal company name (optional)"><input value={v.legal_name} onChange={e => set('legal_name', e.target.value)} placeholder="Magahire LLC" /></F>
              <F label="Registration no. / EIN (optional)"><input value={v.registration_number} onChange={e => set('registration_number', e.target.value)} placeholder="12-3456789" /></F>
            </div>
            <div className="wb-summary"><Sparkles size={15} /><span><b>{biz}</b> · {v.name || '—'} · {v.email || '—'} · {v.country || '—'}</span></div>
          </>}
          {err && <div className="wb-alert" role="alert">{err}</div>}
        </div>
        <div className="wb-actions">
          {stage > 0 ? <button type="button" className="wb-btn ghost" onClick={() => go(stage - 1)} disabled={busy}><ArrowLeft size={16} /> Back</button> : <span />}
          <button type="button" className="wb-btn" onClick={() => (last ? submit() : go(stage + 1))} disabled={busy}>{busy ? <span className="spinner" /> : null}{last ? 'Submit application' : stage === 0 && !token ? (codeSent ? 'Verify email' : 'Send verification code') : stage === 3 && !logo ? 'Skip for now' : 'Continue'}{!busy && !last && <ArrowRight size={16} />}</button>
        </div>
      </main>
    </div>
    </div>
  );
}
