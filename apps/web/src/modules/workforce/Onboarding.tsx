import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, AlertTriangle, CheckCircle2, CalendarClock, Plus } from 'lucide-react';
import { PageHeader, Banner, KpiRow, Button, Person, Async } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { date } from '../../lib/format';
import { Progress } from './shared';

export default function Onboarding() {
  const nav = useNavigate();
  const { can } = useAuth();
  const sum = useApi<any>('/api/v1/placements/summary');
  const s = sum.data;
  const cols: Column<any>[] = [
    { key: 'worker_name', label: 'Worker', sortable: true, mobile: 'title', render: r => <Person name={r.worker_name} sub={r.title} color={r.avatar_color} /> },
    { key: 'company_name', label: 'Client', sortable: true, mobile: 'subtitle' },
    { key: 'start_date', label: 'Starts', sortable: true, render: r => date(r.start_date) },
    { key: 'req', label: 'Required items', render: r => <Progress done={r.req_done} total={r.req_total} />, csv: r => `${r.req_done}/${r.req_total}` },
    { key: 'items', label: 'All items', render: r => `${r.items_done}/${r.items_total}`, mobile: 'hidden' },
    { key: 'missing', label: 'Still missing (required)', render: r => r.missing ? <span className="small">{r.missing}</span> : <span className="pill pill-green">Ready to activate</span> },
    { key: 'account_manager_name', label: 'Account manager' },
  ];
  return (
    <div>
      <PageHeader title="Onboarding" sub="Agency template + client requirements + position requirements + manual items, per placement." actions={can('placements', 'create') ? <Button variant="primary" icon={<Plus size={16} />} onClick={() => nav('/workforce/placements/new')}>New placement</Button> : undefined} />
      {s && s.ready > 0 && <Banner tone="success"><b>{s.ready} placement{s.ready === 1 ? ' has' : 's have'} every required item done</b> — open {s.ready === 1 ? 'it' : 'them'} and click Activate to start the seat.</Banner>}
      <Async state={sum} rows={2}>{() => (
        <KpiRow items={[
          { label: 'In onboarding', icon: <ClipboardCheck size={16} />, value: s.onboarding, deltaText: <span>across all clients</span>, suffix: '', to: '/workforce/onboarding' },
          { label: 'Blocked', icon: <AlertTriangle size={16} />, value: s.blocked, deltaText: <span>required items open</span>, suffix: '', to: '/workforce/onboarding?blocked=true', invert: true },
          { label: 'Ready to activate', icon: <CheckCircle2 size={16} />, value: s.ready, deltaText: <span>all required done</span>, suffix: '', to: '/workforce/onboarding?ready=true' },
          { label: 'Starting within 7 days', icon: <CalendarClock size={16} />, value: s.starting_soon, deltaText: <span>check equipment & access</span>, suffix: '', to: '/workforce/onboarding' },
        ]} />
      )}</Async>
      <DataTable title="Onboarding placements" endpoint="/api/v1/onboarding" columns={cols} rowLink={r => `/workforce/placements/${r.id}?tab=onboarding`} exportName="onboarding" exportResource="onboarding" defaultSort="start_date" defaultDir="asc"
        filters={[{ key: 'blocked', label: 'Blocked', type: 'boolean' }, { key: 'ready', label: 'Ready', type: 'boolean' }]}
        emptyTitle="Nobody is onboarding" emptyText="New placements start here until every required item is complete." />
    </div>
  );
}
