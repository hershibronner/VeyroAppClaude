// Worker Portal pages: Today, Schedule, Timesheets, Time-off, Onboarding, Performance.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Clock, CalendarDays, ListChecks, Send, ChevronLeft, ChevronRight, Plus, Timer, Activity, CheckCircle2, AlarmClock } from 'lucide-react';
import { Card, CardHeader, Button, StatusPill, EmptyState, ErrorState, LoadingBlock, Banner, KpiRow, Drawer, useConfirm, Async, Boundary } from '../../components/ui';
import { FormDrawer } from '../../components/FormDrawer';
import { ChartCard, TrackBars, SoftArea, SimpleBars, fmtHours } from '../../components/charts';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, dateTime, humanize, todayISO, addDaysISO, duration } from '../../lib/format';
import { hm, hrs, DOW, scheduleText, SinceTimer } from '../workforce/shared';

export function Today() {
  const { me } = useAuth();
  const nav = useNavigate();
  const st = useApi<any>('/api/v1/portal/worker/today');
  return <Async state={st} rows={6}>{d => {
    const p = d.placements[0];
    const first = (me?.user.name ?? '').split(' ')[0];
    const working = d.current && !d.current.open_break;
    return (
      <div>
        <div style={{ marginBottom: 18 }}><h1 style={{ margin: 0 }}>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {first}</h1><div className="muted">{date(d.today, { weekday: 'long', month: 'long', day: 'numeric' })}{p ? ` · ${p.title} at ${p.company_name}` : ''}</div></div>
        {d.timesheets_to_submit.length > 0 && <Banner tone="warn"><b>{d.timesheets_to_submit.length} timesheet{d.timesheets_to_submit.length === 1 ? '' : 's'} to submit</b> — {d.timesheets_to_submit.map((t: any) => `week of ${date(t.week_start)} (${hm(t.total_minutes)}${t.status === 'rejected' ? ', rejected' : ''})`).join(', ')}. <Link to="/portal/worker/timesheets">Open timesheets →</Link></Banner>}
        {d.onboarding?.mine_open > 0 && <Banner><b>{d.onboarding.mine_open} onboarding item{d.onboarding.mine_open === 1 ? '' : 's'}</b> waiting for you. <Link to="/portal/worker/onboarding">Complete them →</Link></Banner>}
        <div className="grid-main-side">
          <div className="stack" style={{ gap: 20 }}>
            <Card pad>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div className="small muted">{d.current ? (d.current.open_break ? 'On a break' : 'Clocked in') : 'Not clocked in'}</div>
                  <div className="big-timer" style={{ fontSize: 44 }}>{d.current ? <SinceTimer from={d.current.started_at} /> : duration(d.totals.today_sec)}</div>
                  <div className="small muted">{d.current ? `Since ${dateTime(d.current.started_at)}` : 'Tracked today'}</div>
                </div>
                <Button variant={d.current ? 'outline' : 'primary'} icon={<Clock size={16} />} onClick={() => nav('/portal/worker/tracker')}>{d.current ? 'Open tracker' : 'Clock in'}</Button>
              </div>
              {working && <div className="small muted" style={{ marginTop: 8 }}>Keep the tracker tab open so activity and screenshots follow your policy.</div>}
            </Card>
            <KpiRow compact items={[
              { label: 'Today', icon: <Timer size={16} />, value: duration(d.totals.today_sec).slice(0, 5), deltaText: <span>{d.shift ? `shift ${d.shift.start}–${d.shift.end}` : 'no shift today'}</span>, suffix: '', to: '/portal/worker/tracker' },
              { label: 'This week', icon: <CalendarDays size={16} />, value: hrs(Math.round(d.totals.week_sec / 60)), delta: d.last_week_minutes ? ((d.totals.week_sec / 60 - d.last_week_minutes) / d.last_week_minutes) * 100 : null, suffix: 'vs last week', to: '/portal/worker/timesheets' },
              { label: 'Pending requests', icon: <ListChecks size={16} />, value: d.pending.time_off + d.pending.manual, deltaText: <span>{d.pending.time_off} time-off · {d.pending.manual} manual time</span>, suffix: '', to: '/portal/worker/time-off' },
            ]} />
            <Card><CardHeader title="Today's sessions" />{d.entries_today.length ? <table className="table"><tbody>{d.entries_today.map((e: any) => <tr key={e.id}><td>{dateTime(e.started_at)} – {e.ended_at ? dateTime(e.ended_at).split(', ').pop() : 'now'}</td><td className="small">{e.memo ?? '—'}</td><td className="right num">{hm(e.minutes)}</td></tr>)}</tbody></table> : <EmptyState title="Nothing tracked yet today" action={<Button size="sm" onClick={() => nav('/portal/worker/tracker')}>Open tracker</Button>} />}</Card>
          </div>
          <div className="stack" style={{ gap: 20 }}>
            <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}>Today's shift</div>{d.shift ? <div style={{ marginTop: 10 }}><div className="bold" style={{ fontSize: 22 }}>{d.shift.start} – {d.shift.end}</div><div className="small muted">{d.shift.company_name} · {d.shift.timezone.replace('_', ' ')}</div></div> : <div className="small muted" style={{ marginTop: 8 }}>No shift scheduled today.</div>}<Link className="small" to="/portal/worker/schedule" style={{ display: 'block', marginTop: 10 }}>Full schedule →</Link></Card>
            <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}>Time off</div>{d.upcoming_time_off.length ? <div className="stack" style={{ gap: 6, marginTop: 10 }}>{d.upcoming_time_off.map((t: any) => <div key={t.id} className="row small" style={{ justifyContent: 'space-between' }}><span>{humanize(t.kind)} · {date(t.start_date)} → {date(t.end_date)}</span><StatusPill status={t.status} /></div>)}</div> : <div className="small muted" style={{ marginTop: 8 }}>No upcoming time off.</div>}<Link className="small" to="/portal/worker/time-off" style={{ display: 'block', marginTop: 10 }}>Request time off →</Link></Card>
            {d.placements.map((pp: any) => <Card key={pp.id} pad><div className="small muted">Placement</div><div className="bold">{pp.title}</div><div className="small">{pp.company_name} · <StatusPill status={pp.status} /></div><div className="small muted mt-1">{scheduleText(pp.schedule_days, pp.schedule_start, pp.schedule_end)}</div></Card>)}
          </div>
        </div>
      </div>
    );
  }}</Async>;
}

