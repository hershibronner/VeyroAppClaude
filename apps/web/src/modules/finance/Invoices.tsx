import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, FileDown, Send, ExternalLink, Receipt, AlertTriangle, FileText, Banknote } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { money, date, delta } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Boundary, Button, KpiRow, PageHeader, PermissionDenied, StatusPill, Tabs, Skeleton } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { INVOICE_STATUSES, Money, period } from './shared';
import { useClientOptions } from './Rates';
import './finance.css';

const OPEN = ['sent', 'viewed', 'partially_paid', 'overdue'];

export default function Invoices() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'credits' ? 'credits' : 'invoices';
  const stats = useApi<any>('/api/v1/invoices/stats');
  const clients = useClientOptions();
  if (!can('invoices', 'view')) return <PermissionDenied />;
  const s = stats.data;
  const cols: Column<any>[] = [
    { key: 'number', label: 'Invoice', sortable: true, mobile: 'title', render: r => <b>{r.number}</b> },
    { key: 'company_name', label: 'Client', sortable: true, mobile: 'subtitle' },
    { key: 'period', label: 'Period', render: r => period(r.period_start, r.period_end), csv: r => `${r.period_start ?? ''} – ${r.period_end ?? ''}` },
    { key: 'issue_date', label: 'Issued', sortable: true, render: r => date(r.issue_date) },
    { key: 'due_date', label: 'Due', sortable: true, render: r => <>{date(r.due_date)}{r.days_overdue > 0 && <div className="fin-red small">{r.days_overdue} days overdue</div>}</> },
    { key: 'total_cents', label: 'Total', align: 'right', sortable: true, render: r => <Money cents={r.total_cents} currency={r.currency} />, csv: r => r.total_cents / 100 },
    { key: 'paid_cents', label: 'Paid', align: 'right', render: r => <Money cents={r.paid_cents} currency={r.currency} muted />, csv: r => r.paid_cents / 100 },
    { key: 'balance_cents', label: 'Balance', align: 'right', sortable: true, render: r => <Money cents={r.balance_cents} currency={r.currency} strong />, csv: r => r.balance_cents / 100 },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'sync_status', label: 'Accounting', mobile: 'hidden', render: r => (r.sync_status ? <StatusPill status={r.sync_status} /> : <span className="muted">Not synced</span>) },
  ];
  const cnCols: Column<any>[] = [
    { key: 'number', label: 'Number', mobile: 'title', render: r => <b>{r.number}</b> },
    { key: 'kind', label: 'Type', render: r => <StatusPill status={r.kind} tone={r.kind === 'write_off' ? 'red' : r.kind === 'refund' ? 'amber' : 'blue'} /> },
    { key: 'company_name', label: 'Client', mobile: 'subtitle' },
    { key: 'invoice_number', label: 'Invoice' },
    { key: 'amount_cents', label: 'Amount', align: 'right', sortable: true, render: r => <Money cents={r.amount_cents} currency={r.currency} />, csv: r => r.amount_cents / 100 },
    { key: 'reason', label: 'Reason' },
    { key: 'created_by_name', label: 'By' },
    { key: 'created_at', label: 'Date', sortable: true, render: r => date(r.created_at) },
  ];
  return (
    <div>
      <PageHeader title="Invoices" sub="Generated from approved timesheets. Totals are recomputed with history on every change."
        actions={can('invoices', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => nav('/finance/invoices/new')}>New Invoice</Button>} />
      <Boundary label="Invoice KPIs">
        {s ? <KpiRow items={[
          { label: 'Open balance', icon: <Receipt size={16} />, value: money(s.open_cents, 'USD', { noCents: true }), deltaText: `${s.open} open invoice${s.open === 1 ? '' : 's'}`, suffix: '', to: '/finance/invoices?status=open' },
          { label: 'Overdue', icon: <AlertTriangle size={16} />, value: money(s.overdue_cents, 'USD', { noCents: true }), deltaText: s.overdue ? <b className="down">{s.overdue} overdue</b> : 'None overdue', suffix: '', to: '/finance/invoices?status=overdue' },
          { label: 'Drafts to review', icon: <FileText size={16} />, value: s.drafts, deltaText: `${s.approved} approved, not sent`, suffix: '', to: '/finance/invoices?status=draft' },
          { label: 'Collected this month', icon: <Banknote size={16} />, value: money(s.collected_this_month, 'USD', { noCents: true }), delta: delta(Number(s.collected_this_month), Number(s.collected_last_month)), to: '/finance/ar?tab=payments' },
        ]} /> : stats.error ? null : <Skeleton h={90} style={{ marginBottom: 24 }} />}
      </Boundary>
      <Tabs tabs={[{ key: 'invoices', label: 'Invoices' }, { key: 'credits', label: 'Credit notes, refunds & write-offs' }]} value={tab} onChange={k => setSp(new URLSearchParams(k === 'credits' ? { tab: k } : {}), { replace: true })} />
      {tab === 'invoices' ? (
        <DataTable title="All invoices" endpoint="/api/v1/invoices" columns={cols} exportName="invoices" exportResource="invoices"
          filters={[
            { key: 'status', label: 'Status', options: [{ value: 'open', label: 'Open (unpaid, sent)' }, { value: 'unpaid', label: 'All unpaid' }, ...opts(INVOICE_STATUSES)] },
            { key: 'company_id', label: 'Client', options: clients },
            { key: 'aging', label: 'Aging', options: [{ value: 'current', label: 'Current' }, { value: '1_30', label: '1–30 days' }, { value: '31_60', label: '31–60 days' }, { value: '61_90', label: '61–90 days' }, { value: '90_plus', label: '90+ days' }] },
            { key: 'sync', label: 'Accounting', options: [{ value: 'failed', label: 'Sync failed' }, { value: 'unsynced', label: 'Not synced' }] },
          ]}
          rowLink={r => `/finance/invoices/${r.id}`}
          rowActions={(r, reload) => [
            { label: 'Open', icon: <ExternalLink size={15} />, onClick: () => nav(`/finance/invoices/${r.id}`) },
            { label: 'Download PDF', icon: <FileDown size={15} />, onClick: () => window.open(`/api/v1/invoices/${r.id}/pdf?download=1`, '_blank') },
            { label: 'Send reminder', icon: <Send size={15} />, hidden: !OPEN.includes(r.status) || !can('invoices', 'edit'), onClick: async () => { try { const x = await api.post(`/api/v1/invoices/${r.id}/remind`); toast.success(`Reminder sent to ${x.sent_to}`); reload(); } catch (e) { toast.error(e); } } },
          ]}
          searchPlaceholder="Search number or client" emptyTitle="No invoices yet" emptyText="Generate an invoice from approved timesheets."
          emptyAction={can('invoices', 'create') ? <Button variant="primary" size="sm" onClick={() => nav('/finance/invoices/new')}>New invoice</Button> : undefined} />
      ) : (
        <DataTable title="Credit notes" endpoint="/api/v1/credit-notes" columns={cnCols} exportName="credit-notes" exportResource="invoices"
          filters={[{ key: 'kind', label: 'Type', options: opts(['credit', 'refund', 'write_off', 'overpayment']) }, { key: 'company_id', label: 'Client', options: clients }]}
          rowLink={r => (r.invoice_id ? `/finance/invoices/${r.invoice_id}` : null)} searchPlaceholder="Search number, client, reason" emptyTitle="No credit notes" />
      )}
    </div>
  );
}
