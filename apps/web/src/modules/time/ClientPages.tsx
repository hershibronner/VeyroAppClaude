// Client Portal pages: Home, My Team, Worker detail, Timesheet approval (scoped to the client company server-side).
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Radio, Timer, FileCheck2, Receipt, ChevronLeft, ChevronRight, Check, X, Users } from 'lucide-react';
import { Card, CardHeader, Button, StatusPill, Avatar, EmptyState, ErrorState, LoadingBlock, Banner, KpiRow, Drawer, useConfirm, Async, Boundary, Segmented } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { ChartCard, SimpleBars, TrackBars, fmtHours } from '../../components/charts';
import { useApi, useInterval } from '../../lib/hooks';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, dateTime, money, todayISO, addDaysISO, humanize, delta, relTime } from '../../lib/format';
import { LivePill, SinceTimer, ActivityMeter, hm, hrs, scheduleText, useRealtime } from '../workforce/shared';
import { BlockTimeline } from './Screenshots';
import { TimesheetBody } from './TimesheetDetail';

function TeamCard({ r, onOpen }: { r: any; onOpen: () => void }) {
  return (
    <div className="wf-live-card" style={{ cursor: 'pointer' }} onClick={onOpen} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onOpen()}>
      {r.latest_shot?.url && <div className="thumb" style={{ cursor: 'pointer' }}><img src={r.latest_shot.url} alt="" loading="lazy" /><span className="ago">{relTime(r.latest_shot.taken_at)}</span></div>}
      <div className="body">
        <div className="top"><div className="row" style={{ gap: 10, minWidth: 0 }}><Avatar name={r.worker_name} color={r.avatar_color} size={36} /><div style={{ minWidth: 0 }}><div className="bold truncate">{r.worker_name}</div><div className="small muted truncate">{r.title}</div></div></div><LivePill status={r.status} /></div>
        {['working', 'idle', 'on_break'].includes(r.status) ? <><div className="meta"><span>Session <SinceTimer from={r.session_started_at} /></span><span>Today {hrs(r.today_minutes)}</span></div><ActivityMeter value={r.activity_pct} /></>
          : <div className="meta"><span>{r.shift ? `Shift ${r.shift}` : 'Not scheduled today'}{r.status === 'late' && r.late_minutes ? ` · ${r.late_minutes} min late` : ''}</span><span>Today {hrs(r.today_minutes)}</span></div>}
        {r.week_minutes !== undefined && <div className="meta"><span>This week</span><b>{hrs(r.week_minutes)}</b></div>}
      </div>
    </div>
  );
}

