// Recruiting list pages: Applications, Submissions, Interviews, Assessments (+ template library), Offers.
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarClock, Plus, Video, FileText, Download, Trash2, Link2 } from 'lucide-react';
import { CandidateLinksDialog } from './CandidateLinks';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { money, dateTime, shortDate, relTime, humanize, date } from '../../lib/format';
import { Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, LoadingBlock, PageHeader, Segmented, StatusPill, useConfirm, KpiRow } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { AssessmentDrawer, CandidateCell, InterviewDrawer, OfferDrawer, useHiddenParams, useQueryId, SUBMISSION_STAGES } from './shared';

export function Applications() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [linking, setLinking] = useState(false);
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const hidden = useHiddenParams(sp, setSp, ['from', 'to', 'stale', 'via_link', 'candidate_id', 'mine_positions']);
  const cols: Column<any>[] = [
    { key: 'candidate_name', label: 'Candidate', sortable: true, mobile: 'title', render: r => <CandidateCell r={{ ...r, id: r.candidate_id }} sub={<>{r.email}{r.has_resume && <FileText size={12} style={{ marginLeft: 6 }} aria-label="Resume" />}{r.has_video && <Video size={12} style={{ marginLeft: 4 }} aria-label="Video" />}</>} /> },
    { key: 'position_title', label: 'Position', sortable: true, mobile: 'subtitle', render: r => r.position_id ? <Link to={`/recruiting/positions/${r.position_id}`} onClick={e => e.stopPropagation()}>{r.position_title}</Link> : <span className="muted">General application</span> },
    { key: 'source', label: 'Source', render: r => r.source ?? '—' },
    { key: 'recruiter_name', label: 'Attributed to', sortable: true, render: r => r.recruiter_name ?? <span className="muted">Unattributed</span> },
    { key: 'status', label: 'Application', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'candidate_status', label: 'Candidate', render: r => <StatusPill status={r.candidate_status} /> },
    { key: 'created_at', label: 'Applied', sortable: true, render: r => <span title={dateTime(r.created_at)}>{relTime(r.created_at)}</span>, csv: r => r.created_at },
  ];
  const setStatus = async (r: any, status: string, reload: () => void) => {
    let reason: string | undefined;
    if (status === 'rejected') { const c = await confirm({ title: `Reject ${r.candidate_name}'s application?`, reason: { label: 'Reason', required: true }, danger: true }); if (!c.ok) return; reason = c.reason; }
    try { await api.post(`/api/v1/applications/${r.id}/status`, { status, reason }); toast.success(`Application ${status}`); reload(); } catch (e) { toast.error(e); }
  };
  return <div>
    <PageHeader title="Applications" sub="Every application — public form, recruiter links, position links and manual adds."
      actions={can('candidates', 'create') && <Button variant="primary" icon={<Link2 size={16} />} onClick={() => setLinking(true)}>Generate link</Button>} />
    <CandidateLinksDialog open={linking} onClose={() => setLinking(false)} />
    <DataTable title="All applications" endpoint="/api/v1/applications" columns={cols} exportName="applications" exportResource="candidates" params={hidden.params} headerExtra={hidden.chips}
      filters={[{ key: 'status', label: 'Status', options: opts(['new', 'reviewed', 'advanced', 'rejected']) }, { key: 'recruiter_id', label: 'Recruiter', type: 'member' }, { key: 'source', label: 'Source', options: opts(['Website', 'Recruiter link', 'Position link', 'LinkedIn', 'Job board', 'Added by recruiter']) }]}
      rowLink={r => `/recruiting/candidates/${r.candidate_id}?tab=applications`}
      rowActions={(r, reload) => [{ label: 'Open candidate', onClick: () => nav(`/recruiting/candidates/${r.candidate_id}`) },
        { label: 'Mark reviewed', hidden: r.status !== 'new', onClick: () => setStatus(r, 'reviewed', reload) }, { label: 'Advance to screening', hidden: !['new', 'reviewed'].includes(r.status), onClick: () => setStatus(r, 'advanced', reload) },
        { label: 'Reject', danger: true, hidden: r.status === 'rejected', onClick: () => setStatus(r, 'rejected', reload) }]}
      emptyTitle="No applications yet" emptyText="Share your recruiter link from My Sourced." />
  </div>;
}

