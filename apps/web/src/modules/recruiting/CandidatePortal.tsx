// Candidate Portal pages: Profile · Resume & Media · Applications · Assessments · Interviews · Offers · Documents · Availability · Messages.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Upload, FileText, Download, CalendarClock, Send, PenLine, Eraser, AlertTriangle, Video } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { money, date, dateTime, relTime, humanize } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, KV, LoadingBlock, MoneyInput, PageHeader, PhoneInput, StatusPill, TagInput } from '../../components/ui';
import { tzOpts, CURRENCIES, UNITS } from './shared';
import { VideoCapture } from './ApplyParts';
import './recruiting.css';

function useMe() { return useApi<any>('/api/v1/portal/candidate/me'); }

export function Profile() {
  const me = useMe();
  const [v, setV] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { if (me.data) setV({ ...me.data }); }, [me.data]);
  if (me.error) return <ErrorState error={me.error} retry={me.reload} />;
  if (!me.data || !v) return <LoadingBlock rows={8} />;
  const d = me.data;
  const set = (k: string, x: any) => setV((s: any) => ({ ...s, [k]: x }));
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      const keys = ['first_name', 'last_name', 'phone', 'country', 'city', 'timezone', 'headline', 'years_experience', 'skills', 'software', 'languages', 'rate_min_cents', 'rate_target_cents', 'rate_currency', 'rate_unit', 'rate_note'];
      const body: any = {}; for (const k of keys) body[k] = v[k] === '' ? null : v[k];
      if (body.years_experience !== null && body.years_experience !== undefined) body.years_experience = Number(body.years_experience);
      await api.patch('/api/v1/portal/candidate/profile', body); toast.success('Profile saved'); me.reload();
    } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  return <div>
    <PageHeader title={`Hi ${d.first_name}`} sub={<>Your application status: <StatusPill status={d.stage === 'Not moving forward' ? 'rejected' : d.stage === 'Hired' ? 'hired' : 'pending'} label={d.stage} />{d.recruiter && <> · Your recruiter: <b>{d.recruiter.name}</b></>}</>} />
    <div className="kpi-tiles">
      <Link className="kpi-tile" to="applications"><div className="kpi-label">Applications</div><div className="kpi-value">{d.counts.applications}</div></Link>
      <Link className="kpi-tile" to="assessments"><div className="kpi-label">Assessments to do</div><div className="kpi-value">{d.counts.open_assessments}</div></Link>
      <Link className="kpi-tile" to="interviews"><div className="kpi-label">Upcoming interviews</div><div className="kpi-value">{d.counts.upcoming_interviews}</div></Link>
      <Link className="kpi-tile" to="offers"><div className="kpi-label">Offers waiting</div><div className="kpi-value">{d.counts.open_offers}</div></Link>
    </div>
    {d.counts.open_offers > 0 && <Banner tone="success">You have an offer waiting. <Link to="offers">Review and sign it</Link>.</Banner>}
    {d.counts.open_assessments > 0 && <Banner>You have {d.counts.open_assessments} assessment{d.counts.open_assessments > 1 ? 's' : ''} to complete. <Link to="assessments">Start now</Link>.</Banner>}
    {d.missing.length > 0 && <Banner tone="warn">Complete your profile to get matched faster: {d.missing.map((m: string, i: number) => <span key={m}>{i ? ' · ' : ''}{m.includes('resume') || m.includes('video') ? <Link to="media">{m}</Link> : m}</span>)}</Banner>}
    <Card><CardHeader title="Your profile" sub="Recruiters use this to match you to roles. Clients only see a summary your recruiter shares." right={<Button variant="primary" loading={busy} onClick={save}>Save profile</Button>} />
      <div className="card-b stack" style={{ gap: 16 }}>
        <div className="form-grid">
          <Field label="First name" htmlFor="p-fn" error={errors.first_name}><input id="p-fn" className="input" value={v.first_name ?? ''} onChange={e => set('first_name', e.target.value)} /></Field>
          <Field label="Last name" htmlFor="p-ln"><input id="p-ln" className="input" value={v.last_name ?? ''} onChange={e => set('last_name', e.target.value)} /></Field>
          <Field label="Email" htmlFor="p-em" hint="Contact your recruiter to change your email."><input id="p-em" className="input" value={v.email ?? ''} disabled /></Field>
          <Field label="Phone" htmlFor="p-ph"><PhoneInput id="p-ph" value={v.phone ?? ''} onChange={x => set('phone', x)} /></Field>
          <Field label="Country" htmlFor="p-co"><input id="p-co" className="input" value={v.country ?? ''} onChange={e => set('country', e.target.value)} /></Field>
          <Field label="City" htmlFor="p-ci"><input id="p-ci" className="input" value={v.city ?? ''} onChange={e => set('city', e.target.value)} /></Field>
          <Field label="Timezone" htmlFor="p-tz"><select id="p-tz" className="select" value={v.timezone ?? ''} onChange={e => set('timezone', e.target.value)}><option value="">Select…</option>{tzOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
          <Field label="Headline" htmlFor="p-hl"><input id="p-hl" className="input" value={v.headline ?? ''} onChange={e => set('headline', e.target.value)} /></Field>
          <Field label="Years of experience" htmlFor="p-yr"><input id="p-yr" type="number" className="input" value={v.years_experience ?? ''} onChange={e => set('years_experience', e.target.value)} /></Field>
        </div>
        <Field label="Skills"><TagInput value={v.skills ?? []} onChange={x => set('skills', x)} /></Field>
        <Field label="Software"><TagInput value={v.software ?? []} onChange={x => set('software', x)} /></Field>
        <Field label="Languages"><TagInput value={v.languages ?? []} onChange={x => set('languages', x)} /></Field>
        <div><b>Rate range</b><div className="small muted">Your minimum acceptable and comfortable target. Used for matching only — not shared with clients without your recruiter.</div>
          <div className="form-grid mt-2"><Field label="Minimum" htmlFor="p-rmin" error={errors.rate_min_cents}><MoneyInput id="p-rmin" cents={v.rate_min_cents} onChange={x => set('rate_min_cents', x)} /></Field><Field label="Target" htmlFor="p-rt"><MoneyInput id="p-rt" cents={v.rate_target_cents} onChange={x => set('rate_target_cents', x)} /></Field>
            <Field label="Currency" htmlFor="p-cur"><select id="p-cur" className="select" value={v.rate_currency} onChange={e => set('rate_currency', e.target.value)}>{CURRENCIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></Field><Field label="Unit" htmlFor="p-un"><select id="p-un" className="select" value={v.rate_unit} onChange={e => set('rate_unit', e.target.value)}>{UNITS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></Field></div></div>
      </div></Card>
  </div>;
}

export function Availability() {
  const me = useMe();
  const [v, setV] = useState<any>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (me.data) setV({ availability_status: me.data.availability_status, earliest_start: me.data.earliest_start ?? '', weekly_hours: me.data.weekly_hours ?? '', preferred_hours: me.data.preferred_hours ?? '', timezone: me.data.timezone ?? '' }); }, [me.data]);
  if (me.error) return <ErrorState error={me.error} retry={me.reload} />;
  if (!v) return <LoadingBlock />;
  const save = async () => { setBusy(true); try { await api.patch('/api/v1/portal/candidate/availability', { ...v, weekly_hours: v.weekly_hours ? Number(v.weekly_hours) : null, earliest_start: v.earliest_start || null, timezone: v.timezone || null }); toast.success('Availability updated — your recruiter was notified'); me.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return <div><PageHeader title="Availability" sub="Keep this current so we only match you to roles that fit your schedule." />
    <Card pad><div className="form-grid">
      <Field label="Status" htmlFor="a-st"><select id="a-st" className="select" value={v.availability_status} onChange={e => setV({ ...v, availability_status: e.target.value })}><option value="available">Available now</option><option value="employed">Employed — need to give notice</option><option value="not_available">Not available</option></select></Field>
      <Field label="Earliest start" htmlFor="a-es"><input id="a-es" type="date" className="input" value={v.earliest_start} onChange={e => setV({ ...v, earliest_start: e.target.value })} /></Field>
      <Field label="Hours per week" htmlFor="a-wh"><input id="a-wh" type="number" className="input" value={v.weekly_hours} onChange={e => setV({ ...v, weekly_hours: e.target.value })} /></Field>
      <Field label="Preferred hours" htmlFor="a-ph"><input id="a-ph" className="input" placeholder="e.g. US Eastern business hours" value={v.preferred_hours} onChange={e => setV({ ...v, preferred_hours: e.target.value })} /></Field>
      <Field label="Timezone" htmlFor="a-tz"><select id="a-tz" className="select" value={v.timezone} onChange={e => setV({ ...v, timezone: e.target.value })}><option value="">Select…</option>{tzOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
    </div><div className="mt-3"><Button variant="primary" loading={busy} onClick={save}>Save availability</Button></div></Card></div>;
}

export function Media() {
  const me = useMe();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (me.data) setUrl(me.data.portfolio_url ?? ''); }, [me.data]);
  if (me.error) return <ErrorState error={me.error} retry={me.reload} />;
  if (!me.data) return <LoadingBlock />;
  const d = me.data;
  const up = async (kind: string, f: Blob, name: string) => { const fd = new FormData(); fd.append('file', f, name); const r = await api.upload(`/api/v1/portal/candidate/media/${kind}`, fd); me.reload(); return r; };
  return <div><PageHeader title="Resume & media" sub="Your resume, intro video and portfolio." />
    <div className="grid-2">
      <Card><CardHeader title={<><FileText size={16} /> Resume</>} right={d.resume_url && <a className="btn btn-sm" href={d.resume_url} target="_blank" rel="noreferrer"><Download size={14} /> {d.resume_file_name ?? 'Download'}</a>} /><div className="card-b">
        {d.resume_url || d.resume_file_name ? <div className="row" style={{ gap: 8 }}><CheckCircle2 size={18} color="var(--success)" /> Resume on file</div> : <div className="muted small">No resume yet.</div>}
        <label className="btn mt-2"><Upload size={16} /> {d.resume_url ? 'Replace resume' : 'Upload resume'}<input type="file" hidden accept=".pdf,.txt,.doc,.docx" onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { await up('resume', f, f.name); toast.success('Resume uploaded'); } catch (x) { toast.error(x); } e.target.value = ''; }} /></label>
      </div></Card>
      <Card><CardHeader title={<><Video size={16} /> Intro video</>} /><div className="card-b">
        {d.video_url && <video className="rec-video mb-2" src={d.video_url} controls preload="metadata" />}
        <VideoCapture video={null} onUploaded={x => { if (x) toast.success('Intro video saved'); }} upload={async (b, n) => { const r = await up('video', b, n); return { upload: r.file, filename: n }; }} />
      </div></Card>
      <Card><CardHeader title="Portfolio" /><div className="card-b stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8 }}><input className="input" type="url" aria-label="Portfolio link" placeholder="https://" value={url ?? ''} onChange={e => setUrl(e.target.value)} /><Button onClick={async () => { try { await api.post('/api/v1/portal/candidate/portfolio-url', { url: url ?? '' }); toast.success('Portfolio link saved'); me.reload(); } catch (e) { toast.error(e); } }}>Save</Button></div>
        {d.portfolio_file_url && <a href={d.portfolio_file_url} target="_blank" rel="noreferrer">Current portfolio file</a>}
        <label className="btn"><Upload size={16} /> Upload portfolio file<input type="file" hidden onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { await up('portfolio', f, f.name); toast.success('Portfolio uploaded'); } catch (x) { toast.error(x); } e.target.value = ''; }} /></label>
      </div></Card>
    </div></div>;
}

