import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Table2 } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { downloadText, toCsv } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Button, DateRangePicker, ErrorState, KpiRow, LoadingBlock, PageHeader, PermissionDenied, type DateRange } from '../../components/ui';
import { kpiItems, chunk, useUrlRange, fmtValue, type ApiKpi } from '../home/kit';

export { fmtValue };
/** Loads an analytics endpoint for the URL date range and renders the standard page header (range · export · report builder). */
export function useAnalytics<T = any>(path: string, defDays = 182, extra = '') {
  const [range, setRange] = useUrlRange(defDays);
  const st = useApi<T>(`${path}?from=${range.from}&to=${range.to}${extra}`);
  return { range, setRange, st };
}

export function AnalyticsPage({ title, sub, range, setRange, st, exportRows, exportName, children }: {
  title: string; sub?: ReactNode; range: DateRange; setRange: (r: DateRange) => void; st: { data: any; error: any; loading: boolean; reload: () => void };
  exportRows?: () => { rows: any[]; cols: { key: string; label: string; value?: (r: any) => unknown }[] } | null; exportName: string; children: (d: any) => ReactNode;
}) {
  const nav = useNavigate();
  const { can } = useAuth();
  const doExport = () => {
    const x = exportRows?.();
    if (!x || !x.rows.length) { toast.info('Nothing to export for this range'); return; }
    downloadText(`${exportName}-${range.from}-to-${range.to}.csv`, toCsv(x.rows, x.cols));
    api.post('/api/v1/exports/log', { resource: 'analytics', count: x.rows.length, filters: { page: exportName, from: range.from, to: range.to } }).catch(() => {});
    toast.success(`Exported ${x.rows.length} rows`);
  };
  const actions = <>
    <DateRangePicker value={range} onChange={setRange} />
    {exportRows && <Button icon={<Download size={16} />} onClick={doExport} disabled={!st.data}>Export CSV</Button>}
    <Button variant="primary" icon={<Table2 size={16} />} onClick={() => nav('/analytics/reports')}>Report Builder</Button>
  </>;
  if (!can('analytics', 'view')) return <><PageHeader title={title} /><PermissionDenied /></>;
  return (
    <div>
      <PageHeader title={title} sub={sub} actions={actions} />
      {st.error && !st.data ? <ErrorState error={st.error} retry={st.reload} /> : !st.data ? <LoadingBlock rows={10} /> : <div style={{ opacity: st.loading ? 0.6 : 1, transition: 'opacity .15s' }}>{children(st.data)}</div>}
    </div>
  );
}
export function Kpis({ kpis }: { kpis: ApiKpi[] }) {
  return <div className="ins-kpi-stack">{chunk(kpiItems(kpis), 4).map((r, i) => <KpiRow key={i} items={r} />)}</div>;
}
/** Simple sortable-less table for analytics breakdowns; rows with a link are clickable (drill-down). */
export function BreakdownTable({ rows, cols, onRow, empty = 'No data in this range' }: { rows: any[]; cols: { key: string; label: string; format?: 'money' | 'num' | 'pct' | 'hours'; render?: (r: any) => ReactNode; align?: 'right' }[]; onRow?: (r: any) => void; empty?: string }) {
  if (!rows.length) return <div className="ins-empty-chart" style={{ height: 120 }}>{empty}</div>;
  return (
    <div className="ins-table-scroll">
      <table className="table">
        <thead><tr>{cols.map(c => <th key={c.key} style={{ textAlign: c.align ?? (c.format ? 'right' : 'left') }}>{c.label}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={r.id ?? r.k ?? i} className={onRow && r.link ? 'clickable' : ''} onClick={() => onRow && r.link && onRow(r)}>{cols.map(c => <td key={c.key} style={{ textAlign: c.align ?? (c.format ? 'right' : 'left') }} className={c.format === 'money' ? 'money' : ''}>{c.render ? c.render(r) : c.format ? fmtValue(r[c.key], c.format) : (r[c.key] ?? '—')}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
