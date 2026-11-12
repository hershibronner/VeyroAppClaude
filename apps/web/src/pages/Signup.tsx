// Agency sign-up: one question per screen. Submitting creates the account in "pending approval";
// a VeyroApp admin approves it and the owner gets an email when it is active.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Rocket, ShieldCheck, Clock, Users, User, UsersRound, Building, Building2, Eye, EyeOff, Image as ImageIcon, FileCheck2, CheckCircle2, FileSpreadsheet, Database, Layers, HelpCircle, Search, Share2, Megaphone, UserPlus } from 'lucide-react';
import { api, ApiError, setCsrf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Flow, useFlowIndex, Choices, ChipPicker, FlowInput, type FlowStep } from '../components/Flow';
import './signup.css';

const BRAND = { name: 'VeyroApp', logo_text: 'VeyroApp', primary_color: '#345CFF', accent_color: '#7044FF', hide_powered_by: true };
const INDUSTRIES = ['Dental', 'Medical', 'Real estate', 'Insurance', 'E-commerce', 'Legal', 'Accounting', 'Marketing', 'Customer support', 'Tech / IT', 'Home services', 'Logistics'];
const TEAM = [
  { value: 'just_me', label: 'Just me', icon: <User size={18} /> },
  { value: '2-5', label: '2 – 5 people', icon: <Users size={18} /> },
  { value: '6-20', label: '6 – 20 people', icon: <UsersRound size={18} /> },
  { value: '21+', label: '21 or more', icon: <Building size={18} /> },
];
const WORKERS = [
  { value: 'starting', label: 'Just getting started', desc: 'No active placements yet', icon: <Rocket size={18} /> },
  { value: '1-10', label: '1 – 10 placed VAs', icon: <Users size={18} /> },
  { value: '11-50', label: '11 – 50 placed VAs', icon: <UsersRound size={18} /> },
  { value: '51+', label: '51 or more', icon: <Building2 size={18} /> },
];
const SOFTWARE = [
  { value: 'Spreadsheets', label: 'Excel / Google Sheets', icon: <FileSpreadsheet size={18} /> },
  { value: 'Bullhorn', label: 'Bullhorn', icon: <Database size={18} /> },
  { value: 'Recruit CRM', label: 'Recruit CRM', icon: <Database size={18} /> },
  { value: 'Zoho Recruit', label: 'Zoho Recruit', icon: <Database size={18} /> },
  { value: 'Other software', label: 'Something else', icon: <Layers size={18} /> },
  { value: 'Nothing yet', label: 'Nothing yet', icon: <HelpCircle size={18} /> },
];
const HEARD = [
  { value: 'Google', label: 'Google search', icon: <Search size={18} /> },
  { value: 'Social media', label: 'Social media', icon: <Share2 size={18} /> },
  { value: 'Referral', label: 'A friend or colleague', icon: <UserPlus size={18} /> },
  { value: 'Ad', label: 'An ad', icon: <Megaphone size={18} /> },
];

function strength(pw: string) {
  let s = 0;
  if (pw.length >= 8) s++; if (pw.length >= 12) s++; if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++; if (/\d/.test(pw)) s++; if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}
const STRENGTH = ['Too short', 'Weak', 'Okay', 'Strong', 'Very strong'];

function Drop({ accept, file, preview, icon, title, sub, onFile }: { accept: string; file: File | null; preview?: string | null; icon: React.ReactNode; title: string; sub: string; onFile: (f: File) => void }) {
  const [over, setOver] = useState(false);
  return (
    <label className={`flow-drop ${over ? 'on' : ''} ${file ? 'has' : ''}`} data-flow-focus tabIndex={0} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}>
      <input type="file" hidden accept={accept} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {preview ? <img className="signup-logo-preview" src={preview} alt="Your logo" /> : <span className="flow-drop-ic">{file ? <CheckCircle2 size={28} /> : icon}</span>}
      <b>{file ? file.name : title}</b><small>{file ? 'Looks great — click to replace it' : sub}</small>
    </label>
  );
}

