import { useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Sparkles, Pencil, Copy, Star, StarOff, Send, Users, Trash2, Plus, RefreshCw, Crown, UserMinus, GitCompare, Building2, Clock, Lock } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { money, dateTime, relTime, humanize, shortDate } from '../../lib/format';
import { Avatar, Banner, Boundary, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, KV, LoadingBlock, MemberSelect, Menu, PageHeader, Person, StatusPill, Tabs, useConfirm, EntitySelect } from '../../components/ui';
import { SimpleBars } from '../../components/charts';
import { Timeline } from '../../components/Timeline';
import { AiError, Chips, PositionForm, ScheduleInterviewDialog, SubmitDialog, OfferDialog, SUBMISSION_STAGES, candName, rateRange } from './shared';

type Tab = 'overview' | 'pipeline' | 'matches' | 'sourcing' | 'requirements' | 'activity';

export default function PositionDetail() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'overview';
  const setTab = (t: Tab) => { const n = new URLSearchParams(sp); if (t === 'overview') n.delete('tab'); else n.set('tab', t); setSp(n, { replace: true }); };
  const st = useApi<any>(`/api/v1/positions/${id}`, [id]);
  const [edit, setEdit] = useState(false);
  const [jd, setJd] = useState<{ busy?: boolean; text?: string; err?: unknown } | null>(null);
  const confirm = useConfirm();
  const nav = useNavigate();
  const p = st.data;
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!p) return <LoadingBlock rows={8} />;
  const lead = p.recruiters?.find((r: any) => r.is_lead);
  const setStatus = async (to: string) => {
    let reason: string | undefined;
    if (to === 'closed' || to === 'on_hold') { const r = await confirm({ title: `${to === 'closed' ? 'Close' : 'Put on hold'}: ${p.title}?`, reason: { label: 'Reason', required: to === 'closed' }, danger: to === 'closed' }); if (!r.ok) return; reason = r.reason; }
    try { await api.post(`/api/v1/positions/${p.id}/status`, { status: to, reason }); toast.success(`Position ${humanize(to).toLowerCase()}`); st.reload(); } catch (e) { toast.error(e); }
  };
  const writeJd = async () => { setJd({ busy: true }); try { const r = await api.post(`/api/v1/positions/${p.id}/ai/job-description`); setJd({ text: r.body }); } catch (e) { setJd({ err: e }); } };
  const primaryNext = p.allowed_status.includes('open') ? 'open' : null;
  return (
    <div>
      <PageHeader back="/recruiting/positions" title={<span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>{p.title} <StatusPill status={p.status} />{!p.can_edit && <span className="pill pill-gray"><Lock size={11} /> Read only</span>}</span>}
        sub={<span className="detail-meta" style={{ marginTop: 4 }}>
          <span><Building2 size={14} /> {p.company_id ? <Link to={`/crm/clients/${p.company_id}`}>{p.company_name}</Link> : 'No client yet'}</span>
          <span><Crown size={14} /> Lead: {lead?.name ?? '—'}</span>
          <span><Clock size={14} /> {p.schedule ?? '—'}{p.timezone ? ` (${p.timezone})` : ''}</span>
          <span>Urgency: <StatusPill status={p.urgency} /></span>
        </span>}
        actions={<>
          {p.can_edit && <Button icon={<Pencil size={16} />} onClick={() => setEdit(true)}>Edit</Button>}
          {p.can_edit && primaryNext ? <Button variant="primary" onClick={() => setStatus('open')}>Open for sourcing</Button> : <Button variant="primary" icon={<Sparkles size={16} />} onClick={() => setTab('matches')}>Find best matches</Button>}
          <Menu items={[
            { label: 'Write job description (AI draft)', icon: <Sparkles size={15} />, onClick: writeJd },
            { label: 'Sourcing link & QR', onClick: () => setTab('sourcing') },
            { sep: true, hidden: !p.can_edit },
            ...p.allowed_status.filter((s: string) => s !== primaryNext || !p.can_edit).map((s: string) => ({ label: s === 'open' ? 'Reopen' : `Mark ${humanize(s).toLowerCase()}`, onClick: () => setStatus(s), hidden: !p.can_edit, danger: s === 'closed' })),
            { label: 'Archive position', icon: <Trash2 size={15} />, danger: true, hidden: !p.can_edit, onClick: async () => { const r = await confirm({ title: 'Archive this position?', body: 'It disappears from lists; history is kept.', danger: true, typeToConfirm: 'ARCHIVE' }); if (r.ok) { try { await api.del(`/api/v1/positions/${p.id}`); toast.success('Archived'); nav('/recruiting/positions'); } catch (e) { toast.error(e); } } } },
          ]} />
        </>} />
      {p.last_match_run?.stale && <Banner tone="warn">The position changed since the last AI match run ({relTime(p.last_match_run.created_at)}). <a href="#" onClick={e => { e.preventDefault(); setTab('matches'); }}>Re-run Find Best Matches</a> to refresh rankings.</Banner>}
      {jd && <Card pad className="mb-3">
        <div className="row" style={{ justifyContent: 'space-between' }}><div className="card-title-lg"><Sparkles size={16} /> Job description draft</div><Button size="sm" variant="ghost" onClick={() => setJd(null)}>Dismiss</Button></div>
        {jd.busy ? <LoadingBlock rows={3} /> : jd.err ? <AiError error={jd.err} retry={writeJd} /> : <>
          <textarea className="textarea mt-2" style={{ minHeight: 220 }} value={jd.text} onChange={e => setJd({ ...jd, text: e.target.value })} aria-label="Job description draft" />
          <div className="row mt-2" style={{ gap: 8 }}>{p.can_edit && <Button variant="primary" onClick={async () => { try { await api.patch(`/api/v1/positions/${p.id}`, { description: jd.text }); toast.success('Description saved (not published anywhere)'); setJd(null); st.reload(); } catch (e) { toast.error(e); } }}>Use as description</Button>}<Button icon={<Copy size={14} />} onClick={() => { navigator.clipboard?.writeText(jd.text ?? ''); toast.success('Copied'); }}>Copy</Button><span className="small muted">Draft only — never published automatically.</span></div>
        </>}
      </Card>}
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: 'Overview' }, { key: 'pipeline', label: 'Pipeline', count: p.submissions_count }, { key: 'matches', label: 'Matches (AI)' },
        { key: 'sourcing', label: 'Sourcing Link + QR' }, { key: 'requirements', label: 'Onboarding Requirements', count: p.requirements.length }, { key: 'activity', label: 'Activity' },
      ]} />
      <div className="mt-3">
        <Boundary label="This tab">
          {tab === 'overview' && <OverviewTab p={p} reload={st.reload} />}
          {tab === 'pipeline' && <PipelineTab p={p} />}
          {tab === 'matches' && <MatchesTab p={p} onRan={st.reload} />}
          {tab === 'sourcing' && <SourcingTab p={p} />}
          {tab === 'requirements' && <RequirementsTab p={p} reload={st.reload} />}
          {tab === 'activity' && <Card pad><Timeline type="position" id={p.id} /></Card>}
        </Boundary>
      </div>
      <PositionForm open={edit} onClose={() => setEdit(false)} position={p} onSaved={() => st.reload()} />
    </div>
  );
}

