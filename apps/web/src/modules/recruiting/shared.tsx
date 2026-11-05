// Recruiting: shared constants, pickers, and the create/edit dialogs used across pages.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Upload, CalendarPlus, Download, CheckCircle2, Send, Undo2, XCircle, ExternalLink, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { money, dateTime, date as fmtDate, humanize, relTime } from '../../lib/format';
import { Banner, Button, Dialog, Drawer, EmptyState, ErrorState, Field, KV, LoadingBlock, MemberSelect, MoneyInput, Person, StatusPill, TagInput, useConfirm, EntitySelect } from '../../components/ui';
import { FormDrawer, FormFields, type FieldDef } from '../../components/FormDrawer';
import { Timeline } from '../../components/Timeline';
import './recruiting.css';

export const CANDIDATE_STATUSES = ['new_applicant', 'screening', 'assessment', 'recruiter_review', 'interview', 'qualified', 'talent_pool', 'submitted', 'hired', 'on_hold', 'future', 'rejected', 'withdrawn', 'blacklisted'] as const;
export const SUBMISSION_STAGES = ['submitted', 'client_review', 'client_interview', 'offer', 'hired', 'rejected', 'withdrawn'] as const;
export const REASON_REQUIRED = ['rejected', 'blacklisted', 'on_hold', 'withdrawn'];
export const SOURCES = ['Website', 'Recruiter link', 'Position link', 'LinkedIn', 'Referral', 'Job board', 'Facebook group', 'Sourced by recruiter'];
export const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Argentina/Buenos_Aires', 'America/Sao_Paulo', 'Europe/London', 'Europe/Madrid', 'Africa/Johannesburg', 'Africa/Nairobi', 'Africa/Lagos', 'Asia/Manila', 'Asia/Kolkata', 'Asia/Karachi', 'Asia/Jakarta', 'Asia/Ho_Chi_Minh', 'Australia/Sydney'];
export const tzOpts = TIMEZONES.map(t => ({ value: t, label: t.replace(/_/g, ' ') }));
export const CURRENCIES = ['USD', 'PHP', 'MXN', 'ZAR', 'COP', 'EUR', 'GBP'].map(c => ({ value: c, label: c }));
export const UNITS = [{ value: 'hour', label: 'per hour' }, { value: 'day', label: 'per day' }, { value: 'week', label: 'per week' }, { value: 'month', label: 'per month' }];
export const candName = (r: any) => [r?.first_name, r?.last_name].filter(Boolean).join(' ') || r?.candidate_name || r?.name || '—';
export const rateRange = (r: any) => r.rate_min_cents == null && r.rate_target_cents == null ? '—' : `${money(r.rate_min_cents, r.rate_currency)}${r.rate_target_cents ? ` – ${money(r.rate_target_cents, r.rate_currency)}` : ''}/${r.rate_unit === 'hour' ? 'hr' : r.rate_unit}`;
export function errMsg(e: unknown) { return e instanceof ApiError ? e.message : String(e); }

