import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { money, dateTime, humanize } from '../../lib/format';
import { toast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import { realtime } from '../../lib/realtime';
import { Boundary, Card, CardHeader, KpiRow, PageHeader, PermissionDenied, StatusPill } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { Money, period } from './shared';
import './payroll.css';

export default function Payouts() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [key, setKey] = useState(0);
  const monthStart = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; })();
  const processing = useApi<any>('/api/v1/payouts?status=processing&pageSize=1', [key]);
  const initiated = useApi<any>('/api/v1/payouts?status=initiated&pageSize=1', [key]);
  const failedBatches = useApi<any>('/api/v1/payouts?has_failed=true&pageSize=200', [key]);
  const recent = useApi<any>('/api/v1/payouts?pageSize=200&sort=created_at&dir=desc', [key]);
  useEffect(() => realtime.on('payout', () => setKey(k => k + 1)), []);
  if (!can('payouts', 'view')) return <PermissionDenied />;
  const failedItems = (failedBatches.data?.rows ?? []).reduce((a: number, r: any) => a + r.failed_items, 0);
  const paidThisMonth = (recent.data?.rows ?? []).filter((r: any) => r.status === 'paid' && (r.completed_at ?? r.created_at) >= monthStart).reduce((a: number, r: any) => a + Number(r.total_cents), 0);
  const setFilter = (patch: Record<string, string | null>) => { const n = new URLSearchParams(); for (const [k, v] of Object.entries(patch)) if (v) n.set(k, v); setSp(n, { replace: true }); };
  const cols: Column<any>[] = [
    { key: 'created_at', label: 'Submitted', sortable: true, mobile: 'title', render: r => <b>{dateTime(r.created_at)}</b> },
    { key: 'kind', label: 'Type', render: r => humanize(r.kind) },
    { key: 'period', label: 'Pay period', render: r => (r.period_start ? period(r.period_start, r.period_end) : <span className="muted">Commission payout</span>) },
    { key: 'items', label: 'Transfers', align: 'right', render: r => <span>{r.paid_items}/{r.items} paid{r.failed_items > 0 && <span style={{ color: 'var(--danger)' }}> · {r.failed_items} failed</span>}</span> },
    { key: 'total_cents', label: 'Total', sortable: true, align: 'right', render: r => <Money cents={r.total_cents} currency={r.currency} strong /> },
    { key: 'initiated_by_name', label: 'Initiated by' },
    { key: 'status', label: 'Status', sortable: true, mobile: 'subtitle', render: r => <StatusPill status={r.status} /> },
  ];
  return (
    <div>
      <PageHeader title="Payouts" sub="Worker and commission transfers through Wise (simulated)." />
      <KpiRow items={[
        { label: 'Batches in progress', icon: <Loader2 size={18} />, value: (processing.data?.total ?? 0) + (initiated.data?.total ?? 0), deltaText: '', suffix: 'initiated or processing', onClick: () => setFilter({ status: 'processing' }) },
        { label: 'Failed transfers', icon: <AlertTriangle size={18} />, value: failedItems, deltaText: '', suffix: `in ${failedBatches.data?.total ?? 0} batch${failedBatches.data?.total === 1 ? '' : 'es'}`, onClick: () => setFilter({ has_failed: 'true' }) },
        { label: 'Paid this month', icon: <CheckCircle2 size={18} />, value: money(paidThisMonth, 'USD', { noCents: true }), deltaText: '', suffix: 'completed batches', onClick: () => setFilter({ status: 'paid' }) },
      ]} />
      <div className="grid-main-side">
        <DataTable title="Payout batches" endpoint="/api/v1/payouts" columns={cols} rowLink={r => `/finance/payouts/${r.id}`} reloadKey={key} exportName="payouts" exportResource="payouts"
          filters={[{ key: 'status', label: 'Status', options: opts(['initiated', 'processing', 'paid', 'partially_failed', 'failed']) }, { key: 'kind', label: 'Type', options: opts(['payroll', 'commission']) }, { key: 'has_failed', label: 'Has failures', type: 'boolean' }]}
          emptyTitle="No payouts yet" emptyText="Approve a payroll run and initiate the payout to send transfers." />
        <Boundary label="Simulation"><SimulationCard canEdit={can('payouts', 'edit')} /></Boundary>
      </div>
    </div>
  );
}

function SimulationCard({ canEdit }: { canEdit: boolean }) {
  const st = useApi<any>('/api/v1/payouts/simulation');
  const [busy, setBusy] = useState(false);
  const save = async (v: number) => { setBusy(true); try { await api.put('/api/v1/payouts/simulation', { failure_rate: v }); toast.success(`Failure chance set to ${Math.round(v * 100)}%`); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  const d = st.data;
  return (
    <Card>
      <CardHeader title="Wise (simulated)" right={d && <StatusPill status={d.status} />} />
      <div className="card-b stack" style={{ gap: 10 }}>
        <div className="small muted">Batches move Initiated → Processing → Paid over ~10–30 seconds. Each transfer can fail with the chance below; failed transfers can be retried.</div>
        <label className="small bold" htmlFor="pr-fail">Failure chance per transfer</label>
        <select id="pr-fail" className="select" disabled={!canEdit || busy || !d} value={d ? String(d.failure_rate) : ''} onChange={e => save(Number(e.target.value))}>
          {[0, 0.05, 0.08, 0.2, 0.5].concat(d && ![0, 0.05, 0.08, 0.2, 0.5].includes(d.failure_rate) ? [d.failure_rate] : []).map(v => <option key={v} value={String(v)}>{Math.round(v * 100)}%</option>)}
        </select>
        {!canEdit && <div className="small muted">Only users who can edit payouts can change this.</div>}
        {d?.last_sync_at && <div className="small muted">Last activity {dateTime(d.last_sync_at)}</div>}
      </div>
    </Card>
  );
}
