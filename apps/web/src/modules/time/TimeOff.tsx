import { useState } from 'react';
import { CalendarDays, Hourglass, Plane, CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader, Card, CardHeader, KpiRow, Person, StatusPill, Button, Async, useConfirm, Banner, LoadingBlock } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, humanize, todayISO } from '../../lib/format';
import { DOW } from '../workforce/shared';

export function MonthCalendar({ month, items, render }: { month: string; items: { start_date: string; end_date: string }[]; render: (d: string) => React.ReactNode }) {
  const first = new Date(`${month}-01T12:00:00`);
  const pad = (first.getDay() + 6) % 7;
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [...Array(pad).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  while (cells.length % 7) cells.push(null);
  void items;
  return <div className="wf-cal">{DOW.map(d => <div key={d} className="dh">{d}</div>)}{cells.map((d, i) => d ? <div key={d} className={`day ${d === todayISO() ? 'today' : ''}`}><span className="dn">{Number(d.slice(8))}</span>{render(d)}</div> : <div key={`x${i}`} />)}</div>;
}
const shiftMonth = (m: string, n: number) => { const d = new Date(`${m}-01T12:00:00`); d.setMonth(d.getMonth() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

export default function TimeOff() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const sum = useApi<any>('/api/v1/time/requests/summary');
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const cal = useApi<any>(`/api/v1/time/time-off/calendar?month=${month}`);
  const [rk, setRk] = useState(0);
  const s = sum.data;
  const decide = async (r: any, decision: 'approve' | 'reject', reload: () => void) => {
    const c = await confirm({ title: `${decision === 'approve' ? 'Approve' : 'Reject'} time off for ${r.worker_name}?`, body: `${humanize(r.kind)} · ${date(r.start_date)} → ${date(r.end_date)} (${r.days} day${r.days === 1 ? '' : 's'})`, reason: { label: decision === 'reject' ? 'Reason (sent to the worker)' : 'Note (optional)', required: decision === 'reject' }, danger: decision === 'reject', confirmLabel: decision === 'approve' ? 'Approve' : 'Reject' });
    if (!c.ok) return;
    try { await api.post(`/api/v1/time/time-off/${r.id}/${decision}`, { note: c.reason || null }); toast.success(`Time off ${decision === 'approve' ? 'approved' : 'rejected'}`); reload(); sum.reload(); cal.reload(); } catch (e) { toast.error(e); }
  };
  const cols: Column<any>[] = [
    { key: 'worker_name', label: 'Worker', mobile: 'title', render: r => <Person name={r.worker_name} sub={r.company_name} color={r.avatar_color} size={28} /> },
    { key: 'kind', label: 'Type', render: r => humanize(r.kind) },
    { key: 'start_date', label: 'Dates', sortable: true, mobile: 'subtitle', render: r => `${date(r.start_date)} → ${date(r.end_date)}` },
    { key: 'days', label: 'Days', align: 'right' },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'note', label: 'Note', render: r => <span className="small">{r.note ?? '—'}</span> },
    { key: 'decided_by_name', label: 'Decided by' },
  ];
  return (
    <div>
      <PageHeader title="Time-off" sub="Worker requests → approval → shown on the worker schedule, attendance calendar and Live Now." />
      {s && s.time_off_pending > 0 && <Banner><b>{s.time_off_pending} request{s.time_off_pending === 1 ? '' : 's'} waiting for a decision.</b></Banner>}
      <Async state={sum} rows={2}>{() => <KpiRow items={[
        { label: 'Pending requests', icon: <Hourglass size={16} />, value: s.time_off_pending, deltaText: <span>needs approval</span>, suffix: '', to: '/time/time-off?status=pending' },
        { label: 'Out today', icon: <Plane size={16} />, value: s.out_today, deltaText: <span>approved leave</span>, suffix: '', to: '/time/time-off?when=current' },
        { label: 'Upcoming (30 days)', icon: <CalendarRange size={16} />, value: s.upcoming_30d, deltaText: <span>approved, starting soon</span>, suffix: '', to: '/time/time-off?when=upcoming' },
        { label: 'Days taken this year', icon: <CalendarDays size={16} />, value: s.days_taken_ytd, deltaText: <span>approved, calendar days</span>, suffix: '', to: '/time/time-off?status=approved' },
      ]} />}</Async>
      <Card style={{ marginBottom: 20 }}><CardHeader title="Leave calendar" right={<div className="row" style={{ gap: 6 }}><Button size="sm" icon={<ChevronLeft size={14} />} aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))} /><b style={{ minWidth: 120, textAlign: 'center' }}>{new Date(`${month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</b><Button size="sm" icon={<ChevronRight size={14} />} aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))} /></div>} />
        <div className="card-b">{!cal.data ? <LoadingBlock /> : <MonthCalendar month={month} items={cal.data.rows} render={d => cal.data.rows.filter((r: any) => r.start_date <= d && r.end_date >= d).slice(0, 3).map((r: any) => <span key={r.id} className={`ev ${r.status === 'pending' ? 'pend' : 'off'}`} title={`${r.worker_name} — ${humanize(r.kind)} (${r.status})`}>{r.worker_name.split(' ')[0]} · {humanize(r.kind)}</span>)} />}</div>
      </Card>
      <DataTable key={rk} title="Requests" endpoint="/api/v1/time/time-off" columns={cols} exportName="time-off" exportResource="time_off"
        filters={[{ key: 'status', label: 'Status', options: opts(['pending', 'approved', 'rejected', 'cancelled']) }, { key: 'kind', label: 'Type', options: opts(['vacation', 'sick', 'personal', 'unpaid', 'holiday']) }, { key: 'when', label: 'When', options: [{ value: 'current', label: 'Out now' }, { value: 'upcoming', label: 'Upcoming' }] }]}
        rowActions={(r, reload) => [{ label: 'Approve', hidden: r.status !== 'pending' || !can('time_off', 'approve'), onClick: () => decide(r, 'approve', () => { reload(); setRk(k => k + 1); }) }, { label: 'Reject…', danger: true, hidden: r.status !== 'pending' || !can('time_off', 'approve'), onClick: () => decide(r, 'reject', reload) }]}
        emptyTitle="No time-off requests" emptyText="Workers request time off from the Worker Portal." />
    </div>
  );
}