export function CandidateCell({ r, sub }: { r: any; sub?: ReactNode }) {
  return <Link to={`/recruiting/candidates/${r.candidate_id ?? r.id}`} onClick={e => e.stopPropagation()} style={{ color: 'inherit' }}><Person name={candName(r)} color={r.avatar_color} sub={sub ?? r.headline} /></Link>;
}
export function Chips({ items, hit }: { items?: string[] | null; hit?: string[] }) {
  if (!items?.length) return <span className="muted">—</span>;
  const h = new Set((hit ?? []).map(x => x.toLowerCase()));
  return <div className="rec-chips">{items.map(s => <span key={s} className={`chip ${hit ? (h.has(s.toLowerCase()) ? 'rec-chip-hit' : '') : ''}`}>{s}</span>)}</div>;
}
/** Renders a 503 AI error as a friendly, actionable banner (rest of the page keeps working). */
export function AiError({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return <Banner tone="warn"><b>AI unavailable.</b> {errMsg(error)} {retry && <Button size="xs" variant="ghost" onClick={retry}>Try again</Button>}</Banner>;
}

/* ═════════ Candidate form (create/edit) with "Prefill from resume" ═════════ */
const candFields = (canAttribute: boolean, withPosition: boolean): FieldDef[] => [
  { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name' },
  { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone', type: 'phone' },
  { name: 'country', label: 'Country' }, { name: 'city', label: 'City' },
  { name: 'timezone', label: 'Timezone', type: 'select', options: tzOpts }, { name: 'headline', label: 'Headline', placeholder: 'e.g. Dental Virtual Assistant' },
  { name: 'years_experience', label: 'Years of experience', type: 'number' }, { name: 'availability_status', label: 'Availability', type: 'select', options: [{ value: 'available', label: 'Available' }, { value: 'employed', label: 'Employed (notice needed)' }, { value: 'not_available', label: 'Not available' }] },
  { name: 'skills', label: 'Skills', type: 'tags', full: true }, { name: 'software', label: 'Software', type: 'tags', full: true }, { name: 'languages', label: 'Languages', type: 'tags', full: true },
  { name: 'rate_min_cents', label: 'Minimum acceptable rate', type: 'money' }, { name: 'rate_target_cents', label: 'Target rate', type: 'money' },
  { name: 'rate_currency', label: 'Currency', type: 'select', options: CURRENCIES }, { name: 'rate_unit', label: 'Rate unit', type: 'select', options: UNITS },
  { name: 'earliest_start', label: 'Earliest start', type: 'date' }, { name: 'weekly_hours', label: 'Weekly hours', type: 'number' },
  { name: 'preferred_hours', label: 'Preferred hours', placeholder: 'e.g. US Eastern business hours' }, { name: 'portfolio_url', label: 'Portfolio URL', type: 'url' },
  { name: 'source', label: 'Source', type: 'select', options: SOURCES.map(s => ({ value: s, label: s })) },
  ...(canAttribute ? [{ name: 'sourced_by', label: 'Sourced by (recruiter)', type: 'member' as const }] : []),
  { name: 'tags', label: 'Tags', type: 'tags', full: true },
  ...(withPosition ? [{ name: 'position_id', label: 'Add to position (optional)', type: 'entity' as const, endpoint: '/api/v1/positions?status=open', labelOf: (r: any) => `${r.title}${r.company_name ? ' — ' + r.company_name : ''}`, full: true }] : []),
];
export function CandidateForm({ open, onClose, onSaved, candidate }: { open: boolean; onClose: () => void; onSaved: (c: any) => void; candidate?: any }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const edit = !!candidate;
  const init = () => edit ? { ...candidate } : { availability_status: 'available', rate_currency: 'USD', rate_unit: 'hour', skills: [], software: [], languages: ['English'], tags: [] };
  const [values, setValues] = useState<Record<string, any>>(init);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [prefill, setPrefill] = useState<{ busy: boolean; note?: string; error?: string }>({ busy: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setValues(init()); setErrors({}); setFile(null); setPrefill({ busy: false }); } }, [open]);
  const fields = candFields(can('candidates', 'approve'), !edit);
  const doPrefill = async (f: File) => {
    setFile(f); setPrefill({ busy: true });
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await api.upload('/api/v1/ai/resume', fd);
      const x = r.extraction.fields;
      const got: Record<string, any> = {};
      for (const k of ['first_name', 'last_name', 'email', 'phone', 'headline', 'city', 'country', 'years_experience', 'skills', 'software', 'languages']) { const v = x[k]?.value; if (v !== null && v !== undefined && (!Array.isArray(v) || v.length)) got[k] = v; }
      if (x.education?.value?.length) got.education = x.education.value;
      if (x.experience?.value?.length) got.experience = x.experience.value;
      setValues(s => ({ ...s, ...got }));
      const unc = Object.entries(x).filter(([, v]: any) => v.uncertain && v.value && (!Array.isArray(v.value) || v.value.length)).map(([k]) => humanize(k));
      setPrefill({ busy: false, note: `Pre-filled ${Object.keys(got).length} fields from the resume. ${unc.length ? `Check: ${unc.join(', ')}.` : ''} ${r.extraction.warnings.join(' ')}` });
    } catch (e) { setPrefill({ busy: false, error: errMsg(e) }); }
  };
  const submit = async (force = false) => {
    if (!values.first_name?.trim()) { setErrors({ first_name: 'First name is required' }); return; }
    setBusy(true); setErrors({});
    const body: Record<string, any> = {};
    for (const f of fields) if (values[f.name] !== undefined && values[f.name] !== '') body[f.name] = values[f.name];
    if (values.education) body.education = values.education;
    if (values.experience) body.experience = values.experience;
    if (!edit && !body.source) body.source = 'Sourced by recruiter';
    try {
      const r = edit ? await api.patch(`/api/v1/candidates/${candidate.id}`, Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'position_id'))) : await api.post('/api/v1/candidates', { ...body, force });
      if (file && !edit) { const fd = new FormData(); fd.append('file', file); await api.upload(`/api/v1/candidates/${r.id}/media/resume`, fd).catch(e => toast.error(e)); }
      toast.success(edit ? 'Candidate updated' : 'Candidate created');
      onSaved(r); onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.details?.duplicates) {
        const d = e.details.duplicates as any[];
        const ok = await confirm({ title: 'Possible duplicate', body: <div>These candidates share the email or phone:<ul>{d.map(x => <li key={x.id}><Link to={`/recruiting/candidates/${x.id}`} target="_blank">{x.name}</Link> — {x.email ?? x.phone} ({humanize(x.status)})</li>)}</ul>Create a new candidate anyway?</div>, confirmLabel: 'Create anyway' });
        if (ok.ok) { setBusy(false); return submit(true); }
      } else { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); }
    } finally { setBusy(false); }
  };
  return (
    <Drawer open={open} onClose={onClose} wide title={edit ? `Edit ${candName(candidate)}` : 'New candidate'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => submit(false)}>{edit ? 'Save changes' : 'Create candidate'}</Button></>}>
      {!edit && (
        <div className="mb-3">
          <label className="rec-drop" style={{ display: 'block', padding: 16 }}>
            <input type="file" hidden accept=".pdf,.txt,.doc,.docx,.md" onChange={e => e.target.files?.[0] && doPrefill(e.target.files[0])} />
            <Upload size={18} /> <b>{file ? file.name : 'Prefill from resume (optional)'}</b>
            <div className="small muted mt-1">Analyze Resume extracts only what is in the file — review every field before saving.</div>
          </label>
          {prefill.busy && <div className="small muted mt-1"><span className="spinner" /> Analyzing resume…</div>}
          {prefill.note && <div className="small mt-1" style={{ color: 'var(--success)' }}><Sparkles size={13} /> {prefill.note}</div>}
          {prefill.error && <div className="mt-1"><Banner tone="warn">{prefill.error} The file will still be attached.</Banner></div>}
        </div>
      )}
      <form onSubmit={e => { e.preventDefault(); submit(false); }}><FormFields fields={fields} values={values} setValues={setValues} errors={errors} /><button type="submit" hidden /></form>
      <div className="small muted mt-2">A candidate is a person, independent of any job — you can add them to positions later. Rate expectations are visible to recruiters but never shared with clients unless you mark them shareable on a submission.</div>
    </Drawer>
  );
}

