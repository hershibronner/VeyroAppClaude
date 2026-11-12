// Agency sign-up — "workspace builder": a live preview of the agency's VeyroApp workspace (left) fills in as the
// owner completes five short stages (right). Submitting creates the account in "pending approval".
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, ImagePlus, FileCheck2, Lock, Mail, User, Building2, Globe, Phone, MapPin, Sparkles, Users, Briefcase, LayoutDashboard, Inbox, BarChart3 } from 'lucide-react';
import { api, ApiError, setCsrf } from '../lib/api';
import { useAuth } from '../lib/auth';
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

export default function SignupPage() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [v, setV] = useState({ name: '', email: '', agencyName: '', password: '', phone: '', website: '', country: '', team_size: '', active_workers: '', industries: [] as string[], previous_software: '', legal_name: '', registration_number: '', color: COLORS[0] });
  const set = (k: keyof typeof v, val: any) => { setV(s => ({ ...s, [k]: val })); setErrs(e => ({ ...e, [k]: '' })); };
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
  const pw = strength(v.password);
  const biz = v.agencyName.trim() || 'Your agency';

  const check = (i: number) => {
    const e: Record<string, string> = {};
    if (i === 0) { if (v.name.trim().length < 2) e.name = 'Enter your name'; if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) e.email = 'Enter a valid email'; if (v.password.length < 8) e.password = 'Use at least 8 characters'; }
    if (i === 1) { if (v.agencyName.trim().length < 2) e.agencyName = 'Enter your business name'; if (!v.country.trim()) e.country = 'Enter your country'; }
    if (i === 2) { if (!v.team_size) e.team_size = 'Pick your team size'; if (!v.active_workers) e.active_workers = 'Pick one'; }
    setErrs(e); return !Object.keys(e).length;
  };
  const go = (to: number) => { if (to > stage && !check(stage)) return; setDir(to > stage ? 1 : -1); setStage(to); setErr(null); };
  const submit = async () => {
    for (let i = 0; i < 3; i++) if (!check(i)) { setDir(-1); setStage(i); return; }
    setBusy(true); setErr(null);
    try {
      const { color, ...body } = v;
      await api.post('/api/v1/auth/register', { ...body, agencyName: v.agencyName.trim(), name: v.name.trim(), email: v.email.trim() });
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
      if (/email/i.test(msg)) { setErrs({ email: msg }); setDir(-1); setStage(0); }
    } finally { setBusy(false); }
  };
  const last = stage === STAGES.length - 1;
  const pct = Math.round((stage / (STAGES.length - 1)) * 100);

  return (
    <div className="wb" style={{ ['--brand' as any]: v.color }}>
      {/* ── Live workspace preview ── */}
      <aside className="wb-side">
        <div className="wb-side-top"><span className="wb-mark">V</span><b>VeyroApp</b><span className="wb-tag">for staffing agencies</span></div>
        <div className="wb-preview" aria-hidden>
          <div className="wb-pv-bar"><i /><i /><i /><span>app.veyro/{(v.agencyName.trim() || 'your-agency').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}</span></div>
          <div className="wb-pv-body">
            <div className="wb-pv-nav">
              <div className="wb-pv-logo">{logoUrl ? <img src={logoUrl} alt="" /> : <span>{biz.slice(0, 1).toUpperCase()}</span>}<b>{biz}</b></div>
              {[[LayoutDashboard, 'Dashboard'], [Briefcase, 'Positions'], [Users, 'Candidates'], [Inbox, 'Clients'], [BarChart3, 'Reports']].map(([Ic, l]: any, i) => <div key={l} className={`wb-pv-item ${i === 0 ? 'on' : ''}`}><Ic size={12} />{l}</div>)}
            </div>
            <div className="wb-pv-main">
              <div className="wb-pv-hello">Good morning{v.name.trim() ? `, ${v.name.trim().split(/\s+/)[0]}` : ''} 👋</div>
              <div className="wb-pv-cards">
                <div><small>Open positions</small><b>{v.industries.length ? v.industries.length * 3 : '—'}</b></div>
                <div><small>Placed VAs</small><b>{({ starting: '0', '1-10': '8', '11-50': '32', '51+': '74' } as any)[v.active_workers] ?? '—'}</b></div>
                <div><small>Team</small><b>{({ just_me: '1', '2-5': '4', '6-20': '12', '21+': '25' } as any)[v.team_size] ?? '—'}</b></div>
              </div>
              <div className="wb-pv-chips">{(v.industries.length ? v.industries : ['Your', 'industries']).slice(0, 4).map(x => <span key={x}>{x}</span>)}</div>
              <div className="wb-pv-rows">{[0, 1, 2].map(i => <div key={i}><span className="av" /><i style={{ width: `${60 - i * 12}%` }} /><em /></div>)}</div>
            </div>
          </div>
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
          {stage === 0 && <>
            <h1>Create your agency account</h1><p className="wb-lead">You'll use this to sign in and manage your team.</p>
            <F label="Full name" icon={<User size={16} />} error={errs.name}><input autoFocus autoComplete="name" value={v.name} onChange={e => set('name', e.target.value)} placeholder="Jane Smith" /></F>
            <F label="Work email" icon={<Mail size={16} />} error={errs.email} hint="We'll email you here when your account is approved."><input type="email" autoComplete="email" value={v.email} onChange={e => set('email', e.target.value)} placeholder="jane@youragency.com" /></F>
            <F label="Password" icon={<Lock size={16} />} error={errs.password}>
              <input type={showPw ? 'text' : 'password'} autoComplete="new-password" value={v.password} onChange={e => set('password', e.target.value)} placeholder="At least 8 characters" />
              <button type="button" className="wb-eye" onClick={() => setShowPw(s => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </F>
            {v.password && <div className={`wb-strength s${pw}`}><i /><i /><i /><i /><span>{STRENGTH[pw]}</span></div>}
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
          <button type="button" className="wb-btn" onClick={() => (last ? submit() : go(stage + 1))} disabled={busy}>{busy ? <span className="spinner" /> : null}{last ? 'Submit application' : stage === 3 && !logo ? 'Skip for now' : 'Continue'}{!busy && !last && <ArrowRight size={16} />}</button>
        </div>
      </main>
    </div>
  );
}
