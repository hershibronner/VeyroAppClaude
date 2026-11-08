// Public, tenant-branded application (no login): one question per screen. Resume first — the local AI reads it
// and pre-fills what it finds (only facts present in the resume); the candidate confirms each answer.
// Attribution comes from the link token on the server.
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Upload, Clock, MapPin, Briefcase, Users, Sparkles, CheckCircle2, Plus, X, Zap, CalendarDays, CalendarClock, Hourglass, Globe2, FileText, Link2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { humanize, money, todayISO, addDaysISO } from '../../lib/format';
import { COUNTRY_CODES } from '../../components/ui';
import { Flow, useFlowIndex, Choices, NumberPicker, RangeSlider, ChipPicker, FlowInput, FlowTextarea, AiReveal, FromResume, Confetti, DoneMark, type FlowStep } from '../../components/Flow';
import { tzOpts, CURRENCIES, UNITS } from './shared';
import { VideoCapture, Confirmation } from './ApplyParts';
import { FlowMessage } from '../crm/IntakeFlow';

const COUNTRY_NAMES = COUNTRY_CODES.map(c => c.name).sort();
const TZ_GUESS = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
const PREFILL_KEYS = ['first_name', 'last_name', 'email', 'phone', 'headline', 'city', 'country', 'years_experience', 'skills', 'software', 'languages', 'education', 'experience'] as const;
const FIELD_LABEL: Record<string, string> = { first_name: 'First name', last_name: 'Last name', email: 'Email', phone: 'Phone', headline: 'Current role', city: 'City', country: 'Country', years_experience: 'Experience', skills: 'Skills', software: 'Software', languages: 'Languages', education: 'Education', experience: 'Jobs' };
type Upl = { upload: string; filename: string; url?: string };