export function Home() {
  const nav = useNavigate();
  const st = useApi<any>('/api/v1/portal/client/home');
  const inv = useApi<any>('/api/v1/portal/client/invoices?status=open&pageSize=5&sort=due_date&dir=asc');
  useRealtime('presence', () => st.reload());
  useInterval(() => st.reload(), 60000);
  return <Async state={st} rows={6}>{d => {
    const live = (d.counts.working ?? 0) + (d.counts.idle ?? 0) + (d.counts.on_break ?? 0);
    const sum = inv.data?.summary;
    return (
      <div>
        <div style={{ marginBottom: 18 }}><h1 style={{ margin: 0 }}>{d.company.name}</h1><div className="muted">Your remote team right now{d.account_manager ? ` · Account manager: ${d.account_manager.name}` : ''}</div></div>
        {d.timesheets.awaiting > 0 && d.timesheets.needs_client_approval && <Banner tone="warn"><b>{d.timesheets.awaiting} timesheet{d.timesheets.awaiting === 1 ? '' : 's'} waiting for your approval.</b> <Link to="/portal/client/timesheets?awaiting=true">Review now →</Link></Banner>}
        {sum && sum.overdue_count > 0 && <Banner tone="danger"><b>{sum.overdue_count} invoice{sum.overdue_count === 1 ? ' is' : 's are'} overdue.</b> <Link to="/portal/client/invoices">Pay now →</Link></Banner>}
        <KpiRow items={[
          { label: 'Working now', icon: <Radio size={16} />, value: `${live}/${d.team.length}`, deltaText: <span>{d.counts.late ?? 0} late · {d.counts.absent ?? 0} absent</span>, suffix: '', to: '/portal/client/team' },
          { label: 'Hours this week', icon: <Timer size={16} />, value: hrs(d.hours.this_week, 0), delta: delta(d.hours.this_week, d.hours.last_week), suffix: 'vs all of last week' },
          { label: 'Timesheets to approve', icon: <FileCheck2 size={16} />, value: d.timesheets.needs_client_approval ? d.timesheets.awaiting : '—', deltaText: <span>{d.timesheets.needs_client_approval ? `${hrs(d.timesheets.approved_minutes_month, 0)} approved this month` : 'approved by your agency'}</span>, suffix: '', to: '/portal/client/timesheets' },
          { label: 'Invoices due', icon: <Receipt size={16} />, value: sum ? money(sum.open_cents) : '—', deltaText: <span>{sum ? `${sum.open_count} open${sum.next_due ? ` · next due ${date(sum.next_due)}` : ''}` : inv.error ? 'Invoices unavailable' : 'Loading…'}</span>, suffix: '', to: '/portal/client/invoices' },
        ]} />
        <div className="grid-main-side">
          <div className="stack" style={{ gap: 20 }}>
            <Card><CardHeader title="Team status now" right={<Button size="sm" onClick={() => nav('/portal/client/team')}>My team</Button>} />
              <div className="card-b">{d.team.length ? <div className="wf-live-grid">{d.team.map((r: any) => <TeamCard key={r.worker_id} r={r} onOpen={() => nav(`/portal/client/team/${r.worker_id}`)} />)}</div> : <EmptyState icon={<Users size={22} />} title="No active workers yet" />}</div>
            </Card>
          </div>
          <div className="stack" style={{ gap: 20 }}>
            <Boundary label="Hours"><ChartCard title="Team hours this week" big={hrs(d.hours.this_week, 1)}><SimpleBars data={d.daily} fmt={fmtHours} height={200} /></ChartCard></Boundary>
            <Card><CardHeader title="Open invoices" right={<Button size="sm" onClick={() => nav('/portal/client/invoices')}>All invoices</Button>} />
              {inv.error ? <div className="card-b"><ErrorState error={inv.error} retry={inv.reload} /></div> : !inv.data ? <LoadingBlock rows={2} /> : inv.data.rows.length ? <table className="table"><tbody>{inv.data.rows.map((i: any) => <tr key={i.id}><td><div className="bold">{i.number}</div><div className="small muted">Due {date(i.due_date)}{i.days_overdue ? ` · ${i.days_overdue} days overdue` : ''}</div></td><td><StatusPill status={i.status} /></td><td className="right money">{money(i.balance_cents, i.currency)}</td></tr>)}</tbody></table> : <EmptyState title="Nothing due" text="All invoices are paid." />}
            </Card>
          </div>
        </div>
      </div>
    );
  }}</Async>;
}

export function Team() {
  const nav = useNavigate();
  const st = useApi<any>('/api/v1/portal/client/team');
  const [view, setView] = useState<'all' | 'live'>('all');
  useRealtime('presence', () => st.reload());
  return <Async state={st} rows={6}>{d => {
    const rows = d.rows.filter((r: any) => view === 'all' || ['working', 'idle', 'on_break'].includes(r.status));
    return (
      <div>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}><div><h1 style={{ margin: 0 }}>My Team</h1><div className="muted small">{d.rows.length} active worker{d.rows.length === 1 ? '' : 's'} at {d.company.name}</div></div><Segmented value={view} onChange={setView} options={[{ key: 'all', label: 'Everyone' }, { key: 'live', label: 'Working now' }]} /></div>
        {rows.length ? <div className="wf-live-grid">{rows.map((r: any) => <TeamCard key={r.worker_id} r={r} onOpen={() => nav(`/portal/client/team/${r.worker_id}`)} />)}</div> : <EmptyState title={view === 'live' ? 'Nobody is working right now' : 'No active workers'} />}
        {d.onboarding.length > 0 && <Card style={{ marginTop: 20 }}><CardHeader title="Starting soon" />{<table className="table"><tbody>{d.onboarding.map((w: any) => <tr key={w.id}><td><div className="bold">{w.worker_name}</div><div className="small muted">{w.title}</div></td><td>Starts {date(w.start_date)}</td></tr>)}</tbody></table>}</Card>}
        {d.past.length > 0 && <Card style={{ marginTop: 20 }}><CardHeader title="Past team members" />{<table className="table"><tbody>{d.past.map((w: any, i: number) => <tr key={i} className="clickable" onClick={() => nav(`/portal/client/team/${w.id}`)}><td><div className="bold">{w.worker_name}</div><div className="small muted">{w.title}</div></td><td>Ended {date(w.end_date)}</td></tr>)}</tbody></table>}</Card>}
      </div>
    );
  }}</Async>;
}