export function Submissions() {
  const [sp, setSp] = useSearchParams();
  const hidden = useHiddenParams(sp, setSp, ['from', 'to', 'position_id', 'company_id', 'candidate_id', 'decision', 'mine', 'submitted_by']);
  const cols: Column<any>[] = [
    { key: 'candidate_name', label: 'Candidate', sortable: true, mobile: 'title', render: r => <CandidateCell r={r} /> },
    { key: 'position_title', label: 'Position', sortable: true, mobile: 'subtitle', render: r => <Link to={`/recruiting/positions/${r.position_id}?tab=pipeline`} onClick={e => e.stopPropagation()}>{r.position_title}</Link> },
    { key: 'company_name', label: 'Client', sortable: true },
    { key: 'status', label: 'Stage', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'client_decision', label: 'Client decision', render: r => r.client_decision ? humanize(r.client_decision) : '—' },
    { key: 'next_interview', label: 'Next interview', render: r => r.next_interview ? dateTime(r.next_interview) : '—' },
    { key: 'submitted_by_name', label: 'Submitted by' },
    { key: 'updated_at', label: 'Updated', sortable: true, render: r => relTime(r.updated_at), csv: r => r.updated_at },
  ];
  return <div>
    <PageHeader title="Submissions" sub="Candidate × Position. The same candidate can be in many submissions with different stages." />
    <DataTable title="All submissions" endpoint="/api/v1/submissions" columns={cols} exportName="submissions" exportResource="submissions" params={hidden.params} headerExtra={hidden.chips} defaultSort="updated_at"
      filters={[{ key: 'status', label: 'Stage', options: opts(SUBMISSION_STAGES) }, { key: 'submitted_by', label: 'Submitted by', type: 'member' }]}
      rowLink={r => `/recruiting/positions/${r.position_id}?tab=pipeline`} emptyTitle="No submissions yet" />
  </div>;
}

export function Interviews() {
  const [sp, setSp] = useSearchParams();
  const [openId, setOpenId] = useQueryId(sp, setSp, 'interview');
  const [rk, setRk] = useState(0);
  const hidden = useHiddenParams(sp, setSp, ['from', 'to', 'candidate_id', 'position_id', 'interviewer']);
  const stats = useApi<any>('/api/v1/recruiting/overview', [rk]);
  const cols: Column<any>[] = [
    { key: 'scheduled_at', label: 'When', sortable: true, mobile: 'subtitle', render: r => <div><b>{dateTime(r.scheduled_at)}</b><div className="tiny muted">{new Date(r.scheduled_at).toLocaleString('en-US', { timeZone: r.timezone, hour: 'numeric', minute: '2-digit' })} {r.timezone.split('/').pop()?.replace('_', ' ')} · {r.duration_min} min</div></div>, csv: r => r.scheduled_at },
    { key: 'candidate_name', label: 'Candidate', sortable: true, mobile: 'title', render: r => <CandidateCell r={r} sub={r.position_title ?? 'No position'} /> },
    { key: 'kind', label: 'Type', sortable: true, render: r => <StatusPill status={r.kind === 'client' ? 'client' : 'internal'} label={humanize(r.kind)} /> },
    { key: 'company_name', label: 'Client' },
    { key: 'interviewer_names', label: 'Interviewers', render: r => [r.interviewer_names, r.interviewers].filter(Boolean).join(', ') || '—' },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'feedback_count', label: 'Feedback', align: 'right', render: r => r.feedback_count ? `${r.feedback_count} · ${r.avg_overall}/5` : '—' },
  ];
  return <div>
    <PageHeader title="Interviews" sub="Internal and client interviews with meeting links, .ics files, reminders and scorecards." />
    {stats.data && <KpiRow compact items={[{ label: 'Upcoming', icon: <CalendarClock size={16} />, value: stats.data.kpis.upcoming_interviews, to: '/recruiting/interviews?when=upcoming', deltaText: '', suffix: '' }, { label: 'Client requests to confirm', value: stats.data.banner.requested_interviews, to: '/recruiting/interviews?status=requested', deltaText: '', suffix: '' }, { label: 'Today', value: stats.data.banner.today_interviews, to: '/recruiting/interviews?when=today', deltaText: '', suffix: '' }]} />}
    <DataTable title="Interviews" endpoint="/api/v1/interviews" columns={cols} exportName="interviews" exportResource="interviews" params={hidden.params} headerExtra={hidden.chips} reloadKey={rk} defaultSort="scheduled_at"
      filters={[{ key: 'when', label: 'When', options: opts(['upcoming', 'today', 'past', 'needs_feedback'], { needs_feedback: 'Needs feedback' }) }, { key: 'status', label: 'Status', options: opts(['requested', 'scheduled', 'completed', 'cancelled', 'no_show']) }, { key: 'kind', label: 'Type', options: opts(['internal', 'client']) }, { key: 'interviewer', label: 'Interviewer', type: 'member' }]}
      onRowClick={r => setOpenId(r.id)} rowActions={r => [{ label: 'Open', onClick: () => setOpenId(r.id) }, { label: 'Download .ics', hidden: r.status !== 'scheduled', onClick: () => { window.location.href = `/api/v1/interviews/${r.id}/ics`; } }]}
      emptyTitle="No interviews" emptyText="Schedule one from a candidate profile or the position pipeline." />
    <InterviewDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => setRk(k => k + 1)} />
  </div>;
}

