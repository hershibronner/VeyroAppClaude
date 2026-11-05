import { useNavigate } from 'react-router-dom';
import { Briefcase, Plus, ClipboardCheck, CalendarClock, LogOut, AlertTriangle } from 'lucide-react';
import { PageHeader, Banner, KpiRow, Button, Person, StatusPill, Boundary, Async } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { ChartCard, TrendLine, TrackBars, fmtNum } from '../../components/charts';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { date, money, delta } from '../../lib/format';
import { Progress } from './shared';

export function placementColumns(viewComp: boolean): Column<any>[] {
  return [
    { key: 'worker_name', label: 'Worker', sortable: true, mobile: 'title', render: r => <Person name={r.worker_name} sub={r.title} color={r.avatar_color} /> },
    { key: 'company_name', label: 'Client', sortable: true, mobile: 'subtitle' },
    { key: 'status', label: 'Status', sortable: true, render: r => <span className="row" style={{ gap: 6 }}><StatusPill status={r.status} />{r.replaces_placement_id && <StatusPill status="replacement" label="Replacement" tone="purple" />}</span> },
    { key: 'progress', label: 'Onboarding', sortable: true, render: r => r.status === 'onboarding' ? <Progress done={r.req_done} total={r.req_total} label={`${r.req_done}/${r.req_total} required`} /> : <span className="small muted">{r.items_done}/{r.items_total} done</span>, csv: r => `${r.req_done}/${r.req_total}` },
    { key: 'start_date', label: 'Start', sortable: true, render: r => date(r.start_date) },
    { key: 'end_date', label: 'End', render: r => date(r.end_date) },
    { key: 'account_manager_name', label: 'Account manager' },
    { key: 'policy_name', label: 'Monitoring', mobile: 'hidden' },
    ...(viewComp ? [
      { key: 'pay_rate_cents', label: 'Pay', align: 'right' as const, render: (r: any) => money(r.pay_rate_cents, r.currency), csv: (r: any) => r.pay_rate_cents / 100 },
      { key: 'bill_rate_cents', label: 'Bill', align: 'right' as const, render: (r: any) => money(r.bill_rate_cents, r.currency), csv: (r: any) => r.bill_rate_cents / 100 },
    ] : []),
  ];
}

export default function Placements() {
  const nav = useNavigate();
  const { can } = useAuth();
  const sum = useApi<any>('/api/v1/placements/summary');
  const s = sum.data;
  const clients = useApi<any>('/api/v1/companies?stage=client&pageSize=500&sort=name&dir=asc');
  const clientOpts = (clients.data?.rows ?? []).map((c: any) => ({ value: c.id, label: c.name }));
  return (
    <div>
      <PageHeader title="Placements" sub="Placement is the operational heart — time, billing, payroll and offboarding all reference it." actions={<>
        <Button icon={<ClipboardCheck size={16} />} onClick={() => nav('/workforce/onboarding')}>Onboarding</Button>
        {can('placements', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => nav('/workforce/placements/new')}>New placement</Button>}
      </>} />
      {s && s.starting_soon > 0 && <Banner tone={s.blocked ? 'warn' : 'info'}><b>{s.starting_soon} placement{s.starting_soon === 1 ? '' : 's'} start within 7 days</b>{s.blocked ? ` and ${s.blocked} still ${s.blocked === 1 ? 'has' : 'have'} required onboarding items open.` : '.'} <a href="/workforce/onboarding" onClick={e => { e.preventDefault(); nav('/workforce/onboarding'); }}>Review →</a></Banner>}
      <Async state={sum} rows={2}>{() => (
        <KpiRow items={[
          { label: 'Active placements', icon: <Briefcase size={16} />, value: s.active, delta: delta(s.started_this_month, s.started_last_month), suffix: 'starts vs last month', to: '/workforce/placements?status=active' },
          { label: 'In onboarding', icon: <ClipboardCheck size={16} />, value: s.onboarding, deltaText: <span>{s.ready} ready to activate</span>, suffix: '', to: '/workforce/placements?status=onboarding' },
          { label: 'Blocked by required items', icon: <AlertTriangle size={16} />, value: s.blocked, deltaText: <span>{s.starting_soon} starting within 7 days</span>, suffix: '', to: '/workforce/placements?blocked=true', invert: true },
          { label: 'Ended (90 days)', icon: <LogOut size={16} />, value: s.ended_90d, deltaText: <span>{s.on_leave} on leave · {s.notice} on notice</span>, suffix: '', to: '/workforce/placements?status=ended' },
        ]} />
      )}</Async>
      {s && <div className="grid-2" style={{ marginBottom: 20 }}>
        <Boundary label="Trend"><ChartCard title="Active placements" big={fmtNum(s.trend[s.trend.length - 1]?.value ?? 0)} delta={<span className="muted">at month end · last 6 months</span>}><TrendLine data={s.trend} fmt={fmtNum} /></ChartCard></Boundary>
        <Boundary label="By client"><ChartCard title="Active placements by client" big={fmtNum(s.byClient.reduce((a: number, b: any) => a + b.value, 0))}><TrackBars data={s.byClient} fmt={fmtNum} valueName="Placements" onBarClick={d => nav(`/workforce/placements?company_id=${d.id}`)} /></ChartCard></Boundary>
      </div>}
      <CalendarHint />
      <DataTable title="All placements" endpoint="/api/v1/placements" columns={placementColumns(can('rates', 'view_comp') || can('placements', 'view_comp'))} rowLink={r => `/workforce/placements/${r.id}`} exportName="placements" exportResource="placements"
        filters={[
          { key: 'status', label: 'Status', options: opts(['onboarding', 'active', 'on_leave', 'notice', 'ended']) },
          { key: 'company_id', label: 'Client', options: clientOpts },
          { key: 'account_manager_id', label: 'Account manager', type: 'member' },
          { key: 'blocked', label: 'Blocked onboarding', type: 'boolean' },
          { key: 'replacement', label: 'Replacements', type: 'boolean' },
        ]} searchPlaceholder="Search worker, client, role" emptyTitle="No placements" emptyText="Create a placement from an accepted offer, or start one here." />
    </div>
  );
}
function CalendarHint() { return <div className="small muted" style={{ margin: '0 0 10px' }}><CalendarClock size={12} /> Tip: open a placement to manage onboarding, rates, schedule & monitoring, and offboarding.</div>; }
