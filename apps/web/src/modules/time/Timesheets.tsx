import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox, Building2, CheckCircle2, XCircle, Check } from 'lucide-react';
import { PageHeader, Banner, KpiRow, Button, Person, StatusPill, Boundary, Async, useConfirm } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { ChartCard, TrackBars, fmtHours } from '../../components/charts';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, dateTime, delta, relTime } from '../../lib/format';
import { hrs, useRealtime } from '../workforce/shared';

export function approvalLabel(r: any) {
  if (r.status !== 'submitted') return null;
  const needA = ['agency', 'both'].includes(r.timesheet_approval) && !r.agency_approved_at, needC = ['client', 'both'].includes(r.timesheet_approval) && !r.client_approved_at;
  return needA && needC ? 'Agency + client' : needA ? 'Agency' : needC ? 'Client' : null;
}

export default function Timesheets() {
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const sum = useApi<any>('/api/v1/timesheets/summary');
  const clients = useApi<any>('/api/v1/companies?stage=client&pageSize=500&sort=name&dir=asc');
  const [rk, setRk] = useState(0);
  useRealtime('timesheet', () => { sum.reload(); setRk(k => k + 1); });
  const s = sum.data;
  const cols: Column<any>[] = [
    { key: 'worker_name', label: 'Worker', sortable: true, mobile: 'title', render: r => <Person name={r.worker_name} sub={r.title} color={r.avatar_color} /> },
    { key: 'company_name', label: 'Client', sortable: true, mobile: 'subtitle' },
    { key: 'week_start', label: 'Week', sortable: true, render: r => `Week of ${date(r.week_start)}` },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'awaiting', label: 'Awaiting', render: r => approvalLabel(r) ?? <span className="muted">—</span>, csv: r => approvalLabel(r) ?? '' },
    { key: 'total_minutes', label: 'Hours', align: 'right', sortable: true, render: r => hrs(r.total_minutes, 2), csv: r => (r.total_minutes / 60).toFixed(2) },
    { key: 'submitted_at', label: 'Submitted', sortable: true, render: r => r.submitted_at ? relTime(r.submitted_at) : '—', csv: r => r.submitted_at ?? '' },
    { key: 'account_manager_name', label: 'AM', mobile: 'hidden' },
  ];
  const approveMany = async (ids: string[], reload: () => void) => {
    const r = await confirm({ title: `Approve ${ids.length} timesheet(s)?`, body: 'Only submitted timesheets that your agency is allowed to approve will be approved. Approved time feeds invoices and payroll.' });
    if (!r.ok) return;
    let ok = 0; const errs: string[] = [];
    for (const id of ids) { try { await api.post(`/api/v1/timesheets/${id}/approve`, {}); ok++; } catch (e: any) { errs.push(e.message); } }
    toast.success(`${ok} approved${errs.length ? `, ${errs.length} skipped` : ''}`);
    if (errs.length) toast.info(errs[0]);
    reload(); sum.reload();
  };
  return (
    <div>
      <PageHeader title="Timesheets" sub="Weekly per placement, built automatically from tracked time. Approved time is the financial bridge to invoices and payroll." actions={<>
        <Button onClick={() => nav('/time/manual')}>Manual time requests</Button>
        <Button variant="primary" icon={<Check size={16} />} onClick={() => nav('/time/timesheets?awaiting=agency&status=submitted')}>Review approvals</Button>
      </>} />
      {s && s.submitted > 0 && <Banner><b>{s.submitted} timesheet{s.submitted === 1 ? '' : 's'} submitted</b> ({hrs(s.submitted_minutes, 0)}) — {s.awaiting_agency} awaiting your agency, {s.awaiting_client} awaiting client approval{s.oldest_submitted_at ? `; oldest submitted ${relTime(s.oldest_submitted_at)}` : ''}.</Banner>}
      <Async state={sum} rows={2}>{() => (
        <KpiRow items={[
          { label: 'Awaiting agency', icon: <Inbox size={16} />, value: s.awaiting_agency, deltaText: <span>submitted, needs your approval</span>, suffix: '', to: '/time/timesheets?awaiting=agency' },
          { label: 'Awaiting client', icon: <Building2 size={16} />, value: s.awaiting_client, deltaText: <span>approved in the client portal</span>, suffix: '', to: '/time/timesheets?awaiting=client' },
          { label: 'Approved hours (month)', icon: <CheckCircle2 size={16} />, value: hrs(s.approved_minutes_month, 0), delta: delta(s.approved_minutes_month, s.approved_minutes_last_month), suffix: 'vs last month', to: '/time/timesheets?status=approved' },
          { label: 'Rejected', icon: <XCircle size={16} />, value: s.rejected, deltaText: <span>waiting for worker resubmission</span>, suffix: '', to: '/time/timesheets?status=rejected', invert: true },
        ]} />
      )}</Async>
      {s && <div style={{ marginBottom: 20 }}><Boundary label="Hours chart"><ChartCard title="Approved vs pending hours per week" big={hrs(s.trend.reduce((a: number, b: any) => a + b.value, 0), 0)} delta={<span className="muted">approved in the last 12 weeks</span>}>
        <TrackBars data={s.trend} fmt={fmtHours} valueName="Approved" stackKey="pending" stackName="Not yet approved" onBarClick={d => nav(`/time/timesheets?week_start=${d.week}`)} />
      </ChartCard></Boundary></div>}
      <DataTable key={rk} title="All timesheets" endpoint="/api/v1/timesheets" columns={cols} rowLink={r => `/time/timesheets/${r.id}`} exportName="timesheets" exportResource="timesheets"
        filters={[
          { key: 'status', label: 'Status', options: opts(['open', 'submitted', 'approved', 'rejected', 'locked']) },
          { key: 'awaiting', label: 'Awaiting', options: [{ value: 'agency', label: 'Agency approval' }, { value: 'client', label: 'Client approval' }] },
          { key: 'company_id', label: 'Client', options: (clients.data?.rows ?? []).map((c: any) => ({ value: c.id, label: c.name })) },
          { key: 'week_start', label: 'Week starting', type: 'date' },
        ]}
        bulkActions={can('timesheets', 'approve') ? [{ label: 'Approve selected', icon: <Check size={14} />, onClick: approveMany }] : undefined}
        rowActions={(r, reload) => [
          { label: 'Open', onClick: () => nav(`/time/timesheets/${r.id}`) },
          { label: 'Approve', hidden: r.status !== 'submitted' || !can('timesheets', 'approve') || !['agency', 'both'].includes(r.timesheet_approval) || !!r.agency_approved_at, onClick: async () => { try { const x = await api.post(`/api/v1/timesheets/${r.id}/approve`, {}); toast.success(x.final ? 'Timesheet approved' : 'Agency approval recorded — awaiting client'); reload(); sum.reload(); } catch (e) { toast.error(e); } } },
          { label: 'Reject…', danger: true, hidden: r.status !== 'submitted' || !can('timesheets', 'approve'), onClick: async () => { const c = await confirm({ title: 'Reject timesheet', body: `${r.worker_name} · week of ${date(r.week_start)}`, reason: { label: 'Reason (sent to the worker)', required: true }, danger: true, confirmLabel: 'Reject' }); if (!c.ok) return; try { await api.post(`/api/v1/timesheets/${r.id}/reject`, { reason: c.reason }); toast.success('Timesheet rejected'); reload(); sum.reload(); } catch (e) { toast.error(e); } } },
        ]}
        emptyTitle="No timesheets" emptyText="Timesheets are created automatically each week for active placements." />
      <div className="small muted" style={{ marginTop: 8 }}>Updated {dateTime(new Date())}</div>
    </div>
  );
}
