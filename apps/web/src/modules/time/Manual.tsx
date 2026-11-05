import { Hourglass, Timer, CheckCircle2, XCircle } from 'lucide-react';
import { PageHeader, KpiRow, Person, StatusPill, Async, useConfirm, Banner } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, relTime } from '../../lib/format';
import { hm, hrs } from '../workforce/shared';

export default function Manual() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const sum = useApi<any>('/api/v1/time/requests/summary');
  const s = sum.data;
  const decide = async (r: any, decision: 'approve' | 'reject', reload: () => void) => {
    const c = await confirm({ title: `${decision === 'approve' ? 'Approve' : 'Reject'} manual time?`, body: `${r.worker_name} · ${date(r.work_date)} ${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)} (${hm(r.minutes)}). ${decision === 'approve' ? 'A time entry is created; if the week is already approved, a correction is recorded instead of editing approved days.' : ''}`, reason: { label: decision === 'reject' ? 'Reason (sent to the worker)' : 'Note (optional)', required: decision === 'reject' }, danger: decision === 'reject', confirmLabel: decision === 'approve' ? 'Approve' : 'Reject' });
    if (!c.ok) return;
    try { const x = await api.post(`/api/v1/time/manual-requests/${r.id}/${decision}`, { note: c.reason || null }); toast.success(decision === 'approve' ? (x.adjustment ? 'Approved — added as a correction to the approved timesheet' : 'Approved — time entry created') : 'Request rejected'); reload(); sum.reload(); } catch (e) { toast.error(e); }
  };
  const cols: Column<any>[] = [
    { key: 'worker_name', label: 'Worker', mobile: 'title', render: r => <Person name={r.worker_name} sub={`${r.title} · ${r.company_name}`} color={r.avatar_color} size={28} /> },
    { key: 'work_date', label: 'Date', sortable: true, render: r => date(r.work_date) },
    { key: 'time', label: 'Time', render: r => `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`, csv: r => `${r.start_time}-${r.end_time}` },
    { key: 'minutes', label: 'Duration', align: 'right', render: r => hm(r.minutes) },
    { key: 'reason', label: 'Reason', mobile: 'subtitle', render: r => <span className="small">{r.reason}</span> },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'created_at', label: 'Requested', sortable: true, render: r => relTime(r.created_at) },
    { key: 'decided_by_name', label: 'Decided by' },
  ];
  return (
    <div>
      <PageHeader title="Manual Time Requests" sub="Time a worker forgot to track. Approval creates a time entry on the placement (or a correction if the week is already approved)." />
      {s && s.manual_pending > 0 && <Banner><b>{s.manual_pending} request{s.manual_pending === 1 ? '' : 's'} ({hrs(s.manual_pending_minutes)}) waiting for approval.</b></Banner>}
      <Async state={sum} rows={2}>{() => <KpiRow items={[
        { label: 'Pending', icon: <Hourglass size={16} />, value: s.manual_pending, deltaText: <span>needs a decision</span>, suffix: '', to: '/time/manual?status=pending' },
        { label: 'Pending hours', icon: <Timer size={16} />, value: hrs(s.manual_pending_minutes), deltaText: <span>if all approved</span>, suffix: '', to: '/time/manual?status=pending' },
        { label: 'Approved (30 days)', icon: <CheckCircle2 size={16} />, value: s.manual_approved_30d, deltaText: <span>entries created</span>, suffix: '', to: '/time/manual?status=approved' },
        { label: 'Rejected (30 days)', icon: <XCircle size={16} />, value: s.manual_rejected_30d, deltaText: <span>worker notified</span>, suffix: '', to: '/time/manual?status=rejected' },
      ]} />}</Async>
      <DataTable title="Requests" endpoint="/api/v1/time/manual-requests" columns={cols} exportName="manual-time" exportResource="time"
        filters={[{ key: 'status', label: 'Status', options: opts(['pending', 'approved', 'rejected']) }]}
        rowActions={(r, reload) => [{ label: 'Approve', hidden: r.status !== 'pending' || !can('time', 'approve'), onClick: () => decide(r, 'approve', reload) }, { label: 'Reject…', danger: true, hidden: r.status !== 'pending' || !can('time', 'approve'), onClick: () => decide(r, 'reject', reload) }]}
        emptyTitle="No manual time requests" emptyText="Workers submit these from the Worker Portal tracker." />
    </div>
  );
}
