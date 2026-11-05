import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, X, Send, Wand2, PlusCircle } from 'lucide-react';
import { Card, CardHeader, Button, StatusPill, Avatar, Menu, KV, EmptyState, ErrorState, LoadingBlock, Banner, Dialog, Field, useConfirm, BackButton } from '../../components/ui';
import { Timeline } from '../../components/Timeline';
import { useApi } from '../../lib/hooks';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, dateTime, time as fmtTime, humanize } from '../../lib/format';
import { hm, hrs, DOW, useRealtime } from '../workforce/shared';

/** Days grid + entries + history; shared by agency detail and client portal drawer. */
export function TimesheetBody({ t }: { t: any }) {
  const total = t.days.reduce((a: number, d: any) => a + (d.approved_minutes ?? d.tracked_minutes) + d.adjustment_minutes, 0);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <Card><CardHeader title="Week" sub={t.status === 'approved' || t.status === 'locked' ? 'Approved minutes are an immutable snapshot; corrections appear as adjustments.' : 'Live from tracked time entries (net of breaks and discarded idle time).'} />
        <div className="table-wrap"><table className="table wf-days-table"><thead><tr><th>Day</th>{t.days.map((d: any, i: number) => <th key={d.date}>{DOW[i]}<div className="small muted">{date(d.date, { month: 'short', day: 'numeric' })}</div></th>)}<th>Total</th></tr></thead><tbody>
          <tr><td>Tracked</td>{t.days.map((d: any) => <td key={d.date} className="num">{d.tracked_minutes ? hm(d.tracked_minutes) : '—'}</td>)}<td className="num bold">{hm(t.days.reduce((a: number, d: any) => a + d.tracked_minutes, 0))}</td></tr>
          {(t.status === 'approved' || t.status === 'locked') && <tr><td>Approved</td>{t.days.map((d: any) => <td key={d.date} className="num">{d.approved_minutes !== null ? hm(d.approved_minutes) : '—'}{d.invoiced ? <div className="tiny muted">invoiced</div> : null}{d.paid ? <div className="tiny muted">paid</div> : null}</td>)}<td className="num bold">{hm(t.days.reduce((a: number, d: any) => a + (d.approved_minutes ?? 0), 0))}</td></tr>}
          {t.adjustments.length > 0 && <tr><td>Corrections</td>{t.days.map((d: any) => <td key={d.date} className="num">{d.adjustment_minutes ? hm(d.adjustment_minutes) : '—'}</td>)}<td className="num bold">{hm(t.days.reduce((a: number, d: any) => a + d.adjustment_minutes, 0))}</td></tr>}
          <tr><td>Signals</td>{t.days.map((d: any) => <td key={d.date}>{d.attendance.map((a: any, i: number) => <div key={i} className="tiny"><StatusPill status={a.kind} label={humanize(a.kind)} /></div>)}</td>)}<td className="num bold">{hm(total)}</td></tr>
        </tbody></table></div>
      </Card>
      <Card><CardHeader title="Time entries" sub={`${t.entries.length} session(s)`} />
        {t.entries.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Start</th><th>End</th><th>Source</th><th>Memo</th><th className="right">Breaks</th><th className="right">Idle discarded</th><th className="right">Net</th></tr></thead><tbody>
          {t.entries.map((e: any) => <tr key={e.id}><td>{date(e.work_date, { weekday: 'short', month: 'short', day: 'numeric' })}</td><td>{fmtTime(e.started_at)}</td><td>{e.ended_at ? fmtTime(e.ended_at) : <span className="pill pill-green">Running</span>}</td><td>{humanize(e.source)}</td><td className="small">{e.memo ?? '—'}</td><td className="right">{Math.round(e.break_seconds / 60)}m</td><td className="right">{Math.round(e.discarded_idle_seconds / 60)}m</td><td className="right num">{hm(e.minutes)}</td></tr>)}
        </tbody></table></div> : <EmptyState title="No time tracked this week" />}
      </Card>
      {t.adjustments.length > 0 && <Card><CardHeader title="Corrections after approval" />
        <table className="table"><tbody>{t.adjustments.map((a: any) => <tr key={a.id}><td>{date(a.work_date)}</td><td className="num">{a.minutes_delta > 0 ? '+' : ''}{a.minutes_delta} min</td><td className="small">{a.reason}</td><td className="small muted">{a.created_by_name ?? '—'} · {dateTime(a.created_at)}</td><td className="small">{a.applied_invoice_id ? 'Billed' : 'Not yet billed'}</td></tr>)}</tbody></table></Card>}
    </div>
  );
}

