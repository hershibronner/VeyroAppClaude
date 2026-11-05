// Client portal: Candidates to review (client-safe profiles, video, compare, approve/reject/request interview) and Interviews.
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, XCircle, CalendarPlus, GitCompare, Video, CalendarClock, MessageSquare, Lock } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { money, date, dateTime, relTime, humanize } from '../../lib/format';
import { Avatar, BackButton, Banner, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, KV, LoadingBlock, PageHeader, Segmented, StatusPill, useConfirm } from '../../components/ui';
import { Chips, tzOpts, zonedIso } from './shared';
import './recruiting.css';

const STAGE_LABEL: Record<string, string> = { submitted: 'New', client_review: 'In review', client_interview: 'Interviewing', offer: 'Offer', hired: 'Hired', rejected: 'Declined' };

export function ClientCandidates() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') ?? 'to_review';
  const pos = sp.get('position') ?? '';
  const st = useApi<any>(`/api/v1/portal/client/candidates?status=${view === 'all' ? '' : view === 'interviewing' ? 'client_interview' : view === 'decided' ? 'offer,hired,rejected' : 'to_review'}${pos ? `&position_id=${pos}` : ''}`, [view, pos]);
  const [cmp, setCmp] = useState<string[]>([]);
  const [showCmp, setShowCmp] = useState(false);
  const cmpSt = useApi<any[]>(showCmp && cmp.length >= 2 ? `/api/v1/portal/client/candidates/compare?ids=${cmp.join(',')}` : null, [showCmp, cmp.join(',')]);
  const setQ = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const d = st.data;
  return <div>
    <PageHeader title="Candidates" sub="Profiles your recruiter shared with you. Contact details and rates stay private unless the recruiter shares them."
      actions={cmp.length >= 2 && <Button variant="primary" icon={<GitCompare size={16} />} onClick={() => setShowCmp(true)}>Compare {cmp.length}</Button>} />
    {d && <div className="kpi-tiles">
      <button className="kpi-tile" onClick={() => setQ('view', 'to_review')}><div className="kpi-label">To review</div><div className="kpi-value">{d.counts.to_review}</div></button>
      <button className="kpi-tile" onClick={() => setQ('view', 'interviewing')}><div className="kpi-label">Interviewing</div><div className="kpi-value">{d.counts.interviewing}</div></button>
      <button className="kpi-tile" onClick={() => setQ('view', 'decided')}><div className="kpi-label">Offers & hires</div><div className="kpi-value">{d.counts.offers}</div></button>
      <button className="kpi-tile" onClick={() => setQ('view', 'all')}><div className="kpi-label">All candidates</div><div className="kpi-value">{d.counts.total}</div></button>
    </div>}
    <div className="row mb-3" style={{ gap: 10, flexWrap: 'wrap' }}>
      <Segmented value={view} onChange={v => setQ('view', v)} options={[{ key: 'to_review', label: 'To review' }, { key: 'interviewing', label: 'Interviewing' }, { key: 'decided', label: 'Offers & hires' }, { key: 'all', label: 'All' }]} />
      {d?.positions.length > 0 && <select className="select input-sm" style={{ width: 'auto' }} aria-label="Position" value={pos} onChange={e => setQ('position', e.target.value)}><option value="">All positions</option>{d.positions.map((p: any) => <option key={p.id} value={p.id}>{p.title} ({p.n})</option>)}</select>}
    </div>
    {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <LoadingBlock /> : d.rows.length === 0 ? <EmptyState title={view === 'to_review' ? 'Nothing waiting for you' : 'No candidates here'} text={view === 'to_review' ? 'New profiles appear here as soon as your recruiter submits them — you will also get a notification.' : undefined} /> :
      <div className="grid-2">{d.rows.map((r: any) => <Card key={r.id} pad><div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <Avatar name={r.profile.name} color={r.profile.avatar_color} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}><div className="row" style={{ justifyContent: 'space-between' }}><Link to={r.id} className="bold">{r.profile.name}</Link><StatusPill status={r.status} label={STAGE_LABEL[r.status] ?? humanize(r.status)} /></div>
          <div className="small muted">{r.profile.headline} · {r.profile.country ?? '—'}{r.profile.years_experience ? ` · ${r.profile.years_experience} yrs` : ''}</div>
          <div className="small mt-1">For <b>{r.position_title}</b> · shared {relTime(r.created_at)}</div>
          <div className="mt-1"><Chips items={(r.profile.skills ?? []).slice(0, 4)} /></div>
          {r.next_interview && <div className="small mt-1"><CalendarClock size={13} /> Interview {dateTime(r.next_interview)}</div>}
          {r.profile.video_url && <div className="small mt-1"><Video size={13} /> Intro video available</div>}
          <div className="row mt-2" style={{ gap: 8 }}><Button size="sm" variant="primary" onClick={() => nav(r.id)}>Review profile</Button><label className="check small"><input type="checkbox" checked={cmp.includes(r.id)} disabled={!cmp.includes(r.id) && cmp.length >= 4} onChange={e => setCmp(c => e.target.checked ? [...c, r.id] : c.filter(x => x !== r.id))} /> Compare</label></div>
        </div></div></Card>)}</div>}
    <Dialog open={showCmp} onClose={() => setShowCmp(false)} wide title="Compare candidates">
      {cmpSt.error ? <ErrorState error={cmpSt.error} /> : !cmpSt.data ? <LoadingBlock /> : <div className="rec-compare">{cmpSt.data.map(r => <div key={r.id} className="card"><div className="row" style={{ gap: 10 }}><Avatar name={r.profile.name} color={r.profile.avatar_color} size={36} /><div><Link to={r.id} className="bold" onClick={() => setShowCmp(false)}>{r.profile.name}</Link><div className="small muted">{r.position_title}</div></div></div>
        <dl><dt>Headline</dt><dd>{r.profile.headline ?? '—'}</dd><dt>Location</dt><dd>{r.profile.country ?? '—'} · {r.profile.timezone ?? '—'}</dd><dt>Experience</dt><dd>{r.profile.years_experience ?? '—'} years</dd><dt>Skills</dt><dd><Chips items={r.profile.skills} /></dd><dt>Software</dt><dd><Chips items={r.profile.software} /></dd><dt>Languages</dt><dd>{(r.profile.languages ?? []).join(', ') || '—'}</dd><dt>Availability</dt><dd>{humanize(r.profile.availability_status)}{r.profile.earliest_start ? ` · from ${date(r.profile.earliest_start)}` : ''}</dd><dt>Intro video</dt><dd>{r.profile.video_url ? <video src={r.profile.video_url} controls preload="none" style={{ width: '100%', borderRadius: 8 }} /> : '—'}</dd></dl></div>)}</div>}
    </Dialog>
  </div>;
}

