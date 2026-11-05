import { useNavigate } from 'react-router-dom';
import { Users, UserCheck, Radio, Clock, Plus, Hourglass } from 'lucide-react';
import { PageHeader, Banner, KpiRow, Button, Person, StatusPill, Boundary, Async } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { ChartCard, TrackBars, SimpleBars, fmtHours, fmtNum } from '../../components/charts';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { date, delta } from '../../lib/format';
import { LivePill, hrs } from './shared';

const TITLES: Record<string, { title: string; sub: string; status?: string }> = {
  all: { title: 'All Workers', sub: 'Every worker in this agency — one record per person, across all placements.' },
  active: { title: 'Active Workers', sub: 'Workers with an active placement.', status: 'active' },
  pending: { title: 'Pending Workers', sub: 'Placed and onboarding — not active yet.', status: 'pending' },
  available: { title: 'Available Workers', sub: 'Previously placed and ready for a new placement.', status: 'available' },
  on_leave: { title: 'Workers on Leave', sub: 'Placement paused for approved leave.', status: 'on_leave' },
  inactive: { title: 'Inactive Workers', sub: 'Not available for placement.', status: 'inactive' },
};

export default function Workers({ tab }: { tab: keyof typeof TITLES }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const t = TITLES[tab];
  const sum = useApi<any>('/api/v1/workers/summary');
  const pls = useApi<any>('/api/v1/placements/summary');
  const s = sum.data;
  const cols: Column<any>[] = [
    { key: 'name', label: 'Worker', sortable: true, mobile: 'title', render: r => <Person name={r.name} sub={r.headline ?? r.email} color={r.avatar_color} /> },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'placement_title', label: 'Current placement', mobile: 'subtitle', render: r => r.placement_title ? <div><div className="truncate">{r.placement_title}</div><div className="small muted truncate">{r.company_name}</div></div> : <span className="muted">—</span>, csv: r => r.placement_title ? `${r.placement_title} @ ${r.company_name}` : '' },
    { key: 'live_state', label: 'Now', render: r => r.placement_status === 'active' ? <LivePill status={r.live_state ?? 'offline'} /> : <span className="muted">—</span> },
    { key: 'week_minutes', label: 'This week', sortable: true, align: 'right', render: r => hrs(r.week_minutes), csv: r => (r.week_minutes / 60).toFixed(2) },
    { key: 'account_manager_name', label: 'Account manager' },
    { key: 'country', label: 'Country' },
    { key: 'start_date', label: 'Started', sortable: true, render: r => date(r.start_date) },
    { key: 'has_portal', label: 'Portal', render: r => r.has_portal ? <StatusPill status="active" label="Invited" /> : <span className="muted">No</span>, csv: r => r.has_portal ? 'yes' : 'no' },
  ];
  const banner = pls.data && pls.data.blocked > 0
    ? <Banner tone="warn"><b>{pls.data.blocked} placement{pls.data.blocked === 1 ? '' : 's'} blocked in onboarding</b> — required items are still open{pls.data.starting_soon ? `, ${pls.data.starting_soon} starting within 7 days` : ''}. <a href="/workforce/onboarding?blocked=true" onClick={e => { e.preventDefault(); nav('/workforce/onboarding?blocked=true'); }}>Review onboarding →</a></Banner>
    : pls.data && pls.data.ready > 0 ? <Banner tone="success"><b>{pls.data.ready} worker{pls.data.ready === 1 ? ' is' : 's are'} ready to activate.</b> <a href="/workforce/onboarding?ready=true" onClick={e => { e.preventDefault(); nav('/workforce/onboarding?ready=true'); }}>Activate now →</a></Banner> : null;
  return (
    <div>
      <PageHeader title={t.title} sub={t.sub} actions={<>
        <Button onClick={() => nav('/time/live')} icon={<Radio size={16} />}>Live Now</Button>
        {can('placements', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => nav('/workforce/placements/new')}>New placement</Button>}
      </>} />
      {banner}
      <Async state={sum} rows={2}>{() => (
        <KpiRow items={[
          { label: 'Total workers', icon: <Users size={16} />, value: s.total, delta: delta(s.new_this_month, s.new_last_month), suffix: 'new vs last month', to: '/workforce/workers' },
          { label: 'Active', icon: <UserCheck size={16} />, value: s.active, deltaText: <span>{s.on_leave} on leave</span>, suffix: '', to: '/workforce/active' },
          { label: 'Pending start', icon: <Hourglass size={16} />, value: s.pending, deltaText: <span>{s.available} available</span>, suffix: '', to: '/workforce/pending' },
          { label: 'Clocked in now', icon: <Radio size={16} />, value: s.live, deltaText: <span>{hrs(s.hours.this_week, 0)} tracked this week</span>, suffix: '', to: '/time/live' },
        ]} />
      )}</Async>
      {tab === 'all' && s && (
        <div className="grid-2" style={{ marginBottom: 20 }}>
          <Boundary label="Hours chart"><ChartCard title="Tracked hours per week" big={hrs(s.hoursTrend[s.hoursTrend.length - 2]?.value ?? 0, 0)} delta={<span className="muted">last full week · 12 weeks shown</span>}>
            <TrackBars data={s.hoursTrend} fmt={fmtHours} valueName="Hours" onBarClick={d => nav(`/time/timesheets?week_start=${d.week}`)} />
          </ChartCard></Boundary>
          <Boundary label="Country chart"><ChartCard title="Active & pending workers by country" big={fmtNum(s.byCountry.reduce((a: number, b: any) => a + b.value, 0))}>
            <SimpleBars data={s.byCountry} height={240} />
          </ChartCard></Boundary>
        </div>
      )}
      <DataTable title={t.title} endpoint="/api/v1/workers" params={{ status: t.status }} columns={cols} rowLink={r => `/workforce/workers/${r.id}`} exportName={`workers-${tab}`} exportResource="workers" defaultSort="" searchPlaceholder="Search name, email, client, code"
        filters={[
          ...(tab === 'all' ? [{ key: 'status', label: 'Status', options: opts(['active', 'pending', 'available', 'on_leave', 'inactive']) }] : []),
          { key: 'live', label: 'Clocked in', type: 'boolean' as const },
          { key: 'portal', label: 'Portal access', type: 'boolean' as const },
          { key: 'account_manager_id', label: 'Account manager', type: 'member' as const },
        ]}
        emptyTitle={`No ${t.title.toLowerCase()}`} emptyText="Workers appear here when a candidate is placed." />
      <div className="small muted" style={{ marginTop: 10 }}><Clock size={12} /> Hours include time tracked today and update as workers clock in.</div>
    </div>
  );
}
