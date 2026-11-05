import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, AlarmClock, UserX, LogOut } from 'lucide-react';
import { PageHeader, Card, CardHeader, KpiRow, Person, StatusPill, EmptyState, ErrorState, LoadingBlock, DateRangePicker, Boundary, Banner, type DateRange } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { useApi } from '../../lib/hooks';
import { date, time as fmtTime, todayISO, addDaysISO, humanize } from '../../lib/format';
import { hm } from '../workforce/shared';

const color = (d: any) => {
  if (!d.scheduled) return '#EEF0F4';
  const bad = d.absent + d.late * 0.5 + d.early_leave * 0.3;
  const r = Math.max(0, (d.scheduled - bad) / d.scheduled);
  return r >= 0.97 ? '#16A34A' : r >= 0.9 ? '#4ADE80' : r >= 0.8 ? '#FCD34D' : r >= 0.65 ? '#F59E0B' : '#EF4444';
};
const SHEET_TONE: Record<string, string> = { on_time: 'green', late: 'amber', absent: 'red', early_leave: 'amber', time_off: 'purple', not_started: 'gray', not_scheduled: 'gray', extra_day: 'blue' };

export default function Attendance() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [range, setRange] = useState<DateRange>({ from: addDaysISO(todayISO(), -83), to: todayISO(), label: 'Last 12 weeks' });
  const sel = sp.get('date') || todayISO();
  const sum = useApi<any>(`/api/v1/time/attendance/summary?from=${range.from}&to=${range.to}`);
  const day = useApi<any>(`/api/v1/time/attendance/day?date=${sel}`);
  const s = sum.data;
  const evCols: Column<any>[] = [
    { key: 'work_date', label: 'Date', sortable: true, render: r => date(r.work_date) },
    { key: 'worker_name', label: 'Worker', mobile: 'title', render: r => <Person name={r.worker_name} sub={r.company_name} color={r.avatar_color} size={28} /> },
    { key: 'kind', label: 'Signal', sortable: true, render: r => <StatusPill status={r.kind === 'screen_declined' ? 'warn' : r.kind} label={humanize(r.kind)} /> },
    { key: 'minutes', label: 'Minutes', align: 'right', sortable: true, render: r => r.minutes ?? '—' },
    { key: 'note', label: 'Note', mobile: 'subtitle' },
  ];
  return (
    <div>
      <PageHeader title="Attendance" sub="Schedule vs actual in each placement’s timezone. Late and absent signals notify account managers and trigger automations." actions={<DateRangePicker value={range} onChange={setRange} />} />
      {s && s.top.length > 0 && s.top[0].late + s.top[0].absent >= 4 && <Banner tone="warn"><b>{s.top[0].worker_name}</b> has {s.top[0].late} late arrival{s.top[0].late === 1 ? '' : 's'} and {s.top[0].absent} absence{s.top[0].absent === 1 ? '' : 's'} in this period. <a href={`/workforce/workers/${s.top[0].worker_id}`} onClick={e => { e.preventDefault(); nav(`/workforce/workers/${s.top[0].worker_id}`); }}>Open worker →</a></Banner>}
      {sum.error ? <ErrorState error={sum.error} retry={sum.reload} /> : !s ? <LoadingBlock rows={4} /> : <>
        <KpiRow items={[
          { label: 'On-time rate', icon: <CheckCircle2 size={16} />, value: s.totals.on_time_pct !== null ? `${s.totals.on_time_pct}%` : '—', delta: s.totals.prev_on_time_pct && s.totals.recent_on_time_pct !== null ? s.totals.recent_on_time_pct - s.totals.prev_on_time_pct : null, suffix: 'pts, 2nd vs 1st half' },
          { label: 'Late arrivals', icon: <AlarmClock size={16} />, value: s.totals.late, deltaText: <span>of {s.totals.scheduled.toLocaleString()} scheduled shifts</span>, suffix: '', invert: true },
          { label: 'Absences', icon: <UserX size={16} />, value: s.totals.absent, deltaText: <span>no clock-in recorded</span>, suffix: '', invert: true },
          { label: 'Early leaves', icon: <LogOut size={16} />, value: s.totals.early_leave, deltaText: <span>left 30+ min early</span>, suffix: '', invert: true },
        ]} />
        <div className="grid-main-side" style={{ marginBottom: 20 }}>
          <Card><CardHeader title="Attendance calendar" sub="Each square is a day — click to see schedule vs actual" />
            <div className="card-b">
              <Boundary label="Heatmap"><div className="wf-heat" role="grid" aria-label="Attendance heatmap">
                {(() => { const first = s.days[0]; const pad = first ? (new Date(first.date + 'T12:00:00').getDay() + 6) % 7 : 0; return [...Array(pad).fill(null), ...s.days]; })().map((d: any, i: number) => d ? <button key={d.date} className={d.date === sel ? 'sel' : ''} style={{ background: color(d) }} title={`${date(d.date)} — ${d.worked}/${d.scheduled} worked, ${d.late} late, ${d.absent} absent`} aria-label={`${date(d.date)}: ${d.worked} of ${d.scheduled} worked`} onClick={() => setSp({ date: d.date }, { replace: true })} /> : <span key={`p${i}`} />)}
              </div></Boundary>
              <div className="wf-heat-legend"><span>Less reliable</span>{['#EF4444', '#F59E0B', '#FCD34D', '#4ADE80', '#16A34A'].map(c => <i key={c} style={{ background: c }} />)}<span>Fully on time</span><i style={{ background: '#EEF0F4', marginLeft: 10 }} /><span>No shifts</span></div>
            </div>
          </Card>
          <Card><CardHeader title="Most late / absent" sub={`${date(s.from)} – ${date(s.to)}`} />
            {s.top.length ? <table className="table"><tbody>{s.top.map((r: any) => <tr key={r.worker_id} className="clickable" onClick={() => nav(`/workforce/workers/${r.worker_id}`)}><td><div className="bold">{r.worker_name}</div><div className="small muted">{r.company_name}</div></td><td className="right small">{r.late} late<br /><span className="muted">avg {r.avg_late}m</span></td><td className="right small">{r.absent} absent</td></tr>)}</tbody></table> : <EmptyState title="No late or absent signals" />}
          </Card>
        </div>
      </>}
      <Card style={{ marginBottom: 20 }}><CardHeader title={`Schedule vs actual — ${date(sel)}`} right={<input type="date" className="input input-sm" aria-label="Day" value={sel} max={todayISO()} onChange={e => setSp({ date: e.target.value }, { replace: true })} />} />
        {day.error ? <div className="card-b"><ErrorState error={day.error} retry={day.reload} /></div> : !day.data ? <LoadingBlock /> : !day.data.rows.length ? <EmptyState title="No placements on this day" /> :
          <div className="table-wrap"><table className="table"><thead><tr><th>Worker</th><th>Scheduled</th><th>First in</th><th>Last out</th><th className="right">Worked</th><th>Status</th></tr></thead><tbody>
            {day.data.rows.filter((r: any) => r.scheduled || r.minutes > 0).map((r: any) => <tr key={r.id} className="clickable" onClick={() => nav(`/time/screenshots?worker_id=${r.worker_id}&date=${sel}`)}><td><Person name={r.worker_name} sub={r.company_name} color={r.avatar_color} size={28} /></td><td>{r.scheduled ? `${r.scheduled_start}–${r.scheduled_end}` : 'Not scheduled'}<div className="small muted">{r.timezone.split('/').pop()?.replace('_', ' ')}</div></td><td>{r.first_in ? fmtTime(r.first_in) : '—'}</td><td>{r.open ? <span className="pill pill-green">Clocked in</span> : r.last_out ? fmtTime(r.last_out) : '—'}</td><td className="right num">{hm(r.minutes)}<div className="small muted">of {hm(r.scheduled_minutes)}</div></td><td><StatusPill status={r.status} tone={SHEET_TONE[r.status]} label={humanize(r.status)} />{r.late_minutes ? <span className="small muted"> {r.late_minutes}m</span> : null}</td></tr>)}
          </tbody></table></div>}
      </Card>
      <DataTable title="Attendance signals" endpoint="/api/v1/time/attendance/events" columns={evCols} exportName="attendance" exportResource="attendance" rowLink={r => `/time/screenshots?worker_id=${r.worker_id}&date=${r.work_date}`}
        filters={[{ key: 'kind', label: 'Signal', options: opts(['late', 'absent', 'early_leave', 'screen_declined', 'time_off']) }, { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }]}
        emptyTitle="No attendance signals" />
    </div>
  );
}
