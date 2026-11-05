import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Play, Send, Repeat, LogOut, PauseCircle, AlertTriangle, Plus, Trash2, Wand2, Pencil, FileText } from 'lucide-react';
import { Card, CardHeader, Button, StatusPill, Avatar, Tabs, Menu, KV, EmptyState, ErrorState, LoadingBlock, Boundary, useConfirm, Dialog, Field, Banner, MoneyInput, MemberSelect } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { Timeline } from '../../components/Timeline';
import { BackButton } from '../../components/ui';
import { useApi } from '../../lib/hooks';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, dateTime, money, humanize, todayISO } from '../../lib/format';
import { LivePill, SinceTimer, ActivityMeter, scheduleText, hrs, Progress, IssueDrawer, DOW } from './shared';
import { TIMEZONES } from './PlacementNew';

type TabKey = 'overview' | 'onboarding' | 'rates' | 'schedule' | 'timesheets' | 'issues' | 'documents' | 'activity';

export default function PlacementDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as TabKey) || 'overview';
  const st = useApi<any>(`/api/v1/placements/${id}`);
  const confirm = useConfirm();
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [offboard, setOffboard] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [rk, setRk] = useState(0);
  const reload = () => { st.reload(); setRk(k => k + 1); };
  if (st.error && !st.data) return <div><BackButton fallback="/workforce/placements" /><ErrorState error={st.error} retry={st.reload} /></div>;
  if (!st.data) return <LoadingBlock rows={8} />;
  const p = st.data;
  const activate = async (override?: string) => {
    setBusy(true);
    try { await api.post(`/api/v1/placements/${id}/activate`, override ? { override_reason: override } : {}); toast.success(`${p.worker_name} is active — seat started`); setBlocked(null); setOverrideReason(''); reload(); }
    catch (e) { if (e instanceof ApiError && e.status === 409 && e.details?.missing) setBlocked(e.details.missing); else toast.error(e); }
    finally { setBusy(false); }
  };
  const invite = async () => {
    const r = await confirm({ title: `Invite ${p.worker_name} to the Worker Portal?`, body: `An invitation email goes to ${p.worker_email ?? 'the worker'} (Dev Outbox). It expires in 7 days.`, confirmLabel: 'Send invite' });
    if (!r.ok) return;
    try { await api.post(`/api/v1/placements/${id}/invite`); toast.success('Invitation sent — see Dev Outbox'); reload(); } catch (e) { toast.error(e); }
  };
  const changeStatus = async (status: string) => {
    const labels: Record<string, string> = { on_leave: 'Put on leave', notice: 'Start notice period', active: 'Resume (active)' };
    const r = await confirm({ title: `${labels[status]}?`, body: status === 'notice' ? 'Use Offboard to set the end date and reason.' : undefined, reason: { label: 'Reason', required: true } });
    if (!r.ok) return;
    try { await api.post(`/api/v1/placements/${id}/status`, { status, reason: r.reason }); toast.success('Status updated'); reload(); } catch (e) { toast.error(e); }
  };
  const simulate = async () => {
    const r = await confirm({ title: 'Simulate the rest of this week?', body: 'Demo mode: fills every unworked scheduled day this week with realistic sessions, screenshots and activity, then submits the timesheet for approval.', confirmLabel: 'Simulate & submit' });
    if (!r.ok) return;
    try { const x = await api.post(`/api/v1/placements/${id}/simulate-week`, { submit: true }); toast.success(`Simulated ${x.days.length} day(s), ${x.shots} screenshots${x.submitted ? ' — timesheet submitted' : ''}`); reload(); } catch (e) { toast.error(e); }
  };
  const isOpen = p.status !== 'ended';
  const primary = p.status === 'onboarding' && p.can.edit
    ? <Button variant="primary" icon={<Play size={16} />} loading={busy} onClick={() => activate()}>Activate</Button>
    : !p.has_portal && isOpen && p.can.edit ? <Button variant="primary" icon={<Send size={16} />} onClick={invite}>{p.invite?.status === 'pending' ? 'Resend portal invite' : 'Invite to Worker Portal'}</Button> : null;
  const secondary = p.status === 'onboarding' && !p.has_portal && p.can.edit ? <Button icon={<Send size={16} />} onClick={invite}>{p.invite?.status === 'pending' ? 'Resend invite' : 'Invite to Portal'}</Button> : null;
  return (
    <div>
      <BackButton fallback="/workforce/placements" />
      <Card>
        <div className="detail-head">
          <Avatar name={p.worker_name} size={60} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}><h1 style={{ margin: 0 }}><Link to={`/workforce/workers/${p.worker_id}`} style={{ color: 'inherit' }}>{p.worker_name}</Link></h1><StatusPill status={p.status} />{p.replaces_placement_id && <StatusPill status="replacement" label="Replacement" tone="purple" />}{p.presence && p.presence.state !== 'offline' && <LivePill status={p.presence.state} />}</div>
            <div className="muted mt-1">{p.title} · <Link to={`/crm/companies/${p.company_id}`}>{p.company_name}</Link> · {date(p.start_date)} → {p.end_date ? date(p.end_date) : 'ongoing'}</div>
            <div className="row small muted" style={{ gap: 14, marginTop: 8, flexWrap: 'wrap' }}><span>AM: <b>{p.account_manager_name ?? '—'}</b></span><span>Recruiter: <b>{p.recruiter_name ?? '—'}</b></span><span>{scheduleText(p.schedule_days, p.schedule_start, p.schedule_end)} ({p.timezone})</span><span>Portal: <b>{p.has_portal ? 'Active' : p.invite ? `Invite ${p.invite.status}` : 'Not invited'}</b></span></div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {secondary}{primary}
            <Menu items={[
              { label: 'Edit details', icon: <Pencil size={15} />, onClick: () => setEdit(true), hidden: !p.can.edit || !isOpen },
              { label: 'Log an issue', icon: <AlertTriangle size={15} />, onClick: () => setIssueOpen(true), hidden: !isOpen },
              { label: 'Start replacement', icon: <Repeat size={15} />, onClick: () => nav(`/workforce/placements/new?replacesId=${id}`), hidden: !p.can.edit || !['active', 'notice', 'on_leave'].includes(p.status) },
              { label: 'Simulate rest of week (demo)', icon: <Wand2 size={15} />, onClick: simulate, hidden: !p.can.time || !['active', 'notice'].includes(p.status) },
              { sep: true },
              ...p.allowed_status.filter((s: string) => s !== 'active' || p.status !== 'onboarding').map((s: string) => ({ label: s === 'on_leave' ? 'Put on leave' : s === 'notice' ? 'Start notice period' : 'Resume (active)', icon: <PauseCircle size={15} />, onClick: () => changeStatus(s), hidden: !p.can.edit })),
              { label: p.status === 'onboarding' ? 'Cancel placement' : 'Offboard', icon: <LogOut size={15} />, danger: true, onClick: () => setOffboard(true), hidden: !p.can.edit || !isOpen },
            ]} />
          </div>
        </div>
        <div style={{ padding: '0 24px' }}>
          <Tabs value={tab} onChange={k => setSp({ tab: k }, { replace: true })} tabs={[
            { key: 'overview', label: 'Overview' }, { key: 'onboarding', label: 'Onboarding', count: p.onboarding.req_total - p.onboarding.req_done || null }, { key: 'rates', label: 'Rates' },
            { key: 'schedule', label: 'Schedule & Monitoring' }, { key: 'timesheets', label: 'Timesheets', count: p.timesheet_stats.submitted || null }, { key: 'issues', label: 'Issues', count: p.issues.open || null },
            { key: 'documents', label: 'Documents' }, { key: 'activity', label: 'Activity' },
          ]} />
        </div>
      </Card>
      {p.status === 'onboarding' && p.onboarding.req_total > p.onboarding.req_done && <div style={{ marginTop: 16 }}><Banner tone="warn"><b>{p.onboarding.req_total - p.onboarding.req_done} required onboarding item{p.onboarding.req_total - p.onboarding.req_done === 1 ? '' : 's'} open.</b> Activation is blocked until they are done (or an authorized override with a reason). <a href="?tab=onboarding" onClick={e => { e.preventDefault(); setSp({ tab: 'onboarding' }, { replace: true }); }}>Open checklist →</a></Banner></div>}
      {p.activation_override_reason && <div style={{ marginTop: 16 }}><Banner tone="warn">Activated with override by {p.activated_by_name ?? '—'} on {dateTime(p.activated_at)}: “{p.activation_override_reason}”</Banner></div>}
      <div style={{ marginTop: 20 }}>
        <Boundary label="Placement tab">
          {tab === 'overview' && <Overview p={p} />}
          {tab === 'onboarding' && <Onboarding p={p} onChange={reload} />}
          {tab === 'rates' && <Rates id={id!} />}
          {tab === 'schedule' && <ScheduleMonitoring p={p} onChange={reload} />}
          {tab === 'timesheets' && <DataTable<any> key={rk} title="Timesheets" endpoint="/api/v1/timesheets" params={{ placement_id: id }} urlState={false} rowLink={r => `/time/timesheets/${r.id}`} exportName="placement-timesheets"
            columns={[{ key: 'week_start', label: 'Week', sortable: true, mobile: 'title', render: r => `Week of ${date(r.week_start)}` }, { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> }, { key: 'total_minutes', label: 'Hours', align: 'right', sortable: true, render: r => hrs(r.total_minutes) }, { key: 'submitted_at', label: 'Submitted', render: r => dateTime(r.submitted_at) }, { key: 'approved_at', label: 'Approved', render: r => dateTime(r.approved_at) }, { key: 'adjustments', label: 'Corrections', align: 'right' }]}
            emptyTitle="No timesheets yet" emptyText="Weekly timesheets are built automatically from tracked time." />}
          {tab === 'issues' && <DataTable<any> key={rk} title="Issues" endpoint="/api/v1/issues" params={{ placement_id: id }} urlState={false} exportName="placement-issues"
            columns={[{ key: 'title', label: 'Issue', mobile: 'title', render: r => <div><div className="bold">{r.title}</div><div className="small muted">{r.description ?? ''}</div></div> }, { key: 'kind', label: 'Type', render: r => humanize(r.kind) }, { key: 'severity', label: 'Severity', render: r => <StatusPill status={r.severity} /> }, { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> }, { key: 'created_by_name', label: 'Logged by' }, { key: 'created_at', label: 'Logged', render: r => date(r.created_at) }]}
            rowActions={(r, rl) => [{ label: 'Mark investigating', hidden: r.status !== 'open', onClick: async () => { try { await api.patch(`/api/v1/issues/${r.id}`, { status: 'investigating' }); rl(); } catch (e) { toast.error(e); } } }, { label: 'Resolve…', hidden: r.status === 'resolved', onClick: async () => { const c = await confirm({ title: 'Resolve issue', reason: { label: 'Resolution', required: true } }); if (!c.ok) return; try { await api.patch(`/api/v1/issues/${r.id}`, { status: 'resolved', resolution: c.reason }); rl(); st.reload(); } catch (e) { toast.error(e); } } }]}
            emptyTitle="No issues logged" emptyText="Use More (⋮) → Log an issue to record performance, attendance or client feedback." />}
          {tab === 'documents' && <Documents id={id!} />}
          {tab === 'activity' && <Card pad><Timeline type="placement" id={id!} reloadKey={rk} /></Card>}
        </Boundary>
      </div>
      <Dialog open={!!blocked} onClose={() => setBlocked(null)} title="Activation blocked" footer={<><Button onClick={() => setBlocked(null)}>Close</Button><Button onClick={() => { setBlocked(null); setSp({ tab: 'onboarding' }, { replace: true }); }}>Open checklist</Button>{p.can.approve && <Button variant="danger" disabled={overrideReason.trim().length < 5} loading={busy} onClick={() => activate(overrideReason)}>Override & activate</Button>}</>}>
        <p className="muted" style={{ marginTop: 0 }}>These required onboarding items are incomplete:</p>
        <ul>{(blocked ?? []).map(t => <li key={t}><b>{t}</b></li>)}</ul>
        {p.can.approve ? <Field label="Override reason (audited, owners & admins are notified)" htmlFor="ov-r"><textarea id="ov-r" className="textarea" value={overrideReason} onChange={e => setOverrideReason(e.target.value)} placeholder="Why activate before these items are complete?" /></Field> : <div className="small muted">Only roles with placement approval can override.</div>}
      </Dialog>
      <OffboardDialog open={offboard} onClose={() => setOffboard(false)} p={p} onDone={reload} />
      <IssueDrawer open={issueOpen} onClose={() => setIssueOpen(false)} placementId={id} onSaved={reload} />
      <EditDialog open={edit} onClose={() => setEdit(false)} p={p} onDone={reload} />
    </div>
  );
}