export function Assessments() {
  const { can, scope } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [openId, setOpenId] = useQueryId(sp, setSp, 'assessment');
  const view = sp.get('view') === 'templates' ? 'templates' : 'assigned';
  const [rk, setRk] = useState(0);
  const hidden = useHiddenParams(sp, setSp, ['candidate_id', 'sent_by']);
  const cols: Column<any>[] = [
    { key: 'candidate_name', label: 'Candidate', sortable: true, mobile: 'title', render: r => <CandidateCell r={r} sub={r.position_title ?? 'No position'} /> },
    { key: 'template_name', label: 'Assessment', sortable: true, mobile: 'subtitle', render: r => <div>{r.template_name}<div className="tiny muted">{r.category}</div></div> },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'score', label: 'Score', align: 'right', sortable: true, render: r => r.score !== null && r.score !== undefined ? `${r.score}/100` : '—' },
    { key: 'sent_at', label: 'Sent', sortable: true, render: r => `${shortDate(r.sent_at)}${r.sent_by_name ? ' · ' + r.sent_by_name : ''}`, csv: r => r.sent_at },
    { key: 'completed_at', label: 'Completed', sortable: true, render: r => r.completed_at ? relTime(r.completed_at) : '—', csv: r => r.completed_at },
  ];
  return <div>
    <PageHeader title="Assessments" sub="Work samples from the template library: Sent → Started → Completed → Scored. Candidates complete them in their portal."
      actions={<Segmented value={view} onChange={v => { const n = new URLSearchParams(sp); if (v === 'assigned') n.delete('view'); else n.set('view', v); setSp(n, { replace: true }); }} options={[{ key: 'assigned', label: 'Assigned' }, { key: 'templates', label: 'Template library' }]} />} />
    {view === 'assigned' ? <>
      <DataTable title="Assigned assessments" endpoint="/api/v1/assessments" columns={cols} exportName="assessments" exportResource="assessments" params={hidden.params} headerExtra={hidden.chips} reloadKey={rk} defaultSort="sent_at"
        filters={[{ key: 'status', label: 'Status', options: opts(['sent', 'started', 'completed', 'scored']) }, { key: 'sent_by', label: 'Sent by', type: 'member' }]}
        onRowClick={r => setOpenId(r.id)} rowActions={r => [{ label: r.status === 'completed' ? 'Score' : 'Open', onClick: () => setOpenId(r.id) }]} emptyTitle="No assessments sent yet" emptyText="Send one from a candidate's profile." />
      <AssessmentDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => setRk(k => k + 1)} />
    </> : <TemplateLibrary canCreate={can('assessments', 'create')} canEdit={scope('assessments', 'edit') === 'all'} />}
  </div>;
}

