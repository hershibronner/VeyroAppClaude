// Public, tenant-branded multi-step application (no login). Attribution comes from the link token on the server.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Upload, Sparkles, Video, Square, Circle, RotateCcw, CheckCircle2, FileText, ArrowLeft, ArrowRight, Link2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { humanize, money } from '../../lib/format';
import { Banner, Button, EmptyState, Field, LoadingBlock, MoneyInput, PhoneInput, TagInput, COUNTRY_CODES } from '../../components/ui';
import { tzOpts, CURRENCIES, UNITS } from './shared';
import './recruiting.css';

const STEPS = ['Resume', 'Personal', 'Professional', 'Availability & rate', 'Resume & media', 'Review'];
const COUNTRY_NAMES = COUNTRY_CODES.map(c => c.name).sort();
const TZ_GUESS = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();

export default function Apply({ kind }: { kind?: 'r' | 'p' }) {
  const { slug, token } = useParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const page = useApi<any>(`/api/v1/public/apply/${slug}`, [slug]);
  const link = useApi<any>(kind && token ? `/api/v1/public/apply/${slug}/link/${kind}/${token}` : null, [kind, token]);
  const [step, setStep] = useState(0);
  const [v, setV] = useState<Record<string, any>>({ skills: [], software: [], languages: ['English'], education: [], experience: [], availability_status: 'available', rate_currency: 'USD', rate_unit: 'hour', weekly_hours: 40, timezone: tzOpts.some(t => t.value === TZ_GUESS) ? TZ_GUESS : '' });
  const [resume, setResume] = useState<{ upload: string; filename: string } | null>(null);
  const [video, setVideo] = useState<{ upload: string; filename: string; url?: string } | null>(null);
  const [portfolio, setPortfolio] = useState<{ upload: string; filename: string } | null>(null);
  const [prefilled, setPrefilled] = useState<{ fields: string[]; uncertain: string[]; snippets: Record<string, string>; warnings: string[]; aiError?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);
  const set = (k: string, val: any) => setV(s => ({ ...s, [k]: val }));
  useEffect(() => { window.scrollTo(0, 0); }, [step, done]);

  if (page.error) return <div className="rec-apply"><div className="rec-apply-main"><EmptyState title="Application page not found" text="Check the link you were given." /></div></div>;
  if (!page.data) return <div className="rec-apply"><div className="rec-apply-main"><LoadingBlock rows={6} /></div></div>;
  const org = page.data.org;
  const brand = { background: `linear-gradient(135deg, ${org.primary_color}, ${org.accent_color})` };
  const position = link.data?.position ?? (v.position_id ? page.data.positions.find((p: any) => p.id === v.position_id) : null);

  const uploadFile = async (k: 'resume' | 'video' | 'portfolio', f: File | Blob, name: string) => {
    const fd = new FormData(); fd.append('file', f, name);
    return api.upload(`/api/v1/public/apply/${slug}/upload/${k}`, fd);
  };
  const onResume = async (f: File) => {
    setBusy(true); setErr(null);
    try {
      const r = await uploadFile('resume', f, f.name);
      setResume({ upload: r.upload, filename: r.filename });
      if (r.extraction) {
        const x = r.extraction.fields; const got: Record<string, any> = {}; const unc: string[] = []; const snip: Record<string, string> = {};
        for (const k of ['first_name', 'last_name', 'email', 'phone', 'headline', 'city', 'country', 'years_experience', 'skills', 'software', 'languages', 'education', 'experience']) {
          const val = x[k]?.value; if (val === null || val === undefined || (Array.isArray(val) && !val.length)) continue;
          got[k] = val; if (x[k].uncertain) unc.push(k); if (x[k].snippet) snip[k] = x[k].snippet;
        }
        setV(s => ({ ...s, ...got }));
        setPrefilled({ fields: Object.keys(got), uncertain: unc, snippets: snip, warnings: r.extraction.warnings });
      } else setPrefilled({ fields: [], uncertain: [], snippets: {}, warnings: [], aiError: r.ai_error });
      setStep(1);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); }
  };
  const validate = (s: number): boolean => {
    const e: Record<string, string> = {};
    if (s === 1) {
      if (!v.first_name?.trim()) e.first_name = 'First name is required';
      if (!v.last_name?.trim()) e.last_name = 'Last name is required';
      if (!/^\S+@\S+\.\S+$/.test(v.email ?? '')) e.email = 'Enter a valid email';
      if ((v.phone ?? '').replace(/\D/g, '').length < 7) e.phone = 'Enter your phone number';
      if (!v.country?.trim()) e.country = 'Country is required';
    }
    if (s === 3 && v.rate_min_cents && v.rate_target_cents && v.rate_min_cents > v.rate_target_cents) e.rate_target_cents = 'Your target should be at least your minimum';
    if (s === 4 && !resume) e.resume = 'Please upload your resume';
    if (s === 4 && v.portfolio_url && !/^https?:\/\//.test(v.portfolio_url)) e.portfolio_url = 'Enter a full URL starting with https://';
    setErrors(e);
    return !Object.keys(e).length;
  };
  const next = () => { if (validate(step)) setStep(s => Math.min(5, s + 1)); };
  const submit = async () => {
    if (!v.consent) { setErrors({ consent: 'Please confirm the information is accurate' }); return; }
    setBusy(true); setErr(null);
    try {
      const body = { link_kind: kind ?? null, link_token: token ?? null, position_id: link.data?.position?.id ?? v.position_id ?? null, ...v, years_experience: v.years_experience === '' || v.years_experience === undefined ? null : Number(v.years_experience), weekly_hours: v.weekly_hours ? Number(v.weekly_hours) : null,
        resume_upload: resume?.upload ?? null, video_upload: video?.upload ?? null, portfolio_upload: portfolio?.upload ?? null, resume_prefilled: !!prefilled?.fields.length, consent: true };
      (body as any).education = (v.education ?? []).filter((e: any) => e.degree?.trim()).map((e: any) => ({ degree: e.degree, school: e.school || null, year: e.year ? Number(e.year) || null : null }));
      (body as any).experience = (v.experience ?? []).filter((e: any) => e.title?.trim()).map((e: any) => ({ title: e.title, company: e.company || null, start: e.start ? String(e.start) : null, end: e.end ? String(e.end) : null }));
      const r = await api.post(`/api/v1/public/apply/${slug}/submit`, body);
      setDone(r);
    } catch (e) {
      if (e instanceof ApiError && e.fields) { setErrors(e.fields); setErr('Please check the highlighted fields.'); const k = Object.keys(e.fields)[0]; const s = ['first_name', 'last_name', 'email', 'phone', 'country'].includes(k) ? 1 : ['rate_min_cents', 'rate_target_cents'].includes(k) ? 3 : ['portfolio_url'].includes(k) ? 4 : 5; setStep(s); }
      else setErr(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const hint = (k: string) => prefilled?.fields.includes(k) ? <span className={prefilled.uncertain.includes(k) ? 'rec-uncertain' : 'small'} style={{ color: prefilled.uncertain.includes(k) ? undefined : 'var(--success)' }}>{prefilled.uncertain.includes(k) ? 'From your resume — please double-check' : 'Filled from your resume'}</span> : undefined;

  return (
    <div className="rec-apply">
      <header className="rec-apply-top">
        {org.logo_url ? <img src={org.logo_url} alt="" style={{ width: 38, height: 38, borderRadius: 10, objectFit: 'cover' }} /> : <span className="rec-apply-logo" style={brand}>{org.logo_text.slice(0, 1)}</span>}
        <b style={{ fontSize: 17 }}>{org.logo_text}</b><span className="muted small" style={{ marginLeft: 'auto' }}>Careers</span>
      </header>
      <main className="rec-apply-main">
        <div className="rec-apply-hero" style={brand}>
          <h1>{position ? `Apply: ${position.title}` : `Work with ${org.name}`}</h1>
          <div style={{ opacity: .92 }}>{position ? [humanize(position.employment_type), position.schedule, position.timezone, position.weekly_hours ? `${position.weekly_hours} h/week` : null].filter(Boolean).join(' · ') : 'Remote roles with US-based businesses. One application puts you in our talent pool for every matching role.'}</div>
          {link.data?.recruiter_first_name && <div className="small mt-1" style={{ opacity: .9 }}>You were invited by {link.data.recruiter_first_name} from {org.name}.</div>}
        </div>
        {link.error && <Banner tone="warn">{(link.error as any).message} You can still apply below.</Banner>}
        {link.data?.position_closed && <Banner tone="warn">That position is no longer open — your application will go to our general talent pool.</Banner>}
        {done ? <Confirmation done={done} org={org} slug={slug!} onAccount={async (redirect) => { await refresh(); nav(redirect, { replace: true }); }} /> : <>
          <div className="rec-steps" aria-label="Progress">{STEPS.map((s, i) => <div key={s} className={`rec-step ${i === step ? 'on' : i < step ? 'done' : ''}`}><i />{i + 1}. {s}</div>)}</div>
          <div className="card card-pad">
            {err && <Banner tone="danger">{err}</Banner>}
            {step === 0 && <div className="stack" style={{ gap: 14 }}>
              <h2 style={{ margin: 0 }}>Upload your resume and AI can fill most of the application for you.</h2>
              <div className="muted small">We only copy what is written in your resume — you review every field before submitting. PDF, DOCX or TXT, up to 15 MB.</div>
              <DropZone accept=".pdf,.txt,.doc,.docx" busy={busy} label={resume ? resume.filename : 'Choose your resume or drop it here'} onFile={onResume} icon={<Upload size={22} />} />
              {!position && page.data.positions.length > 0 && <Field label="Applying for a specific role? (optional)" htmlFor="ap-pos"><select id="ap-pos" className="select" value={v.position_id ?? ''} onChange={e => set('position_id', e.target.value || null)}><option value="">General application — match me to any role</option>{page.data.positions.map((p: any) => <option key={p.id} value={p.id}>{p.title}{p.schedule ? ` · ${p.schedule}` : ''}</option>)}</select></Field>}
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="small muted">No resume handy? You can add it later in step 5.</span><Button onClick={() => setStep(1)}>Skip</Button></div>
            </div>}
            {step === 1 && <div className="stack" style={{ gap: 14 }}>
              <h2 style={{ margin: 0 }}>Personal details</h2>
              {prefilled && (prefilled.aiError ? <Banner tone="warn">{prefilled.aiError} Your resume is attached — please fill in the fields.</Banner> : prefilled.fields.length > 0 ? <Banner tone="success"><Sparkles size={14} /> We filled {prefilled.fields.length} fields from your resume. {prefilled.uncertain.length > 0 && <>Please double-check: {prefilled.uncertain.map(humanize).join(', ')}.</>} {prefilled.warnings.join(' ')}</Banner> : <Banner tone="warn">We couldn't read details from that file. {prefilled.warnings.join(' ')}</Banner>)}
              <div className="form-grid">
                <F label="First name *" k="first_name" errors={errors} hint={hint('first_name')}><input id="f-first_name" className="input" autoComplete="given-name" value={v.first_name ?? ''} onChange={e => set('first_name', e.target.value)} /></F>
                <F label="Last name *" k="last_name" errors={errors} hint={hint('last_name')}><input id="f-last_name" className="input" autoComplete="family-name" value={v.last_name ?? ''} onChange={e => set('last_name', e.target.value)} /></F>
                <F label="Email *" k="email" errors={errors} hint={hint('email')}><input id="f-email" className="input" type="email" autoComplete="email" value={v.email ?? ''} onChange={e => set('email', e.target.value)} /></F>
                <F label="Phone *" k="phone" errors={errors} hint={hint('phone')}><PhoneInput id="f-phone" value={v.phone ?? ''} onChange={x => set('phone', x)} defaultCountry="PH" /></F>
                <F label="Country *" k="country" errors={errors} hint={hint('country')}><input id="f-country" className="input" list="ap-countries" autoComplete="country-name" value={v.country ?? ''} onChange={e => set('country', e.target.value)} /><datalist id="ap-countries">{COUNTRY_NAMES.map(c => <option key={c} value={c} />)}</datalist></F>
                <F label="City" k="city" errors={errors} hint={hint('city')}><input id="f-city" className="input" value={v.city ?? ''} onChange={e => set('city', e.target.value)} /></F>
                <F label="Your timezone" k="timezone" errors={errors}><select id="f-timezone" className="select" value={v.timezone ?? ''} onChange={e => set('timezone', e.target.value)}><option value="">Select…</option>{tzOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></F>
              </div>
            </div>}
            {step === 2 && <div className="stack" style={{ gap: 14 }}>
              <h2 style={{ margin: 0 }}>Professional details</h2>
              <div className="form-grid">
                <F label="Headline / current role" k="headline" errors={errors} hint={hint('headline')}><input id="f-headline" className="input" placeholder="e.g. Dental Virtual Assistant" value={v.headline ?? ''} onChange={e => set('headline', e.target.value)} /></F>
                <F label="Years of experience" k="years_experience" errors={errors} hint={hint('years_experience')}><input id="f-years_experience" className="input" type="number" min={0} max={60} value={v.years_experience ?? ''} onChange={e => set('years_experience', e.target.value)} /></F>
              </div>
              <F label="Skills" k="skills" errors={errors} hint={hint('skills') ?? 'Press Enter after each one'}><TagInput value={v.skills} onChange={x => set('skills', x)} suggestions={position?.skills ?? []} /></F>
              <F label="Software you use" k="software" errors={errors} hint={hint('software')}><TagInput value={v.software} onChange={x => set('software', x)} suggestions={position?.software ?? []} /></F>
              <F label="Languages" k="languages" errors={errors} hint={hint('languages')}><TagInput value={v.languages} onChange={x => set('languages', x)} suggestions={['English', 'Spanish', 'Tagalog', 'Portuguese', 'French']} /></F>
              <Rows title="Experience" rows={v.experience} onChange={x => set('experience', x)} cols={[['title', 'Job title'], ['company', 'Company'], ['start', 'From (year)'], ['end', 'To (year or Present)']]} hint={hint('experience')} />
              <Rows title="Education" rows={v.education} onChange={x => set('education', x)} cols={[['degree', 'Degree / course'], ['school', 'School'], ['year', 'Year']]} hint={hint('education')} />
            </div>}
            {step === 3 && <div className="stack" style={{ gap: 14 }}>
              <h2 style={{ margin: 0 }}>Availability and rate</h2>
              <div className="form-grid">
                <F label="Current availability" k="availability_status" errors={errors}><select id="f-availability_status" className="select" value={v.availability_status} onChange={e => set('availability_status', e.target.value)}><option value="available">Available now</option><option value="employed">Employed — need to give notice</option><option value="not_available">Not available yet</option></select></F>
                <F label="Earliest start date" k="earliest_start" errors={errors}><input id="f-earliest_start" className="input" type="date" value={v.earliest_start ?? ''} onChange={e => set('earliest_start', e.target.value)} /></F>
                <F label="Hours per week you can work" k="weekly_hours" errors={errors}><input id="f-weekly_hours" className="input" type="number" min={1} max={80} value={v.weekly_hours ?? ''} onChange={e => set('weekly_hours', e.target.value)} /></F>
                <F label="Preferred working hours" k="preferred_hours" errors={errors}><input id="f-preferred_hours" className="input" placeholder="e.g. US Eastern business hours, night shift OK" value={v.preferred_hours ?? ''} onChange={e => set('preferred_hours', e.target.value)} /></F>
              </div>
              <div className="card card-pad" style={{ background: 'var(--bg-2)' }}>
                <b>Your rate range</b>
                <div className="small muted mt-1">Tell us honestly what works for you. Your <b>minimum</b> is the lowest you would accept; your <b>target</b> is what you'd be comfortable with. We use this to match you to roles that fit — it is never shared with clients without your recruiter's agreement, and it doesn't lock you into anything.</div>
                <div className="form-grid mt-2">
                  <F label="Minimum acceptable" k="rate_min_cents" errors={errors}><MoneyInput id="f-rate_min_cents" cents={v.rate_min_cents} onChange={x => set('rate_min_cents', x)} /></F>
                  <F label="Comfortable target" k="rate_target_cents" errors={errors}><MoneyInput id="f-rate_target_cents" cents={v.rate_target_cents} onChange={x => set('rate_target_cents', x)} /></F>
                  <F label="Currency" k="rate_currency" errors={errors}><select id="f-rate_currency" className="select" value={v.rate_currency} onChange={e => set('rate_currency', e.target.value)}>{CURRENCIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></F>
                  <F label="Unit" k="rate_unit" errors={errors}><select id="f-rate_unit" className="select" value={v.rate_unit} onChange={e => set('rate_unit', e.target.value)}>{UNITS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></F>
                </div>
                <F label="Anything we should know? (optional)" k="rate_note" errors={errors}><input id="f-rate_note" className="input" placeholder="e.g. flexible for long-term roles" value={v.rate_note ?? ''} onChange={e => set('rate_note', e.target.value)} /></F>
              </div>
            </div>}
            {step === 4 && <div className="stack" style={{ gap: 16 }}>
              <h2 style={{ margin: 0 }}>Resume &amp; media</h2>
              <div><div className="bold mb-2">Resume *</div>{resume ? <div className="row" style={{ gap: 8 }}><CheckCircle2 size={18} color="var(--success)" /><span>{resume.filename} uploaded</span><Button size="xs" variant="ghost" onClick={() => setResume(null)}>Replace</Button></div> : <DropZone accept=".pdf,.txt,.doc,.docx" busy={busy} label="Upload your resume (required)" icon={<FileText size={20} />} onFile={async f => { setBusy(true); try { const r = await uploadFile('resume', f, f.name); setResume({ upload: r.upload, filename: r.filename }); setErrors(e => ({ ...e, resume: '' })); } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); } }} />}
                {errors.resume && <div className="err small" style={{ color: 'var(--danger)' }}>{errors.resume}</div>}</div>
              <div><div className="bold mb-2">Intro video <span className="muted small">(optional, recommended — 30–90 seconds)</span></div><VideoCapture video={video} onUploaded={setVideo} upload={(b, n) => uploadFile('video', b, n)} /></div>
              <div><div className="bold mb-2">Portfolio <span className="muted small">(optional)</span></div>
                <div className="form-grid"><F label="Portfolio link" k="portfolio_url" errors={errors}><input id="f-portfolio_url" className="input" type="url" placeholder="https://" value={v.portfolio_url ?? ''} onChange={e => set('portfolio_url', e.target.value)} /></F>
                  <Field label="Or upload a file"><label className="btn" style={{ width: '100%' }}><Link2 size={16} /> {portfolio ? portfolio.filename : 'Choose file'}<input type="file" hidden onChange={async e => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); try { const r = await uploadFile('portfolio', f, f.name); setPortfolio({ upload: r.upload, filename: r.filename }); } catch (x) { setErr(x instanceof ApiError ? x.message : String(x)); } finally { setBusy(false); } }} /></label></Field></div></div>
            </div>}
            {step === 5 && <div className="stack" style={{ gap: 14 }}>
              <h2 style={{ margin: 0 }}>Review &amp; submit</h2>
              <Review title="Personal" onEdit={() => setStep(1)} items={[['Name', `${v.first_name ?? ''} ${v.last_name ?? ''}`], ['Email', v.email], ['Phone', v.phone], ['Location', [v.city, v.country].filter(Boolean).join(', ')], ['Timezone', v.timezone]]} />
              <Review title="Professional" onEdit={() => setStep(2)} items={[['Headline', v.headline], ['Experience', v.years_experience ? `${v.years_experience} years` : ''], ['Skills', v.skills.join(', ')], ['Software', v.software.join(', ')], ['Languages', v.languages.join(', ')], ['Jobs', v.experience.map((e: any) => `${e.title}${e.company ? ' — ' + e.company : ''}`).join('; ')], ['Education', v.education.map((e: any) => `${e.degree}${e.school ? ' — ' + e.school : ''}`).join('; ')]]} />
              <Review title="Availability & rate" onEdit={() => setStep(3)} items={[['Availability', humanize(v.availability_status)], ['Start', v.earliest_start], ['Hours/week', v.weekly_hours], ['Rate range', v.rate_min_cents ? `${money(v.rate_min_cents, v.rate_currency)} – ${v.rate_target_cents ? money(v.rate_target_cents, v.rate_currency) : '—'} per ${v.rate_unit}` : '']]} />
              <Review title="Resume & media" onEdit={() => setStep(4)} items={[['Resume', resume?.filename], ['Intro video', video ? 'Added' : 'Not added'], ['Portfolio', v.portfolio_url || portfolio?.filename]]} />
              {position && <div className="small">Applying for <b>{position.title}</b>.</div>}
              <label className="check"><input type="checkbox" checked={!!v.consent} onChange={e => set('consent', e.target.checked)} /> I confirm this information is accurate and I agree that {org.name} may contact me about roles.</label>
              {errors.consent && <div className="small" style={{ color: 'var(--danger)' }}>{errors.consent}</div>}
            </div>}
            <div className="row mt-3" style={{ justifyContent: 'space-between' }}>
              {step > 0 ? <Button icon={<ArrowLeft size={16} />} onClick={() => setStep(s => s - 1)}>Back</Button> : <span />}
              {step === 0 ? null : step < 5 ? <Button variant="primary" onClick={next} disabled={busy}>Continue <ArrowRight size={16} /></Button> : <Button variant="primary" loading={busy} onClick={submit}>Submit application</Button>}
            </div>
          </div>
        </>}
        {!org.hide_powered_by && <div className="tiny muted" style={{ textAlign: 'center', marginTop: 24 }}>Powered by VeyroApp</div>}
      </main>
    </div>
  );
}

function F({ label, k, errors, hint, children }: { label: string; k: string; errors: Record<string, string>; hint?: ReactNode; children: ReactNode }) {
  return <Field label={label} htmlFor={`f-${k}`} error={errors[k] || null} hint={hint}>{children}</Field>;
}
function DropZone({ accept, busy, label, onFile, icon }: { accept: string; busy: boolean; label: string; onFile: (f: File) => void; icon: ReactNode }) {
  const [over, setOver] = useState(false);
  return <label className={`rec-drop ${over ? 'on' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}>
    <input type="file" hidden accept={accept} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    {busy ? <><span className="spinner" /> <div className="mt-1">Uploading and reading…</div></> : <>{icon}<div className="bold mt-1">{label}</div><div className="small muted">Click to browse or drag a file here</div></>}
  </label>;
}
function Rows({ title, rows, onChange, cols, hint }: { title: string; rows: any[]; onChange: (r: any[]) => void; cols: [string, string][]; hint?: ReactNode }) {
  return <div><div className="row" style={{ justifyContent: 'space-between' }}><b className="small">{title}</b>{hint}</div>
    {rows.map((r, i) => <div key={i} className="row mt-1" style={{ gap: 6, flexWrap: 'wrap' }}>{cols.map(([k, l]) => <input key={k} className="input input-sm" style={{ flex: 1, minWidth: 110 }} aria-label={l} placeholder={l} value={r[k] ?? ''} onChange={e => onChange(rows.map((x, j) => j === i ? { ...x, [k]: k === 'year' ? (e.target.value ? Number(e.target.value) || null : null) : e.target.value } : x))} />)}<Button size="xs" variant="ghost" aria-label={`Remove ${title} row`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button></div>)}
    <Button size="xs" className="mt-1" onClick={() => onChange([...rows, {}])}>+ Add {title.toLowerCase()}</Button></div>;
}
function Review({ title, items, onEdit }: { title: string; items: [string, any][]; onEdit: () => void }) {
  return <div className="card card-pad" style={{ background: 'var(--bg-2)' }}><div className="row" style={{ justifyContent: 'space-between' }}><b>{title}</b><Button size="xs" variant="ghost" onClick={onEdit}>Edit</Button></div>
    <dl className="kv mt-1">{items.map(([k, val]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{val === null || val === undefined || val === '' ? '—' : String(val)}</dd></div>)}</dl></div>;
}

/** In-browser recording with MediaRecorder, with an upload fallback. */
export function VideoCapture({ video, onUploaded, upload }: { video: { upload: string; filename: string; url?: string } | null; onUploaded: (v: { upload: string; filename: string; url?: string } | null) => void; upload: (b: Blob, name: string) => Promise<any> }) {
  const live = useRef<HTMLVideoElement>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [state, setState] = useState<'idle' | 'preview' | 'recording' | 'uploading'>('idle');
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const supported = typeof window !== 'undefined' && 'MediaRecorder' in window && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => () => { stream.current?.getTracks().forEach(t => t.stop()); }, []);
  useEffect(() => { if (state !== 'recording') return; const t = setInterval(() => setSecs(s => { if (s + 1 >= 120) rec.current?.stop(); return s + 1; }), 1000); return () => clearInterval(t); }, [state]);
  const start = async () => {
    setErr(null);
    try { stream.current = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true }); if (live.current) { live.current.srcObject = stream.current; live.current.muted = true; await live.current.play().catch(() => {}); } setState('preview'); }
    catch { setErr('We could not access your camera or microphone. Allow access in your browser, or upload a video file instead.'); }
  };
  const record = () => {
    if (!stream.current) return;
    chunks.current = [];
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) ?? '';
    const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = async () => {
      stream.current?.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks.current, { type: r.mimeType || 'video/webm' });
      setState('uploading');
      try { const res = await upload(blob, `intro-video.${(r.mimeType || '').includes('mp4') ? 'mp4' : 'webm'}`); onUploaded({ upload: res.upload, filename: res.filename, url: URL.createObjectURL(blob) }); setState('idle'); }
      catch (e) { setErr(e instanceof ApiError ? e.message : 'Upload failed — try again'); setState('idle'); }
    };
    rec.current = r; r.start(1000); setSecs(0); setState('recording');
  };
  const onFile = async (f: File) => { setState('uploading'); setErr(null); try { const res = await upload(f, f.name); onUploaded({ upload: res.upload, filename: res.filename, url: URL.createObjectURL(f) }); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Upload failed'); } finally { setState('idle'); } };
  if (video && state === 'idle') return <div className="stack" style={{ gap: 8 }}>{video.url && <video className="rec-video" src={video.url} controls style={{ maxWidth: 420 }} />}<div className="row" style={{ gap: 8 }}><CheckCircle2 size={18} color="var(--success)" /> Intro video added <Button size="xs" icon={<RotateCcw size={13} />} onClick={() => onUploaded(null)}>Redo</Button></div></div>;
  return <div className="stack" style={{ gap: 10 }}>
    {err && <Banner tone="warn">{err}</Banner>}
    <video ref={live} className="rec-video" style={{ display: state === 'preview' || state === 'recording' ? 'block' : 'none', maxWidth: 420 }} playsInline aria-label="Camera preview" />
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      {supported && state === 'idle' && <Button icon={<Video size={16} />} onClick={start}>Record in browser</Button>}
      {state === 'preview' && <Button variant="danger" icon={<Circle size={16} />} onClick={record}>Start recording</Button>}
      {state === 'recording' && <><span className="rec-rec">Recording {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span><Button icon={<Square size={16} />} onClick={() => rec.current?.stop()}>Stop</Button></>}
      {state === 'uploading' && <span className="small"><span className="spinner" /> Uploading video…</span>}
      {state === 'idle' && <label className="btn"><Upload size={16} /> Upload a video file<input type="file" hidden accept="video/*" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} /></label>}
    </div>
    <div className="small muted">Say hello, share your experience and why you'd be great for remote work. Max 2 minutes.</div>
  </div>;
}

function Confirmation({ done, org, slug, onAccount }: { done: any; org: any; slug: string; onAccount: (redirect: string) => void }) {
  const [pw, setPw] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const create = async (withPassword: boolean) => {
    setBusy(true); setErr(null);
    try { const r = await api.post(`/api/v1/public/apply/${slug}/account`, { applicant_token: done.applicant_token, password: withPassword ? pw : undefined }); if (r.mode === 'created') onAccount(r.redirect); else setMsg(r.message); }
    catch (e) { setErr(e instanceof ApiError ? (e.fields?.password ?? e.message) : String(e)); } finally { setBusy(false); }
  };
  return <div className="card card-pad" style={{ textAlign: 'center' }}>
    <CheckCircle2 size={44} color="var(--success)" />
    <h2>Thanks, {done.first_name}! Your application is in.</h2>
    <div className="muted">{done.position_title ? `We received your application for ${done.position_title}.` : `You're now in the ${org.name} talent pool.`} {done.returning ? 'We found your existing profile and added this application to it.' : ''} A recruiter will review it shortly — check your email for a confirmation.</div>
    {!done.has_account && <div className="card card-pad mt-3" style={{ textAlign: 'left', background: 'var(--bg-2)' }}>
      <b>Create an account to track your application</b> <span className="small muted">(optional)</span>
      <div className="small muted mt-1">See your status, complete assessments, join interviews and sign offers.</div>
      {msg ? <Banner tone="success">{msg}</Banner> : done.email_has_login ? <div className="mt-2"><div className="small">This email already has a VeyroApp login.</div><Button className="mt-1" loading={busy} onClick={() => create(false)}>Email me an access link</Button></div> :
        <form className="row mt-2" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={e => { e.preventDefault(); create(true); }}><input className="input" type="password" autoComplete="new-password" aria-label="Choose a password" placeholder="Choose a password (8+ characters)" value={pw} onChange={e => setPw(e.target.value)} style={{ flex: 1, minWidth: 220 }} /><Button type="submit" variant="primary" loading={busy} disabled={pw.length < 8}>Create account</Button></form>}
      {err && <div className="small mt-1" style={{ color: 'var(--danger)' }}>{err}</div>}
    </div>}
    {done.has_account && <div className="mt-3"><a className="btn btn-primary" href="/login?next=/portal/candidate/applications">Sign in to track it</a></div>}
  </div>;
}
