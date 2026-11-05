import { useSearchParams } from 'react-router-dom';
import { DollarSign, Users, TrendingUp, Percent } from 'lucide-react';
import { qs } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { money, date as fmtDate } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { Boundary, DateRangePicker, ErrorState, KpiRow, PageHeader, PermissionDenied, Segmented, Skeleton, presetRange, EmptyState } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { ChartCard, TrendLine, TrackBars, fmtMoneyCompact } from '../../components/charts';
import { Money, hoursOf, pctOf } from './shared';
import './payroll.css';

const GROUPS = [{ key: 'client', label: 'Client' }, { key: 'placement', label: 'Placement' }, { key: 'worker', label: 'Worker' }, { key: 'account_manager', label: 'Account manager' }, { key: 'team', label: 'Team' }, { key: 'month', label: 'Month' }] as const;

export default function Margin() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const def = presetRange(182, 'Last 6 months');
  const from = sp.get('from') ?? def.from; const to = sp.get('to') ?? def.to;
  const group = sp.get('group_by') ?? 'client';
  const basis = sp.get('basis') ?? 'approved';
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } n.delete('page'); n.delete('sort'); setSp(n, { replace: true }); };
  const base = { from, to, group_by: group, basis: basis === 'billed' ? 'billed' : undefined };
  const top = useApi<any>(can('margin', 'view') ? `/api/v1/margin${qs({ ...base, sort: 'gp_cents', dir: 'desc', pageSize: 8 })}` : null, [from, to, group, basis]);
  if (!can('margin', 'view')) return <PermissionDenied />;
  if (top.error && [403, 404].includes((top.error as any).status)) return <PermissionDenied text={top.error.message} />;
  const t = top.data?.totals;
  const groupLabel = GROUPS.find(g => g.key === group)?.label ?? 'Group';
  const cols: Column<any>[] = [
    { key: 'label', label: groupLabel, sortable: true, mobile: 'title', render: r => <b>{r.label}</b> },
    { key: 'placements', label: 'Placements', align: 'right' },
    { key: 'minutes', label: 'Hours', sortable: true, align: 'right', render: r => hoursOf(r.minutes) },
    { key: 'revenue_cents', label: 'Revenue', sortable: true, align: 'right', render: r => <Money cents={r.revenue_cents} />, csv: r => r.revenue_cents / 100 },
    { key: 'cost_cents', label: 'Worker cost', sortable: true, align: 'right', render: r => <Money cents={r.cost_cents} />, csv: r => r.cost_cents / 100 },
    { key: 'gp_cents', label: 'Gross margin', sortable: true, align: 'right', render: r => <Money cents={r.gp_cents} strong />, csv: r => r.gp_cents / 100 },
    { key: 'margin_pct', label: 'Contribution margin', sortable: true, align: 'right', mobile: 'subtitle', render: r => <b style={{ color: r.margin_pct < 0 ? 'var(--danger)' : r.margin_pct < 30 ? 'var(--warning)' : 'var(--success)' }}>{pctOf(r.margin_pct)}</b> },
  ];
  return (
    <div>
      <PageHeader title="Margin" sub={basis === 'billed' ? 'Billed revenue − worker cost of the same approved days' : 'Revenue and worker cost of all approved timesheet days'} actions={<>
        <DateRangePicker value={{ from, to, label: sp.get('from') ? `${fmtDate(from, { month: 'short', day: 'numeric' })} – ${fmtDate(to)}` : def.label }} onChange={r => set({ from: r.from, to: r.to })} />
        <Segmented options={[{ key: 'approved', label: 'Approved time' }, { key: 'billed', label: 'Billed only' }]} value={basis} onChange={k => set({ basis: k === 'billed' ? 'billed' : null })} />
      </>} />
      {top.error && !top.data ? <ErrorState error={top.error} retry={top.reload} /> : <>
        <Boundary label="Margin KPIs">
          {t ? <KpiRow items={[
            { label: 'Revenue', icon: <DollarSign size={18} />, value: money(t.revenue_cents, 'USD', { noCents: true }), deltaText: '', suffix: `${hoursOf(t.minutes)} approved`, onClick: () => set({ group_by: 'month' }) },
            { label: 'Worker cost', icon: <Users size={18} />, value: money(t.cost_cents, 'USD', { noCents: true }), deltaText: '', suffix: 'regular + overtime pay', onClick: () => set({ group_by: 'worker' }) },
            { label: 'Gross margin', icon: <TrendingUp size={18} />, value: money(t.gp_cents, 'USD', { noCents: true }), deltaText: '', suffix: 'revenue − cost', onClick: () => set({ group_by: 'client' }) },
            { label: 'Margin %', icon: <Percent size={18} />, value: pctOf(t.margin_pct), deltaText: '', suffix: 'contribution margin', onClick: () => set({ group_by: 'placement' }) },
          ]} /> : <Skeleton h={100} style={{ marginBottom: 22 }} />}
        </Boundary>
        <div className="grid-2 mb-3">
          <Boundary label="Margin trend">
            <ChartCard title="Gross margin by month">
              {top.data ? (top.data.trend.length ? <TrendLine data={top.data.trend.map((m: any) => ({ label: m.label, value: m.gp_cents, month: m.key }))} fmt={fmtMoneyCompact} /> : <EmptyState title="No approved time in this range" />) : <Skeleton h={260} />}
            </ChartCard>
          </Boundary>
          <Boundary label="Top groups">
            <ChartCard title={`Top ${groupLabel.toLowerCase()}s by gross margin`}>
              {top.data ? (top.data.rows.length ? <TrackBars data={top.data.rows.map((r: any) => ({ label: r.label, value: r.gp_cents }))} fmt={fmtMoneyCompact} valueName="Gross margin" /> : <EmptyState title="No data" />) : <Skeleton h={260} />}
            </ChartCard>
          </Boundary>
        </div>
      </>}
      <DataTable title={<span className="row" style={{ gap: 12 }}>Margin by <Segmented options={GROUPS.map(g => ({ key: g.key, label: g.label }))} value={group} onChange={k => set({ group_by: k })} /></span>}
        endpoint="/api/v1/margin" params={base} columns={cols} defaultSort="gp_cents" exportName={`margin-by-${group}`} exportResource="margin" emptyTitle="No approved time in this range" />
    </div>
  );
}