function TemplateLibrary({ canCreate, canEdit }: { canCreate: boolean; canEdit: boolean }) {
  const st = useApi<any[]>('/api/v1/assessment-templates');
  const [edit, setEdit] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = { name: edit.name, category: edit.category || null, instructions: edit.instructions || null, allow_file: !!edit.allow_file, questions: edit.questions.filter((q: any) => q.q.trim()).map((q: any) => ({ q: q.q.trim() })) };
    try { if (edit.id) await api.patch(`/api/v1/assessment-templates/${edit.id}`, body); else await api.post('/api/v1/assessment-templates', body); toast.success('Template saved'); setEdit(null); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  return <Card><CardHeader title="Template library" right={canCreate && <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setEdit({ name: '', category: '', instructions: '', allow_file: true, questions: [{ q: '' }] })}>New template</Button>} />
    <div className="card-b">{st.data.length === 0 ? <EmptyState title="No templates" /> : <div className="grid-2">{st.data.map(t => <div key={t.id} className="card card-pad"><div className="row" style={{ justifyContent: 'space-between' }}><b>{t.name}</b>{canEdit && <Button size="xs" onClick={() => setEdit({ ...t, questions: t.questions.length ? t.questions : [{ q: '' }] })}>Edit</Button>}</div><div className="small muted">{t.category ?? 'General'} · {t.questions.length} question{t.questions.length === 1 ? '' : 's'}{t.allow_file ? ' · file upload' : ''}</div><div className="small mt-1">{t.instructions}</div><div className="tiny muted mt-1">Used {t.uses} times{t.avg_score ? ` · average score ${t.avg_score}` : ''}</div></div>)}</div>}</div>
    <Dialog open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? 'Edit template' : 'New assessment template'} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!edit?.name?.trim() || !edit?.questions.some((q: any) => q.q.trim().length >= 3)} onClick={save}>Save</Button></>}>
      {edit && <div className="stack" style={{ gap: 12 }}>
        <div className="form-grid"><Field label="Name *" htmlFor="tp-n"><input id="tp-n" className="input" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Category" htmlFor="tp-c"><input id="tp-c" className="input" value={edit.category ?? ''} onChange={e => setEdit({ ...edit, category: e.target.value })} /></Field></div>
        <Field label="Instructions" htmlFor="tp-i"><textarea id="tp-i" className="textarea" value={edit.instructions ?? ''} onChange={e => setEdit({ ...edit, instructions: e.target.value })} /></Field>
        {edit.questions.map((q: any, i: number) => <div key={i} className="row" style={{ gap: 8 }}><input className="input" aria-label={`Question ${i + 1}`} placeholder={`Question ${i + 1}`} value={q.q} onChange={e => setEdit({ ...edit, questions: edit.questions.map((x: any, k: number) => k === i ? { q: e.target.value } : x) })} />{edit.questions.length > 1 && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} aria-label="Remove question" onClick={() => setEdit({ ...edit, questions: edit.questions.filter((_: any, k: number) => k !== i) })} />}</div>)}
        <div><Button size="sm" icon={<Plus size={14} />} onClick={() => setEdit({ ...edit, questions: [...edit.questions, { q: '' }] })}>Add question</Button></div>
        <label className="check"><input type="checkbox" checked={!!edit.allow_file} onChange={e => setEdit({ ...edit, allow_file: e.target.checked })} /> Allow file upload</label>
      </div>}
    </Dialog>
  </Card>;
}

export function Offers() {
  const [sp, setSp] = useSearchParams();
  const [openId, setOpenId] = useQueryId(sp, setSp, 'offer');
  const [rk, setRk] = useState(0);
  const hidden = useHiddenParams(sp, setSp, ['needs_placement', 'candidate_id', 'position_id']);
  const cols: Column<any>[] = [
    { key: 'candidate_name', label: 'Candidate', sortable: true, mobile: 'title', render: r => <CandidateCell r={r} sub={r.position_title} /> },
    { key: 'company_name', label: 'Client', mobile: 'subtitle' },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'pay_rate_cents', label: 'Pay rate', align: 'right', render: r => r.comp_restricted ? <span className="muted">Restricted</span> : `${money(r.pay_rate_cents, r.currency)}/${r.rate_unit}`, csv: r => r.comp_restricted ? '' : (r.pay_rate_cents ?? 0) / 100 },
    { key: 'bill_rate_cents', label: 'Bill rate', align: 'right', render: r => r.comp_restricted ? <span className="muted">Restricted</span> : `${money(r.bill_rate_cents, r.currency)}/${r.rate_unit}`, csv: r => r.comp_restricted ? '' : (r.bill_rate_cents ?? 0) / 100 },
    { key: 'start_date', label: 'Start', sortable: true, render: r => date(r.start_date) },
    { key: 'expires_at', label: 'Expires', sortable: true, render: r => date(r.expires_at) },
    { key: 'placement', label: 'Placement', render: r => r.placement_id ? <StatusPill status="active" label="Created" /> : r.status === 'accepted' ? <Link className="btn btn-xs btn-primary" to={`/workforce/placements/new?offerId=${r.id}`} onClick={e => e.stopPropagation()}>Create placement</Link> : '—' },
  ];
  return <div>
    <PageHeader title="Offers" sub="Draft → Approved → Sent → Viewed → Accepted / Declined / Expired. Candidates accept with an e-signature." />
    <DataTable title="All offers" endpoint="/api/v1/offers" columns={cols} exportName="offers" exportResource="offers" params={hidden.params} headerExtra={hidden.chips} reloadKey={rk}
      filters={[{ key: 'status', label: 'Status', options: opts(['draft', 'approved', 'sent', 'viewed', 'accepted', 'declined', 'expired']) }]}
      onRowClick={r => setOpenId(r.id)} rowActions={r => [{ label: 'Open', onClick: () => setOpenId(r.id) }]} emptyTitle="No offers yet" emptyText="Create an offer from a submitted candidate's profile or the pipeline." />
    <OfferDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => setRk(k => k + 1)} />
  </div>;
}
void Download;