function OverviewTab({ p, reload }: { p: any; reload: () => void }) {
  const [assign, setAssign] = useState<string | null>(null);
  const [asLead, setAsLead] = useState(false);
  const act = async (fn: () => Promise<any>, msg: string) => { try { await fn(); toast.success(msg); reload(); } catch (e) { toast.error(e); } };
  const f = p.funnel ?? {};
  return <div className="grid-main-side">
    <div className="stack" style={{ gap: 20 }}>
      <Card><CardHeader title="Details" /><div className="card-b"><KV items={[
        ['Client', p.company_name], ['Account manager', p.account_manager_name], ['Openings', `${p.placed_count} placed of ${p.openings}`], ['Employment type', humanize(p.employment_type)], ['Schedule', p.schedule], ['Timezone', p.timezone], ['Weekly hours', p.weekly_hours],
        ['Target pay range', p.pay_min_cents ? `${money(p.pay_min_cents, p.currency)} – ${money(p.pay_max_cents, p.currency)} / ${p.rate_unit}` : null],
        ['Client bill budget', p.comp_restricted ? <span className="muted"><Lock size={12} /> Restricted</span> : p.bill_budget_cents ? `${money(p.bill_budget_cents, p.currency)} / ${p.rate_unit}` : null],
        ['Health', <StatusPill status={p.health} label={humanize(p.health)} />], ['Equipment', p.equipment], ['Created', `${shortDate(p.created_at)}${p.created_by_name ? ` by ${p.created_by_name}` : ''}`],
      ]} /></div></Card>
      <Card><CardHeader title="Requirements" /><div className="card-b stack" style={{ gap: 12 }}>
        <div><div className="small muted mb-2">Skills</div><Chips items={p.skills} /></div><div><div className="small muted mb-2">Software</div><Chips items={p.software} /></div><div><div className="small muted mb-2">Languages</div><Chips items={p.languages} /></div>
      </div></Card>
      <Card><CardHeader title="Description" /><div className="card-b small" style={{ whiteSpace: 'pre-wrap' }}>{p.description || <span className="muted">No description yet — use “Write job description” in More to draft one.</span>}</div></Card>
    </div>
    <div className="stack" style={{ gap: 20 }}>
      <Card><CardHeader title="Pipeline" /><div className="card-b">{SUBMISSION_STAGES.map(s => <div key={s} className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}><Link to={`/recruiting/submissions?position_id=${p.id}&status=${s}`}><StatusPill status={s} /></Link><b>{f[s] ?? 0}</b></div>)}<div className="small muted mt-2">{p.applications_count} applications</div></div></Card>
      <Card><CardHeader title="Recruiters" sub="Lead recruiter is highlighted" /><div className="card-b">
        {(p.recruiters ?? []).length === 0 && <EmptyState title="No recruiters assigned" />}
        {(p.recruiters ?? []).map((r: any) => <div key={r.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}><Person name={r.name} color={r.avatar_color} sub={r.is_lead ? 'Lead recruiter' : 'Recruiter'} />{p.can_assign && <Menu items={[{ label: 'Make lead', icon: <Crown size={15} />, hidden: r.is_lead, onClick: () => act(() => api.post(`/api/v1/positions/${p.id}/recruiters`, { user_id: r.id, is_lead: true }), `${r.name} is now lead`) }, { label: 'Unassign', icon: <UserMinus size={15} />, danger: true, onClick: () => act(() => api.del(`/api/v1/positions/${p.id}/recruiters/${r.id}`), `${r.name} unassigned`) }]} />}</div>)}
        {p.can_assign && <div className="mt-2 stack" style={{ gap: 8 }}><MemberSelect value={assign} onChange={setAssign} placeholder="Add recruiter…" roles={['recruiter', 'owner', 'admin', 'management', 'account_manager', 'sales']} /><label className="check small"><input type="checkbox" checked={asLead} onChange={e => setAsLead(e.target.checked)} /> Lead recruiter</label><Button size="sm" disabled={!assign} onClick={() => act(() => api.post(`/api/v1/positions/${p.id}/recruiters`, { user_id: assign, is_lead: asLead }), 'Recruiter assigned — they were notified').then(() => { setAssign(null); setAsLead(false); })}>Assign</Button></div>}
        {p.recruiter_history.length > 0 && <details className="mt-2"><summary className="small muted" style={{ cursor: 'pointer' }}>Assignment history ({p.recruiter_history.length})</summary>{p.recruiter_history.map((h: any) => <div key={h.id} className="small" style={{ padding: '4px 0' }}>{h.user_name}{h.is_lead ? ' (lead)' : ''} · assigned {shortDate(h.assigned_at)}{h.assigned_by_name ? ` by ${h.assigned_by_name}` : ''}{h.unassigned_at ? ` · removed ${shortDate(h.unassigned_at)}` : ''}</div>)}</details>}
      </div></Card>
    </div>
  </div>;
}