function Overview({ p }: { p: any }) {
  const nav = useNavigate();
  return (
    <div className="grid-main-side">
      <div className="stack" style={{ gap: 20 }}>
        <Card pad><KV items={[
          ['Client', p.company_name], ['Role', p.title], ['Status', <StatusPill key="s" status={p.status} />], ['Start date', date(p.start_date)], ['End date', p.end_date ? `${date(p.end_date)}${p.end_reason ? ` — ${p.end_reason}` : ''}` : '—'],
          ['Schedule', `${scheduleText(p.schedule_days, p.schedule_start, p.schedule_end)} · ${p.weekly_hours}h/week`], ['Timezone', p.timezone], ['Monitoring policy', `${p.policy_name ?? '—'}${p.policy_accepted_at ? ` · accepted ${dateTime(p.policy_accepted_at)}` : ' · not yet accepted by worker'}`],
          ['Account manager', p.account_manager_name], ['Recruiter', p.recruiter_name], ['Sales', p.sales_name], ['Activated', p.activated_at ? `${dateTime(p.activated_at)} by ${p.activated_by_name ?? '—'}` : '—'],
          ['Active-worker seat', p.seat ? `${dateTime(p.seat.started_at)} → ${p.seat.ended_at ? dateTime(p.seat.ended_at) : 'running'}` : 'Starts on activation'],
          ...(p.can.view_comp && p.current_rate ? [['Current rate', `Pay ${money(p.current_rate.pay_rate_cents, p.current_rate.currency)} · Bill ${money(p.current_rate.bill_rate_cents, p.current_rate.currency)} per ${p.current_rate.unit} (from ${date(p.current_rate.effective_from)})`] as [string, string]] : []),
          ['Equipment', (p.equipment ?? []).length ? (p.equipment as string[]).join(' · ') : '—'],
        ]} /></Card>
        {p.related.length > 0 && <Card><CardHeader title="Replacement history" sub="Both placements are kept — history is never overwritten" />
          <table className="table"><tbody>{p.related.map((r: any) => <tr key={r.id} className="clickable" onClick={() => nav(`/workforce/placements/${r.id}`)}><td>{r.relation === 'replaces' ? 'Replaces' : 'Replaced by'}</td><td className="bold">{r.worker_name}</td><td><StatusPill status={r.status} /></td><td className="small muted">{date(r.start_date)} → {r.end_date ? date(r.end_date) : 'ongoing'}</td></tr>)}</tbody></table></Card>}
      </div>
      <div className="stack" style={{ gap: 20 }}>
        <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}>Live</div>
          {p.presence && p.presence.state !== 'offline' ? <div className="stack" style={{ gap: 8, marginTop: 10 }}><div className="row" style={{ justifyContent: 'space-between' }}><LivePill status={p.presence.state} /><SinceTimer from={p.presence.session_started_at} /></div><ActivityMeter value={p.presence.activity_pct} /><div className="small muted">Screen share: {p.presence.screen_share ?? '—'}</div><Link className="small" to={`/time/screenshots?worker_id=${p.worker_id}`}>Today's screenshots & activity →</Link></div> : <div className="small muted" style={{ marginTop: 8 }}>Not clocked in right now.</div>}
        </Card>
        <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}>Onboarding</div><div style={{ marginTop: 12 }}><Progress done={p.onboarding.req_done} total={p.onboarding.req_total} label={`${p.onboarding.req_done}/${p.onboarding.req_total} required`} /></div><div className="small muted mt-1">{p.onboarding.done}/{p.onboarding.total} items done overall</div></Card>
        <Card pad><KV items={[['Timesheets submitted', p.timesheet_stats.submitted], ['Timesheets approved', p.timesheet_stats.approved], ['Approved hours', hrs(p.timesheet_stats.approved_minutes, 0)], ['Open issues', p.issues.open]]} /></Card>
      </div>
    </div>
  );
}