export function Applications() {
  const st = useApi<any>('/api/v1/portal/candidate/applications');
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  const steps: string[] = st.data.steps;
  return <div><PageHeader title="Applications & status" sub="Where each application stands." />
    {st.data.rows.length === 0 ? <EmptyState title="No applications yet" /> : st.data.rows.map((r: any) => {
      const idx = steps.indexOf(r.stage);
      return <Card key={r.id} pad className="mb-3"><div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}><div><b>{r.position_title}</b><div className="small muted">{[r.schedule, r.employment_type && humanize(r.employment_type)].filter(Boolean).join(' · ')} · applied {date(r.created_at)}</div></div><StatusPill status={r.stage === 'Not moving forward' ? 'rejected' : r.stage === 'Hired' ? 'hired' : r.stage === 'Offer' ? 'offer' : 'pending'} label={r.stage} /></div>
        {idx >= 0 && <div className="rec-steps mt-2" style={{ marginBottom: 0 }}>{steps.map((s, k) => <div key={s} className={`rec-step ${k === idx ? 'on' : k < idx ? 'done' : ''}`}><i />{s}</div>)}</div>}
        {r.stage === 'Not moving forward' && <div className="small muted mt-2">This role didn't work out, but you stay in our talent pool for future matches.</div>}
      </Card>;
    })}</div>;
}