export function Schedule() {
  const [from, setFrom] = useState(() => { const t = new Date(todayISO() + 'T12:00:00'); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return t.toISOString().slice(0, 10); });
  const st = useApi<any>(`/api/v1/portal/worker/schedule?from=${from}&to=${addDaysISO(from, 27)}`);
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div><h1 style={{ margin: 0 }}>Schedule</h1><div className="muted small">Shifts, approved time off and tracked hours</div></div>
        <div className="row" style={{ gap: 6 }}><Button size="sm" icon={<ChevronLeft size={14} />} aria-label="Previous 4 weeks" onClick={() => setFrom(addDaysISO(from, -28))} /><span className="bold">{date(from, { month: 'short', day: 'numeric' })} – {date(addDaysISO(from, 27))}</span><Button size="sm" icon={<ChevronRight size={14} />} aria-label="Next 4 weeks" onClick={() => setFrom(addDaysISO(from, 28))} /></div>
      </div>
      <Async state={st} rows={6}>{d => <Card pad>
        <div className="wf-cal">{DOW.map(x => <div key={x} className="dh">{x}</div>)}
          {d.days.map((day: any) => <div key={day.date} className={`day ${day.date === todayISO() ? 'today' : ''}`}><span className="dn">{date(day.date, { month: 'short', day: 'numeric' })}</span>
            {day.time_off ? <span className={`ev ${day.time_off.status === 'pending' ? 'pend' : 'off'}`}>{humanize(day.time_off.kind)}{day.time_off.status === 'pending' ? ' (pending)' : ''}</span> : day.shifts.map((s: any) => <span key={s.placement_id} className="ev" title={`${s.title} @ ${s.company_name}`}>{s.start}–{s.end}</span>)}
            {day.worked_minutes > 0 && <span className="ev done">{hm(day.worked_minutes)} worked</span>}
          </div>)}
        </div>
        <div className="small muted" style={{ marginTop: 12 }}>Times are in your client's timezone: {[...new Set(d.placements.map((p: any) => p.timezone))].join(', ').replace(/_/g, ' ') || '—'}.</div>
      </Card>}</Async>
    </div>
  );
}