function PipelineTab({ p }: { p: any }) {
  const st = useApi<any>(`/api/v1/positions/${p.id}/pipeline`, [p.id]);
  const confirm = useConfirm();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [iv, setIv] = useState<any>(null);
  const [offer, setOffer] = useState<any>(null);
  const [pick, setPick] = useState(false);
  const [cand, setCand] = useState<any>(null);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  const rows = st.data.rows as any[];
  const move = async (r: any, to: string) => {
    if (r.status === to) return;
    if (to === 'client_interview') { setIv(r); return; }
    if (to === 'offer') { setOffer(r); return; }
    if (to === 'hired') { toast.error('Hired is set automatically when a placement is created from the accepted offer.'); return; }
    let reason: string | undefined;
    if (to === 'rejected' || to === 'withdrawn') { const c = await confirm({ title: `Mark ${r.name} ${to}?`, reason: { label: 'Reason', required: true }, danger: true }); if (!c.ok) return; reason = c.reason; }
    try { await api.post(`/api/v1/submissions/${r.id}/status`, { status: to, reason }); toast.success(`Moved to ${humanize(to)}`); st.reload(); } catch (e) { toast.error(e); }
  };
  return <div>
    <div className="row mb-2" style={{ justifyContent: 'space-between' }}><div className="small muted">Drag a card to move the submission. Client Interview and Offer open the scheduling / offer forms so each stage has a real record.</div>
      {st.data.can_edit && ['open', 'on_hold'].includes(p.status) && <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setPick(true)}>Submit a candidate</Button>}</div>
    {rows.length === 0 ? <EmptyState icon={<Users size={22} />} title="No submissions yet" text="Run Find Best Matches or submit a qualified candidate." /> :
      <div className="kanban rec-kanban">{(st.data.stages as string[]).map(s => {
        const items = rows.filter(r => r.status === s);
        return <div key={s} className={`kcol ${over === s ? 'drop' : ''}`} onDragOver={(e: DragEvent) => { if (st.data.can_edit) { e.preventDefault(); setOver(s); } }} onDragLeave={() => setOver(null)} onDrop={() => { setOver(null); const r = rows.find(x => x.id === drag); if (r) move(r, s); setDrag(null); }}>
          <div className="kcol-h"><StatusPill status={s} /><span className="muted">{items.length}</span></div>
          {items.map(r => <div key={r.id} className={`kcard ${drag === r.id ? 'dragging' : ''}`} draggable={st.data.can_edit} onDragStart={() => setDrag(r.id)} onDragEnd={() => setDrag(null)}>
            <Link to={`/recruiting/candidates/${r.candidate_id}?tab=submissions`}><Person name={r.name} color={r.avatar_color} sub={r.headline} size={28} /></Link>
            <div className="small muted mt-1">{r.country ?? ''}{r.years_experience ? ` · ${r.years_experience} yrs` : ''} · {relTime(r.updated_at)}</div>
            {r.next_interview && <div className="small mt-1">Interview {dateTime(r.next_interview)}</div>}
            {r.client_decision && <div className="mt-1"><StatusPill status={r.client_decision === 'approve' ? 'approved' : r.client_decision === 'reject' ? 'rejected' : 'scheduled'} label={`Client: ${humanize(r.client_decision)}`} /></div>}
            {r.client_feedback && <div className="tiny muted mt-1" style={{ whiteSpace: 'pre-wrap' }}>“{r.client_feedback.slice(0, 120)}”</div>}
            {st.data.can_edit && <select className="select input-sm mt-1" aria-label={`Move ${r.name}`} value="" onChange={e => e.target.value && move(r, e.target.value)}><option value="">Move to…</option>{(st.data.stages as string[]).filter(x => x !== s).map(x => <option key={x} value={x}>{humanize(x)}</option>)}</select>}
          </div>)}
        </div>;
      })}</div>}
    {iv && <ScheduleInterviewDialog open onClose={() => setIv(null)} onDone={() => st.reload()} candidateId={iv.candidate_id} candidateName={iv.name} positionId={p.id} submissionId={iv.id} kind="client" />}
    {offer && <OfferDialog open onClose={() => setOffer(null)} onDone={() => st.reload()} candidate={{ id: offer.candidate_id, first_name: offer.first_name, last_name: offer.last_name }} positionId={p.id} />}
    <Dialog open={pick} onClose={() => setPick(false)} title="Submit a candidate" footer={<><Button onClick={() => setPick(false)}>Cancel</Button><Button variant="primary" disabled={!cand} onClick={() => setPick(false)}>Continue</Button></>}>
      <Field label="Qualified or talent-pool candidate" htmlFor="pk-c"><EntitySelect id="pk-c" endpoint="/api/v1/candidates?status=qualified,talent_pool,submitted&sort=name&dir=asc" value={cand?.id} onChange={(_, r) => setCand(r ?? null)} labelOf={r => `${r.name}${r.headline ? ' — ' + r.headline : ''}`} /></Field>
      <div className="small muted mt-2">Only Qualified, Talent Pool or already-Submitted candidates can be submitted. Move others through screening first.</div>
    </Dialog>
    {cand && !pick && <SubmitDialog open onClose={() => setCand(null)} onDone={() => { setCand(null); st.reload(); }} candidate={cand} positionId={p.id} />}
  </div>;
}