function Onboarding({ p, onChange }: { p: any; onChange: () => void }) {
  const st = useApi<any[]>(`/api/v1/placements/${p.id}/onboarding`);
  const confirm = useConfirm();
  const [title, setTitle] = useState(''); const [req, setReq] = useState(false); const [owner, setOwner] = useState('agency');
  const editable = p.can.onboarding && p.status !== 'ended';
  const patch = async (it: any, body: any) => { try { await api.patch(`/api/v1/onboarding/items/${it.id}`, body); st.reload(); onChange(); } catch (e) { toast.error(e); } };
  const add = async () => { try { await api.post(`/api/v1/placements/${p.id}/onboarding`, { title, required: req, owner }); setTitle(''); setReq(false); st.reload(); onChange(); toast.success('Item added'); } catch (e) { toast.error(e); } };
  const remove = async (it: any) => { const r = await confirm({ title: `Remove “${it.title}”?`, body: 'The removal is recorded on the activity timeline.', danger: true, confirmLabel: 'Remove' }); if (!r.ok) return; try { await api.del(`/api/v1/onboarding/items/${it.id}`); st.reload(); onChange(); } catch (e) { toast.error(e); } };
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  const groups = ['agency', 'client', 'position', 'manual'].map(src => ({ src, items: st.data!.filter(i => i.source === src) })).filter(g => g.items.length);
  const reqOpen = st.data.filter(i => i.required && !i.done_at).length;
  return (
    <div className="grid-main-side">
      <Card><CardHeader title="Onboarding checklist" sub={`${st.data.filter(i => i.done_at).length}/${st.data.length} done · ${reqOpen} required open`} />
        <div style={{ padding: '0 20px 12px' }}>
          {groups.map(g => <div key={g.src}><div className="wf-section-label" style={{ marginTop: 14 }}>{g.src === 'agency' ? 'Agency template' : g.src === 'client' ? 'Client requirements' : g.src === 'position' ? 'Position requirements' : 'Manual additions'}</div>
            {g.items.map(it => <div key={it.id} className="checklist-item">
              <input type="checkbox" aria-label={`Mark ${it.title} ${it.done_at ? 'not done' : 'done'}`} checked={!!it.done_at} disabled={!editable} onChange={e => patch(it, { done: e.target.checked })} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={it.done_at ? 'muted' : 'bold'} style={{ textDecoration: it.done_at ? 'line-through' : undefined }}>{it.title}</div>
                <div className="small muted">Owner: {it.owner}{it.done_at ? ` · done ${dateTime(it.done_at)}${it.done_by_name ? ` by ${it.done_by_name}` : ''}` : ''}{it.source === 'manual' && it.created_by_name ? ` · added by ${it.created_by_name}` : ''}{it.required_changed_at ? ` · requirement changed by ${it.required_changed_by_name ?? '—'} ${dateTime(it.required_changed_at)}` : ''}</div>
              </div>
              <button className={`pill ${it.required ? 'pill-red' : 'pill-gray'}`} style={{ border: 'none', cursor: editable ? 'pointer' : 'default' }} disabled={!editable} onClick={() => patch(it, { required: !it.required })} title={editable ? 'Toggle required / optional' : undefined}>{it.required ? 'Required' : 'Optional'}</button>
              {editable && it.source === 'manual' && <button className="icon-btn" aria-label={`Remove ${it.title}`} onClick={() => remove(it)}><Trash2 size={15} /></button>}
            </div>)}
          </div>)}
          {!st.data.length && <EmptyState title="No checklist items" />}
        </div>
      </Card>
      <div className="stack" style={{ gap: 20 }}>
        {editable && <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}>Add a manual item</div>
          <div className="stack" style={{ gap: 10, marginTop: 12 }}>
            <Field label="Title" htmlFor="ob-t"><input id="ob-t" className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Client CRM login created" /></Field>
            <Field label="Owner" htmlFor="ob-o"><select id="ob-o" className="select" value={owner} onChange={e => setOwner(e.target.value)}><option value="agency">Agency</option><option value="worker">Worker</option><option value="client">Client</option></select></Field>
            <label className="check"><input type="checkbox" checked={req} onChange={e => setReq(e.target.checked)} /> Required for activation</label>
            <Button icon={<Plus size={15} />} disabled={title.trim().length < 2} onClick={add}>Add item</Button>
          </div></Card>}
        <Card pad><div className="small muted">Activation is blocked only by incomplete <b>required</b> items. Optional items can stay open. Workers can complete their own (owner: worker) items from the Worker Portal.</div></Card>
      </div>
    </div>
  );
}