/* ═════════ Position form ═════════ */
export function PositionForm({ open, onClose, onSaved, position }: { open: boolean; onClose: () => void; onSaved: (p: any) => void; position?: any }) {
  const { can } = useAuth();
  const comp = can('rates', 'view_comp') || can('positions', 'view_comp');
  const edit = !!position;
  const fields: FieldDef[] = [
    { name: 'title', label: 'Title', required: true, full: true },
    { name: 'company_id', label: 'Client', type: 'entity', endpoint: '/api/v1/companies?stage=client', labelOf: r => r.name, placeholder: 'No client yet' },
    { name: 'openings', label: 'Openings', type: 'number' },
    { name: 'urgency', label: 'Urgency', type: 'select', options: ['low', 'normal', 'high', 'critical'].map(v => ({ value: v, label: humanize(v) })) },
    { name: 'employment_type', label: 'Employment type', type: 'select', options: ['full_time', 'part_time', 'contract', 'project'].map(v => ({ value: v, label: humanize(v) })) },
    { name: 'schedule', label: 'Schedule', placeholder: 'Mon–Fri 9:00–17:00' }, { name: 'timezone', label: 'Timezone', type: 'select', options: tzOpts },
    { name: 'weekly_hours', label: 'Weekly hours', type: 'number' },
    ...(edit ? [{ name: 'health', label: 'Health', type: 'select' as const, options: ['on_track', 'at_risk', 'critical'].map(v => ({ value: v, label: humanize(v) })) }] : []),
    { name: 'skills', label: 'Skills', type: 'tags', full: true }, { name: 'software', label: 'Software', type: 'tags', full: true }, { name: 'languages', label: 'Languages', type: 'tags', full: true },
    { name: 'equipment', label: 'Equipment', full: true },
    { name: 'pay_min_cents', label: 'Target pay (min)', type: 'money' }, { name: 'pay_max_cents', label: 'Target pay (max)', type: 'money' },
    ...(comp ? [{ name: 'bill_budget_cents', label: 'Client bill-rate budget', type: 'money' as const, hint: 'Restricted — only visible to roles with compensation access.' }] : []),
    { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES }, { name: 'rate_unit', label: 'Rate unit', type: 'select', options: UNITS },
    ...(!edit ? [{ name: 'status', label: 'Status', type: 'select' as const, options: [{ value: 'draft', label: 'Draft / intake' }, { value: 'open', label: 'Open' }] }, { name: 'lead_recruiter', label: 'Lead recruiter', type: 'member' as const, roles: ['recruiter', 'owner', 'admin', 'management'] }] : []),
    { name: 'description', label: 'Description', type: 'textarea', full: true },
  ];
  const initial = edit ? { ...position } : { openings: 1, urgency: 'normal', employment_type: 'full_time', currency: 'USD', rate_unit: 'hour', status: 'draft', skills: [], software: [], languages: ['English'], weekly_hours: 40, schedule: 'Mon–Fri 9:00–17:00', timezone: 'America/New_York' };
  return <FormDrawer open={open} onClose={onClose} wide title={edit ? `Edit ${position.title}` : 'New position'} fields={fields} initial={initial} submitLabel={edit ? 'Save changes' : 'Create position'}
    onSubmit={async v => {
      const keys = fields.map(f => f.name).filter(k => k !== 'lead_recruiter');
      const body: Record<string, any> = {};
      for (const k of keys) if (v[k] !== undefined && v[k] !== '') body[k] = v[k];
      if (!edit && v.lead_recruiter) body.recruiters = [{ user_id: v.lead_recruiter, is_lead: true }];
      if (edit) delete body.status;
      const r = edit ? await api.patch(`/api/v1/positions/${position.id}`, body) : await api.post('/api/v1/positions', body);
      toast.success(edit ? 'Position updated' : 'Position created'); onSaved(r);
    }} />;
}