function scoreClass(s: number) { return s >= 75 ? 'hi' : s < 45 ? 'lo' : ''; }
function MatchesTab({ p, onRan }: { p: any; onRan: () => void }) {
  const st = useApi<any>(`/api/v1/positions/${p.id}/matches`, [p.id]);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [cmp, setCmp] = useState<string[]>([]);
  const [showCmp, setShowCmp] = useState(false);
  const [onlyShort, setOnlyShort] = useState(false);
  const [sub, setSub] = useState<any>(null);
  const run = async () => { setRunning(true); setErr(null); try { const r = await api.post(`/api/v1/positions/${p.id}/matches`, {}); st.setData(r); onRan(); if (r.results.length) toast.success(`Ranked ${r.results.length} candidate${r.results.length === 1 ? '' : 's'}`); else toast.info('No candidates available to match'); } catch (e) { setErr(e); } finally { setRunning(false); } };
  const shortlist = async (r: any) => { try { await api.post(`/api/v1/positions/${p.id}/matches/${r.id}/shortlist`, { shortlisted: !r.shortlisted }); st.reload(); } catch (e) { toast.error(e); } };
  const d = st.data;
  const results = (d?.results ?? []).filter((r: any) => !onlyShort || r.shortlisted);
  const sel = (d?.results ?? []).filter((r: any) => cmp.includes(r.id));
  return <div>
    <Card pad className="mb-3"><div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
      <div><div className="card-title-lg"><Sparkles size={16} /> Find Best Matches</div><div className="small muted">{d?.run?.model?.startsWith('claude') ? 'Claude reads the full role and each candidate profile, then ranks the strongest fits. Only facts on each profile are used.' : 'Ranks the authorized talent pool on skills (35), software (15), experience (15), timezone overlap (10), availability (10), language (5) and pay vs budget (10). Only facts on each profile are used.'}</div>
        {d?.run && <div className="small mt-1">Last run {dateTime(d.run.created_at)} by {d.run.run_by_name ?? '—'} · model <code>{d.run.model}</code> · pool {d.run.inputs?.pool_size ?? '—'} candidates {d.stale ? <StatusPill status="at_risk" label="Stale — position changed" /> : <StatusPill status="active" label="Current" />}</div>}</div>
      <div className="row" style={{ gap: 8 }}>{cmp.length >= 2 && <Button icon={<GitCompare size={16} />} onClick={() => setShowCmp(true)}>Compare ({cmp.length})</Button>}<label className="check small"><input type="checkbox" checked={onlyShort} onChange={e => setOnlyShort(e.target.checked)} /> Shortlist only</label><Button variant="primary" icon={<RefreshCw size={16} />} loading={running} onClick={run}>{d?.run ? 'Re-run' : 'Run'} matching</Button></div>
    </div></Card>
    <AiError error={err} retry={run} />
    {d?.run?.inputs?.note && <div className="banner warn"><div>{d.run.inputs.note}</div></div>}
    {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <LoadingBlock /> : !d.run ? <EmptyState icon={<Sparkles size={22} />} title="No match run yet" text="Run matching to rank candidates for this position." /> : results.length === 0 ? (onlyShort && d.results.length
        ? <EmptyState icon={<Star size={22} />} title="Nobody shortlisted yet" text={`${d.results.length} candidate${d.results.length === 1 ? ' is' : 's are'} ranked — untick “Shortlist only” to see them.`} action={<Button onClick={() => setOnlyShort(false)}>Show all matches</Button>} />
        : <EmptyState icon={<Users size={22} />} title="No one to match yet" text={d.run.inputs?.empty_reason ?? 'No candidates were available for this position.'} action={<Link to="/recruiting/candidates" className="btn btn-primary">Go to candidates</Link>} />) :
      results.map((r: any) => <div key={r.id} className="rec-match">
        <div className={`rec-score ${scoreClass(r.score)}`} aria-label={`Score ${r.score} of 100`}>{r.score}</div>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><Link to={`/recruiting/candidates/${r.candidate_id}`} className="bold">{r.name}</Link><span className="small muted">{r.headline} · {r.country ?? '—'} · {r.years_experience ?? '—'} yrs · {rateRange(r)}</span><StatusPill status={r.candidate_status} />{r.submission_status && <StatusPill status={r.submission_status} label={`Submitted: ${humanize(r.submission_status)}`} />}</div>
          <div className="small mt-1"><b style={{ color: 'var(--success)' }}>Why it matches:</b> {r.reasons.length ? r.reasons.join(' · ') : '—'}</div>
          {r.missing.length > 0 && <div className="small mt-1"><b style={{ color: 'var(--danger)' }}>What’s missing:</b> {r.missing.join(' · ')}</div>}
          <div className="rec-bars">{Object.entries(r.breakdown).map(([k, v]: any) => <div key={k} className="rec-bar" title={v.detail}>{humanize(k)} {v.score}/{v.max}<i><b style={{ width: `${(v.score / v.max) * 100}%` }} /></i></div>)}</div>
        </div>
        <div className="rec-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <Button size="sm" variant={r.shortlisted ? 'primary' : 'outline'} icon={r.shortlisted ? <Star size={14} /> : <StarOff size={14} />} onClick={() => shortlist(r)}>{r.shortlisted ? 'Shortlisted' : 'Shortlist'}</Button>
          <label className="check small"><input type="checkbox" checked={cmp.includes(r.id)} disabled={!cmp.includes(r.id) && cmp.length >= 4} onChange={e => setCmp(c => e.target.checked ? [...c, r.id] : c.filter(x => x !== r.id))} /> Compare</label>
          {!r.submission_status && <Button size="sm" icon={<Send size={14} />} onClick={() => setSub({ id: r.candidate_id, first_name: r.first_name, last_name: r.last_name, status: r.candidate_status })}>Submit</Button>}
        </div>
      </div>)}
    <Dialog open={showCmp} onClose={() => setShowCmp(false)} wide title="Compare candidates">
      <div className="rec-compare">{sel.map((r: any) => <div key={r.id} className="card"><div className="row" style={{ gap: 10 }}><div className={`rec-score ${scoreClass(r.score)}`}>{r.score}</div><div><Link to={`/recruiting/candidates/${r.candidate_id}`} className="bold">{r.name}</Link><div className="small muted">{r.headline}</div></div></div>
        <dl><dt>Country / timezone</dt><dd>{r.country ?? '—'} · {r.timezone ?? '—'}</dd><dt>Experience</dt><dd>{r.years_experience ?? '—'} years</dd><dt>Skills</dt><dd><Chips items={r.skills} hit={p.skills} /></dd><dt>Software</dt><dd><Chips items={r.software} hit={p.software} /></dd><dt>Languages</dt><dd>{(r.languages ?? []).join(', ') || '—'}</dd><dt>Availability</dt><dd>{humanize(r.availability_status)}{r.earliest_start ? ` · ${shortDate(r.earliest_start)}` : ''}</dd><dt>Rate expectation</dt><dd>{rateRange(r)}</dd><dt>Missing</dt><dd className="small">{r.missing.join('; ') || '—'}</dd></dl></div>)}</div>
    </Dialog>
    {sub && <SubmitDialog open onClose={() => setSub(null)} onDone={() => { setSub(null); st.reload(); }} candidate={sub} positionId={p.id} />}
  </div>;
}