function Rates({ id }: { id: string }) {
  const st = useApi<any>(`/api/v1/placements/${id}/rates`);
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<any>({ effective_from: todayISO(), reason: '' });
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  const d = st.data;
  const cur = d.rates.find((r: any) => r.is_current) ?? d.rates[0];
  const save = async () => {
    setBusy(true);
    try { const r = await api.post(`/api/v1/placements/${id}/rates`, v); (r.warnings ?? []).forEach((w: string) => toast.info(w)); toast.success('New rate added (effective-dated)'); setOpen(false); st.reload(); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrs(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader title="Rate history" sub="Effective-dated — past economics are never overwritten" right={d.can_edit && d.can_view_comp ? <Button size="sm" icon={<Plus size={14} />} onClick={() => { setV({ effective_from: todayISO(), reason: '', pay_rate_cents: cur?.pay_rate_cents, bill_rate_cents: cur?.bill_rate_cents, currency: cur?.currency, unit: cur?.unit }); setErrs({}); setOpen(true); }}>Add rate change</Button> : null} />
      {!d.can_view_comp && <div className="card-b"><Banner tone="info">Pay and bill amounts are restricted for your role.</Banner></div>}
      {d.rates.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Effective</th><th>Status</th>{d.can_view_comp && <><th className="right">Pay</th><th className="right">Bill</th><th className="right">Margin</th></>}<th>Reason</th><th>By</th><th className="right">Invoiced / paid days</th></tr></thead><tbody>
        {d.rates.map((r: any) => <tr key={r.id}><td>{date(r.effective_from)} → {r.effective_to ? date(r.effective_to) : 'open'}</td><td>{r.is_current ? <StatusPill status="active" label="Current" /> : r.is_future ? <StatusPill status="scheduled" label="Scheduled" /> : <StatusPill status="closed" label="Past" />}</td>
          {d.can_view_comp && <><td className="right money">{money(r.pay_rate_cents, r.currency)}/{r.unit}</td><td className="right money">{money(r.bill_rate_cents, r.currency)}/{r.unit}</td><td className="right">{r.margin_pct !== undefined && r.margin_pct !== null ? `${Number(r.margin_pct).toFixed(1)}%` : '—'}</td></>}
          <td className="small">{r.reason ?? '—'}</td><td className="small">{r.created_by_name ?? '—'}</td><td className="right small">{r.invoiced_days} / {r.paid_days}</td></tr>)}
      </tbody></table></div> : <EmptyState title="No rates" />}
      <Dialog open={open} onClose={() => setOpen(false)} title="Add rate change" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!v.reason?.trim()} onClick={save}>Save rate</Button></>}>
        <div className="form-grid">
          <Field label="Effective from" htmlFor="rt-ef" error={errs.effective_from}><input id="rt-ef" type="date" className="input" value={v.effective_from} onChange={e => setV({ ...v, effective_from: e.target.value })} /></Field>
          <div />
          <Field label="Pay rate" htmlFor="rt-pay" error={errs.pay_rate_cents}><MoneyInput id="rt-pay" cents={v.pay_rate_cents} onChange={c => setV({ ...v, pay_rate_cents: c })} /></Field>
          <Field label="Bill rate" htmlFor="rt-bill" error={errs.bill_rate_cents}><MoneyInput id="rt-bill" cents={v.bill_rate_cents} onChange={c => setV({ ...v, bill_rate_cents: c })} /></Field>
          <Field label="Reason *" htmlFor="rt-r" error={errs.reason} full><input id="rt-r" className="input" value={v.reason} onChange={e => setV({ ...v, reason: e.target.value })} placeholder="e.g. Performance raise" /></Field>
        </div>
      </Dialog>
    </Card>
  );
}

