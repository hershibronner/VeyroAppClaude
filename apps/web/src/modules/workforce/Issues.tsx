import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Flame, CheckCircle2, Timer, Plus } from 'lucide-react';
import { PageHeader, KpiRow, Button, Person, StatusPill, Boundary, Async, useConfirm, Banner } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { ChartCard, SimpleBars } from '../../components/charts';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, humanize, delta } from '../../lib/format';
import { IssueDrawer } from './shared';

export default function Issues() {
  const nav = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const sum = useApi<any>('/api/v1/issues/summary');
  const [open, setOpen] = useState(false);
  const [rk, setRk] = useState(0);
  const s = sum.data;
  const reload = () => { setRk(k => k + 1); sum.reload(); };
  const cols: Column<any>[] = [
    { key: 'title', label: 'Issue', mobile: 'title', render: r => <div><div className="bold">{r.title}</div><div className="small muted truncate" style={{ maxWidth: 360 }}>{r.description ?? ''}</div></div> },
    { key: 'worker_name', label: 'Worker', sortable: true, mobile: 'subtitle', render: r => r.worker_name ? <Person name={r.worker_name} sub={r.company_name} color={r.avatar_color} size={28} /> : '—' },
    { key: 'kind', label: 'Type', render: r => humanize(r.kind) },
    { key: 'severity', label: 'Severity', sortable: true, render: r => <StatusPill status={r.severity} /> },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'created_by_name', label: 'Logged by' },
    { key: 'created_at', label: 'Logged', sortable: true, render: r => date(r.created_at) },
  ];
  return (
    <div>
      <PageHeader title="Issues" sub="Performance, attendance and client feedback — linked to the placement." actions={can('issues', 'create') ? <Button variant="primary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>Log issue</Button> : undefined} />
      {s && s.high > 0 && <Banner tone="danger"><b>{s.high} high-severity issue{s.high === 1 ? '' : 's'} open.</b> Review them and consider starting a replacement from the placement.</Banner>}
      <Async state={sum} rows={2}>{() => (
        <KpiRow items={[
          { label: 'Open issues', icon: <AlertTriangle size={16} />, value: s.open, delta: delta(s.new_30d, s.new_prev_30d), suffix: 'new vs prior 30 days', invert: true, to: '/workforce/issues?status=open' },
          { label: 'High / critical', icon: <Flame size={16} />, value: s.high, deltaText: <span>open now</span>, suffix: '', to: '/workforce/issues?severity=high' },
          { label: 'Resolved (30 days)', icon: <CheckCircle2 size={16} />, value: s.resolved_30d, deltaText: <span>{s.replacement} led to replacement</span>, suffix: '', to: '/workforce/issues?status=resolved' },
          { label: 'Avg. days to resolve', icon: <Timer size={16} />, value: s.avg_days_to_resolve ?? '—', deltaText: <span>all time</span>, suffix: '' },
        ]} />
      )}</Async>
      {s && s.byKind.length > 0 && <div style={{ marginBottom: 20 }}><Boundary label="Issues chart"><ChartCard title="Issues by type (6 months)"><SimpleBars data={s.byKind.map((k: any) => ({ label: humanize(k.label), value: k.value }))} height={200} /></ChartCard></Boundary></div>}
      <DataTable key={rk} title="All issues" endpoint="/api/v1/issues" columns={cols} rowLink={r => r.placement_id ? `/workforce/placements/${r.placement_id}?tab=issues` : null} exportName="issues" exportResource="issues"
        filters={[{ key: 'status', label: 'Status', options: opts(['open', 'investigating', 'resolved', 'replacement']) }, { key: 'kind', label: 'Type', options: opts(['performance', 'attendance', 'client_complaint', 'conduct', 'other']) }, { key: 'severity', label: 'Severity', options: opts(['low', 'medium', 'high', 'critical']) }]}
        rowActions={(r, rl) => [
          { label: 'Open placement', onClick: () => nav(`/workforce/placements/${r.placement_id}`), hidden: !r.placement_id },
          { label: 'Mark investigating', hidden: r.status !== 'open' || !can('issues', 'edit'), onClick: async () => { try { await api.patch(`/api/v1/issues/${r.id}`, { status: 'investigating' }); rl(); sum.reload(); } catch (e) { toast.error(e); } } },
          { label: 'Resolve…', hidden: r.status === 'resolved' || !can('issues', 'edit'), onClick: async () => { const c = await confirm({ title: `Resolve “${r.title}”`, reason: { label: 'Resolution', required: true } }); if (!c.ok) return; try { await api.patch(`/api/v1/issues/${r.id}`, { status: 'resolved', resolution: c.reason }); toast.success('Issue resolved'); rl(); sum.reload(); } catch (e) { toast.error(e); } } },
          { label: 'Reopen', hidden: r.status !== 'resolved' || !can('issues', 'edit'), onClick: async () => { try { await api.patch(`/api/v1/issues/${r.id}`, { status: 'open' }); rl(); sum.reload(); } catch (e) { toast.error(e); } } },
          { label: 'Start replacement', hidden: !r.placement_id || !can('placements', 'create') || r.status === 'resolved', onClick: () => nav(`/workforce/placements/new?replacesId=${r.placement_id}`) },
        ]}
        emptyTitle="No issues" emptyText="Log performance, attendance or client feedback against a placement." />
      <IssueDrawer open={open} onClose={() => setOpen(false)} onSaved={reload} />
    </div>
  );
}