export default function TimesheetDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const st = useApi<any>(`/api/v1/timesheets/${id}`);
  const confirm = useConfirm();
  const [adj, setAdj] = useState(false);
  const [av, setAv] = useState<any>({ work_date: '', minutes_delta: '', reason: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [rk, setRk] = useState(0);
  useRealtime('timesheet', d => { if (d.id === id) st.reload(); });
  if (st.error && !st.data) return <div><BackButton fallback="/time/timesheets" /><ErrorState error={st.error} retry={st.reload} /></div>;
  if (!st.data) return <LoadingBlock rows={8} />;
  const t = st.data;
  const reload = () => { st.reload(); setRk(k => k + 1); };
  const needAgency = t.needs.agency && !t.agency_approved_at, needClient = t.needs.client && !t.client_approved_at;
  const approve = async (onBehalf = false) => {
    let reason: string | undefined;
    if (onBehalf) { const r = await confirm({ title: 'Approve on behalf of the client?', body: `${t.company_name} normally approves in the Client Portal. This is audited.`, reason: { label: 'Why (e.g. client confirmed by email)', required: true } }); if (!r.ok) return; reason = r.reason; }
    setBusy(true);
    try { const r = await api.post(`/api/v1/timesheets/${id}/approve`, { on_behalf_of_client: onBehalf, reason }); toast.success(r.final ? 'Timesheet approved — locked for invoicing & payroll' : 'Agency approval recorded — awaiting client'); reload(); }
    catch (e) { if (e instanceof ApiError && e.details?.needs_on_behalf) { setBusy(false); return approve(true); } toast.error(e); } finally { setBusy(false); }
  };
  const reject = async () => {
    const r = await confirm({ title: 'Reject timesheet', body: 'The worker and account manager are notified; the worker can fix and resubmit.', reason: { label: 'Reason', required: true }, danger: true, confirmLabel: 'Reject' });
    if (!r.ok) return;
    try { await api.post(`/api/v1/timesheets/${id}/reject`, { reason: r.reason }); toast.success('Timesheet rejected'); reload(); } catch (e) { toast.error(e); }
  };
  const submit = async () => { try { await api.post(`/api/v1/timesheets/${id}/submit`); toast.success('Submitted on behalf of the worker'); reload(); } catch (e) { toast.error(e); } };
  const simulate = async () => {
    const r = await confirm({ title: 'Simulate the rest of this week?', body: 'Demo mode: creates realistic sessions, screenshots and activity for every unworked scheduled day, then submits.', confirmLabel: 'Simulate & submit' });
    if (!r.ok) return;
    try { const x = await api.post(`/api/v1/placements/${t.placement_id}/simulate-week`, { submit: true, week_start: t.week_start }); toast.success(`Simulated ${x.days.length} day(s)${x.submitted ? ' — submitted' : ''}`); reload(); } catch (e) { toast.error(e); }
  };
  const saveAdj = async () => {
    setBusy(true);
    try { await api.post(`/api/v1/timesheets/${id}/adjust`, { ...av, minutes_delta: Number(av.minutes_delta) }); toast.success('Correction recorded'); setAdj(false); reload(); } catch (e) { if (e instanceof ApiError && e.fields) setErrs(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  const canAct = t.status === 'submitted' && t.can.approve;
  return (
    <div>
      <BackButton fallback="/time/timesheets" />
      <Card>
        <div className="detail-head">
          <Avatar name={t.worker_name} color={t.avatar_color} size={56} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}><h1 style={{ margin: 0 }}>{t.worker_name}</h1><StatusPill status={t.status} /></div>
            <div className="muted mt-1">Week of {date(t.week_start)} · <Link to={`/workforce/placements/${t.placement_id}?tab=timesheets`}>{t.title} @ {t.company_name}</Link></div>
            <div className="row small muted" style={{ gap: 14, marginTop: 8, flexWrap: 'wrap' }}><span>Total <b>{hrs(t.total_minutes, 2)}</b></span><span>Approval: <b>{humanize(t.timesheet_approval)}</b></span><span>Activity <b>{t.avg_activity !== null ? `${t.avg_activity}%` : '—'}</b></span><span>Screenshots <b>{t.screenshots.n}</b>{t.screenshots.flagged ? ` (${t.screenshots.flagged} flagged)` : ''}</span><span>AM <b>{t.account_manager_name ?? '—'}</b></span></div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {canAct && <Button variant="danger" icon={<X size={16} />} onClick={reject}>Reject</Button>}
            {canAct && needAgency && <Button variant="primary" icon={<Check size={16} />} loading={busy} onClick={() => approve(false)}>Approve</Button>}
            {canAct && !needAgency && needClient && <Button variant="primary" icon={<Check size={16} />} loading={busy} onClick={() => approve(true)}>Approve for client</Button>}
            <Menu items={[
              { label: 'Submit on behalf of worker', icon: <Send size={15} />, hidden: !['open', 'rejected'].includes(t.status) || !t.can.edit, onClick: submit },
              { label: 'Simulate rest of week (demo)', icon: <Wand2 size={15} />, hidden: !['open', 'rejected'].includes(t.status) || !t.can.simulate, onClick: simulate },
              { label: 'Add correction', icon: <PlusCircle size={15} />, hidden: !['approved', 'locked'].includes(t.status) || !t.can.approve, onClick: () => { setAv({ work_date: t.week_start, minutes_delta: '', reason: '' }); setErrs({}); setAdj(true); } },
              { label: 'Screenshots & activity', onClick: () => nav(`/time/screenshots?worker_id=${t.worker_id}&date=${t.week_start}`) },
              { label: 'Open placement', onClick: () => nav(`/workforce/placements/${t.placement_id}`) },
            ]} />
          </div>
        </div>
      </Card>
      <div style={{ marginTop: 16 }}>
        {t.status === 'rejected' && <Banner tone="danger">Rejected: “{t.rejected_reason}”. Waiting for the worker to fix and resubmit.</Banner>}
        {t.status === 'submitted' && <Banner>{needAgency && needClient ? 'Needs agency and client approval.' : needAgency ? 'Needs agency approval.' : needClient ? `Waiting for ${t.company_name} to approve in the Client Portal.` : 'Approved by all parties.'}{t.agency_approved_at ? ` Agency approved by ${t.agency_approved_by_name ?? '—'} ${dateTime(t.agency_approved_at)}.` : ''}{t.client_approved_at ? ` Client approved by ${t.client_approved_by_name ?? '—'} ${dateTime(t.client_approved_at)}.` : ''}</Banner>}
        {t.open_entries > 0 && <Banner tone="warn">The worker is clocked in right now — approval is available after they clock out.</Banner>}
      </div>
      <div className="grid-main-side" style={{ marginTop: 20 }}>
        <TimesheetBody t={t} />
        <div className="stack" style={{ gap: 20 }}>
          <Card pad><KV items={[['Status', <StatusPill key="s" status={t.status} />], ['Submitted', dateTime(t.submitted_at)], ['Agency approval', t.agency_approved_at ? `${t.agency_approved_by_name ?? '—'} · ${dateTime(t.agency_approved_at)}` : t.needs.agency ? 'Pending' : 'Not required'], ['Client approval', t.client_approved_at ? `${t.client_approved_by_name ?? '—'} · ${dateTime(t.client_approved_at)}` : t.needs.client ? 'Pending' : 'Not required'], ['Approved', dateTime(t.approved_at)], ['Locked', dateTime(t.locked_at)]]} /></Card>
          <Card><CardHeader title="Approval history" />{t.history.length ? <div className="card-b stack" style={{ gap: 10 }}>{t.history.map((h: any, i: number) => <div key={i} className="small"><b>{humanize(h.decision)}</b> by {h.actor_name ?? (h.decision === 'submitted' ? 'worker' : 'system')} ({h.party}) · {dateTime(h.created_at)}{h.reason && <div className="muted">{h.reason}</div>}</div>)}</div> : <EmptyState title="No approvals yet" />}</Card>
          <Card pad><Timeline type="timesheet" id={id!} reloadKey={rk} /></Card>
        </div>
      </div>
      <Dialog open={adj} onClose={() => setAdj(false)} title="Add correction" footer={<><Button onClick={() => setAdj(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={saveAdj}>Save correction</Button></>}>
        <p className="small muted" style={{ marginTop: 0 }}>Approved days are never edited. A correction creates an adjustment row that Finance applies on the next invoice / payroll.</p>
        <div className="form-grid">
          <Field label="Day" htmlFor="aj-d" error={errs.work_date}><select id="aj-d" className="select" value={av.work_date} onChange={e => setAv({ ...av, work_date: e.target.value })}>{t.days.map((d: any) => <option key={d.date} value={d.date}>{date(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}</option>)}</select></Field>
          <Field label="Minutes (+/−)" htmlFor="aj-m" error={errs.minutes_delta} hint="e.g. 30 or -15"><input id="aj-m" type="number" className="input" value={av.minutes_delta} onChange={e => setAv({ ...av, minutes_delta: e.target.value })} /></Field>
          <Field label="Reason *" htmlFor="aj-r" error={errs.reason} full><textarea id="aj-r" className="textarea" value={av.reason} onChange={e => setAv({ ...av, reason: e.target.value })} /></Field>
        </div>
      </Dialog>
    </div>
  );
}
