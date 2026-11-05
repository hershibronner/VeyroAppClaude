import { useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Sparkles, Mail, Phone, MapPin, User, Upload, Video, FileText, Link2, Pencil, Send, CalendarPlus, ClipboardList, BadgeDollarSign, ExternalLink, Download, Copy, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { money, date, dateTime, relTime, humanize, shortDate } from '../../lib/format';
import { Avatar, Banner, Boundary, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, KV, LoadingBlock, Menu, PageHeader, StatusPill, Tabs, TagInput, EntitySelect } from '../../components/ui';
import { Timeline } from '../../components/Timeline';
import { AiError, AssessmentDialog, AssessmentDrawer, CandidateForm, Chips, InterviewDrawer, OfferDialog, OfferDrawer, ScheduleInterviewDialog, StatusDialog, SubmitDialog, candName, rateRange, errMsg } from './shared';

type Tab = 'profile' | 'applications' | 'submissions' | 'interviews' | 'assessments' | 'offers' | 'documents' | 'activity';
const NEXT_PRIMARY: Record<string, string> = { new_applicant: 'screening', screening: 'recruiter_review', assessment: 'recruiter_review', recruiter_review: 'qualified', interview: 'qualified', qualified: 'talent_pool', on_hold: 'screening', future: 'screening', rejected: 'screening', withdrawn: 'screening' };

export default function CandidateDetail() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'profile';
  const setTab = (t: Tab) => { const n = new URLSearchParams(sp); if (t === 'profile') n.delete('tab'); else n.set('tab', t); setSp(n, { replace: true }); };
  const st = useApi<any>(`/api/v1/candidates/${id}`, [id]);
  const { can } = useAuth();
  const [statusTo, setStatusTo] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [dlg, setDlg] = useState<null | 'interview' | 'submit' | 'offer' | 'assessment' | 'position'>(null);
  const [drawer, setDrawer] = useState<{ kind: 'interview' | 'offer' | 'assessment'; id: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [aiErr, setAiErr] = useState<unknown>(null);
  const [draft, setDraft] = useState<{ kind: string; busy?: boolean; text?: string; subject?: string; err?: unknown } | null>(null);
  const resumeIn = useRef<HTMLInputElement>(null); const videoIn = useRef<HTMLInputElement>(null); const portIn = useRef<HTMLInputElement>(null);
  const c = st.data;
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!c) return <LoadingBlock rows={8} />;
  const allowed: string[] = (c.allowed_status ?? []).filter((s: string) => s !== 'blacklisted' || c.can_blacklist);
  const primary = NEXT_PRIMARY[c.status] && allowed.includes(NEXT_PRIMARY[c.status]) ? NEXT_PRIMARY[c.status] : null;
  const canSubmit = ['qualified', 'talent_pool', 'submitted'].includes(c.status);
  const go = (s: string) => { if (s === 'interview') { setDlg('interview'); return; } if (s === 'submitted') { setDlg('submit'); return; } setStatusTo(s); };
  const upload = async (kind: string, f: File | undefined) => {
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try { const r = await api.upload(`/api/v1/candidates/${c.id}/media/${kind}`, fd); toast.success(`${kind === 'resume' ? 'Resume' : kind === 'video' ? 'Intro video' : 'Portfolio'} uploaded${r.note ? ' — ' + r.note : ''}`); st.reload(); } catch (e) { toast.error(e); }
  };
  const analyze = async () => { setAnalyzing(true); setAiErr(null); try { await api.post(`/api/v1/candidates/${c.id}/analyze-resume`); st.reload(); toast.success('Resume analyzed — review the extracted fields'); } catch (e) { setAiErr(e); } finally { setAnalyzing(false); } };
  const runDraft = async (kind: string) => { setDraft({ kind, busy: true }); try { const r = await api.post('/api/v1/ai/draft', { kind, candidate_id: c.id, position_id: c.submissions[0]?.position_id ?? c.applications.find((a: any) => a.position_id)?.position_id }); setDraft({ kind, text: r.body, subject: r.subject }); } catch (e) { setDraft({ kind, err: e }); } };
  const editable = c.can_edit;
  const pending = c.extraction?.status === 'pending_review' ? c.extraction : null;
  return (
    <div>
      <PageHeader back="/recruiting/candidates" title={<span className="row" style={{ gap: 12, flexWrap: 'wrap' }}><Avatar name={c.name} color={c.avatar_color} size={44} />{c.name} <StatusPill status={c.status} />{c.worker && <Link to={`/workforce/workers/${c.worker.id}`} className="pill pill-green">Worker · {humanize(c.worker.status)}</Link>}</span>}
        sub={<span className="detail-meta">
          {c.headline && <span>{c.headline}</span>}
          {c.email && <span><Mail size={14} /> <a href={`mailto:${c.email}`}>{c.email}</a></span>}
          {c.phone && <span><Phone size={14} /> {c.phone}</span>}
          {(c.city || c.country) && <span><MapPin size={14} /> {[c.city, c.country].filter(Boolean).join(', ')}</span>}
          <span><User size={14} /> {c.sourced_by_name ? `Sourced by ${c.sourced_by_name}` : 'No recruiter attribution'} · {c.source ?? '—'}</span>
        </span>}
        actions={<>
          {editable && canSubmit && <Button icon={<Send size={16} />} onClick={() => setDlg('submit')}>Submit to client</Button>}
          {editable && primary && <Button variant="primary" onClick={() => go(primary)}>Move to {humanize(primary)}</Button>}
          {editable && !primary && !canSubmit && <Button variant="primary" icon={<CalendarPlus size={16} />} onClick={() => setDlg('interview')}>Schedule interview</Button>}
          <Menu items={[
            { label: 'Analyze Resume', icon: <Sparkles size={15} />, onClick: analyze, disabled: !editable || (!c.resume_text && !c.resume_file) },
            { label: 'Draft candidate summary', icon: <Sparkles size={15} />, onClick: () => runDraft('candidate_summary') },
            { label: 'Draft outreach email', icon: <Mail size={15} />, onClick: () => runDraft('outreach_email') },
            { label: 'Draft interview questions', icon: <ClipboardList size={15} />, onClick: () => runDraft('interview_questions') },
            { sep: true },
            { label: 'Edit profile', icon: <Pencil size={15} />, onClick: () => setEdit(true), hidden: !editable },
            { label: 'Schedule interview', icon: <CalendarPlus size={15} />, onClick: () => setDlg('interview'), hidden: !editable || (!primary && !canSubmit) },
            { label: 'Send assessment', icon: <ClipboardList size={15} />, onClick: () => setDlg('assessment'), hidden: !editable || !can('assessments', 'create') },
            { label: 'Add to a position', icon: <Link2 size={15} />, onClick: () => setDlg('position'), hidden: !can('candidates', 'create') },
            { label: 'Create offer', icon: <BadgeDollarSign size={15} />, onClick: () => setDlg('offer'), hidden: !editable || !can('offers', 'create') || !c.submissions.length },
            { label: 'Upload resume', icon: <Upload size={15} />, onClick: () => resumeIn.current?.click(), hidden: !editable },
            { label: 'Upload intro video', icon: <Video size={15} />, onClick: () => videoIn.current?.click(), hidden: !editable },
            { label: 'Upload portfolio file', icon: <FileText size={15} />, onClick: () => portIn.current?.click(), hidden: !editable },
            { sep: true, hidden: !editable },
            ...allowed.filter(s => s !== primary).map(s => ({ label: `Move to ${humanize(s)}`, onClick: () => go(s), hidden: !editable, danger: ['rejected', 'blacklisted'].includes(s) })),
          ]} />
        </>} />
      <input ref={resumeIn} type="file" hidden accept=".pdf,.txt,.doc,.docx,.md" onChange={e => { upload('resume', e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={videoIn} type="file" hidden accept="video/*" onChange={e => { upload('video', e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={portIn} type="file" hidden onChange={e => { upload('portfolio', e.target.files?.[0]); e.target.value = ''; }} />
      {!editable && <Banner>You can view this candidate. Editing is limited to candidates you sourced or who are in positions you are assigned to.</Banner>}
      {c.status_reason && ['rejected', 'blacklisted', 'on_hold', 'withdrawn'].includes(c.status) && <Banner tone={c.status === 'blacklisted' ? 'danger' : 'warn'}><b>{humanize(c.status)}:</b> {c.status_reason}</Banner>}
      {c.offers.some((o: any) => o.status === 'accepted' && !o.placement_id) && <Banner tone="success"><CheckCircle2 size={16} /> Offer accepted. <Link to={`/workforce/placements/new?offerId=${c.offers.find((o: any) => o.status === 'accepted' && !o.placement_id).id}`}>Create the placement</Link> — {c.first_name} becomes a worker as the same person.</Banner>}
      <AiError error={aiErr} retry={analyze} />
      {analyzing && <Card pad className="mb-3"><span className="spinner" /> Analyzing resume…</Card>}
      {pending && editable && <Boundary label="Resume analysis"><ExtractionReview c={c} ex={pending} onDone={st.reload} /></Boundary>}
      {draft && <Card pad className="mb-3"><div className="row" style={{ justifyContent: 'space-between' }}><div className="card-title-lg"><Sparkles size={16} /> {humanize(draft.kind)} (draft)</div><Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Dismiss</Button></div>
        {draft.busy ? <LoadingBlock rows={3} /> : draft.err ? <AiError error={draft.err} retry={() => runDraft(draft.kind)} /> : <>
          {draft.subject && <div className="small mt-2"><b>Subject:</b> {draft.subject}</div>}
          <textarea className="textarea mt-2" style={{ minHeight: 180 }} value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} aria-label="Draft text" />
          <div className="row mt-2" style={{ gap: 8 }}><Button icon={<Copy size={14} />} onClick={() => { navigator.clipboard?.writeText(`${draft.subject ? draft.subject + '\n\n' : ''}${draft.text}`); toast.success('Copied'); }}>Copy</Button><span className="small muted">Draft only — nothing was sent. Built from facts on this profile.</span></div></>}
      </Card>}

      <div className="rec-media">
        <Card><CardHeader title={<><FileText size={16} /> Resume</>} right={c.resume_url ? <a className="btn btn-sm" href={c.resume_url} target="_blank" rel="noreferrer"><Download size={14} /> {c.resume_file_name ?? 'Download'}</a> : editable ? <Button size="sm" icon={<Upload size={14} />} onClick={() => resumeIn.current?.click()}>Upload</Button> : undefined} />
          <div className="card-b">{c.resume_text ? <div className="rec-resume" aria-label="Resume text">{c.resume_text}</div> : c.resume_url && /\.pdf$/i.test(c.resume_file ?? '') ? <iframe title="Resume PDF" src={c.resume_url} style={{ width: '100%', height: 360, border: '1px solid var(--border)', borderRadius: 10 }} /> : <EmptyState title="No resume yet" text={editable ? 'Upload a PDF, DOCX or TXT.' : undefined} />}</div></Card>
        <div className="stack" style={{ gap: 16 }}>
          <Card><CardHeader title={<><Video size={16} /> Intro video</>} right={editable ? <Button size="sm" icon={<Upload size={14} />} onClick={() => videoIn.current?.click()}>{c.video_url ? 'Replace' : 'Upload'}</Button> : undefined} />
            <div className="card-b">{c.video_url ? <video className="rec-video" src={c.video_url} controls preload="metadata" aria-label={`Intro video from ${c.name}`} /> : <div className="rec-video-empty"><div><Video size={22} /><div className="small mt-1">No intro video yet</div></div></div>}</div></Card>
          <Card><CardHeader title={<><Link2 size={16} /> Portfolio</>} /><div className="card-b small">
            {c.portfolio_url ? <a href={c.portfolio_url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> {c.portfolio_url}</a> : <span className="muted">No portfolio link</span>}
            {c.portfolio_file_url && <div className="mt-1"><a href={c.portfolio_file_url} target="_blank" rel="noreferrer"><Download size={13} /> Portfolio file</a></div>}
          </div></Card>
        </div>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'profile', label: 'Profile' }, { key: 'applications', label: 'Applications', count: c.applications.length }, { key: 'submissions', label: 'Submissions', count: c.submissions.length },
        { key: 'interviews', label: 'Interviews', count: c.interviews.length }, { key: 'assessments', label: 'Assessments', count: c.assessments.length }, { key: 'offers', label: 'Offers', count: c.offers.length },
        { key: 'documents', label: 'Documents', count: c.documents.length + c.media.length }, { key: 'activity', label: 'Activity' },
      ]} />
      <div className="mt-3"><Boundary label="This tab">
        {tab === 'profile' && <ProfileTab c={c} />}
        {tab === 'applications' && <SimpleTable empty="No applications" rows={c.applications} cols={[['Applied', (a: any) => dateTime(a.created_at)], ['Position', (a: any) => a.position_id ? <Link to={`/recruiting/positions/${a.position_id}`}>{a.position_title}</Link> : 'General application'], ['Client', (a: any) => a.company_name ?? '—'], ['Source', (a: any) => `${a.source ?? '—'}${a.link_label ? ` (${a.link_label})` : ''}`], ['Recruiter', (a: any) => a.recruiter_name ?? '—'], ['Status', (a: any) => <StatusPill status={a.status} />], ['', (a: any) => editable && a.status === 'new' ? <Button size="xs" onClick={async () => { try { await api.post(`/api/v1/applications/${a.id}/status`, { status: 'reviewed' }); toast.success('Marked reviewed'); st.reload(); } catch (e) { toast.error(e); } }}>Mark reviewed</Button> : null]]} />}
        {tab === 'submissions' && <SimpleTable empty="Not submitted to any position yet" rows={c.submissions} cols={[['Position', (s: any) => <Link to={`/recruiting/positions/${s.position_id}?tab=pipeline`}>{s.position_title}</Link>], ['Client', (s: any) => s.company_name ?? '—'], ['Stage', (s: any) => <StatusPill status={s.status} />], ['Client decision', (s: any) => s.client_decision ? humanize(s.client_decision) : '—'], ['Client feedback', (s: any) => <span className="small" style={{ whiteSpace: 'pre-wrap' }}>{s.client_feedback ?? '—'}</span>], ['Shared', (s: any) => Object.entries(s.shareable ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'Profile only'], ['Submitted', (s: any) => `${shortDate(s.created_at)} · ${s.submitted_by_name ?? ''}`], ['', (s: any) => <Button size="xs" onClick={(e: any) => { e.stopPropagation(); setPreview(s.id); }}>Client view</Button>]]} />}
        {tab === 'interviews' && <SimpleTable empty="No interviews" rows={c.interviews} onRow={(i: any) => setDrawer({ kind: 'interview', id: i.id })} cols={[['When', (i: any) => dateTime(i.scheduled_at)], ['Type', (i: any) => humanize(i.kind)], ['Position', (i: any) => i.position_title ?? '—'], ['Status', (i: any) => <StatusPill status={i.status} />], ['Outcome', (i: any) => i.outcome ? humanize(i.outcome) : '—'], ['Feedback', (i: any) => (i.feedback ?? []).length ? `${i.feedback.length} · avg ${(i.feedback.reduce((a: number, f: any) => a + (f.overall ?? 0), 0) / i.feedback.length).toFixed(1)}/5` : '—']]} />}
        {tab === 'assessments' && <SimpleTable empty="No assessments" rows={c.assessments} onRow={(a: any) => setDrawer({ kind: 'assessment', id: a.id })} cols={[['Assessment', (a: any) => a.template_name], ['Category', (a: any) => a.category ?? '—'], ['Status', (a: any) => <StatusPill status={a.status} />], ['Score', (a: any) => a.score !== null && a.score !== undefined ? `${a.score}/100` : '—'], ['Sent', (a: any) => shortDate(a.sent_at)], ['Completed', (a: any) => a.completed_at ? shortDate(a.completed_at) : '—']]} />}
        {tab === 'offers' && <SimpleTable empty="No offers" rows={c.offers} onRow={(o: any) => setDrawer({ kind: 'offer', id: o.id })} cols={[['Position', (o: any) => o.position_title ?? '—'], ['Client', (o: any) => o.company_name ?? '—'], ['Status', (o: any) => <StatusPill status={o.status} />], ['Pay rate', (o: any) => o.comp_restricted ? <span className="muted">Restricted</span> : `${money(o.pay_rate_cents, o.currency)}/${o.rate_unit}`], ['Start', (o: any) => date(o.start_date)], ['Signed', (o: any) => o.signed_at ? `${o.signature_name} · ${shortDate(o.signed_at)}` : '—']]} />}
        {tab === 'documents' && <Card><CardHeader title="Documents & uploads" /><div className="card-b">
          {c.documents.length + c.media.length === 0 ? <EmptyState title="No documents" /> : <>
            {c.documents.map((d: any) => <div key={d.id} className="checklist-item"><FileText size={16} /><div style={{ flex: 1 }}><b>{d.name}</b><div className="tiny muted">{humanize(d.category)} · {humanize(d.visibility)} · {shortDate(d.created_at)}{d.signature_status ? ` · ${humanize(d.signature_status)}` : ''}</div></div>{d.file_url && <a className="btn btn-xs" href={d.file_url} target="_blank" rel="noreferrer">Open</a>}</div>)}
            {c.media.map((m: any) => <div key={m.id} className="checklist-item">{m.kind === 'video' ? <Video size={16} /> : m.kind === 'resume' ? <FileText size={16} /> : <Link2 size={16} />}<div style={{ flex: 1 }}><b>{humanize(m.kind)}</b> <span className="small muted">{m.file_name ?? m.url ?? ''}</span><div className="tiny muted">Uploaded {relTime(m.created_at)}</div></div>{(m.file_url || m.url) && <a className="btn btn-xs" href={m.file_url ?? m.url} target="_blank" rel="noreferrer">Open</a>}</div>)}
          </>}</div></Card>}
        {tab === 'activity' && <Card pad><Timeline type="candidate" id={c.id} /></Card>}
      </Boundary></div>

      <StatusDialog candidate={c} to={statusTo} onClose={() => setStatusTo(null)} onDone={st.reload} />
      <CandidateForm open={edit} onClose={() => setEdit(false)} candidate={c} onSaved={() => st.reload()} />
      {dlg === 'interview' && <ScheduleInterviewDialog open onClose={() => setDlg(null)} onDone={() => st.reload()} candidateId={c.id} candidateName={c.name} positionId={c.submissions[0]?.position_id ?? c.applications.find((a: any) => a.position_id)?.position_id ?? null} />}
      {dlg === 'submit' && <SubmitDialog open onClose={() => setDlg(null)} onDone={() => st.reload()} candidate={c} />}
      {dlg === 'offer' && <OfferDialog open onClose={() => setDlg(null)} onDone={() => { st.reload(); setTab('offers'); }} candidate={c} />}
      {dlg === 'assessment' && <AssessmentDialog open onClose={() => setDlg(null)} onDone={() => { st.reload(); setTab('assessments'); }} candidate={c} positionId={c.applications.find((a: any) => a.position_id)?.position_id ?? null} />}
      {dlg === 'position' && <AddToPosition c={c} onClose={() => setDlg(null)} onDone={st.reload} />}
      {preview && <ClientPreview id={preview} onClose={() => setPreview(null)} />}
      {drawer?.kind === 'interview' && <InterviewDrawer id={drawer.id} onClose={() => setDrawer(null)} onChanged={st.reload} />}
      {drawer?.kind === 'offer' && <OfferDrawer id={drawer.id} onClose={() => setDrawer(null)} onChanged={st.reload} />}
      {drawer?.kind === 'assessment' && <AssessmentDrawer id={drawer.id} onClose={() => setDrawer(null)} onChanged={st.reload} />}
    </div>
  );
}

function ProfileTab({ c }: { c: any }) {
  return <div className="grid-2">
    <Card><CardHeader title="Professional" /><div className="card-b stack" style={{ gap: 14 }}>
      <KV items={[['Headline', c.headline], ['Experience', c.years_experience !== null && c.years_experience !== undefined ? `${c.years_experience} years` : null], ['Timezone', c.timezone], ['Tags', (c.tags ?? []).join(', ')]]} />
      <div><div className="small muted mb-2">Skills</div><Chips items={c.skills} /></div><div><div className="small muted mb-2">Software</div><Chips items={c.software} /></div><div><div className="small muted mb-2">Languages</div><Chips items={c.languages} /></div>
      <div><div className="small muted mb-2">Experience</div>{(c.experience ?? []).length ? c.experience.map((e: any, i: number) => <div key={i} className="small" style={{ padding: '3px 0' }}><b>{e.title}</b>{e.company ? ` — ${e.company}` : ''} <span className="muted">{[e.start, e.end].filter(Boolean).join('–')}</span></div>) : <span className="muted small">—</span>}</div>
      <div><div className="small muted mb-2">Education (with source evidence)</div>{(c.education ?? []).length ? c.education.map((e: any, i: number) => <div key={i} className="small" style={{ padding: '3px 0' }}><b>{e.degree}</b>{e.school ? ` — ${e.school}` : ''}{e.year ? `, ${e.year}` : ''}{e.evidence && <div className="rec-snippet">“{e.evidence}”</div>}</div>) : <span className="muted small">—</span>}</div>
    </div></Card>
    <div className="stack" style={{ gap: 20 }}>
      <Card><CardHeader title="Availability & rate expectation" sub="Expectation is not the pay rate. Never shown to clients unless shared on a submission." /><div className="card-b"><KV items={[
        ['Availability', humanize(c.availability_status)], ['Earliest start', date(c.earliest_start)], ['Weekly hours', c.weekly_hours], ['Preferred hours', c.preferred_hours],
        ['Minimum acceptable', c.rate_min_cents !== null && c.rate_min_cents !== undefined ? `${money(c.rate_min_cents, c.rate_currency)} / ${c.rate_unit}` : null], ['Comfortable target', c.rate_target_cents !== null && c.rate_target_cents !== undefined ? `${money(c.rate_target_cents, c.rate_currency)} / ${c.rate_unit}` : null], ['Note', c.rate_note],
      ]} /></div></Card>
      <Card><CardHeader title="Attribution" /><div className="card-b"><KV items={[['Source', c.source], ['Sourced by', c.sourced_by_name], ['Created', `${dateTime(c.created_at)}${c.created_by_name ? ` by ${c.created_by_name}` : ''}`], ['Last updated', relTime(c.updated_at)], ['Portal account', c.user_id ? 'Yes' : 'Not yet']]} /></div></Card>
      {c.extraction && c.extraction.status !== 'pending_review' && <Card><CardHeader title="Last resume analysis" /><div className="card-b small">{humanize(c.extraction.status)} {c.extraction.accepted_by_name ? `by ${c.extraction.accepted_by_name}` : ''} · {relTime(c.extraction.accepted_at ?? c.extraction.created_at)} · model {c.extraction.model}</div></Card>}
    </div>
  </div>;
}

function SimpleTable({ rows, cols, empty, onRow }: { rows: any[]; cols: [string, (r: any) => any][]; empty: string; onRow?: (r: any) => void }) {
  if (!rows.length) return <Card><EmptyState title={empty} /></Card>;
  return <Card><div className="table-wrap"><table className="table"><thead><tr>{cols.map(([h], i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.id} className={onRow ? 'clickable' : ''} onClick={() => onRow?.(r)}>{cols.map(([, f], i) => <td key={i}>{f(r) ?? '—'}</td>)}</tr>)}</tbody></table></div></Card>;
}

const SCALARS = ['first_name', 'last_name', 'email', 'phone', 'headline', 'city', 'country', 'years_experience'] as const;
const LISTS = ['skills', 'software', 'languages'] as const;
function ExtractionReview({ c, ex, onDone }: { c: any; ex: any; onDone: () => void }) {
  const f = ex.data.fields;
  const initial = useMemo(() => {
    const v: Record<string, any> = {}; const on: Record<string, boolean> = {};
    for (const k of [...SCALARS, ...LISTS, 'education', 'experience'] as string[]) {
      const val = f[k]?.value; if (val === null || val === undefined || (Array.isArray(val) && !val.length)) continue;
      v[k] = val; on[k] = JSON.stringify(val) !== JSON.stringify(c[k]) && !(Array.isArray(c[k]) ? c[k].length && !f[k].uncertain && JSON.stringify([...c[k]].sort()) === JSON.stringify([...val].sort()) : false);
    }
    return { v, on };
  }, [ex.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [vals, setVals] = useState<Record<string, any>>(initial.v);
  const [on, setOn] = useState<Record<string, boolean>>(initial.on);
  const [busy, setBusy] = useState(false);
  const keys = Object.keys(initial.v);
  const accept = async () => {
    setBusy(true);
    try {
      const fields: Record<string, any> = {};
      for (const k of keys) if (on[k]) fields[k] = k === 'years_experience' ? (vals[k] === '' || vals[k] === null ? null : Number(vals[k])) : vals[k];
      await api.post(`/api/v1/resume-extractions/${ex.id}/accept`, { fields }); toast.success('Accepted fields saved to the profile'); onDone();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const discard = async () => { try { await api.post(`/api/v1/resume-extractions/${ex.id}/discard`); toast.success('Analysis discarded'); onDone(); } catch (e) { toast.error(e); } };
  return <Card className="mb-3"><CardHeader title={<><Sparkles size={16} /> Analyze Resume — review extracted fields</>} sub={`Model ${ex.model} · ${relTime(ex.created_at)}. Only text found in the resume is extracted; each field shows its source snippet. Tick what to keep, edit if needed.`} right={<div className="row" style={{ gap: 8 }}><Button onClick={discard}>Discard</Button><Button variant="primary" loading={busy} disabled={!keys.some(k => on[k])} onClick={accept}>Accept selected ({keys.filter(k => on[k]).length})</Button></div>} />
    <div className="card-b">
      {ex.data.warnings?.length > 0 && <Banner tone="warn"><AlertTriangle size={14} /> {ex.data.warnings.join(' ')}</Banner>}
      {keys.length === 0 && <EmptyState title="Nothing could be extracted" text="Fill the fields manually." />}
      {keys.map(k => <div key={k} className="rec-extract">
        <input type="checkbox" aria-label={`Accept ${humanize(k)}`} checked={!!on[k]} onChange={e => setOn({ ...on, [k]: e.target.checked })} />
        <div><b className="small">{humanize(k)}</b>{f[k].uncertain && <div className="rec-uncertain">Uncertain — check</div>}<div className="tiny muted">Current: {Array.isArray(c[k]) ? (k === 'education' || k === 'experience' ? `${c[k].length} entries` : c[k].join(', ') || '—') : c[k] ?? '—'}</div></div>
        <div style={{ minWidth: 0 }}>
          {(SCALARS as readonly string[]).includes(k) ? <input className="input input-sm" aria-label={humanize(k)} value={vals[k] ?? ''} onChange={e => setVals({ ...vals, [k]: e.target.value })} /> :
            (LISTS as readonly string[]).includes(k) ? <TagInput value={vals[k] ?? []} onChange={v => setVals({ ...vals, [k]: v })} /> :
              <div className="small">{(vals[k] as any[]).map((e, i) => <div key={i}>{k === 'education' ? `${e.degree}${e.school ? ' — ' + e.school : ''}${e.year ? ', ' + e.year : ''}` : `${e.title}${e.company ? ' — ' + e.company : ''} ${[e.start, e.end].filter(Boolean).join('–')}`}</div>)}</div>}
          {f[k].snippet && <div className="rec-snippet">Source: “{String(f[k].snippet).slice(0, 300)}”</div>}
          {f[k].note && <div className="tiny muted mt-1">{f[k].note}</div>}
        </div>
      </div>)}
    </div></Card>;
}

function ClientPreview({ id, onClose }: { id: string; onClose: () => void }) {
  const st = useApi<any>(`/api/v1/submissions/${id}`, [id]);
  const p = st.data?.client_profile;
  return <Dialog open onClose={onClose} wide title="What the client sees">
    {st.error ? <ErrorState error={st.error} /> : !p ? <LoadingBlock /> : <div className="stack" style={{ gap: 12 }}>
      <Banner>Client-safe profile for <b>{st.data.position_title}</b>. Contact details, private notes and rate are hidden unless marked shareable on the submission.</Banner>
      <KV items={[['Name shown', p.name], ['Headline', p.headline], ['Location', [p.city, p.country].filter(Boolean).join(', ')], ['Experience', p.years_experience !== null && p.years_experience !== undefined ? `${p.years_experience} years` : null], ['Email', p.email ?? <span className="muted">Hidden</span>], ['Phone', p.phone ?? <span className="muted">Hidden</span>], ['Rate expectation', p.rate_target_cents ? `${money(p.rate_target_cents, p.rate_currency)} / ${p.rate_unit}` : <span className="muted">Hidden</span>], ['Intro video', p.video_url ? 'Included' : 'None']]} />
      <div><div className="small muted mb-2">Skills</div><Chips items={p.skills} /></div>
      {p.presentation && <div className="small" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-2)', padding: 12, borderRadius: 10 }}>{p.presentation}</div>}
    </div>}
  </Dialog>;
}

function AddToPosition({ c, onClose, onDone }: { c: any; onClose: () => void; onDone: () => void }) {
  const [pos, setPos] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  return <Dialog open onClose={onClose} title={`Add ${candName(c)} to a position`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!pos} loading={busy} onClick={async () => { setBusy(true); try { await api.post('/api/v1/applications', { candidate_id: c.id, position_id: pos }); toast.success('Added — shows as an application on the position'); onDone(); onClose(); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); } }}>Add</Button></>}>
    <Field label="Position" htmlFor="ap-pos"><EntitySelect id="ap-pos" endpoint="/api/v1/positions?status=open,on_hold,draft" value={pos} onChange={setPos} labelOf={r => r.title + (r.company_name ? ` — ${r.company_name}` : '')} /></Field>
    <div className="small muted mt-2">This records interest in the position. Use “Submit to client” once the candidate is qualified.</div>
  </Dialog>;
}
void rateRange;