export function Assessments() {
  const st = useApi<any[]>('/api/v1/portal/candidate/assessments');
  const [open, setOpen] = useState<any>(null);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  return <div><PageHeader title="Assessments" sub="Complete work samples requested by your recruiter. You can save and come back." />
    {st.data.length === 0 ? <EmptyState title="No assessments" text="Your recruiter will send one if it's needed for a role." /> : <div className="grid-2">{st.data.map(a => <Card key={a.id} pad><div className="row" style={{ justifyContent: 'space-between' }}><b>{a.name}</b><StatusPill status={a.status} /></div><div className="small muted">{a.category}{a.position_title ? ` · ${a.position_title}` : ''} · sent {relTime(a.sent_at)}</div>
      {a.status === 'scored' && <div className="mt-1 small">Score: <b>{a.score}/100</b></div>}
      <div className="mt-2">{['sent', 'started'].includes(a.status) ? <Button variant="primary" size="sm" onClick={async () => { if (a.status === 'sent') await api.post(`/api/v1/portal/candidate/assessments/${a.id}/start`).catch(() => {}); setOpen(a); }}>{a.status === 'sent' ? 'Start' : 'Continue'}</Button> : <Button size="sm" onClick={() => setOpen(a)}>View answers</Button>}</div></Card>)}</div>}
    {open && <AssessmentRunner a={open} onClose={() => { setOpen(null); st.reload(); }} />}
  </div>;
}
function AssessmentRunner({ a, onClose }: { a: any; onClose: () => void }) {
  const [ans, setAns] = useState<Record<string, string>>(a.answers ?? {});
  const [file, setFile] = useState<{ name: string; url?: string } | null>(a.file_name ? { name: a.file_name, url: a.file_url } : null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const ro = !['sent', 'started'].includes(a.status);
  const save = async () => { try { await api.post(`/api/v1/portal/candidate/assessments/${a.id}/save`, { answers: ans }); toast.success('Draft saved'); } catch (e) { toast.error(e); } };
  const submit = async () => { setBusy(true); setErr(null); try { await api.post(`/api/v1/portal/candidate/assessments/${a.id}/submit`, { answers: ans }); toast.success('Submitted — your recruiter will review it'); onClose(); } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); } };
  return <Dialog open onClose={onClose} wide title={a.name} footer={ro ? <Button onClick={onClose}>Close</Button> : <><Button onClick={save}>Save draft</Button><Button variant="primary" loading={busy} onClick={submit}>Submit assessment</Button></>}>
    <div className="stack" style={{ gap: 14 }}>
      {a.instructions && <div className="small muted">{a.instructions}</div>}
      {err && <Banner tone="danger">{err}</Banner>}
      {(a.questions ?? []).map((q: any, i: number) => <Field key={i} label={`${i + 1}. ${q.q}`} htmlFor={`aq-${i}`}><textarea id={`aq-${i}`} className="textarea" style={{ minHeight: 110 }} disabled={ro} value={ans[String(i)] ?? ''} onChange={e => setAns({ ...ans, [String(i)]: e.target.value })} /></Field>)}
      {a.allow_file && <div><div className="small bold mb-2">Attachment (optional)</div>{file && <div className="small mb-2"><CheckCircle2 size={14} color="var(--success)" /> {file.url ? <a href={file.url} target="_blank" rel="noreferrer">{file.name}</a> : file.name}</div>}
        {!ro && <label className="btn btn-sm"><Upload size={14} /> {file ? 'Replace file' : 'Attach a file'}<input type="file" hidden onChange={async e => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); try { const r = await api.upload(`/api/v1/portal/candidate/assessments/${a.id}/file`, fd); setFile({ name: r.file_name, url: r.file_url }); toast.success('File attached'); } catch (x) { toast.error(x); } e.target.value = ''; }} /></label>}</div>}
    </div>
  </Dialog>;
}