export function WorkerDetail() {
  const { workerId } = useParams();
  const [sp, setSp] = useSearchParams();
  const day = sp.get('date') || todayISO();
  const st = useApi<any>(`/api/v1/portal/client/team/${workerId}?date=${day}`);
  useRealtime('screenshot', d => { if (d.worker_id === workerId && day === todayISO()) st.reload(); });
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={8} />;
  const d = st.data;
  return (
    <div>
      <Link to="/portal/client/team" className="back-link"><ChevronLeft size={14} /> My Team</Link>
      <Card pad>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <div className="row" style={{ gap: 14 }}><Avatar name={d.worker.name} color={d.worker.avatar_color} size={56} /><div><h1 style={{ margin: 0 }}>{d.worker.name}</h1><div className="muted">{d.placements[0]?.title}{d.worker.country ? ` · ${d.worker.country}` : ''}</div></div></div>
          {d.live && <div className="stack" style={{ gap: 6, minWidth: 220 }}><div className="row" style={{ justifyContent: 'space-between' }}><LivePill status={d.live.status} />{d.live.session_started_at && <SinceTimer from={d.live.session_started_at} />}</div><ActivityMeter value={d.live.activity_pct} /></div>}
        </div>
      </Card>
      <div className="grid-main-side" style={{ marginTop: 20 }}>
        <div className="stack" style={{ gap: 20 }}>
          <Card><CardHeader title="Screenshots & activity" sub={date(day)} right={<div className="row" style={{ gap: 6 }}><Button size="sm" icon={<ChevronLeft size={14} />} aria-label="Previous day" onClick={() => setSp({ date: addDaysISO(day, -1) }, { replace: true })} /><input type="date" className="input input-sm" aria-label="Date" value={day} max={todayISO()} onChange={e => setSp({ date: e.target.value }, { replace: true })} /><Button size="sm" icon={<ChevronRight size={14} />} aria-label="Next day" disabled={day >= todayISO()} onClick={() => setSp({ date: addDaysISO(day, 1) }, { replace: true })} /></div>} />
            <div className="card-b">
              {!d.screenshots_allowed && <Banner tone="info">{d.screenshot_reason} Activity levels and tracked time are still shown.</Banner>}
              <div className="row small" style={{ gap: 18, marginBottom: 12, flexWrap: 'wrap' }}><span>Tracked <b>{hm(d.timeline.summary.tracked_minutes)}</b></span><span>Activity <b>{d.timeline.summary.avg_activity !== null ? `${d.timeline.summary.avg_activity}%` : '—'}</b></span>{d.screenshots_allowed && <span>Screenshots <b>{d.timeline.summary.screenshots}</b></span>}</div>
              <Boundary label="Timeline"><BlockTimeline data={d.timeline} workerName={d.worker.name} /></Boundary>
            </div>
          </Card>
          <Card><CardHeader title="Timesheets" right={<Link to="/portal/client/timesheets" className="small">Approve timesheets →</Link>} />
            {d.timesheets.length ? <table className="table"><tbody>{d.timesheets.map((t: any) => <tr key={t.id}><td>Week of {date(t.week_start)}</td><td><StatusPill status={t.status} /></td><td className="right num">{hm(t.total_minutes)}</td></tr>)}</tbody></table> : <EmptyState title="No timesheets yet" />}
          </Card>
        </div>
        <div className="stack" style={{ gap: 20 }}>
          <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}>Schedule</div>{d.placements.map((p: any) => <div key={p.id} style={{ marginTop: 10 }}><div className="bold">{scheduleText(p.schedule_days, p.schedule_start, p.schedule_end)}</div><div className="small muted">{p.timezone.replace('_', ' ')} · {p.weekly_hours}h/week · <StatusPill status={p.status} /></div><div className="small muted">Since {date(p.start_date)}{p.end_date ? ` · until ${date(p.end_date)}` : ''}</div></div>)}
            {d.time_off.length > 0 && <div style={{ marginTop: 12 }}><div className="wf-section-label">Upcoming time off</div>{d.time_off.map((t: any, i: number) => <div key={i} className="small">{humanize(t.kind)} · {date(t.start_date)} → {date(t.end_date)}</div>)}</div>}
          </Card>
          <Boundary label="Weekly hours"><ChartCard title="Hours per week" big={hrs(d.weekly[d.weekly.length - 1]?.value ?? 0)} delta={<span className="muted">this week</span>}><TrackBars data={d.weekly} fmt={fmtHours} valueName="Hours" height={220} /></ChartCard></Boundary>
        </div>
      </div>
    </div>
  );
}