export function Timesheets() {
  const st = useApi<any>('/api/v1/portal/worker/timesheets');
  const [openId, setOpenId] = useState<string | null>(null);
  const det = useApi<any>(openId ? `/api/v1/portal/worker/timesheets/${openId}` : null, [openId]);
  const confirm = useConfirm();
  const submit = async (t: any) => {
    const r = await confirm({ title: `Submit week of ${date(t.week_start)}?`, body: `${hm(t.total_minutes)} will be sent for approval. You can't edit it afterwards unless it is rejected.`, confirmLabel: 'Submit timesheet' });
    if (!r.ok) return;
    try { await api.post(`/api/v1/portal/worker/timesheets/${t.id}/submit`); toast.success('Timesheet submitted for approval'); st.reload(); det.reload(); } catch (e) { toast.error(e); }
  };
  return (
    <div>
      <h1 style={{ margin: '0 0 4px' }}>Timesheets</h1><div className="muted small" style={{ marginBottom: 16 }}>Built automatically from your tracked time every week.</div>
      {st.data?.rows.some((t: any) => t.status === 'rejected') && <Banner tone="danger">A timesheet was rejected — open it to see the reason, then fix your time (manual time request) and resubmit.</Banner>}
      <Card><Async state={st}>{d => d.rows.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Week</th><th>Placement</th><th>Status</th><th className="right">Hours</th><th /></tr></thead><tbody>
        {d.rows.map((t: any) => <tr key={t.id} className="clickable" onClick={() => setOpenId(t.id)}><td>Week of {date(t.week_start)}</td><td className="small">{t.title}<div className="muted">{t.company_name}</div></td><td><StatusPill status={t.status} />{t.rejected_reason && <div className="small" style={{ color: 'var(--danger)' }}>{t.rejected_reason}</div>}</td><td className="right num">{hm(t.total_minutes)}</td><td className="right" onClick={e => e.stopPropagation()}>{['open', 'rejected'].includes(t.status) && t.total_minutes > 0 && t.week_start < todayISO() && <Button size="sm" variant="primary" icon={<Send size={14} />} onClick={() => submit(t)}>Submit</Button>}</td></tr>)}
      </tbody></table></div> : <EmptyState title="No timesheets yet" />}</Async></Card>
      <Drawer open={!!openId} onClose={() => setOpenId(null)} wide title={det.data ? `Week of ${date(det.data.week_start)}` : 'Timesheet'} footer={det.data && ['open', 'rejected'].includes(det.data.status) && det.data.total_minutes > 0 ? <Button variant="primary" icon={<Send size={14} />} onClick={() => submit(det.data)}>Submit for approval</Button> : undefined}>
        {det.error ? <ErrorState error={det.error} /> : !det.data ? <LoadingBlock /> : <div className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 10 }}><StatusPill status={det.data.status} /><b>{hm(det.data.total_minutes)}</b><span className="muted small">{det.data.title} · {det.data.company_name}</span></div>
          {det.data.rejected_reason && det.data.status === 'rejected' && <Banner tone="danger">Rejected: {det.data.rejected_reason}</Banner>}
          <table className="table"><thead><tr><th>Date</th><th>Start</th><th>End</th><th>Memo</th><th className="right">Net</th></tr></thead><tbody>{det.data.entries.map((e: any) => <tr key={e.id}><td>{date(e.work_date, { weekday: 'short', month: 'short', day: 'numeric' })}</td><td>{dateTime(e.started_at).split(', ').pop()}</td><td>{e.ended_at ? dateTime(e.ended_at).split(', ').pop() : 'running'}</td><td className="small">{e.memo ?? '—'}{e.source !== 'tracker' ? ` · ${e.source}` : ''}</td><td className="right num">{hm(e.minutes)}</td></tr>)}</tbody></table>
          {!det.data.entries.length && <EmptyState title="No time this week" />}
          {det.data.history.length > 0 && <div><div className="wf-section-label">History</div>{det.data.history.map((h: any, i: number) => <div key={i} className="small">{humanize(h.decision)} by {h.actor_name ?? 'you'} · {dateTime(h.created_at)}{h.reason ? ` — ${h.reason}` : ''}</div>)}</div>}
          {det.data.adjustments.length > 0 && <div><div className="wf-section-label">Corrections</div>{det.data.adjustments.map((a: any, i: number) => <div key={i} className="small">{date(a.work_date)}: {a.minutes_delta > 0 ? '+' : ''}{a.minutes_delta} min — {a.reason}</div>)}</div>}
        </div>}
      </Drawer>
    </div>
  );
}