export function Interviews() {
  const st = useApi<any[]>('/api/v1/portal/candidate/interviews');
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  const up = st.data.filter(i => i.status === 'scheduled' && new Date(i.scheduled_at) > new Date());
  const past = st.data.filter(i => !up.includes(i));
  return <div><PageHeader title="Interviews" sub="Join links and calendar files for your interviews." />
    <Card className="mb-3"><CardHeader title="Upcoming" />{up.length === 0 ? <EmptyState icon={<CalendarClock size={22} />} title="No upcoming interviews" /> : <div className="card-b">{up.map(i => <div key={i.id} className="checklist-item"><CalendarClock size={18} /><div style={{ flex: 1 }}><b>{i.position_title ?? 'Interview'}</b> · {i.kind === 'client' ? 'with the client' : 'with your recruiter'}<div className="small">{new Date(i.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })} (your time) · {i.duration_min} min</div><div className="tiny muted">{new Date(i.scheduled_at).toLocaleString('en-US', { timeZone: i.timezone, timeStyle: 'short' })} {i.timezone}</div></div><a className="btn btn-sm btn-primary" href={i.meeting_url} target="_blank" rel="noreferrer">Join</a><a className="btn btn-sm" href={i.ics_url} download>Add to calendar</a></div>)}</div>}</Card>
    {past.length > 0 && <Card><CardHeader title="Past & other" /><div className="card-b">{past.map(i => <div key={i.id} className="checklist-item"><div style={{ flex: 1 }}>{i.position_title ?? 'Interview'} · {dateTime(i.scheduled_at)}</div><StatusPill status={i.status} /></div>)}</div></Card>}
  </div>;
}