function ScheduleMonitoring({ p, onChange }: { p: any; onChange: () => void }) {
  const policies = useApi<any[]>('/api/v1/time/policies');
  const tpls = useApi<any[]>('/api/v1/equipment-templates');
  const [eq, setEq] = useState<string[]>(p.equipment ?? []);
  const [newEq, setNewEq] = useState('');
  useEffect(() => setEq(p.equipment ?? []), [p.equipment]);
  const confirm = useConfirm();
  const editable = p.can.edit && p.status !== 'ended';
  const pol = (policies.data ?? []).find(x => x.id === p.monitoring_policy_id);
  const changePolicy = async (pid: string) => {
    const r = await confirm({ title: 'Change monitoring policy?', body: 'The worker must review and accept the new policy before their next clock-in. This change is audited.', confirmLabel: 'Change policy' });
    if (!r.ok) return;
    try { await api.patch(`/api/v1/placements/${p.id}`, { monitoring_policy_id: pid }); toast.success('Policy changed'); onChange(); } catch (e) { toast.error(e); }
  };
  const saveEq = async (items: string[]) => { try { await api.patch(`/api/v1/placements/${p.id}`, { equipment: items }); setEq(items); toast.success('Equipment updated'); onChange(); } catch (e) { toast.error(e); } };
  const applyTpl = async (tid: string) => { try { const r = await api.post(`/api/v1/placements/${p.id}/equipment/apply-template`, { template_id: tid }); setEq(r.equipment); toast.success('Template applied'); onChange(); } catch (e) { toast.error(e); } };
  return (
    <div className="grid-2">
      <Card><CardHeader title="Schedule" sub="Used for attendance (late / absent / early leave) in the placement timezone" />
        <div className="card-b"><KV items={[['Workdays', (p.schedule_days ?? []).map((d: number) => DOW[d - 1]).join(', ')], ['Shift', `${p.schedule_start.slice(0, 5)} – ${p.schedule_end.slice(0, 5)}`], ['Timezone', p.timezone], ['Weekly hours', `${p.weekly_hours}h`]]} />
          <div className="small muted" style={{ marginTop: 10 }}>Edit via More (⋮) → Edit details.</div></div>
      </Card>
      <Card><CardHeader title="Monitoring policy" sub={p.policy_accepted_at ? `Accepted by the worker ${dateTime(p.policy_accepted_at)}` : 'Not yet accepted by the worker'} />
        <div className="card-b">
          {editable && <Field label="Policy" htmlFor="sm-pol"><select id="sm-pol" className="select" value={p.monitoring_policy_id ?? ''} onChange={e => changePolicy(e.target.value)}>{(policies.data ?? []).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
          {pol ? <ul className="wf-policy small" style={{ paddingLeft: 18 }}>
            <li>Screenshots: <b>{pol.screenshots_enabled ? `every ${pol.screenshot_interval_min} min, at a random moment` : 'off'}</b>{pol.blur ? ' (blurred)' : ''}</li>
            <li>Activity tracking: <b>{pol.activity_tracking ? 'keyboard/mouse counts only — never content' : 'off'}</b></li>
            <li>Idle prompt after <b>{pol.idle_minutes} min</b> without input</li><li>Retention: <b>{pol.retention_days} days</b>, then auto-deleted</li>
            <li>Worker can delete a screenshot within <b>{pol.worker_delete_window_min} min</b> (logged)</li><li>Client can view screenshots: <b>{pol.client_can_view ? 'yes' : 'no'}</b></li>
          </ul> : <div className="muted small">{p.policy_name ?? 'No policy'}</div>}
        </div>
      </Card>
      <Card><CardHeader title="Equipment" sub="From a reusable template, overridable per placement" right={editable && (tpls.data ?? []).length ? <select className="select input-sm" style={{ width: 'auto' }} aria-label="Apply equipment template" value="" onChange={e => e.target.value && applyTpl(e.target.value)}><option value="">Apply template…</option>{(tpls.data ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select> : null} />
        <div className="card-b">
          {eq.length ? eq.map((it, i) => <div key={i} className="checklist-item"><span style={{ flex: 1 }}>{it}</span>{editable && <button className="icon-btn" aria-label={`Remove ${it}`} onClick={() => saveEq(eq.filter((_, j) => j !== i))}><Trash2 size={14} /></button>}</div>) : <div className="muted small">No equipment listed.</div>}
          {editable && <div className="row" style={{ gap: 8, marginTop: 10 }}><input className="input input-sm" aria-label="New equipment item" placeholder="Add equipment item" value={newEq} onChange={e => setNewEq(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newEq.trim()) { saveEq([...eq, newEq.trim()]); setNewEq(''); } }} /><Button size="sm" disabled={!newEq.trim()} onClick={() => { saveEq([...eq, newEq.trim()]); setNewEq(''); }}>Add</Button></div>}
        </div>
      </Card>
    </div>
  );
}

function Documents({ id }: { id: string }) {
  const st = useApi<any>(`/api/v1/placements/${id}/documents`);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock />;
  if (st.data.restricted) return <EmptyState title="Documents are restricted" text="Your role cannot view documents." />;
  return <Card><CardHeader title="Documents" sub="Worker contracts, IDs and compliance documents" />
    {st.data.rows.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Category</th><th>Verification</th><th>Signature</th><th>Expires</th><th /></tr></thead><tbody>{st.data.rows.map((d: any) => <tr key={d.id}><td><FileText size={14} /> {d.name}</td><td>{humanize(d.category)}</td><td><StatusPill status={d.verification} /></td><td>{d.signature_status ? <StatusPill status={d.signature_status} /> : '—'}</td><td>{d.expires_at ? date(d.expires_at) : '—'}</td><td className="right">{d.url ? <a href={d.url} target="_blank" rel="noreferrer">Open</a> : null}</td></tr>)}</tbody></table></div> : <EmptyState title="No documents" />}
  </Card>;
}

function OffboardDialog({ open, onClose, p, onDone }: { open: boolean; onClose: () => void; p: any; onDone: () => void }) {
  const [v, setV] = useState({ end_date: todayISO(), reason: '', final_timesheet: true });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setV({ end_date: todayISO(), reason: '', final_timesheet: true }); }, [open]);
  const go = async () => {
    setBusy(true);
    try { const r = await api.post(`/api/v1/placements/${p.id}/offboard`, v); toast.success(r.scheduled ? `Offboarding scheduled for ${r.end_date}` : `Offboarded${r.submitted?.length ? ' — final timesheet submitted' : ''}`); onClose(); onDone(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={p.status === 'onboarding' ? `Cancel placement for ${p.worker_name}` : `Offboard ${p.worker_name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={v.reason.trim().length < 3} onClick={go}>{v.end_date > todayISO() ? 'Schedule offboarding' : 'Offboard now'}</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="small muted">Tracking stops, the active-worker seat ends and the worker portal keeps their history. A future end date puts the placement on notice until then.</div>
        <Field label="End date" htmlFor="ob-ed"><input id="ob-ed" type="date" className="input" value={v.end_date} min={p.start_date} onChange={e => setV({ ...v, end_date: e.target.value })} /></Field>
        <Field label="Reason *" htmlFor="ob-rs"><textarea id="ob-rs" className="textarea" value={v.reason} onChange={e => setV({ ...v, reason: e.target.value })} placeholder="e.g. Client downsized team" /></Field>
        <label className="check"><input type="checkbox" checked={v.final_timesheet} onChange={e => setV({ ...v, final_timesheet: e.target.checked })} /> Submit the final timesheet for approval</label>
      </div>
    </Dialog>
  );
}

function EditDialog({ open, onClose, p, onDone }: { open: boolean; onClose: () => void; p: any; onDone: () => void }) {
  const [v, setV] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  useEffect(() => { if (open) { setErrs({}); setV({ title: p.title, schedule_days: p.schedule_days, schedule_start: p.schedule_start.slice(0, 5), schedule_end: p.schedule_end.slice(0, 5), timezone: p.timezone, weekly_hours: p.weekly_hours, account_manager_id: p.account_manager_id, recruiter_id: p.recruiter_id, sales_id: p.sales_id, ...(p.status === 'onboarding' ? { start_date: p.start_date } : {}) }); } }, [open, p]);
  const save = async () => {
    setBusy(true);
    try { await api.patch(`/api/v1/placements/${p.id}`, { ...v, weekly_hours: Number(v.weekly_hours) }); toast.success('Placement updated'); onClose(); onDone(); } catch (e) { if (e instanceof ApiError && e.fields) setErrs(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} wide title="Edit placement" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Role title" htmlFor="ed-t" error={errs.title}><input id="ed-t" className="input" value={v.title ?? ''} onChange={e => setV({ ...v, title: e.target.value })} /></Field>
        {p.status === 'onboarding' ? <Field label="Start date" htmlFor="ed-sd"><input id="ed-sd" type="date" className="input" value={v.start_date ?? ''} onChange={e => setV({ ...v, start_date: e.target.value })} /></Field> : <div />}
        <Field label="Workdays" full><div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{DOW.map((n, i) => { const on = (v.schedule_days ?? []).includes(i + 1); return <button key={n} type="button" className={`btn btn-sm ${on ? 'btn-primary' : ''}`} aria-pressed={on} onClick={() => setV({ ...v, schedule_days: on ? v.schedule_days.filter((x: number) => x !== i + 1) : [...v.schedule_days, i + 1].sort() })}>{n}</button>; })}</div></Field>
        <Field label="Shift start" htmlFor="ed-ss"><input id="ed-ss" type="time" className="input" value={v.schedule_start ?? ''} onChange={e => setV({ ...v, schedule_start: e.target.value })} /></Field>
        <Field label="Shift end" htmlFor="ed-se" error={errs.schedule_end}><input id="ed-se" type="time" className="input" value={v.schedule_end ?? ''} onChange={e => setV({ ...v, schedule_end: e.target.value })} /></Field>
        <Field label="Timezone" htmlFor="ed-tz" error={errs.timezone}><select id="ed-tz" className="select" value={v.timezone ?? ''} onChange={e => setV({ ...v, timezone: e.target.value })}>{[...new Set([v.timezone, ...TIMEZONES].filter(Boolean))].map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></Field>
        <Field label="Weekly hours" htmlFor="ed-wh"><input id="ed-wh" type="number" className="input" value={v.weekly_hours ?? ''} onChange={e => setV({ ...v, weekly_hours: e.target.value })} /></Field>
        <Field label="Account manager" htmlFor="ed-am"><MemberSelect id="ed-am" value={v.account_manager_id} onChange={x => setV({ ...v, account_manager_id: x })} /></Field>
        <Field label="Recruiter" htmlFor="ed-rc"><MemberSelect id="ed-rc" value={v.recruiter_id} onChange={x => setV({ ...v, recruiter_id: x })} /></Field>
        <Field label="Sales" htmlFor="ed-sl"><MemberSelect id="ed-sl" value={v.sales_id} onChange={x => setV({ ...v, sales_id: x })} /></Field>
      </div>
    </Dialog>
  );
}