export function TimeOff() {
  const st = useApi<any>('/api/v1/portal/worker/time-off');
  const tr = useApi<any>('/api/v1/portal/worker/tracker/state');
  const [open, setOpen] = useState(false);
  const confirm = useConfirm();
  const cancel = async (r: any) => { const c = await confirm({ title: 'Cancel this request?', confirmLabel: 'Cancel request', danger: true }); if (!c.ok) return; try { await api.post(`/api/v1/portal/worker/time-off/${r.id}/cancel`); toast.success('Request cancelled'); st.reload(); } catch (e) { toast.error(e); } };
  const pls = (tr.data?.placements ?? []);
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}><div><h1 style={{ margin: 0 }}>Time-off</h1><div className="muted small">Requests go to your account manager. Approved time off shows on your schedule.</div></div><Button variant="primary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>Request time off</Button></div>
      <Card><Async state={st}>{d => d.rows.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Type</th><th>Dates</th><th>Status</th><th>Note</th><th /></tr></thead><tbody>
        {d.rows.map((r: any) => <tr key={r.id}><td>{humanize(r.kind)}</td><td>{date(r.start_date)} → {date(r.end_date)}</td><td><StatusPill status={r.status} />{r.decided_by_name && <div className="small muted">{r.decided_by_name}{r.decision_note ? ` — ${r.decision_note}` : ''}</div>}</td><td className="small">{r.note ?? '—'}</td><td className="right">{r.status === 'pending' && <Button size="sm" variant="ghost" onClick={() => cancel(r)}>Cancel</Button>}</td></tr>)}
      </tbody></table></div> : <EmptyState title="No time-off requests" action={<Button size="sm" onClick={() => setOpen(true)}>Request time off</Button>} />}</Async></Card>
      <FormDrawer open={open} onClose={() => setOpen(false)} title="Request time off" submitLabel="Send request" initial={{ kind: 'vacation', start_date: addDaysISO(todayISO(), 7), end_date: addDaysISO(todayISO(), 8), placement_id: pls[0]?.id }}
        fields={[
          ...(pls.length > 1 ? [{ name: 'placement_id', label: 'Placement', type: 'select' as const, options: pls.map((p: any) => ({ value: p.id, label: `${p.title} — ${p.company_name}` })), full: true }] : []),
          { name: 'kind', label: 'Type', type: 'select', required: true, options: ['vacation', 'sick', 'personal', 'unpaid', 'holiday'].map(k => ({ value: k, label: humanize(k) })) },
          { name: 'start_date', label: 'First day', type: 'date', required: true }, { name: 'end_date', label: 'Last day', type: 'date', required: true },
          { name: 'note', label: 'Note for your manager', type: 'textarea' },
        ]}
        onSubmit={async v => { await api.post('/api/v1/portal/worker/time-off', v); toast.success('Request sent'); st.reload(); }} />
    </div>
  );
}

export function Onboarding() {
  const st = useApi<any>('/api/v1/portal/worker/onboarding');
  const toggle = async (it: any) => { try { await api.post(`/api/v1/portal/worker/onboarding/${it.id}`, { done: !it.done_at }); st.reload(); } catch (e) { toast.error(e); } };
  return (
    <div>
      <h1 style={{ margin: '0 0 4px' }}>Onboarding</h1><div className="muted small" style={{ marginBottom: 16 }}>Complete your items — your agency handles the rest.</div>
      <Async state={st}>{d => {
        if (!d.rows.length) return <EmptyState title="No onboarding items" text="You're all set." />;
        const byPl = d.rows.reduce((m: Record<string, any[]>, r: any) => { (m[r.placement_id] ??= []).push(r); return m; }, {});
        return <div className="stack" style={{ gap: 20 }}>{(Object.values(byPl) as any[][]).map((items: any[]) => {
          const mine = items.filter(i => i.owner === 'worker'), agency = items.filter(i => i.owner !== 'worker');
          const done = items.filter(i => i.done_at).length;
          return <Card key={items[0].placement_id}><CardHeader title={`${items[0].placement_title} · ${items[0].company_name}`} sub={`${done}/${items.length} complete · placement ${humanize(items[0].placement_status)}`} />
            <div style={{ padding: '0 20px 12px' }}>
              <div className="wf-section-label" style={{ marginTop: 10 }}>Your items</div>
              {mine.length ? mine.map(i => <label key={i.id} className="checklist-item" style={{ cursor: 'pointer' }}><input type="checkbox" checked={!!i.done_at} onChange={() => toggle(i)} /><div style={{ flex: 1 }}><div className={i.done_at ? 'muted' : 'bold'}>{i.title}</div><div className="small muted">{i.required ? 'Required' : 'Optional'}{i.done_at ? ` · done ${dateTime(i.done_at)}` : ''}</div></div></label>) : <div className="small muted">Nothing for you to do.</div>}
              <div className="wf-section-label" style={{ marginTop: 14 }}>Handled by your agency</div>
              {agency.map(i => <div key={i.id} className="checklist-item"><CheckCircle2 size={18} color={i.done_at ? 'var(--success)' : 'var(--muted-2)'} /><div style={{ flex: 1 }}><div className={i.done_at ? 'muted' : ''}>{i.title}</div><div className="small muted">{i.done_at ? `Done ${dateTime(i.done_at)}` : 'In progress'}</div></div></div>)}
            </div></Card>;
        })}</div>;
      }}</Async>
    </div>
  );
}

