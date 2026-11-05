import { useNavigate, useSearchParams } from 'react-router-dom';
import { CreditCard, FileText, Receipt, AlertTriangle, CalendarClock } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { money, date as fmtDate } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { Banner, Button, PageHeader, StatusPill, Tabs, KpiRow, Skeleton } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { Money, period } from './shared';
import './payroll.css';

export default function ClientInvoices() {
  const nav = useNavigate();
  const { me } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('status') === 'open' ? 'open' : sp.get('status') === 'paid' ? 'paid' : 'all';
  const sum = useApi<any>('/api/v1/portal/client/invoices?pageSize=1&status=open');
  const s = sum.data?.summary;
  const canPay = me?.workspace?.role.key !== 'client_viewer';
  const cols: Column<any>[] = [
    { key: 'number', label: 'Invoice', sortable: true, mobile: 'title', render: r => <b>{r.number}</b> },
    { key: 'period', label: 'Service period', render: r => period(r.period_start, r.period_end) },
    { key: 'issue_date', label: 'Issued', sortable: true, render: r => fmtDate(r.issue_date) },
    { key: 'due_date', label: 'Due', sortable: true, render: r => <span>{fmtDate(r.due_date)}{r.days_overdue > 0 && <div className="small" style={{ color: 'var(--danger)' }}>{r.days_overdue} days overdue</div>}</span> },
    { key: 'total_cents', label: 'Total', sortable: true, align: 'right', render: r => <Money cents={r.total_cents} currency={r.currency} /> },
    { key: 'balance_cents', label: 'Balance', align: 'right', render: r => <Money cents={r.balance_cents} currency={r.currency} strong={r.balance_cents > 0} muted={r.balance_cents <= 0} /> },
    { key: 'status', label: 'Status', mobile: 'subtitle', render: r => <StatusPill status={r.status} /> },
    { key: 'pay', label: '', render: r => (r.pay_url && canPay ? <Button size="sm" variant="primary" icon={<CreditCard size={14} />} onClick={e => { e.stopPropagation(); nav(r.pay_url); }}>Pay now</Button> : null), mobile: 'hidden' },
  ];
  return (
    <div>
      <PageHeader title="Invoices" sub="View, download and pay your invoices." />
      {s && s.overdue_count > 0 && <Banner tone="danger"><b>{s.overdue_count} invoice{s.overdue_count > 1 ? 's are' : ' is'} overdue.</b> Pay online by card to avoid late fees.</Banner>}
      {s ? <KpiRow items={[
        { label: 'Open balance', icon: <Receipt size={18} />, value: money(s.open_cents), deltaText: '', suffix: `${s.open_count} open invoice${s.open_count === 1 ? '' : 's'}`, onClick: () => setSp({ status: 'open' }) },
        { label: 'Overdue', icon: <AlertTriangle size={18} />, value: s.overdue_count, deltaText: '', suffix: 'invoices past due', onClick: () => setSp({ status: 'overdue' }) },
        { label: 'Next due', icon: <CalendarClock size={18} />, value: s.next_due ? fmtDate(s.next_due, { month: 'short', day: 'numeric' }) : '—', deltaText: '', suffix: s.next_due ? fmtDate(s.next_due, { year: 'numeric' }) : 'nothing due', onClick: () => setSp({ status: 'open' }) },
      ]} /> : <Skeleton h={100} style={{ marginBottom: 22 }} />}
      <Tabs tabs={[{ key: 'all', label: 'All' }, { key: 'open', label: 'Open', count: s?.open_count }, { key: 'paid', label: 'Paid' }]} value={tab} onChange={k => setSp(k === 'all' ? {} : { status: k })} />
      <div className="mt-3">
        <DataTable endpoint="/api/v1/portal/client/invoices" columns={cols} rowLink={r => `/portal/client/invoices/${r.id}`} searchPlaceholder="Search invoice number"
          rowActions={r => [
            { label: 'View', icon: <FileText size={15} />, onClick: () => nav(`/portal/client/invoices/${r.id}`) },
            { label: 'Download PDF', onClick: () => window.open(`/api/v1/portal/client/invoices/${r.id}/pdf`, '_blank') },
            { label: 'Pay now', icon: <CreditCard size={15} />, hidden: !r.pay_url || !canPay, onClick: () => nav(r.pay_url) },
          ]}
          emptyTitle={tab === 'open' ? 'No open invoices' : 'No invoices yet'} emptyText={tab === 'open' ? 'You are all paid up.' : 'Invoices appear here once they are sent to you.'} exportName="invoices" />
      </div>
    </div>
  );
}