function SourcingTab({ p }: { p: any }) {
  const st = useApi<any>(`/api/v1/positions/${p.id}/sourcing`, [p.id]);
  const [busy, setBusy] = useState(false);
  const mine = st.data?.mine;
  const clicks = useApi<any[]>(mine ? `/api/v1/sourcing/links/${mine.id}/clicks` : null, [mine?.id]);
  const create = async () => { setBusy(true); try { await api.post(`/api/v1/positions/${p.id}/sourcing`); toast.success('Your position link is ready'); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  const copy = (u: string) => { navigator.clipboard?.writeText(u).then(() => toast.success('Link copied'), () => toast.error('Copy failed — select the link and copy it manually')); };
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  return <div className="grid-main-side">
    <div className="stack" style={{ gap: 20 }}>
      <Card><CardHeader title="Your position link" sub="Candidates who apply through it are attributed to you (resolved on the server from the token)." /><div className="card-b">
        {!mine ? <EmptyState title="You don't have a link for this position yet" action={<Button variant="primary" loading={busy} onClick={create}>Create my position link</Button>} /> : <div className="row" style={{ gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <img className="rec-qr" src={mine.qr_url} alt={`QR code for ${mine.url}`} />
          <div style={{ flex: 1, minWidth: 240 }} className="stack">
            <div className="rec-linkbox"><input className="input" readOnly value={mine.url} aria-label="Position link" onFocus={e => e.target.select()} /><Button icon={<Copy size={16} />} onClick={() => copy(mine.url)}>Copy</Button></div>
            <div className="row" style={{ gap: 24 }}><div><div className="small muted">Clicks</div><div className="kpi-value" style={{ fontSize: 26 }}>{mine.clicks}</div></div><div><div className="small muted">Applications</div><div className="kpi-value" style={{ fontSize: 26 }}>{mine.applications}</div></div><div><div className="small muted">Qualified+</div><div className="kpi-value" style={{ fontSize: 26 }}>{mine.qualified}</div></div></div>
            <div className="row" style={{ gap: 8 }}><a className="btn btn-sm" href={mine.qr_url} download={`qr-${p.title.replace(/\W+/g, '-')}.png`}>Download QR</a><a className="btn btn-sm" href={mine.url} target="_blank" rel="noreferrer">Preview application page</a></div>
          </div>
        </div>}
      </div></Card>
      {mine && <Card pad><div className="card-title-lg">Clicks — last 30 days</div>{!clicks.data ? <LoadingBlock /> : <SimpleBars data={clicks.data.map(x => ({ label: x.label.split(' ')[1], value: x.value }))} height={170} />}</Card>}
    </div>
    <Card><CardHeader title="All links for this position" /><div className="card-b">{st.data.links.length === 0 ? <EmptyState title="No links yet" /> : st.data.links.map((l: any) => <div key={l.id} className="checklist-item"><Avatar name={l.user_name} size={28} /><div style={{ flex: 1, minWidth: 0 }}><div className="bold small">{l.user_name}{!l.active && ' (inactive)'}</div><div className="tiny muted truncate">{l.url}</div></div><div className="small right">{l.clicks} clicks<br />{l.applications} apps</div></div>)}
      <div className="small muted mt-2">General application page: <a href={st.data.public_url} target="_blank" rel="noreferrer">{st.data.public_url}</a></div></div></Card>
  </div>;
}

function RequirementsTab({ p, reload }: { p: any; reload: () => void }) {
  const [title, setTitle] = useState(''); const [req, setReq] = useState(true);
  const act = async (fn: () => Promise<any>, msg: string) => { try { await fn(); toast.success(msg); reload(); } catch (e) { toast.error(e); } };
  return <Card><CardHeader title="Onboarding requirements" sub="Added to every placement for this position, merged with the agency and client templates. Required items block activation." /><div className="card-b">
    {p.requirements.length === 0 && <EmptyState title="No position-specific requirements" text="Agency and client templates still apply." />}
    {p.requirements.map((r: any) => <div key={r.id} className="checklist-item"><div style={{ flex: 1 }}><b>{r.title}</b></div><StatusPill status={r.required ? 'active' : 'draft'} label={r.required ? 'Required' : 'Optional'} />
      {p.can_edit && <Menu items={[{ label: r.required ? 'Make optional' : 'Make required', onClick: () => act(() => api.patch(`/api/v1/positions/${p.id}/requirements/${r.id}`, { required: !r.required }), 'Requirement updated') }, { label: 'Remove', danger: true, icon: <Trash2 size={15} />, onClick: () => act(() => api.del(`/api/v1/positions/${p.id}/requirements/${r.id}`), 'Requirement removed') }]} />}</div>)}
    {p.can_edit && <form className="row mt-2" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={e => { e.preventDefault(); if (title.trim().length >= 2) act(() => api.post(`/api/v1/positions/${p.id}/requirements`, { title: title.trim(), required: req }), 'Requirement added').then(() => setTitle('')); }}>
      <input className="input" style={{ flex: 1, minWidth: 220 }} aria-label="New requirement" placeholder="e.g. HIPAA training certificate" value={title} onChange={e => setTitle(e.target.value)} />
      <label className="check small"><input type="checkbox" checked={req} onChange={e => setReq(e.target.checked)} /> Required</label><Button type="submit" icon={<Plus size={14} />} disabled={title.trim().length < 2}>Add</Button></form>}
  </div></Card>;
}
void candName;