/* ═════════ Candidate status change (with reason where required) ═════════ */
export function StatusDialog({ candidate, to, onClose, onDone }: { candidate: any; to: string | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setReason(''), [to]);
  if (!to) return null;
  const need = REASON_REQUIRED.includes(to);
  const go = async () => {
    setBusy(true);
    try { await api.post(`/api/v1/candidates/${candidate.id}/status`, { status: to, reason: reason || null }); toast.success(`Moved to ${humanize(to)}`); onDone(); onClose(); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return <Dialog open onClose={onClose} title={`Move ${candName(candidate)} to ${humanize(to)}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={['rejected', 'blacklisted'].includes(to) ? 'danger' : 'primary'} disabled={need && !reason.trim()} loading={busy} onClick={go}>Confirm</Button></>}>
    {to === 'blacklisted' && <Banner tone="danger">Blacklisting is permanent, permissioned and audited. The candidate will not be matched again.</Banner>}
    <Field label={`Reason${need ? ' *' : ' (optional)'}`} htmlFor="st-reason"><textarea id="st-reason" className="textarea" value={reason} onChange={e => setReason(e.target.value)} placeholder={need ? 'Required — shown on the activity timeline' : 'Optional note'} /></Field>
  </Dialog>;
}

/* ═════════ Schedule interview ═════════ */
function localInput(d: Date) { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
/** Converts a "YYYY-MM-DDTHH:mm" wall-clock time in `tz` to an ISO instant. */
export function zonedIso(local: string, tz: string) {
  const [d, t] = local.split('T'); const [y, m, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, da, h, mi);
  const off = (ts: number) => { const s = new Date(ts).toLocaleString('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); const [md, hm] = s.split(', '); const [mo, dd, yy] = md.split('/').map(Number); const [hh, mm] = hm.split(':').map(Number); return Date.UTC(yy, mo - 1, dd, hh % 24, mm) - ts; };
  return new Date(guess - off(guess - off(guess))).toISOString();
}
export function ScheduleInterviewDialog({ open, onClose, onDone, candidateId, candidateName, positionId, submissionId, kind = 'internal' }: { open: boolean; onClose: () => void; onDone: (iv: any) => void; candidateId: string; candidateName: string; positionId?: string | null; submissionId?: string | null; kind?: 'internal' | 'client' }) {
  const { me } = useAuth();
  const tomorrow = new Date(Date.now() + 86400000); tomorrow.setHours(10, 0, 0, 0);
  const [v, setV] = useState<any>({});
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) setV({ kind, when: localInput(tomorrow), timezone: 'America/New_York', duration_min: kind === 'client' ? 45 : 30, interviewer: me?.user.id, position_id: positionId ?? null, interviewers: '', notify_candidate: true }); }, [open]);
  const go = async () => {
    setBusy(true);
    try {
      const iv = await api.post('/api/v1/interviews', { candidate_id: candidateId, position_id: v.position_id || null, submission_id: submissionId ?? null, kind: v.kind, scheduled_at: zonedIso(v.when, v.timezone), duration_min: Number(v.duration_min), timezone: v.timezone, interviewer_ids: v.interviewer ? [v.interviewer] : [], interviewers: v.interviewers || null, notify_candidate: v.notify_candidate });
      toast.success('Interview scheduled — meeting link generated'); onDone(iv); onClose();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return <Dialog open={open} onClose={onClose} title={`Schedule interview — ${candidateName}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<CalendarPlus size={16} />} loading={busy} disabled={!v.when} onClick={go}>Schedule</Button></>}>
    <div className="form-grid">
      <Field label="Type" htmlFor="iv-kind"><select id="iv-kind" className="select" value={v.kind} onChange={e => setV({ ...v, kind: e.target.value })} disabled={!!submissionId}><option value="internal">Internal (recruiter)</option><option value="client">Client interview</option></select></Field>
      {!positionId && <Field label="Position" htmlFor="iv-pos"><EntitySelect id="iv-pos" endpoint="/api/v1/positions?status=open,on_hold" value={v.position_id} onChange={x => setV({ ...v, position_id: x })} labelOf={r => r.title + (r.company_name ? ` — ${r.company_name}` : '')} placeholder="Not tied to a position" /></Field>}
      <Field label="Date & time" htmlFor="iv-when"><input id="iv-when" type="datetime-local" className="input" value={v.when ?? ''} onChange={e => setV({ ...v, when: e.target.value })} /></Field>
      <Field label="Timezone" htmlFor="iv-tz"><select id="iv-tz" className="select" value={v.timezone} onChange={e => setV({ ...v, timezone: e.target.value })}>{tzOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
      <Field label="Duration" htmlFor="iv-dur"><select id="iv-dur" className="select" value={v.duration_min} onChange={e => setV({ ...v, duration_min: e.target.value })}>{[15, 30, 45, 60, 90].map(n => <option key={n} value={n}>{n} minutes</option>)}</select></Field>
      <Field label="Interviewer" htmlFor="iv-int"><MemberSelect id="iv-int" value={v.interviewer} onChange={x => setV({ ...v, interviewer: x })} /></Field>
      <Field label="Other attendees (names)" htmlFor="iv-oth" full><input id="iv-oth" className="input" value={v.interviewers} onChange={e => setV({ ...v, interviewers: e.target.value })} placeholder={v.kind === 'client' ? 'e.g. Dana Fox (hiring manager)' : 'Optional'} /></Field>
      <Field full><label className="check"><input type="checkbox" checked={!!v.notify_candidate} onChange={e => setV({ ...v, notify_candidate: e.target.checked })} /> Email the candidate the time and meeting link</label></Field>
    </div>
    <div className="small muted">A meet.veyro.local link and an .ics calendar file are generated. Reminders go out ~24 hours before.</div>
  </Dialog>;
}

/* ═════════ Submit to client ═════════ */
export function SubmitDialog({ open, onClose, onDone, candidate, positionId }: { open: boolean; onClose: () => void; onDone: (s: any) => void; candidate: any; positionId?: string | null }) {
  const [pos, setPos] = useState<string | null>(positionId ?? null);
  const [share, setShare] = useState({ contact: false, rate: false, notes: false });
  const [pres, setPres] = useState('');
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<{ busy: boolean; err?: unknown }>({ busy: false });
  useEffect(() => { if (open) { setPos(positionId ?? null); setShare({ contact: false, rate: false, notes: false }); setPres(''); setAi({ busy: false }); } }, [open, positionId]);
  const draft = async () => { setAi({ busy: true }); try { const r = await api.post('/api/v1/ai/draft', { kind: 'client_presentation', candidate_id: candidate.id, position_id: pos, include_rate: share.rate }); setPres(r.body); setAi({ busy: false }); } catch (e) { setAi({ busy: false, err: e }); } };
  const go = async () => { setBusy(true); try { const s = await api.post('/api/v1/submissions', { candidate_id: candidate.id, position_id: pos, shareable: share, presentation: pres || null }); toast.success('Submitted to client — they can review the client-safe profile in their portal'); onDone(s); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return <Dialog open={open} onClose={onClose} wide title={`Submit ${candName(candidate)} to a client`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Send size={16} />} disabled={!pos} loading={busy} onClick={go}>Submit</Button></>}>
    <div className="stack" style={{ gap: 14 }}>
      {!positionId && <Field label="Position *" htmlFor="sub-pos"><EntitySelect id="sub-pos" endpoint="/api/v1/positions?status=open,on_hold" value={pos} onChange={setPos} labelOf={r => r.title + (r.company_name ? ` — ${r.company_name}` : '')} /></Field>}
      <div><div className="small bold mb-2">Share with the client (default: profile only)</div>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="check"><input type="checkbox" checked={share.contact} onChange={e => setShare({ ...share, contact: e.target.checked })} /> Contact details & full name</label>
          <label className="check"><input type="checkbox" checked={share.rate} onChange={e => setShare({ ...share, rate: e.target.checked })} /> Rate expectation</label>
          <label className="check"><input type="checkbox" checked={share.notes} onChange={e => setShare({ ...share, notes: e.target.checked })} /> Recruiter notes</label>
        </div></div>
      <Field label={<span className="row" style={{ justifyContent: 'space-between', width: '100%' }}>Client presentation <Button size="xs" variant="ghost" icon={<Sparkles size={13} />} loading={ai.busy} onClick={draft}>Draft with AI</Button></span>} htmlFor="sub-pres" hint="Leave blank to use an automatic summary from the profile. Nothing is sent until you click Submit.">
        <textarea id="sub-pres" className="textarea" style={{ minHeight: 140 }} value={pres} onChange={e => setPres(e.target.value)} placeholder="What makes this candidate a fit…" />
      </Field>
      <AiError error={ai.err} retry={draft} />
    </div>
  </Dialog>;
}

/* ═════════ Offer create ═════════ */
export function OfferDialog({ open, onClose, onDone, candidate, positionId }: { open: boolean; onClose: () => void; onDone: (o: any) => void; candidate: any; positionId?: string | null }) {
  const { can } = useAuth();
  const comp = can('rates', 'view_comp') || can('offers', 'view_comp');
  const fields: FieldDef[] = [
    ...(!positionId ? [{ name: 'position_id', label: 'Position', type: 'entity' as const, required: true, endpoint: `/api/v1/submissions?candidate_id=${candidate?.id}`, labelOf: (r: any) => `${r.position_title}${r.company_name ? ' — ' + r.company_name : ''} (${humanize(r.status)})`, full: true }] : []),
    { name: 'pay_rate_cents', label: 'Pay rate (to worker)', type: 'money', required: true, hint: comp ? undefined : 'Write-only for your role — approvers see it.' },
    { name: 'bill_rate_cents', label: 'Bill rate (to client)', type: 'money', required: true },
    { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES }, { name: 'rate_unit', label: 'Unit', type: 'select', options: UNITS },
    { name: 'weekly_hours', label: 'Weekly hours', type: 'number' }, { name: 'start_date', label: 'Start date', type: 'date', required: true },
    { name: 'expires_at', label: 'Offer expires', type: 'date' },
    { name: 'terms', label: 'Terms', type: 'textarea', full: true },
  ];
  return <FormDrawer open={open} onClose={onClose} title={`New offer — ${candName(candidate)}`} fields={fields} submitLabel="Create draft offer"
    initial={{ currency: 'USD', rate_unit: 'hour', weekly_hours: 40, terms: 'Full-time remote contractor engagement, Monday–Friday. Pay is per approved hour.', position_id: positionId ?? null }}
    onSubmit={async v => {
      let pos = positionId ?? null;
      if (!pos && v.position_id) { const s = await api.get(`/api/v1/submissions/${v.position_id}`); pos = s.position_id; }
      const r = await api.post('/api/v1/offers', { candidate_id: candidate.id, position_id: pos, pay_rate_cents: v.pay_rate_cents, bill_rate_cents: v.bill_rate_cents, currency: v.currency, rate_unit: v.rate_unit, weekly_hours: v.weekly_hours ?? null, start_date: v.start_date, expires_at: v.expires_at || null, terms: v.terms || null });
      toast.success(can('offers', 'approve') ? 'Draft offer created — approve it to send' : 'Draft offer created — an approver has been notified'); onDone(r);
    }}>{() => <div className="small muted mt-2">Offers follow Draft → Approved → Sent → Viewed → Accepted/Declined. The candidate accepts with an e-signature in their portal.</div>}</FormDrawer>;
}

/* ═════════ Assign assessment ═════════ */
export function AssessmentDialog({ open, onClose, onDone, candidate, positionId }: { open: boolean; onClose: () => void; onDone: () => void; candidate: any; positionId?: string | null }) {
  const tpls = useApi<any[]>(open ? '/api/v1/assessment-templates' : null, [open]);
  const [t, setT] = useState<string>('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setT(''); }, [open]);
  const sel = tpls.data?.find(x => x.id === t);
  const go = async () => { setBusy(true); try { await api.post('/api/v1/assessments', { template_id: t, candidate_id: candidate.id, position_id: positionId ?? null }); toast.success('Assessment sent — the candidate completes it in their portal'); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return <Dialog open={open} onClose={onClose} title={`Send assessment to ${candName(candidate)}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!t} loading={busy} onClick={go}>Send assessment</Button></>}>
    {tpls.error ? <ErrorState error={tpls.error} /> : !tpls.data ? <LoadingBlock rows={3} /> : <>
      <Field label="Template" htmlFor="as-t"><select id="as-t" className="select" value={t} onChange={e => setT(e.target.value)}><option value="">Choose from the library…</option>{tpls.data.map(x => <option key={x.id} value={x.id}>{x.name}{x.category ? ` · ${x.category}` : ''}</option>)}</select></Field>
      {sel && <div className="mt-2 small"><div className="muted">{sel.instructions}</div><ol>{(sel.questions ?? []).map((q: any, i: number) => <li key={i}>{q.q}</li>)}</ol>{sel.allow_file && <div className="muted">File upload allowed.</div>}</div>}
      {candidate.status && ['new_applicant', 'screening'].includes(candidate.status) && <div className="small muted mt-2">The candidate will move to <b>Assessment</b>.</div>}
    </>}
  </Dialog>;
}

/* ═════════ Interview drawer (details, feedback scorecard, outcome, reschedule) ═════════ */
export function InterviewDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged?: () => void }) {
  const st = useApi<any>(id ? `/api/v1/interviews/${id}` : null, [id]);
  const confirm = useConfirm();
  const [fb, setFb] = useState<any>(null);
  const [resched, setResched] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const i = st.data;
  const reload = () => { st.reload(); onChanged?.(); };
  const act = async (fn: () => Promise<any>, msg: string) => { setBusy(true); try { await fn(); toast.success(msg); reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  if (!id) return null;
  const past = i && new Date(i.scheduled_at) <= new Date();
  return <Drawer open onClose={onClose} wide title={i ? `${i.kind === 'client' ? 'Client' : 'Internal'} interview — ${i.candidate_name}` : 'Interview'}
    footer={i && <div className="rec-actions">
      {i.status === 'requested' && <Button variant="primary" loading={busy} icon={<CheckCircle2 size={16} />} onClick={() => act(() => api.post(`/api/v1/interviews/${i.id}/confirm`, {}), 'Interview confirmed — candidate and client notified')}>Confirm requested time</Button>}
      {['scheduled', 'requested'].includes(i.status) && <Button onClick={() => setResched({ when: '', timezone: i.timezone })}>Reschedule</Button>}
      {['scheduled', 'completed'].includes(i.status) && <Button variant={i.status === 'scheduled' && past ? 'primary' : 'outline'} onClick={() => setFb({ communication: 4, experience: 4, culture: 4, technical: 4, overall: 4, recommendation: 'hire', notes: '' })}>Add scorecard</Button>}
      {i.status === 'scheduled' && <Button variant="danger" onClick={async () => { const r = await confirm({ title: 'Cancel interview?', reason: { label: 'Reason', required: true }, danger: true, confirmLabel: 'Cancel interview' }); if (r.ok) act(() => api.post(`/api/v1/interviews/${i.id}/status`, { status: 'cancelled', reason: r.reason }), 'Interview cancelled'); }}>Cancel</Button>}
      {i.status === 'scheduled' && past && <Button onClick={() => act(() => api.post(`/api/v1/interviews/${i.id}/status`, { status: 'no_show' }), 'Marked as no-show')}>No-show</Button>}
    </div>}>
    {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !i ? <LoadingBlock /> : <div className="stack" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 8 }}><StatusPill status={i.status} />{i.outcome && <StatusPill status={i.outcome} label={`Outcome: ${humanize(i.outcome)}`} />}</div>
      <KV items={[
        ['Candidate', <Link to={`/recruiting/candidates/${i.candidate_id}`}>{i.candidate_name}</Link>], ['Position', i.position_id ? <Link to={`/recruiting/positions/${i.position_id}`}>{i.position_title}</Link> : '—'], ['Client', i.company_name],
        ['When', `${new Date(i.scheduled_at).toLocaleString('en-US', { timeZone: i.timezone, dateStyle: 'medium', timeStyle: 'short' })} (${i.timezone})`], ['Your time', dateTime(i.scheduled_at)], ['Duration', `${i.duration_min} min`],
        ['Interviewers', [i.interviewer_names, i.interviewers].filter(Boolean).join(', ') || '—'], ['Meeting link', i.meeting_url && i.status !== 'cancelled' ? <a href={i.meeting_url} target="_blank" rel="noreferrer">{i.meeting_url}</a> : '—'],
        ['Requested by', i.requested_by_name ? `${i.requested_by_name}${i.request_note ? ` — "${i.request_note}"` : ''}` : null], ['Cancel reason', i.cancel_reason],
      ]} />
      {i.status === 'scheduled' && <div><a className="btn btn-sm" href={i.ics_url} download><Download size={14} /> Download .ics</a></div>}
      {i.status === 'requested' && <Banner tone="warn">The client asked for this time. Confirm it (or reschedule) to send invites and the meeting link.</Banner>}
      <div><h3 className="mb-2">Feedback</h3>{i.feedback.length === 0 ? <EmptyState title="No scorecards yet" text={past ? 'Add the first scorecard.' : 'Feedback opens after the interview.'} /> : i.feedback.map((f: any) => (
        <div key={f.id} className="checklist-item" style={{ alignItems: 'flex-start' }}><div style={{ flex: 1 }}><b>{f.author_label ?? f.author_name}</b> · {f.overall}/5 · <StatusPill status={f.recommendation === 'no_hire' ? 'rejected' : f.recommendation === 'maybe' ? 'pending' : 'approved'} label={humanize(f.recommendation)} />
          {f.scores && Object.keys(f.scores).length > 0 && <div className="small muted mt-1">{Object.entries(f.scores).map(([k, v]) => `${humanize(k)} ${v}/5`).join(' · ')}</div>}{f.notes && <div className="small mt-1">{f.notes}</div>}<div className="tiny muted mt-1">{relTime(f.created_at)}</div></div></div>))}</div>
      {['scheduled', 'completed'].includes(i.status) && <div className="row" style={{ gap: 8 }}><span className="small muted">Outcome:</span>{['advance', 'hold', 'reject'].map(o => <Button key={o} size="sm" variant={i.outcome === o ? 'primary' : 'outline'} onClick={() => act(() => api.post(`/api/v1/interviews/${i.id}/outcome`, { outcome: o }), `Outcome set: ${o}`)}>{humanize(o)}</Button>)}</div>}
      <div><h3 className="mb-2">Activity</h3><Timeline type="interview" id={i.id} composer={false} reloadKey={i.updated_at} /></div>
    </div>}
    <Dialog open={!!fb} onClose={() => setFb(null)} title="Interview scorecard" footer={<><Button onClick={() => setFb(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => act(() => api.post(`/api/v1/interviews/${id}/feedback`, { scores: { communication: fb.communication, experience: fb.experience, culture: fb.culture, technical: fb.technical }, overall: fb.overall, recommendation: fb.recommendation, notes: fb.notes || null }), 'Scorecard saved').then(() => setFb(null))}>Save scorecard</Button></>}>
      {fb && <div className="form-grid">{['communication', 'experience', 'culture', 'technical', 'overall'].map(k => <Field key={k} label={`${humanize(k)} (1–5)`} htmlFor={`fb-${k}`}><select id={`fb-${k}`} className="select" value={fb[k]} onChange={e => setFb({ ...fb, [k]: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>)}
        <Field label="Recommendation" htmlFor="fb-rec"><select id="fb-rec" className="select" value={fb.recommendation} onChange={e => setFb({ ...fb, recommendation: e.target.value })}>{['strong_hire', 'hire', 'maybe', 'no_hire'].map(r => <option key={r} value={r}>{humanize(r)}</option>)}</select></Field>
        <Field label="Notes" full htmlFor="fb-notes"><textarea id="fb-notes" className="textarea" value={fb.notes} onChange={e => setFb({ ...fb, notes: e.target.value })} /></Field></div>}
    </Dialog>
    <Dialog open={!!resched} onClose={() => setResched(null)} title="Reschedule interview" footer={<><Button onClick={() => setResched(null)}>Cancel</Button><Button variant="primary" disabled={!resched?.when} loading={busy} onClick={() => act(() => api.patch(`/api/v1/interviews/${id}`, { scheduled_at: zonedIso(resched.when, resched.timezone), timezone: resched.timezone }), 'Interview rescheduled — attendees notified').then(() => setResched(null))}>Save</Button></>}>
      {resched && <div className="form-grid"><Field label="New date & time" htmlFor="rs-when"><input id="rs-when" type="datetime-local" className="input" value={resched.when} onChange={e => setResched({ ...resched, when: e.target.value })} /></Field>
        <Field label="Timezone" htmlFor="rs-tz"><select id="rs-tz" className="select" value={resched.timezone} onChange={e => setResched({ ...resched, timezone: e.target.value })}>{tzOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field></div>}
    </Dialog>
  </Drawer>;
}

/* ═════════ Offer drawer ═════════ */
export function OfferDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged?: () => void }) {
  const st = useApi<any>(id ? `/api/v1/offers/${id}` : null, [id]);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const o = st.data;
  const act = async (fn: () => Promise<any>, msg: string) => { setBusy(true); try { await fn(); toast.success(msg); st.reload(); onChanged?.(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  if (!id) return null;
  return <Drawer open onClose={onClose} title={o ? `Offer — ${o.candidate_name}` : 'Offer'} footer={o && <div className="rec-actions">
    {o.status === 'draft' && o.can_approve && <Button variant="primary" loading={busy} icon={<CheckCircle2 size={16} />} onClick={() => act(() => api.post(`/api/v1/offers/${o.id}/approve`), 'Offer approved')}>Approve</Button>}
    {o.status === 'approved' && <Button variant="primary" loading={busy} icon={<Send size={16} />} onClick={async () => { const r = await confirm({ title: 'Send offer?', body: `${o.candidate_name} will get an email with a link to review and sign in their candidate portal.`, confirmLabel: 'Send offer' }); if (r.ok) act(() => api.post(`/api/v1/offers/${o.id}/send`), 'Offer sent'); }}>Send to candidate</Button>}
    {o.create_placement_url && <Link className="btn btn-primary" to={o.create_placement_url}><ExternalLink size={16} /> Create placement</Link>}
    {o.status === 'approved' && <Button icon={<Undo2 size={16} />} onClick={async () => { const r = await confirm({ title: 'Move back to draft?', reason: { label: 'Reason', required: true } }); if (r.ok) act(() => api.post(`/api/v1/offers/${o.id}/revert`, { reason: r.reason }), 'Back to draft'); }}>Back to draft</Button>}
    {['draft', 'approved', 'sent', 'viewed'].includes(o.status) && <Button variant="danger" icon={<XCircle size={16} />} onClick={async () => { const r = await confirm({ title: 'Withdraw / expire this offer?', reason: { label: 'Reason', required: true }, danger: true }); if (r.ok) act(() => api.post(`/api/v1/offers/${o.id}/expire`, { reason: r.reason }), 'Offer expired'); }}>Withdraw</Button>}
  </div>}>
    {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !o ? <LoadingBlock /> : <div className="stack" style={{ gap: 16 }}>
      <div className="rec-steps">{['draft', 'approved', 'sent', 'viewed', 'accepted'].map((s, k, arr) => { const idx = arr.indexOf(o.status); return <div key={s} className={`rec-step ${s === o.status ? 'on' : idx > k || (o.status === 'accepted') ? 'done' : ''}`}><i />{humanize(s)}</div>; })}</div>
      {['declined', 'expired'].includes(o.status) && <Banner tone="danger">Offer {o.status}{o.decline_reason ? `: ${o.decline_reason}` : ''}</Banner>}
      {o.status === 'accepted' && <Banner tone="success">Accepted and signed by <b>{o.signature_name}</b> on {dateTime(o.signed_at)} (IP {o.signed_ip}). {o.placement_id ? 'Placement created.' : 'Next step: create the placement — the candidate becomes a worker as the same person.'}</Banner>}
      <KV items={[
        ['Candidate', <Link to={`/recruiting/candidates/${o.candidate_id}`}>{o.candidate_name}</Link>], ['Position', o.position_id ? <Link to={`/recruiting/positions/${o.position_id}`}>{o.position_title}</Link> : '—'], ['Client', o.company_name],
        ['Pay rate', o.comp_restricted ? <span className="muted">Restricted</span> : `${money(o.pay_rate_cents, o.currency)} / ${o.rate_unit}`], ['Bill rate', o.comp_restricted ? <span className="muted">Restricted</span> : `${money(o.bill_rate_cents, o.currency)} / ${o.rate_unit}`],
        ...(o.margin_pct !== undefined ? [['Margin', `${money(o.margin_cents, o.currency)} (${o.margin_pct}%)`] as [string, string]] : []),
        ['Weekly hours', o.weekly_hours], ['Start date', fmtDate(o.start_date)], ['Expires', fmtDate(o.expires_at)],
        ['Created by', o.created_by_name], ['Approved by', o.approved_by_name ? `${o.approved_by_name} · ${dateTime(o.approved_at)}` : null], ['Sent', dateTime(o.sent_at)], ['Viewed', dateTime(o.viewed_at)],
      ]} />
      {o.terms && <div><div className="small bold mb-2">Terms</div><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{o.terms}</div></div>}
      {o.signature_data && <div><div className="small bold mb-2">Signature</div><img src={o.signature_data} alt={`Signature of ${o.signature_name}`} style={{ maxWidth: 280, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} /></div>}
      {o.status === 'draft' && !o.can_approve && <Banner>Waiting for an approver (Owner/Admin/Management). They were notified.</Banner>}
      <div><h3 className="mb-2">Activity</h3><Timeline type="offer" id={o.id} composer={false} reloadKey={o.updated_at} /></div>
    </div>}
  </Drawer>;
}

/* ═════════ Assessment drawer (answers, file, score) ═════════ */
export function AssessmentDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged?: () => void }) {
  const st = useApi<any>(id ? `/api/v1/assessments/${id}` : null, [id]);
  const [score, setScore] = useState<string>(''); const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const a = st.data;
  useEffect(() => { setScore(''); setNotes(''); }, [id]);
  if (!id) return null;
  const save = async () => { setBusy(true); try { await api.post(`/api/v1/assessments/${id}/score`, { score: Number(score), notes: notes || null }); toast.success('Assessment scored'); st.reload(); onChanged?.(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return <Drawer open onClose={onClose} wide title={a ? `${a.template_name} — ${a.candidate_name}` : 'Assessment'} footer={a?.status === 'completed' ? <><Field label="Score (0–100)" htmlFor="as-score"><input id="as-score" className="input" type="number" min={0} max={100} value={score} onChange={e => setScore(e.target.value)} style={{ width: 110 }} /></Field><Button variant="primary" loading={busy} disabled={score === '' || Number(score) < 0 || Number(score) > 100} onClick={save}>Save score</Button></> : a && ['sent', 'started'].includes(a.status) ? <Button onClick={async () => { try { await api.post(`/api/v1/assessments/${id}/remind`); toast.success('Reminder emailed'); } catch (e) { toast.error(e); } }}>Send reminder</Button> : undefined}>
    {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !a ? <LoadingBlock /> : <div className="stack" style={{ gap: 14 }}>
      <div className="rec-steps">{['sent', 'started', 'completed', 'scored'].map((s, k, arr) => <div key={s} className={`rec-step ${a.status === s ? 'on' : arr.indexOf(a.status) > k ? 'done' : ''}`}><i />{humanize(s)}</div>)}</div>
      <KV items={[['Candidate', <Link to={`/recruiting/candidates/${a.candidate_id}`}>{a.candidate_name}</Link>], ['Position', a.position_title], ['Sent', `${dateTime(a.sent_at)} by ${a.sent_by_name ?? '—'}`], ['Started', dateTime(a.started_at)], ['Completed', dateTime(a.completed_at)], ['Score', a.score !== null && a.score !== undefined ? `${a.score}/100 (${a.scored_by_name ?? ''})` : null], ['Scorer notes', a.scorer_notes]]} />
      {a.instructions && <div className="small muted">{a.instructions}</div>}
      {(a.questions ?? []).map((q: any, i: number) => <div key={i}><div className="small bold">Q{i + 1}. {q.q}</div><div className="small mt-1" style={{ whiteSpace: 'pre-wrap' }}>{a.answers?.[String(i)] || <span className="muted">No answer yet</span>}</div></div>)}
      {a.file_url && <div><a className="btn btn-sm" href={a.file_url} target="_blank" rel="noreferrer"><Download size={14} /> {a.file_name ?? 'Attached file'}</a></div>}
      {a.status === 'completed' && <Field label="Scorer notes" htmlFor="as-notes"><textarea id="as-notes" className="textarea" value={notes} onChange={e => setNotes(e.target.value)} /></Field>}
    </div>}
  </Drawer>;
}

/** Tiny hook to auto-open a drawer from ?param=<id>. */
export function useQueryId(sp: URLSearchParams, setSp: (n: URLSearchParams, o?: any) => void, key: string): [string | null, (id: string | null) => void] {
  const v = sp.get(key);
  return [v, (id) => { const n = new URLSearchParams(sp); if (id) n.set(key, id); else n.delete(key); setSp(n, { replace: true }); }];
}
export function useScrollIntoView<T extends HTMLElement>(on: boolean) { const r = useRef<T>(null); useEffect(() => { if (on) r.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [on]); return r; }
export { AlertTriangle, TagInput, MoneyInput };

/** URL-only filters (from KPI/funnel links) passed to DataTable `params`, with removable chips. */
const HIDDEN_LABELS: Record<string, (v: string) => string> = {
  from: v => `From ${fmtDate(v)}`, to: v => `To ${fmtDate(v)}`, stage: v => `Reached: ${humanize(v)}`, needs_review: () => 'Needs review', exclude_status: v => `Excluding ${v.split(',').map(humanize).join(', ')}`,
  stale: () => 'Waiting > 48h', mine: () => 'My positions', mine_positions: () => 'My positions', recruiter_id: v => (v === 'me' ? 'Sourced by me' : 'Sourced by recruiter'), position_id: () => 'One position', candidate_id: () => 'One candidate',
  keywords: v => `Keywords: ${v}`, max_rate: v => `Rate ≤ ${money(Number(v))}`, min_years: v => `${v}+ years`, bilingual: () => 'Bilingual', available: () => 'Available now', software: v => `Software: ${v}`, languages: v => `Languages: ${v}`, tag: v => `Tag: ${v}`,
  company_id: () => 'One client', needs_placement: () => 'Accepted, no placement yet', decision: v => `Client decision: ${humanize(v)}`, submitted_by: v => (v === 'me' ? 'Submitted by me' : 'Submitted by recruiter'), interviewer: v => (v === 'me' ? 'I am interviewing' : 'Interviewer'), sent_by: v => (v === 'me' ? 'Sent by me' : 'Sent by'), via_link: () => 'Via sourcing link',
};
export function useHiddenParams(sp: URLSearchParams, setSp: (n: URLSearchParams, o?: any) => void, keys: string[]) {
  const params: Record<string, string> = {};
  for (const k of keys) { const v = sp.get(k); if (v) params[k] = v; }
  const clear = (k: string) => { const n = new URLSearchParams(sp); n.delete(k); n.delete('page'); setSp(n, { replace: true }); };
  const chips = Object.keys(params).length ? <div className="rec-chips" style={{ padding: '0 16px 12px' }}>{Object.entries(params).map(([k, v]) => <span key={k} className="chip">{(HIDDEN_LABELS[k] ?? ((x: string) => `${humanize(k)}: ${x}`))(v)}<button type="button" aria-label={`Remove filter ${k}`} onClick={() => clear(k)}><XCircle size={12} /></button></span>)}</div> : null;
  return { params, chips };
}