export function Timesheets() {
  const confirm = useConfirm();
  const [openId, setOpenId] = useState<string | null>(null);
  const [rk, setRk] = useState(0);
  const det = useApi<any>(openId ? `/api/v1/portal/client/timesheets/${openId}` : null, [openId, rk]);
  const approve = async (id: string) => { try { const r = await api.post(`/api/v1/portal/client/timesheets/${id}/approve`); toast.success(r.final ? 'Timesheet approved' : 'Approved — waiting for your agency'); setRk(k => k + 1); } catch (e) { toast.error(e); } };
  const reject = async (id: string) => { const r = await confirm({ title: 'Reject this timesheet?', body: 'Your agency and the worker are notified with your reason.', reason: { label: 'What needs to change?', required: true }, danger: true, confirmLabel: 'Reject' }); if (!r.ok) return; try { await api.post(`/api/v1/portal/client/timesheets/${id}/reject`, { reason: r.reason }); toast.success('Timesheet rejected'); setRk(k => k + 1); } catch (e) { toast.error(e); } };
  const cols: Column<any>[] = [
    { key: 'worker_name', label: 'Worker', sortable: true, mobile: 'title', render: r => <div className="row" style={{ gap: 8 }}><Avatar name={r.worker_name} color={r.avatar_color} size={28} /><div><div className="bold">{r.worker_name}</div><div className="small muted">{r.title}</div></div></div> },
    { key: 'week_start', label: 'Week', sortable: true, mobile: 'subtitle', render: r => `Week of ${date(r.week_start)}` },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status === 'submitted' && r.client_approved_at ? 'approved' : r.status} label={r.status === 'submitted' && r.client_approved_at ? 'You approved' : undefined} /> },
    { key: 'total_minutes', label: 'Hours', align: 'right', sortable: true, render: r => hm(r.total_minutes) },
    { key: 'submitted_at', label: 'Submitted', render: r => dateTime(r.submitted_at) },
  ];
  return (
    <div>
      <h1 style={{ margin: '0 0 4px' }}>Timesheets</h1><div className="muted small" style={{ marginBottom: 16 }}>Approve your team's weekly hours. Approved time is what you are invoiced for.</div>
      <DataTable key={rk} endpoint="/api/v1/portal/client/timesheets" columns={cols} onRowClick={r => setOpenId(r.id)} exportName="timesheets"
        filters={[{ key: 'awaiting', label: 'Awaiting my approval', type: 'boolean' }, { key: 'status', label: 'Status', options: ['submitted', 'approved', 'rejected', 'locked', 'open'].map(s => ({ value: s, label: humanize(s) })) }]}
        rowActions={r => [{ label: 'Open', onClick: () => setOpenId(r.id) }, { label: 'Approve', hidden: r.status !== 'submitted' || !!r.client_approved_at, onClick: () => approve(r.id) }, { label: 'Reject…', danger: true, hidden: r.status !== 'submitted', onClick: () => reject(r.id) }]}
        emptyTitle="No timesheets yet" emptyText="Timesheets appear here when your workers submit their week." />
      <Drawer open={!!openId} onClose={() => setOpenId(null)} wide title={det.data ? `${det.data.worker_name} · week of ${date(det.data.week_start)}` : 'Timesheet'}
        footer={det.data?.can_approve ? <><Button variant="danger" icon={<X size={14} />} onClick={() => reject(det.data.id)}>Reject</Button><Button variant="primary" icon={<Check size={14} />} onClick={() => approve(det.data.id)}>Approve {hm(det.data.total_minutes)}</Button></> : undefined}>
        {det.error ? <ErrorState error={det.error} /> : !det.data ? <LoadingBlock /> : <div className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}><StatusPill status={det.data.status} /><b>{hm(det.data.total_minutes)}</b><span className="small muted">{det.data.title} · activity {det.data.avg_activity !== null ? `${det.data.avg_activity}%` : '—'}</span></div>
          {det.data.status === 'submitted' && det.data.client_approved_at && <Banner tone="success">You approved this on {dateTime(det.data.client_approved_at)} — waiting for your agency.</Banner>}
          {det.data.timesheet_approval === 'agency' && <Banner>Your agency approves these timesheets for you.</Banner>}
          {det.data.open_entries > 0 && <Banner tone="warn">The worker is still clocked in this week — approval opens after they clock out.</Banner>}
          <TimesheetBody t={det.data} />
        </div>}
      </Drawer>
    </div>
  );
}