export function Performance() {
  const st = useApi<any>('/api/v1/portal/worker/performance');
  return (
    <div>
      <h1 style={{ margin: '0 0 4px' }}>Performance</h1><div className="muted small" style={{ marginBottom: 16 }}>Your hours, attendance and activity — computed from your own tracked data.</div>
      <Async state={st} rows={6}>{d => <>
        <KpiRow items={[
          { label: 'Approved hours (90 days)', icon: <CheckCircle2 size={16} />, value: hrs(d.approved_minutes_90d, 0), deltaText: <span>{d.attendance.days_worked} days worked</span>, suffix: '', to: '/portal/worker/timesheets' },
          { label: 'On-time rate (90 days)', icon: <AlarmClock size={16} />, value: d.attendance.on_time_pct !== null ? `${d.attendance.on_time_pct}%` : '—', deltaText: <span>{d.attendance.late} late · {d.attendance.absent} absent</span>, suffix: '' },
          { label: 'Avg. activity (30 days)', icon: <Activity size={16} />, value: d.avg_activity_30d !== null ? `${d.avg_activity_30d}%` : '—', deltaText: <span>keyboard & mouse counts</span>, suffix: '' },
          { label: 'This week', icon: <Timer size={16} />, value: hrs(d.weekly[d.weekly.length - 1]?.value ?? 0), deltaText: <span>last week {hrs(d.weekly[d.weekly.length - 2]?.value ?? 0)}</span>, suffix: '' },
        ]} />
        <div className="grid-2">
          <Boundary label="Weekly hours"><ChartCard title="Hours per week" big={hrs(d.weekly.reduce((a: number, b: any) => a + b.value, 0), 0)} delta={<span className="muted">last 12 weeks</span>}><TrackBars data={d.weekly} fmt={fmtHours} valueName="Hours" /></ChartCard></Boundary>
          <Boundary label="Activity"><ChartCard title="Daily activity" big={d.avg_activity_30d !== null ? `${d.avg_activity_30d}%` : '—'} delta={<span className="muted">average on worked days · 30 days</span>}><SoftArea data={d.activity_daily} fmt={v => `${v}%`} height={240} /></ChartCard></Boundary>
          {d.apps.length > 0 && <Boundary label="Apps"><ChartCard title="Where your active time went (30 days)"><SimpleBars data={d.apps.map((a: any) => ({ label: a.label.split(' — ')[0], value: Math.round(a.value / 3600) }))} fmt={v => `${v}h`} /></ChartCard></Boundary>}
          <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}>Attendance (90 days)</div><div className="grid-3" style={{ marginTop: 14 }}><div><div className="small muted">Late arrivals</div><div className="bold" style={{ fontSize: 24 }}>{d.attendance.late}</div><div className="small muted">avg {d.attendance.avg_late_min} min</div></div><div><div className="small muted">Absences</div><div className="bold" style={{ fontSize: 24 }}>{d.attendance.absent}</div></div><div><div className="small muted">Early leaves</div><div className="bold" style={{ fontSize: 24 }}>{d.attendance.early_leave}</div></div></div></Card>
        </div>
      </>}</Async>
    </div>
  );
}