export default function Apply({ kind }: { kind?: 'r' | 'p' }) {
  const { slug, token } = useParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const page = useApi<any>(`/api/v1/public/apply/${slug}`, [slug]);
  const link = useApi<any>(kind && token ? `/api/v1/public/apply/${slug}/link/${kind}/${token}` : null, [kind, token]);
  const [v, setV] = useState<Record<string, any>>({ first_name: '', last_name: '', email: '', phone: '', country: '', city: '', timezone: tzOpts.some(t => t.value === TZ_GUESS) ? TZ_GUESS : '', headline: '', years_experience: '', skills: [], software: [], languages: ['English'], education: [], experience: [], availability_status: null, earliest_start: '', weekly_hours: 40, preferred_hours: '', rate_min_cents: 500, rate_target_cents: 900, rate_currency: 'USD', rate_unit: 'hour', rate_note: '', portfolio_url: '', position_id: null, consent: false });
  const set = (k: string, val: any) => setV(s => ({ ...s, [k]: val }));
  const [resume, setResume] = useState<Upl | null>(null);
  const [video, setVideo] = useState<Upl | null>(null);
  const [portfolio, setPortfolio] = useState<Upl | null>(null);
  const [prefill, setPrefill] = useState<{ fields: string[]; items: { label: string; value: string }[]; aiError?: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);

  const d = page.data;
  const position = link.data?.position ?? (v.position_id ? d?.positions.find((p: any) => p.id === v.position_id) : null);
  const needsRolePick = !!d && !link.data?.position && d.positions.length > 0;
  const tag = (k: string) => (prefill?.fields.includes(k) ? <FromResume /> : null);

  const uploadFile = useCallback(async (k: 'resume' | 'video' | 'portfolio', f: File | Blob, name: string) => {
    const fd = new FormData(); fd.append('file', f, name);
    return api.upload(`/api/v1/public/apply/${slug}/upload/${k}`, fd);
  }, [slug]);

  const steps: FlowStep[] = useMemo(() => !d ? [] : ([
    { id: 'welcome', bare: true, cta: 'Start my application',
      title: position ? <>Apply for <span className="grad">{position.title}</span></> : <>Work with <span className="grad">{d.org.name}</span></>,
      hint: <>{link.data?.recruiter_first_name ? `${link.data.recruiter_first_name} from ${d.org.name} invited you. ` : ''}Upload your resume and our AI fills in most of this for you — it takes about 3 minutes.
        {link.error ? ` (${(link.error as any).message})` : ''}{link.data?.position_closed ? ' That position is closed — your application joins our talent pool.' : ''}</>,
      body: <div className="flow-welcome-meta">{position ? [
        position.employment_type && <span key="t"><Briefcase size={15} /> {humanize(position.employment_type)}</span>,
        position.schedule && <span key="s"><Clock size={15} /> {position.schedule}</span>,
        position.timezone && <span key="z"><Globe2 size={15} /> {position.timezone.replace('_', ' ')}</span>,
        position.weekly_hours && <span key="h"><Hourglass size={15} /> {position.weekly_hours} h/week</span>,
      ] : [<span key="r"><MapPin size={15} /> 100% remote</span>, <span key="u"><Users size={15} /> US clients</span>, <span key="c"><Clock size={15} /> 3 minutes</span>]}</div> },
    needsRolePick && { id: 'role', title: 'Which role are you applying for?', hint: 'Pick one — or join the talent pool and we will match you.', optional: true,
      body: <Choices value={v.position_id ?? '__pool'} onChange={x => set('position_id', x === '__pool' ? null : x)} onPicked={() => flow.next()}
        options={[...d.positions.slice(0, 9).map((p: any) => ({ value: p.id, label: p.title, desc: [humanize(p.employment_type), p.weekly_hours ? `${p.weekly_hours} h/week` : null].filter(Boolean).join(' · '), icon: <Briefcase size={17} /> })), { value: '__pool', label: 'Any role', desc: 'Join the talent pool', icon: <Sparkles size={17} /> }]} /> },
    { id: 'resume', title: <>Upload your resume — <span className="grad">our AI does the typing</span>.</>, hint: 'We only copy what is written in your resume, and you check every answer. PDF, DOCX or TXT, up to 15 MB.', noCta: true,
      body: <><DropZone busy={uploading} file={resume?.filename} onFile={onResume} />
        <button type="button" className="flow-skip" style={{ marginTop: 14 }} onClick={() => flow.next()}>{resume ? 'Continue' : "I don't have it handy — skip for now"}</button></> },
    resume && prefill && { id: 'ai', bare: true, noCta: !prefill.aiError, cta: 'Continue',
      title: prefill.aiError ? 'We saved your resume' : <><Sparkles size={30} style={{ verticalAlign: '-4px', color: 'var(--fb)' }} /> Reading your resume…</>,
      hint: prefill.aiError ? `${prefill.aiError} You'll fill in a few quick questions instead.` : prefill.items.length ? `Found ${prefill.items.length} details in ${resume.filename}.` : 'We could not find details to copy — you will fill them in next.',
      body: prefill.aiError ? undefined : <AiReveal items={prefill.items} onDone={() => flow.next()} /> },
    { id: 'name', title: "What's your name?", hint: tag('first_name'), validate: () => (!v.first_name.trim() ? 'First name is required' : !v.last_name.trim() ? 'Last name is required' : null),
      body: <div className="flow-row2"><FlowInput label="First name" autoComplete="given-name" value={v.first_name} onChange={e => set('first_name', e.target.value)} placeholder="Maria" /><FlowInput label="Last name" autoComplete="family-name" value={v.last_name} onChange={e => set('last_name', e.target.value)} placeholder="Santos" /></div> },
    { id: 'email', title: <>Hi {v.first_name || 'there'}! What's your email?</>, hint: tag('email') ?? 'We will send your application updates here.', validate: () => (/^\S+@\S+\.\S+$/.test(v.email.trim()) ? null : 'Enter a valid email'),
      body: <FlowInput type="email" autoComplete="email" inputMode="email" value={v.email} onChange={e => set('email', e.target.value)} placeholder="maria@email.com" /> },
    { id: 'phone', title: 'And your phone or WhatsApp number?', hint: tag('phone') ?? 'Include your country code.', validate: () => (v.phone.replace(/\D/g, '').length >= 7 ? null : 'Enter your phone number with country code'),
      body: <FlowInput type="tel" autoComplete="tel" inputMode="tel" value={v.phone} onChange={e => set('phone', e.target.value)} placeholder="+63 917 555 0101" /> },
    { id: 'location', title: 'Where are you based?', hint: tag('country'), validate: () => (v.country.trim().length >= 2 ? null : 'Country is required'),
      body: <><div className="flow-row2"><FlowInput label="Country" list="ap-countries" autoComplete="country-name" value={v.country} onChange={e => set('country', e.target.value)} placeholder="Philippines" /><FlowInput label="City" value={v.city} onChange={e => set('city', e.target.value)} placeholder="Manila" /></div>
        <datalist id="ap-countries">{COUNTRY_NAMES.map(c => <option key={c} value={c} />)}</datalist>
        <select className="flow-select" aria-label="Your timezone" value={v.timezone} onChange={e => set('timezone', e.target.value)}><option value="">Your timezone…</option>{tzOpts.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></> },
    { id: 'headline', title: 'What do you do, and for how long?', hint: tag('headline'),
      body: <div className="flow-row2"><FlowInput label="Current role / headline" value={v.headline} onChange={e => set('headline', e.target.value)} placeholder="Dental Virtual Assistant" /><FlowInput label="Years of experience" type="number" min={0} max={60} inputMode="numeric" value={v.years_experience} onChange={e => set('years_experience', e.target.value)} placeholder="4" /></div> },
    { id: 'skills', title: 'Your top skills', hint: tag('skills') ?? 'Tap to select, or type your own.', validate: () => (v.skills.length ? null : 'Add at least one skill'),
      body: <ChipPicker options={[...(position?.skills ?? []), 'Customer Service', 'Scheduling', 'Data Entry', 'Email Management', 'Bookkeeping', 'Social Media Management']} value={v.skills} onChange={x => set('skills', x)} /> },
    { id: 'software', title: 'Which software do you use?', hint: tag('software') ?? 'Tools you are comfortable with.', optional: true,
      body: <ChipPicker options={[...(position?.software ?? []), 'Google Workspace', 'Microsoft Office', 'Slack', 'Zoom', 'QuickBooks', 'Canva', 'Asana']} value={v.software} onChange={x => set('software', x)} /> },
    { id: 'languages', title: 'Which languages do you speak?', hint: tag('languages'), validate: () => (v.languages.length ? null : 'Add at least one language'),
      body: <ChipPicker options={['English', 'Spanish', 'Tagalog', 'Portuguese', 'French', 'Afrikaans', 'Swahili']} value={v.languages} onChange={x => set('languages', x)} /> },
    { id: 'experience', title: 'Where have you worked?', hint: tag('experience') ?? 'Your most recent roles (optional).', optional: true,
      body: <Rows rows={v.experience} onChange={x => set('experience', x)} cols={[['title', 'Job title'], ['company', 'Company'], ['start', 'From'], ['end', 'To (or Present)']]} addLabel="Add a job" /> },
    { id: 'education', title: 'Your education', hint: tag('education') ?? 'Degree, course or certificate (optional).', optional: true,
      body: <Rows rows={v.education} onChange={x => set('education', x)} cols={[['degree', 'Degree / course'], ['school', 'School'], ['year', 'Year']]} addLabel="Add education" /> },
    { id: 'availability', title: 'Are you available right now?', validate: () => (v.availability_status ? null : 'Pick one'),
      body: <Choices value={v.availability_status} onChange={x => set('availability_status', x)} onPicked={() => flow.next()} options={[
        { value: 'available', label: 'Yes, available now', icon: <Zap size={17} /> }, { value: 'employed', label: 'Employed, but open to offers', icon: <Briefcase size={17} /> }, { value: 'not_available', label: 'Not right now', desc: 'Keep me in mind for later', icon: <Hourglass size={17} /> }]} /> },
    { id: 'start', title: 'When could you start?', optional: true,
      body: <><Choices columns={3} value={v.earliest_start === todayISO() ? 'now' : v.earliest_start === addDaysISO(todayISO(), 14) ? '2w' : v.earliest_start === addDaysISO(todayISO(), 30) ? '1m' : null}
        onChange={x => set('earliest_start', x === 'now' ? todayISO() : x === '2w' ? addDaysISO(todayISO(), 14) : addDaysISO(todayISO(), 30))}
        options={[{ value: 'now', label: 'Immediately', icon: <Zap size={17} /> }, { value: '2w', label: 'In 2 weeks', icon: <CalendarClock size={17} /> }, { value: '1m', label: 'In a month', icon: <CalendarDays size={17} /> }]} />
        <FlowInput label="Or pick a date" type="date" value={v.earliest_start} onChange={e => set('earliest_start', e.target.value)} /></> },
    { id: 'hours', title: 'How many hours a week can you work?',
      body: <><NumberPicker value={v.weekly_hours} onChange={n => set('weekly_hours', n)} min={5} max={60} quick={[20, 30, 40, 50]} unit={() => 'hours / week'} />
        <div style={{ height: 18 }} /><FlowInput label="Preferred working hours (optional)" value={v.preferred_hours} onChange={e => set('preferred_hours', e.target.value)} placeholder="US Eastern business hours, night shift OK" /></> },
    { id: 'rate', title: 'What hourly rate are you looking for?', hint: 'Be honest — your minimum is the lowest you would accept, your target is what feels right. We use this to match you to roles that fit.',
      validate: () => (v.rate_target_cents >= v.rate_min_cents ? null : 'Your target should be at least your minimum'),
      body: <><RangeSlider min={200} max={4000} step={50} low={v.rate_min_cents} high={v.rate_target_cents} onChange={(lo, hi) => setV(s => ({ ...s, rate_min_cents: lo, rate_target_cents: hi }))} format={c => money(c, v.rate_currency, { noCents: c % 100 === 0 })} labels={['Minimum', 'Target']} />
        <div className="flow-row2" style={{ marginTop: 18 }}><select className="flow-select" aria-label="Currency" value={v.rate_currency} onChange={e => set('rate_currency', e.target.value)}>{CURRENCIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
          <select className="flow-select" aria-label="Rate unit" value={v.rate_unit} onChange={e => set('rate_unit', e.target.value)}>{UNITS.map(u => <option key={u.value} value={u.value}>{u.label[0].toUpperCase() + u.label.slice(1)}</option>)}</select></div></> },
    { id: 'video', title: <>Say hello on camera <span style={{ fontSize: '0.6em', color: 'var(--soft)' }}>(recommended)</span></>, hint: 'A 30–90 second intro: who you are, your experience, why remote work suits you. Candidates with a video get reviewed first.', optional: true, cta: video ? 'Looks good' : 'Continue',
      body: <div className="flow-cardlet" style={{ marginTop: 0 }}><VideoCapture video={video} onUploaded={setVideo} upload={(b, n) => uploadFile('video', b, n)} /></div> },
    { id: 'portfolio', title: 'Anything to show us?', hint: 'A portfolio link or file (optional).', optional: true, validate: () => (v.portfolio_url && !/^https?:\/\//.test(v.portfolio_url) ? 'Enter a full link starting with https://' : null),
      body: <><FlowInput type="url" value={v.portfolio_url} onChange={e => set('portfolio_url', e.target.value)} placeholder="https://" />
        <label className="flow-skip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 14, textDecoration: 'none', cursor: 'pointer' }}><Link2 size={15} />{portfolio ? `${portfolio.filename} attached` : 'Or upload a file'}<input type="file" hidden onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { const r = await uploadFile('portfolio', f, f.name); setPortfolio({ upload: r.upload, filename: r.filename }); } catch (x) { setErr(x instanceof ApiError ? x.message : String(x)); } }} /></label></> },
    !resume && { id: 'resume2', title: 'Last thing — please add your resume', hint: 'We need it to put you forward for roles.', noCta: !resume, validate: () => (resume ? null : 'Please upload your resume'),
      body: <DropZone busy={uploading} file={null} onFile={f => onResume(f, true)} /> },
    { id: 'review', title: 'Ready to send?', cta: 'Submit application', validate: () => (v.consent ? null : 'Please confirm the information is accurate'),
      body: <>
        <div className="flow-review">{[
          ['Name', `${v.first_name} ${v.last_name}`, 'name'], ['Email', v.email, 'email'], ['Phone', v.phone, 'phone'], ['Location', [v.city, v.country].filter(Boolean).join(', '), 'location'],
          ['Role', [v.headline, v.years_experience ? `${v.years_experience} yrs` : ''].filter(Boolean).join(' · '), 'headline'], ['Skills', v.skills.join(', '), 'skills'], ['Languages', v.languages.join(', '), 'languages'],
          ['Availability', [humanize(v.availability_status), v.earliest_start ? `from ${v.earliest_start}` : ''].filter(Boolean).join(' '), 'availability'], ['Hours', `${v.weekly_hours} h/week`, 'hours'],
          ['Rate', `${money(v.rate_min_cents, v.rate_currency)} – ${money(v.rate_target_cents, v.rate_currency)} / ${v.rate_unit}`, 'rate'], ['Resume', resume?.filename, 'resume'], ['Video', video ? 'Added' : 'Not added', 'video'],
        ].map(([k, val, id], i) => <div key={k} className="flow-review-row" style={{ ['--d' as any]: `${i * 35 + 200}ms` }}><span>{k}</span><b>{val || '—'}</b><button type="button" onClick={() => flow.go(stepsRef.findIndex(s => s.id === id))}>Edit</button></div>)}</div>
        {position && <p className="flow-hint" style={{ fontSize: 15 }}>Applying for <b style={{ color: 'var(--ink)' }}>{position.title}</b>.</p>}
        <label className="flow-consent"><input type="checkbox" checked={v.consent} onChange={e => set('consent', e.target.checked)} /> I confirm this information is accurate and {d.org.name} may contact me about roles.</label>
      </> },
    { id: 'done', bare: true, noCta: true, title: <>You're in, {done?.first_name ?? v.first_name}! 🎉</>, hint: undefined,
      body: done ? <><Confetti colors={[d.org.primary_color, d.org.accent_color, '#1FAE5B', '#F59E0B']} /><DoneMark /><Confirmation compact done={done} org={d.org} slug={slug!} onAccount={async redirect => { await refresh(); nav(redirect, { replace: true }); }} /></> : null },
  ].filter(Boolean) as FlowStep[]),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [d, v, resume, video, portfolio, prefill, uploading, position, link.data, link.error, needsRolePick, done]);
  const stepsRef = steps;
  const flow = useFlowIndex(steps.length || 1);

  async function onResume(f: File, isLast = false) {
    setUploading(true); setErr(null);
    try {
      const r = await uploadFile('resume', f, f.name);
      setResume({ upload: r.upload, filename: r.filename });
      if (isLast) { setPrefill(p => p ?? { fields: [], items: [] }); return; }
      if (r.extraction) {
        const x = r.extraction.fields; const got: Record<string, any> = {}; const items: { label: string; value: string }[] = [];
        for (const k of PREFILL_KEYS) {
          const val = x[k]?.value; if (val === null || val === undefined || (Array.isArray(val) && !val.length)) continue;
          got[k] = k === 'years_experience' ? String(val) : val;
          const shown = Array.isArray(val) ? (typeof val[0] === 'object' ? `${val.length} found` : val.slice(0, 4).join(', ') + (val.length > 4 ? ` +${val.length - 4}` : '')) : k === 'years_experience' ? `${val} years` : String(val);
          items.push({ label: FIELD_LABEL[k], value: shown });
        }
        setV(s => ({ ...s, ...Object.fromEntries(Object.entries(got).map(([k, val]) => [k, k === 'languages' ? [...new Set([...(s.languages ?? []), ...(val as string[])])] : val])) }));
        setPrefill({ fields: Object.keys(got), items });
      } else setPrefill({ fields: [], items: [], aiError: r.ai_error ?? 'Our AI is unavailable right now.' });
      window.setTimeout(() => flow.next(), 50);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); } finally { setUploading(false); }
  }

  if (page.error) return <FlowMessage title="Application page not found" text="Check the link you were given." />;
  if (!d) return <FlowMessage title="Loading…" />;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body = {
        ...v, link_kind: kind ?? null, link_token: token ?? null, position_id: link.data?.position?.id ?? v.position_id ?? null,
        years_experience: v.years_experience === '' ? null : Number(v.years_experience) || null, availability_status: v.availability_status ?? 'available',
        earliest_start: v.earliest_start || null, preferred_hours: v.preferred_hours || null, rate_note: v.rate_note || null, portfolio_url: v.portfolio_url || null,
        education: (v.education ?? []).filter((e: any) => e.degree?.trim()).map((e: any) => ({ degree: e.degree, school: e.school || null, year: e.year ? Number(e.year) || null : null })),
        experience: (v.experience ?? []).filter((e: any) => e.title?.trim()).map((e: any) => ({ title: e.title, company: e.company || null, start: e.start ? String(e.start) : null, end: e.end ? String(e.end) : null })),
        resume_upload: resume?.upload ?? null, video_upload: video?.upload ?? null, portfolio_upload: portfolio?.upload ?? null, resume_prefilled: !!prefill?.fields.length, consent: true,
      };
      const r = await api.post(`/api/v1/public/apply/${slug}/submit`, body);
      setDone(r); flow.next();
    } catch (e) {
      if (e instanceof ApiError && e.fields) { const k = Object.keys(e.fields)[0]; setErr(e.fields[k]); const map: Record<string, string> = { first_name: 'name', last_name: 'name', email: 'email', phone: 'phone', country: 'location', portfolio_url: 'portfolio', rate_target_cents: 'rate' }; const to = steps.findIndex(s => s.id === map[k]); if (to >= 0) flow.go(to); }
      else setErr(e instanceof ApiError ? e.message : 'Something went wrong — please try again.');
    } finally { setBusy(false); }
  };
  const onAdvance = () => { setErr(null); if (steps[flow.index]?.id === 'review') submit(); else flow.next(); };
  return <Flow brand={d.org} steps={steps} index={Math.min(flow.index, steps.length - 1)} dir={flow.dir} onAdvance={onAdvance} onBack={() => { setErr(null); flow.back(); }} busy={busy || uploading} error={err} />;
}

function DropZone({ busy, file, onFile }: { busy: boolean; file: string | null | undefined; onFile: (f: File) => void }) {
  const [over, setOver] = useState(false);
  return (
    <label className={`flow-drop ${over ? 'on' : ''}`} data-flow-focus tabIndex={0} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}>
      <input type="file" hidden accept=".pdf,.txt,.doc,.docx,.md" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {busy ? <><span className="spinner" style={{ width: 28, height: 28 }} /><b>Uploading…</b></> : file ? <><span className="flow-drop-ic"><CheckCircle2 size={28} /></span><b>{file}</b><small>Click to replace it</small></> : <><span className="flow-drop-ic"><Upload size={28} /></span><b>Drop your resume here</b><small>or click to browse · PDF, DOCX, TXT</small></>}
    </label>
  );
}

function Rows({ rows, onChange, cols, addLabel }: { rows: any[]; onChange: (r: any[]) => void; cols: [string, string][]; addLabel: string }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      {rows.map((r, i) => (
        <div key={i} className="flow-cardlet" style={{ marginTop: 0, display: 'flex', gap: 10, alignItems: 'flex-start', animation: 'flowPop .35s both' }}>
          <FileText size={18} style={{ color: 'var(--fa)', marginTop: 10, flex: 'none' }} />
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${Math.min(cols.length, 2)}, minmax(0, 1fr))`, gap: '0 14px' }}>
            {cols.map(([k, l]) => <input key={k} className="flow-input flow-input-sm" style={{ marginTop: 4 }} aria-label={l} placeholder={l} value={r[k] ?? ''} onChange={e => onChange(rows.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />)}
          </div>
          <button type="button" className="flow-skip" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}><X size={16} /></button>
        </div>
      ))}
      <button type="button" className="flow-chip" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...rows, {}])}><Plus size={14} /> {addLabel}</button>
    </div>
  );
}
export type { ReactNode };
