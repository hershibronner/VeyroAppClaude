import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { money, date, dateTime, humanize, relTime, todayISO } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Async, Banner, Boundary, Button, Card, CardHeader, DateRangePicker, Dialog, EmptyState, Field, KpiRow, MoneyInput, PageHeader, PermissionDenied, StatusPill, Tabs, type DateRange } from '../../components/ui';
import { ChartCard, TrackBars, fmtMoney } from '../../components/charts';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { Money, Stat } from './shared';
import './finance.css';

type Tab = 'aging' | 'payments' | 'reconciliation' | 'accounting';

export default function AR() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (['aging', 'payments', 'reconciliation', 'accounting'].includes(sp.get('tab') ?? '') ? sp.get('tab') : 'aging') as Tab;
  if (!can('invoices', 'view')) return <PermissionDenied />;
  return (
    <div>
      <PageHeader title="Payments & AR" sub="Receivables aging, collections, payments, reconciliation and accounting sync." />
      <Tabs tabs={[{ key: 'aging', label: 'AR aging & collections' }, { key: 'payments', label: 'Payments', hidden: !can('payments', 'view') }, { key: 'reconciliation', label: 'Reconciliation', hidden: !can('payments', 'view') }, { key: 'accounting', label: 'Accounting sync' }]} value={tab} onChange={k => setSp(new URLSearchParams({ tab: k }), { replace: true })} />
      {tab === 'aging' && <Aging />}
      {tab === 'payments' && <Payments />}
      {tab === 'reconciliation' && <Reconciliation />}
      {tab === 'accounting' && <Accounting />}
    </div>
  );
}