export function ClientCandidate() {
  const { id } = useParams();
  const st = useApi<any>(`/api/v1/portal/client/candidates/${id}`, [id]);
  const confirm = useConfirm();
  const [iv, setIv] = useState<any>(null);
  const [fb, setFb] = useState('');
  const [busy, setBusy] = useState(false);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  const r = st.data;
  if (!r) return <LoadingBlock rows={8} />;
  const p = r.profile;
  const decide = async (decision: string, extra: any = {}) => { setBusy(true); try { await api.post(`/api/v1/portal/client/candidates/${r.id}/decision`, { decision, ...extra }); toast.success(decision === 'interview' ? 'Interview requested — your recruiter will confirm the time' : decision === 'approve' ? 'Approved — your recruiter was notified' : 'Declined — thanks for the feedback'); st.reload(); setIv(null); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  const closed = ['hired', 'rejected'].includes(r.status);
  const pendingIv = r.interviews.find((i: any) => ['requested', 'scheduled'].includes(i.status) && new Date(i.scheduled_at) > new Date());
  return <div>
    <BackButton fallback="/portal/client/candidates" />
    <PageHeader title={<span className="row" style={{ gap: 12 }}><Avatar name={p.name} color={p.avatar_color} size={44} />{p.name} <StatusPill status={r.status} label={STAGE_LABEL[r.status] ?? humanize(r.status)} /></span>} sub={`${p.headline ?? ''} · for ${r.position_title}`}
      actions={r.can_decide && !closed && <>
        <Button variant="danger" icon={<XCircle size={16} />} disabled={busy} onClick={async () => { const c = await confirm({ title: `Decline ${p.first_name}?`, reason: { label: 'Short reason for your recruiter', required: true }, danger: true, confirmLabel: 'Decline' }); if (c.ok) decide('reject', { feedback: c.reason }); }}>Decline</Button>
        <Button icon={<CheckCircle2 size={16} />} disabled={busy || r.client_decision === 'approve'} onClick={() => decide('approve')}>{r.client_decision === 'approve' ? 'Approved' : 'Approve'}</Button>
        <Button variant="primary" icon={<CalendarPlus size={16} />} disabled={busy || !!pendingIv} onClick={() => { const d = new Date(Date.now() + 2 * 86400000); d.setHours(10, 0, 0, 0); setIv({ when: `${d.toISOString().slice(0, 10)}T10:00`, timezone: 'America/New_York', duration_min: 45, note: '' }); }}>{pendingIv ? 'Interview requested' : 'Request interview'}</Button>
      </>} />
    {!r.can_decide && <Banner><Lock size={14} /> Your role can view candidates. Ask your account owner to approve, decline or request interviews.</Banner>}
    {pendingIv && <Banner tone={pendingIv.status === 'requested' ? 'warn' : 'success'}>{pendingIv.status === 'requested' ? `Interview requested for ${dateTime(pendingIv.scheduled_at)} — waiting for the recruiter to confirm.` : <>Interview confirmed for {dateTime(pendingIv.scheduled_at)}. <Link to="/portal/client/interviews">See interviews</Link></>}</Banner>}
    <div className="rec-media">
      <Card><CardHeader title="Profile" /><div className="card-b stack" style={{ gap: 14 }}>
        {r.profile.presentation && <div className="small" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-2)', padding: 12, borderRadius: 10 }}>{r.profile.presentation}</div>}
        <KV items={[['Location', [p.city, p.country].filter(Boolean).join(', ')], ['Timezone', p.timezone], ['Experience', p.years_experience !== null && p.years_experience !== undefined ? `${p.years_experience} years` : null], ['Availability', `${humanize(p.availability_status)}${p.earliest_start ? ` · from ${date(p.earliest_start)}` : ''}`], ['Hours', p.weekly_hours ? `${p.weekly_hours}/week${p.preferred_hours ? ` · ${p.preferred_hours}` : ''}` : p.preferred_hours],
          ...(p.email ? [['Email', p.email] as [string, string]] : []), ...(p.phone ? [['Phone', p.phone] as [string, string]] : []), ...(p.rate_target_cents ? [['Rate expectation', `${money(p.rate_target_cents, p.rate_currency)} / ${p.rate_unit}`] as [string, string]] : []), ['Portfolio', p.portfolio_url ? <a href={p.portfolio_url} target="_blank" rel="noreferrer">{p.portfolio_url}</a> : null]]} />
        <div><div className="small muted mb-2">Skills</div><Chips items={p.skills} /></div><div><div className="small muted mb-2">Software</div><Chips items={p.software} /></div><div><div className="small muted mb-2">Languages</div><Chips items={p.languages} /></div>
        <div><div className="small muted mb-2">Experience</div>{(p.experience ?? []).length ? p.experience.map((e: any, i: number) => <div key={i} className="small">{e.title}{e.company ? ` — ${e.company}` : ''} <span className="muted">{[e.start, e.end].filter(Boolean).join('–')}</span></div>) : '—'}</div>
        <div><div className="small muted mb-2">Education</div>{(p.education ?? []).length ? p.education.map((e: any, i: number) => <div key={i} className="small">{e.degree}{e.school ? ` — ${e.school}` : ''}{e.year ? `, ${e.year}` : ''}</div>) : '—'}</div>
        {!p.shareable.contact && <div className="tiny muted"><Lock size={11} /> Contact details are kept private by your recruiter until you move forward.</div>}
      </div></Card>
      <div className="stack" style={{ gap: 16 }}>
        <Card><CardHeader title={<><Video size={16} /> Intro video</>} /><div className="card-b">{p.video_url ? <video className="rec-video" src={p.video_url} controls preload="metadata" aria-label={`Intro video from ${p.first_name}`} /> : <div className="rec-video-empty"><div className="small">No intro video</div></div>}</div></Card>
        <Card><CardHeader title={<><MessageSquare size={16} /> Feedback for your recruiter</>} /><div className="card-b">
          {r.client_feedback && <div className="small mb-2" style={{ whiteSpace: 'pre-wrap' }}>{r.client_feedback}</div>}
          {!closed && <><textarea className="textarea" aria-label="Feedback" placeholder="What do you like, what's missing?" value={fb} onChange={e => setFb(e.target.value)} /><Button size="sm" className="mt-1" disabled={fb.trim().length < 2} onClick={async () => { try { await api.post(`/api/v1/portal/client/candidates/${r.id}/feedback`, { feedback: fb }); toast.success('Feedback sent'); setFb(''); st.reload(); } catch (e) { toast.error(e); } }}>Send feedback</Button></>}
        </div></Card>
        {r.interviews.length > 0 && <Card><CardHeader title="Interviews" /><div className="card-b">{r.interviews.map((i: any) => <div key={i.id} className="checklist-item"><div style={{ flex: 1 }}>{dateTime(i.scheduled_at)}<div className="tiny muted">{i.timezone}</div></div><StatusPill status={i.status} />{i.meeting_url && <a className="btn btn-xs" href={i.meeting_url} target="_blank" rel="noreferrer">Join</a>}</div>)}</div></Card>}
      </div>
    </div>
    <Dialog open={!!iv} onClose={() => setIv(null)} title={`Request an interview with ${p.first_name}`} footer={<><Button onClick={() => setIv(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!iv?.when} onClick={() => decide('interview', { preferred_time: zonedIso(iv.when, iv.timezone), timezone: iv.timezone, duration_min: Number(iv.duration_min), feedback: iv.note || undefined })}>Send request</Button></>}>
      {iv && <div className="form-grid">
        <Field label="Preferred date & time" htmlFor="ci-w"><input id="ci-w" type="datetime-local" className="input" value={iv.when} onChange={e => setIv({ ...iv, when: e.target.value })} /></Field>
        <Field label="Timezone" htmlFor="ci-tz"><select id="ci-tz" className="select" value={iv.timezone} onChange={e => setIv({ ...iv, timezone: e.target.value })}>{tzOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
        <Field label="Length" htmlFor="ci-d"><select id="ci-d" className="select" value={iv.duration_min} onChange={e => setIv({ ...iv, duration_min: e.target.value })}>{[30, 45, 60].map(n => <option key={n} value={n}>{n} minutes</option>)}</select></Field>
        <Field label="Note for the recruiter (optional)" htmlFor="ci-n" full><textarea id="ci-n" className="textarea" value={iv.note} onChange={e => setIv({ ...iv, note: e.target.value })} placeholder="Other times that work, who will join…" /></Field>
      </div>}
      <div className="small muted">Your recruiter confirms the time, then you and the candidate get the meeting link and a calendar file.</div>
    </Dialog>
  </div>;
}

export function ClientInterviews() {
  const st = useApi<any[]>('/api/v1/portal/client/interviews');
  const confirm = useConfirm();
  const [fb, setFb] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  const now = Date.now();
  const up = st.data.filter(i => ['scheduled', 'requested'].includes(i.status) && new Date(i.scheduled_at).getTime() > now);
  const past = st.data.filter(i => !up.includes(i));
  const save = async () => { setBusy(true); try { await api.post(`/api/v1/portal/client/interviews/${fb.id}/feedback`, { overall: Number(fb.overall), recommendation: fb.recommendation, notes: fb.notes || undefined }); toast.success('Thanks — feedback sent to your recruiter'); setFb(null); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  const row = (i: any) => <div key={i.id} className="checklist-item" style={{ flexWrap: 'wrap' }}>
    <Avatar name={i.candidate_name} color={i.avatar_color} size={34} />
    <div style={{ flex: 1, minWidth: 200 }}><Link to={`/portal/client/candidates/${i.submission_id}`} className="bold">{i.candidate_name}</Link> · {i.position_title}<div className="small">{dateTime(i.scheduled_at)} · {i.duration_min} min <span className="muted">({new Date(i.scheduled_at).toLocaleString('en-US', { timeZone: i.timezone, timeStyle: 'short' })} {i.timezone})</span></div>{i.request_note && <div className="tiny muted">Your note: {i.request_note}</div>}</div>
    <StatusPill status={i.status} label={i.status === 'requested' ? 'Awaiting confirmation' : undefined} />
    {i.meeting_url && <a className="btn btn-sm btn-primary" href={i.meeting_url} target="_blank" rel="noreferrer">Join</a>}
    {i.ics_url && <a className="btn btn-sm" href={i.ics_url} download>Add to calendar</a>}
    {['scheduled', 'requested'].includes(i.status) && new Date(i.scheduled_at).getTime() > now && <Button size="sm" variant="ghost" onClick={async () => { const c = await confirm({ title: 'Ask to change this interview', reason: { label: 'What should change?', required: true }, confirmLabel: 'Send' }); if (c.ok) { try { await api.post(`/api/v1/portal/client/interviews/${i.id}/change-request`, { message: c.reason }); toast.success('Your recruiter was notified'); } catch (e) { toast.error(e); } } }}>Request change</Button>}
    {['scheduled', 'completed'].includes(i.status) && new Date(i.scheduled_at).getTime() <= now + 15 * 60000 && (i.my_feedback?.length ? <span className="small muted">Feedback sent: {i.my_feedback[0].overall}/5</span> : <Button size="sm" variant="primary" onClick={() => setFb({ id: i.id, name: i.candidate_name, overall: 4, recommendation: 'hire', notes: '' })}>Leave feedback</Button>)}
  </div>;
  return <div><PageHeader title="Interviews" sub="Interviews with candidates for your positions." />
    <Card className="mb-3"><CardHeader title="Upcoming" />{up.length === 0 ? <EmptyState icon={<CalendarClock size={22} />} title="No upcoming interviews" text={<>Request one from a <Link to="/portal/client/candidates">candidate profile</Link>.</>} /> : <div className="card-b">{up.map(row)}</div>}</Card>
    <Card><CardHeader title="Past" />{past.length === 0 ? <EmptyState title="No past interviews" /> : <div className="card-b">{past.map(row)}</div>}</Card>
    <Dialog open={!!fb} onClose={() => setFb(null)} title={`Feedback on ${fb?.name ?? ''}`} footer={<><Button onClick={() => setFb(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Send feedback</Button></>}>
      {fb && <div className="form-grid"><Field label="Overall (1–5)" htmlFor="cf-o"><select id="cf-o" className="select" value={fb.overall} onChange={e => setFb({ ...fb, overall: e.target.value })}>{[5, 4, 3, 2, 1].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>
        <Field label="Recommendation" htmlFor="cf-r"><select id="cf-r" className="select" value={fb.recommendation} onChange={e => setFb({ ...fb, recommendation: e.target.value })}><option value="strong_hire">Strong yes</option><option value="hire">Yes</option><option value="maybe">Maybe</option><option value="no_hire">No</option></select></Field>
        <Field label="Notes" htmlFor="cf-n" full><textarea id="cf-n" className="textarea" value={fb.notes} onChange={e => setFb({ ...fb, notes: e.target.value })} /></Field></div>}
    </Dialog>
  </div>;
}