export function Offers() {
  const st = useApi<any[]>('/api/v1/portal/candidate/offers');
  const [open, setOpen] = useState<any>(null);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  const view = async (o: any) => { try { const r = await api.post(`/api/v1/portal/candidate/offers/${o.id}/view`); setOpen(r); } catch (e) { toast.error(e); } };
  return <div><PageHeader title="Offers" sub="Review your offer and sign it electronically." />
    {st.data.length === 0 ? <EmptyState title="No offers yet" /> : <div className="grid-2">{st.data.map(o => <Card key={o.id} pad><div className="row" style={{ justifyContent: 'space-between' }}><b>{o.position_title}</b><StatusPill status={o.status} /></div><div className="small muted">{o.company_name} · start {date(o.start_date)}{o.expires_at ? ` · respond by ${date(o.expires_at)}` : ''}</div>
      <div className="mt-1">{money(o.pay_rate_cents, o.currency)} / {o.rate_unit}{o.weekly_hours ? ` · ${o.weekly_hours} h/week` : ''}</div>
      <div className="mt-2"><Button size="sm" variant={['sent', 'viewed'].includes(o.status) ? 'primary' : 'outline'} onClick={() => view(o)}>{['sent', 'viewed'].includes(o.status) ? 'Review & sign' : 'View'}</Button></div></Card>)}</div>}
    {open && <OfferSign o={open} onClose={() => { setOpen(null); st.reload(); }} />}
  </div>;
}
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null); const drawing = useRef(false); const has = useRef(false);
  useEffect(() => { const c = ref.current!; const r = c.getBoundingClientRect(); c.width = r.width * 2; c.height = r.height * 2; const ctx = c.getContext('2d')!; ctx.scale(2, 2); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0A0E16'; }, []);
  const pos = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  return <div><canvas ref={ref} className="rec-sig" aria-label="Draw your signature"
    onPointerDown={e => { drawing.current = true; ref.current!.setPointerCapture(e.pointerId); const ctx = ref.current!.getContext('2d')!; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); }}
    onPointerMove={e => { if (!drawing.current) return; const ctx = ref.current!.getContext('2d')!; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); has.current = true; }}
    onPointerUp={() => { drawing.current = false; if (has.current) onChange(ref.current!.toDataURL('image/png')); }} />
    <Button size="xs" variant="ghost" icon={<Eraser size={13} />} onClick={() => { const c = ref.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); has.current = false; onChange(null); }}>Clear</Button></div>;
}
function OfferSign({ o, onClose }: { o: any; onClose: () => void }) {
  const [name, setName] = useState(''); const [sig, setSig] = useState<string | null>(null); const [agree, setAgree] = useState(false);
  const [decline, setDecline] = useState(false); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const open = ['sent', 'viewed'].includes(o.status);
  const accept = async () => { setBusy(true); setErr(null); try { await api.post(`/api/v1/portal/candidate/offers/${o.id}/accept`, { signature_name: name, signature_data: sig, agree }); toast.success('Offer accepted and signed — congratulations!'); onClose(); } catch (e) { setErr(e instanceof ApiError ? (Object.values(e.fields ?? {})[0] as string) ?? e.message : String(e)); } finally { setBusy(false); } };
  const doDecline = async () => { setBusy(true); try { await api.post(`/api/v1/portal/candidate/offers/${o.id}/decline`, { reason }); toast.success('Offer declined — your recruiter was notified'); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return <Dialog open onClose={onClose} wide title={`Offer: ${o.position_title}`} footer={open ? (decline ? <><Button onClick={() => setDecline(false)}>Back</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 2} onClick={doDecline}>Decline offer</Button></> : <><Button onClick={() => setDecline(true)}>Decline</Button><Button variant="primary" icon={<PenLine size={16} />} loading={busy} disabled={name.trim().length < 2 || !sig || !agree} onClick={accept}>Accept & sign</Button></>) : <Button onClick={onClose}>Close</Button>}>
    <div className="stack" style={{ gap: 14 }}>
      <KV items={[['Role', o.position_title], ['Client', o.company_name], ['Pay', `${money(o.pay_rate_cents, o.currency)} per ${o.rate_unit}`], ['Hours', o.weekly_hours ? `${o.weekly_hours} per week` : null], ['Start date', date(o.start_date)], ['Respond by', date(o.expires_at)]]} />
      {o.terms && <div><b className="small">Terms</b><div className="small mt-1" style={{ whiteSpace: 'pre-wrap' }}>{o.terms}</div></div>}
      {o.status === 'accepted' && <Banner tone="success"><CheckCircle2 size={14} /> You signed this offer as <b>{o.signature_name}</b> on {dateTime(o.signed_at)} (IP {o.signed_ip}).{o.signature_data && <div className="mt-1"><img src={o.signature_data} alt="Your signature" style={{ maxWidth: 240, background: '#fff', borderRadius: 6 }} /></div>}</Banner>}
      {o.status === 'declined' && <Banner tone="warn">You declined this offer{o.decline_reason ? `: ${o.decline_reason}` : ''}.</Banner>}
      {o.status === 'expired' && <Banner tone="warn"><AlertTriangle size={14} /> This offer expired. Contact your recruiter.</Banner>}
      {open && !decline && <div className="card card-pad" style={{ background: 'var(--bg-2)' }}>
        <b>Sign electronically</b>
        <Field label="Type your full legal name" htmlFor="sg-n"><input id="sg-n" className="input" value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></Field>
        <div className="small bold mt-2 mb-2">Draw your signature</div><SignaturePad onChange={setSig} />
        <label className="check mt-2"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /> I have read and agree to the terms of this offer. I understand my typed name and drawn signature are a legal electronic signature.</label>
        <div className="tiny muted mt-1">We record the date, time and your IP address with your signature.</div>
        {err && <div className="small mt-1" style={{ color: 'var(--danger)' }}>{err}</div>}
      </div>}
      {open && decline && <Field label="Why are you declining? (helps us find a better match)" htmlFor="dc-r"><textarea id="dc-r" className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></Field>}
    </div>
  </Dialog>;
}

export function Documents() {
  const st = useApi<any>('/api/v1/portal/candidate/documents');
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  return <div><PageHeader title="Documents" sub="Documents shared with you and files you uploaded." />
    <Card className="mb-3"><CardHeader title="Shared with you" />{st.data.documents.length === 0 ? <EmptyState title="No documents yet" /> : <div className="card-b">{st.data.documents.map((d: any) => <div key={d.id} className="checklist-item"><FileText size={16} /><div style={{ flex: 1 }}><b>{d.name}</b><div className="tiny muted">{humanize(d.category)} · {date(d.created_at)}{d.signature_status ? ` · ${humanize(d.signature_status)}` : ''}</div></div>{d.file_url && <a className="btn btn-xs" href={d.file_url} target="_blank" rel="noreferrer">Open</a>}</div>)}</div>}</Card>
    <Card><CardHeader title="Your uploads" />{st.data.uploads.length === 0 ? <EmptyState title="Nothing uploaded" action={<Link to="../media" className="btn btn-sm">Upload resume or video</Link>} /> : <div className="card-b">{st.data.uploads.map((m: any) => <div key={m.id} className="checklist-item"><div style={{ flex: 1 }}><b>{humanize(m.kind)}</b> <span className="small muted">{m.file_name ?? m.url}</span><div className="tiny muted">{relTime(m.created_at)}</div></div>{(m.file_url || m.url) && <a className="btn btn-xs" href={m.file_url ?? m.url} target="_blank" rel="noreferrer">Open</a>}</div>)}</div>}</Card>
  </div>;
}

export function Messages() {
  const st = useApi<any>('/api/v1/portal/candidate/messages');
  const [body, setBody] = useState(''); const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [st.data]);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  const send = async () => { if (!body.trim()) return; setBusy(true); try { await api.post('/api/v1/portal/candidate/messages', { body }); setBody(''); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return <div><PageHeader title="Messages" sub={st.data.recruiter_name ? `Chat with ${st.data.recruiter_name}, your recruiter.` : 'Chat with the recruiting team.'} />
    <Card pad>
      {st.data.messages.length === 0 ? <EmptyState title="No messages yet" text="Ask a question about your application — your recruiter will reply here." /> : <div className="rec-thread">{st.data.messages.map((m: any) => <div key={m.id} className={`rec-msg ${m.mine ? 'mine' : ''}`}>{m.body}<div className="meta">{m.mine ? 'You' : m.author_name} · {relTime(m.created_at)}</div></div>)}<div ref={end} /></div>}
      <form className="row mt-2" style={{ gap: 8 }} onSubmit={e => { e.preventDefault(); send(); }}><textarea className="textarea" style={{ minHeight: 60, flex: 1 }} aria-label="Message" placeholder="Write a message…" value={body} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }} /><Button type="submit" variant="primary" icon={<Send size={16} />} loading={busy} disabled={!body.trim()}>Send</Button></form>
    </Card></div>;
}