export default function SignupPage() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [v, setV] = useState({ name: '', email: '', agencyName: '', password: '', phone: '', website: '', country: '', team_size: '', active_workers: '', industries: [] as string[], previous_software: '', heard_from: '', legal_name: '', registration_number: '' });
  const set = (k: keyof typeof v, val: any) => setV(s => ({ ...s, [k]: val }));
  const [showPw, setShowPw] = useState(false);
  const [logo, setLogo] = useState<File | null>(null);
  const [doc, setDoc] = useState<File | null>(null);
  const logoUrl = useMemo(() => (logo ? URL.createObjectURL(logo) : null), [logo]);
  useEffect(() => () => { if (logoUrl) URL.revokeObjectURL(logoUrl); }, [logoUrl]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const first = v.name.trim().split(/\s+/)[0];
  const pwScore = strength(v.password);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/api/v1/auth/register', { ...v, agencyName: v.agencyName.trim(), name: v.name.trim(), email: v.email.trim() });
      if (logo || doc) {
        // The new session has its own CSRF token; fetch it without re-rendering the app (which would remount this page).
        const fresh = await api.get<{ csrf: string }>('/api/v1/auth/me'); setCsrf(fresh.csrf);
        const fd = new FormData();
        if (logo) fd.append('logo', logo, logo.name);
        if (doc) fd.append('registration', doc, doc.name);
        await api.upload('/api/v1/onboarding/application/files', fd).catch(() => { /* the account exists; files can be re-sent from the pending screen */ });
      }
      await refresh();
      nav('/', { replace: true });
    } catch (x) {
      const msg = x instanceof ApiError ? x.message : 'Something went wrong — please try again.';
      setErr(msg);
      if (x instanceof ApiError && /email/i.test(msg)) flow.go(steps.findIndex(s => s.id === 'email'));
    } finally { setBusy(false); }
  };

  const steps: FlowStep[] = [
    { id: 'welcome', bare: true, cta: "Let's get started", title: <>Run your staffing company <span className="grad">in one place</span>.</>,
      hint: 'Create your VeyroApp agency account. It takes about three minutes — we review every new agency and email you as soon as you are approved.',
      body: <div className="flow-welcome-meta"><span><Clock size={15} /> 3 minutes</span><span><ShieldCheck size={15} /> Reviewed by our team</span><span><Rocket size={15} /> Import your data with AI</span></div> },
    { id: 'name', title: "Hi there! What's your name?", validate: () => (v.name.trim().length >= 2 ? null : 'Please tell us your name'),
      body: <FlowInput autoComplete="name" value={v.name} onChange={e => set('name', e.target.value)} placeholder="Jane Smith" /> },
    { id: 'email', title: <>Nice to meet you{first ? `, ${first}` : ''}! What's your work email?</>, hint: "This is how you'll sign in — and where we'll tell you when your account is approved.",
      validate: () => (/^\S+@\S+\.\S+$/.test(v.email.trim()) ? null : 'Enter a valid email address'),
      body: <FlowInput type="email" autoComplete="email" inputMode="email" value={v.email} onChange={e => { set('email', e.target.value); setErr(null); }} placeholder="jane@youragency.com" /> },
    { id: 'business', title: "What's the name of your business?", hint: 'Your team, clients and candidates will see this name.', validate: () => (v.agencyName.trim().length >= 2 ? null : 'Enter your business name'),
      body: <FlowInput autoComplete="organization" value={v.agencyName} onChange={e => set('agencyName', e.target.value)} placeholder="Magahire" /> },
    { id: 'password', title: 'Create a password', hint: 'At least 8 characters. Mixing letters, numbers and a symbol makes it stronger.', validate: () => (v.password.length >= 8 ? null : 'Use at least 8 characters'),
      body: <>
        <div className="signup-pw"><FlowInput type={showPw ? 'text' : 'password'} autoComplete="new-password" value={v.password} onChange={e => set('password', e.target.value)} placeholder="••••••••" />
          <button type="button" className="signup-pw-eye" data-flow-noenter onClick={() => setShowPw(s => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
        <div className={`signup-meter s${v.password ? pwScore : 0}`} aria-live="polite"><i /><i /><i /><i /><span>{v.password ? STRENGTH[pwScore] : ' '}</span></div>
      </> },
    { id: 'phone', title: 'Best phone number to reach you?', hint: 'Optional — only used if our team has a question about your application.', optional: true,
      body: <FlowInput type="tel" autoComplete="tel" inputMode="tel" value={v.phone} onChange={e => set('phone', e.target.value)} placeholder="+1 555 123 4567" /> },
    { id: 'where', title: <>Where is {v.agencyName.trim() || 'your business'} based?</>, validate: () => (v.country.trim() ? null : 'Tell us your country'),
      body: <div className="flow-row2"><FlowInput label="Country" autoComplete="country-name" value={v.country} onChange={e => set('country', e.target.value)} placeholder="United States" /><FlowInput label="Website (optional)" autoComplete="url" value={v.website} onChange={e => set('website', e.target.value)} placeholder="youragency.com" /></div> },
    { id: 'team', title: 'How big is your internal team?', hint: 'Recruiters, sales, account managers — not the VAs you place.', validate: () => (v.team_size ? null : 'Pick one'),
      body: <Choices value={v.team_size} onChange={x => set('team_size', x)} onPicked={() => flow.next()} options={TEAM} /> },
    { id: 'workers', title: 'How many remote staff do you have placed right now?', validate: () => (v.active_workers ? null : 'Pick one'),
      body: <Choices value={v.active_workers} onChange={x => set('active_workers', x)} onPicked={() => flow.next()} options={WORKERS} /> },
    { id: 'industries', title: 'Which industries do you staff for?', hint: 'Tap all that apply, or add your own.', optional: true,
      body: <ChipPicker options={INDUSTRIES} value={v.industries} onChange={x => set('industries', x)} /> },
    { id: 'software', title: 'What do you use today to manage recruiting?', hint: "We'll help you bring that data over after you're approved.", optional: true,
      body: <Choices columns={3} value={v.previous_software} onChange={x => set('previous_software', x)} onPicked={() => flow.next()} options={SOFTWARE} /> },
    { id: 'logo', title: 'Upload your logo', hint: 'It shows on your client portal, candidate application pages and emails. PNG, JPG or SVG.', optional: true, cta: logo ? 'Looks good' : 'OK',
      body: <Drop accept="image/png,image/jpeg,image/svg+xml,image/webp" file={logo} preview={logoUrl} icon={<ImageIcon size={28} />} title="Drop your logo here" sub="or click to browse · square images look best" onFile={f => { if (f.size > 5 * 1024 * 1024) setErr('Logo must be under 5 MB'); else { setErr(null); setLogo(f); } }} /> },
    { id: 'verify', title: 'Help us verify your business', hint: 'Your business registration or incorporation certificate speeds up approval. You can skip this and send it later.', optional: true,
      body: <>
        <Drop accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" file={doc} icon={<FileCheck2 size={28} />} title="Drop your business registration" sub="PDF, image or Word · up to 15 MB" onFile={f => { if (f.size > 15 * 1024 * 1024) setErr('Document must be under 15 MB'); else { setErr(null); setDoc(f); } }} />
        <div className="flow-row2" style={{ marginTop: 14 }}><FlowInput label="Legal company name (optional)" value={v.legal_name} onChange={e => set('legal_name', e.target.value)} placeholder="Magahire LLC" /><FlowInput label="Registration / EIN (optional)" value={v.registration_number} onChange={e => set('registration_number', e.target.value)} placeholder="12-3456789" /></div>
      </> },
    { id: 'heard', title: 'Last one — how did you hear about VeyroApp?', optional: true,
      body: <Choices value={v.heard_from} onChange={x => set('heard_from', x)} onPicked={() => flow.next()} options={HEARD} /> },
    { id: 'review', title: 'All set — does this look right?', cta: 'Create my account',
      body: <div className="flow-review">
        {logoUrl && <div className="signup-review-logo" style={{ ['--d' as any]: '120ms' }}><img src={logoUrl} alt="" /></div>}
        {([['Name', v.name, 'name'], ['Email', v.email, 'email'], ['Business', v.agencyName, 'business'], ['Phone', v.phone || '—', 'phone'], ['Location', [v.country, v.website].filter(Boolean).join(' · '), 'where'],
          ['Team', TEAM.find(t => t.value === v.team_size)?.label, 'team'], ['Placed staff', WORKERS.find(t => t.value === v.active_workers)?.label, 'workers'], ['Industries', v.industries.join(', ') || '—', 'industries'],
          ['Current software', v.previous_software || '—', 'software'], ['Logo', logo ? logo.name : 'Not added', 'logo'], ['Verification', doc ? doc.name : 'Not added', 'verify']] as [string, string | undefined, string][]).map(([k, val, id], i) =>
          <div key={k} className="flow-review-row" style={{ ['--d' as any]: `${i * 40 + 200}ms` }}><span>{k}</span><b>{val || '—'}</b><button type="button" onClick={() => flow.go(steps.findIndex(s => s.id === id))}>Edit</button></div>)}
        <p className="flow-hint" style={{ fontSize: 13, marginTop: 14 }}>By creating an account you agree to the VeyroApp terms. Your application is reviewed by our team, usually within one business day.</p>
      </div> },
  ];
  const flow = useFlowIndex(steps.length);
  return (
    <Flow brand={BRAND} steps={steps} index={flow.index} dir={flow.dir} busy={busy} error={err}
      onAdvance={() => (flow.index === steps.length - 1 ? submit() : flow.next())} onBack={flow.back}
      topRight={<Link to="/login" className="flow-toplink">Already have an account? <b>Sign in</b></Link>}
      footerNote={<>Questions? <a href="mailto:support@veyroapp.com">support@veyroapp.com</a></>} />
  );
}