function Aging() {
  const nav = useNavigate();
  const { can } = useAuth();
  const st = useApi<any>('/api/v1/finance/ar');
  const [busy, setBusy] = useState<string | null>(null);
  const remind = async (id: string) => { setBusy(id); try { const r = await api.post(`/api/v1/invoices/${id}/remind`); toast.success(`Reminder sent to ${r.sent_to}`); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(null); } };
  return (
    <Async state={st} rows={6}>{d => (
      <div className="fin-stack">
        {d.overdue_cents > 0 && <Banner tone="warn">{money(d.overdue_cents)} is past due across {d.collections.length} invoice{d.collections.length === 1 ? '' : 's'}. Average days to collect (last 90 days): {d.dso_days}.</Banner>}
        <KpiRow items={d.buckets.map((b: any) => ({ label: b.label, value: money(b.amount_cents, 'USD', { noCents: true }), deltaText: `${b.count} invoice${b.count === 1 ? '' : 's'}`, suffix: '', to: `/finance/invoices?aging=${b.key}` }))} />
        <div className="grid-2">
          <Boundary label="Aging chart">
            <ChartCard title="Open balance by age" big={money(d.total_cents, 'USD', { noCents: true })} delta={<span className="muted">DSO {d.dso_days} days</span>}>
              <TrackBars data={d.buckets.map((b: any) => ({ label: b.label, value: b.amount_cents, key: b.key }))} fmt={fmtMoney} onBarClick={(x: any) => nav(`/finance/invoices?aging=${x.key}`)} />
            </ChartCard>
          </Boundary>
          <Boundary label="By client">
            <Card>
              <CardHeader title="By client" sub={`${d.clients.length} client${d.clients.length === 1 ? '' : 's'} with open balances`} />
              {d.clients.length === 0 ? <EmptyState title="No open receivables" /> : <div className="fin-scroll"><table className="fin-lines">
                <thead><tr><th>Client</th><th className="r">Current</th><th className="r">1–30</th><th className="r">31–60</th><th className="r">61–90</th><th className="r">90+</th><th className="r">Total</th></tr></thead>
                <tbody>{d.clients.map((c: any) => <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/finance/invoices?status=open&company_id=${c.company_id}`)}>
                  <td><b>{c.company_name}</b><div className="small muted">{c.invoices} invoice{c.invoices === 1 ? '' : 's'} · AM {c.account_manager_name ?? '—'}</div></td>
                  {['current', '1_30', '31_60', '61_90', '90_plus'].map(k => <td key={k} className="r">{c[k] ? money(c[k]) : <span className="muted">—</span>}</td>)}
                  <td className="r"><b>{money(c.total_cents)}</b></td></tr>)}</tbody></table></div>}
            </Card>
          </Boundary>
        </div>
        <Boundary label="Collections">
          <Card>
            <CardHeader title="Collections" sub="Past-due invoices, oldest first. Overdue reminders are also sent automatically by the “Invoice overdue 7 days” automation." />
            {d.collections.length === 0 ? <EmptyState title="Nothing past due" /> : <div className="fin-scroll"><table className="fin-lines">
              <thead><tr><th>Invoice</th><th>Client</th><th>Due</th><th className="r">Days past due</th><th className="r">Balance</th><th>Last reminder</th><th /></tr></thead>
              <tbody>{d.collections.map((i: any) => <tr key={i.id}>
                <td><Link to={`/finance/invoices/${i.id}`}><b>{i.number}</b></Link> <StatusPill status={i.status} /></td>
                <td>{i.company_name}</td><td>{date(i.due_date)}</td>
                <td className="r"><span className="fin-red">{i.days_past_due}</span></td>
                <td className="r">{money(i.balance_cents, i.currency)}</td>
                <td>{i.last_reminder_at ? relTime(i.last_reminder_at) : <span className="muted">Never</span>}</td>
                <td className="r">{can('invoices', 'edit') && <Button size="xs" icon={<Bell size={13} />} loading={busy === i.id} onClick={() => remind(i.id)}>Remind</Button>}</td>
              </tr>)}</tbody></table></div>}
          </Card>
        </Boundary>
      </div>
    )}</Async>
  );
}

function Payments() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [refund, setRefund] = useState<any | null>(null);
  const [key, setKey] = useState(0);
  const cols: Column<any>[] = [
    { key: 'received_at', label: 'Received', sortable: true, render: r => dateTime(r.received_at) },
    { key: 'invoice_number', label: 'Invoice', mobile: 'title', render: r => <Link to={`/finance/invoices/${r.invoice_id}`} onClick={e => e.stopPropagation()}><b>{r.invoice_number}</b></Link> },
    { key: 'company_name', label: 'Client', sortable: true, mobile: 'subtitle' },
    { key: 'method', label: 'Method', render: r => (r.method === 'card' ? `${humanize(r.card_brand ?? 'card')} •••• ${r.card_last4 ?? ''}` : r.method === 'ach' ? 'ACH' : humanize(r.method)) },
    { key: 'receipt_number', label: 'Receipt' },
    { key: 'status', label: 'Status', render: r => <><StatusPill status={r.status} />{r.failure_reason && <div className="small muted">{r.failure_reason}</div>}</> },
    { key: 'amount_cents', label: 'Amount', align: 'right', sortable: true, render: r => <Money cents={r.amount_cents} currency={r.currency} />, csv: r => r.amount_cents / 100 },
    { key: 'refunded_cents', label: 'Refunded', align: 'right', render: r => (Number(r.refunded_cents) ? <Money cents={r.refunded_cents} currency={r.currency} /> : <span className="muted">—</span>), csv: r => r.refunded_cents / 100 },
    { key: 'sync_status', label: 'Accounting', render: r => (r.sync_status ? <StatusPill status={r.sync_status} /> : <span className="muted">Not synced</span>) },
  ];
  return (
    <>
      <DataTable title="Payments" endpoint="/api/v1/payments" columns={cols} reloadKey={key} exportName="payments" exportResource="payments"
        filters={[{ key: 'status', label: 'Status', options: opts(['succeeded', 'failed', 'refunded']) }, { key: 'method', label: 'Method', options: [{ value: 'card', label: 'Card' }, { value: 'ach', label: 'ACH' }, ...opts(['wire', 'check', 'cash', 'manual'])] }, { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }]}
        rowLink={r => `/finance/invoices/${r.invoice_id}`}
        rowActions={r => [{ label: 'Open invoice', onClick: () => nav(`/finance/invoices/${r.invoice_id}`) }, { label: 'Refund', hidden: r.status !== 'succeeded' || !can('payments', 'edit'), onClick: () => setRefund(r) }]}
        searchPlaceholder="Search invoice, client, receipt" emptyTitle="No payments yet" />
      {refund && <RefundDialog payment={refund} onClose={() => setRefund(null)} onDone={() => { setRefund(null); setKey(k => k + 1); }} />}
    </>
  );
}

function RefundDialog({ payment, onClose, onDone }: { payment: any; onClose: () => void; onDone: () => void }) {
  const max = Number(payment.amount_cents) - Number(payment.refunded_cents);
  const [amount, setAmount] = useState<number | null>(max);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!amount || amount > max) e.amount = `Between ${money(1)} and ${money(max)}`;
    if (reason.trim().length < 3) e.reason = 'A reason is required';
    setErr(e); if (Object.keys(e).length) return;
    setBusy(true);
    try { await api.post(`/api/v1/payments/${payment.id}/refund`, { amount_cents: amount, reason: reason.trim() }); toast.success('Refund issued'); onDone(); } catch (x) { toast.error(x); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={`Refund ${payment.receipt_number ?? 'payment'}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} onClick={submit}>Refund</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="Amount *" htmlFor="rf-a" error={err.amount} hint={`Refundable ${money(max, payment.currency)}`}><MoneyInput id="rf-a" cents={amount} onChange={setAmount} /></Field>
        <Field label="Reason *" htmlFor="rf-r" error={err.reason}><textarea id="rf-r" className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function Reconciliation() {
  const t = todayISO();
  const [range, setRange] = useState<DateRange>({ from: t.slice(0, 5) + '01-01', to: t, label: 'Year to date' });
  const st = useApi<any>(`/api/v1/payments/reconciliation?from=${range.from}&to=${range.to}`);
  const [onlyIssues, setOnlyIssues] = useState(false);
  return (
    <div className="fin-stack">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div className="muted small">Compares each invoice’s recorded paid amount to the sum of its payments (net of refunds and overpayment credits).</div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>
      <Async state={st}>{d => (
        <>
          <Card pad><div className="fin-statgrid">
            <Stat label="Invoices">{d.summary.invoices}</Stat>
            <Stat label="Invoiced">{money(d.summary.invoiced_cents, 'USD', { noCents: true })}</Stat>
            <Stat label="Collected">{money(d.summary.collected_cents, 'USD', { noCents: true })}</Stat>
            <Stat label="Still open">{money(d.summary.open_cents, 'USD', { noCents: true })}</Stat>
            <Stat label="Mismatches"><span className={d.summary.mismatches ? 'fin-red' : ''}>{d.summary.mismatches}</span></Stat>
            <Stat label="Not synced to QuickBooks">{d.summary.unsynced}</Stat>
          </div></Card>
          <Card>
            <CardHeader title="Payments vs invoices" right={<label className="check small"><input type="checkbox" checked={onlyIssues} onChange={e => setOnlyIssues(e.target.checked)} /> Only mismatches</label>} />
            {d.rows.length === 0 ? <EmptyState title="No invoices in this range" /> : <div className="fin-scroll"><table className="fin-lines">
              <thead><tr><th>Invoice</th><th>Client</th><th>Issued</th><th className="r">Total</th><th className="r">Payments</th><th className="r">Recorded paid</th><th className="r">Difference</th><th>Status</th><th>Accounting</th></tr></thead>
              <tbody>{d.rows.filter((r: any) => !onlyIssues || !r.matched).map((r: any) => <tr key={r.id}>
                <td><Link to={`/finance/invoices/${r.id}`}><b>{r.number}</b></Link></td><td>{r.company_name}</td><td>{date(r.issue_date)}</td>
                <td className="r">{money(r.total_cents, r.currency)}</td><td className="r">{money(r.applied_cents, r.currency)}{r.failed_attempts > 0 && <div className="small muted">{r.failed_attempts} declined</div>}</td>
                <td className="r">{money(r.paid_cents, r.currency)}</td><td className={`r ${r.difference_cents ? 'fin-red' : ''}`}>{money(r.difference_cents, r.currency)}</td>
                <td>{r.matched ? <StatusPill status="matched" tone="green" label="Matched" /> : <StatusPill status="mismatch" tone="red" label="Mismatch" />} <StatusPill status={r.status} /></td>
                <td>{r.sync_status ? <StatusPill status={r.sync_status} /> : <span className="muted">Not synced</span>}</td>
              </tr>)}</tbody></table></div>}
          </Card>
        </>
      )}</Async>
    </div>
  );
}

function Accounting() {
  const { can } = useAuth();
  const sum = useApi<any>('/api/v1/accounting/summary');
  const [key, setKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (k: string, body: unknown) => {
    setBusy(k);
    try { const r = await api.post('/api/v1/accounting/sync', body); toast.success(`Synced ${r.synced} of ${r.attempted}${r.failed ? ` · ${r.failed} failed` : ''}`); sum.reload(); setKey(x => x + 1); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const cols: Column<any>[] = [
    { key: 'created_at', label: 'Last attempt', sortable: true, render: r => dateTime(r.created_at) },
    { key: 'entity_type', label: 'Record', mobile: 'title', render: r => <><b>{humanize(r.entity_type)}</b> {r.ref_number ?? ''}</> },
    { key: 'company_name', label: 'Client', mobile: 'subtitle' },
    { key: 'amount_cents', label: 'Amount', align: 'right', render: r => <Money cents={r.amount_cents} />, csv: r => (r.amount_cents ?? 0) / 100 },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'external_id', label: 'QuickBooks ID' },
    { key: 'error', label: 'Error', render: r => (r.error ? <span className="small fin-red">{r.error}</span> : <span className="muted">—</span>) },
    { key: 'attempts', label: 'Attempts', align: 'right' },
  ];
  return (
    <div className="fin-stack">
      <Async state={sum} rows={2}>{s => (
        <Card pad>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div className="fin-statgrid" style={{ flex: 1 }}>
              <Stat label="Connection" sub={s.integration?.provider}><StatusPill status={s.integration?.status ?? 'connected'} /></Stat>
              <Stat label="Last sync">{s.integration?.last_sync_at ? relTime(s.integration.last_sync_at) : '—'}</Stat>
              <Stat label="Synced">{s.synced}</Stat>
              <Stat label="Failed"><span className={s.failed ? 'fin-red' : ''}>{s.failed}</span></Stat>
              <Stat label="Pending">{s.pending}</Stat>
            </div>
            {can('invoices', 'edit') && <div className="row" style={{ gap: 8 }}>
              <Button icon={<RotateCcw size={15} />} disabled={!s.failed} loading={busy === 'failed'} onClick={() => run('failed', { failed_only: true })}>Retry failed</Button>
              <Button variant="primary" icon={<RefreshCw size={15} />} disabled={!s.pending} loading={busy === 'all'} onClick={() => run('all', { all_pending: true })}>Sync all pending</Button>
            </div>}
          </div>
          {s.integration?.status && s.integration.status !== 'connected' && <Banner tone="danger">QuickBooks is {s.integration.status}. Reconnect it in <Link to="/settings/integrations">Settings → Integrations</Link>.</Banner>}
        </Card>
      )}</Async>
      <DataTable title="Sync log" endpoint="/api/v1/accounting/log" columns={cols} reloadKey={key} exportName="accounting-sync" exportResource="invoices"
        filters={[{ key: 'status', label: 'Status', options: opts(['synced', 'failed']) }, { key: 'entity_type', label: 'Record', options: opts(['invoice', 'payment', 'credit_note']) }]}
        rowLink={r => (r.invoice_id ? `/finance/invoices/${r.invoice_id}` : null)}
        rowActions={(r, reload) => [{ label: 'Retry sync', hidden: r.status !== 'failed' || !can('invoices', 'edit'), onClick: async () => { try { const x = await api.post(`/api/v1/accounting/log/${r.id}/retry`); toast.success(x.log.status === 'synced' ? `Synced (${x.log.external_id})` : `Still failing: ${x.log.error}`); reload(); sum.reload(); } catch (e) { toast.error(e); } } }]}
        searchPlaceholder="Search number, client, error" emptyTitle="Nothing synced yet" />
    </div>
  );
}
