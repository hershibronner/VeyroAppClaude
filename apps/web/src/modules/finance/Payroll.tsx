import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Wallet, Users, TrendingUp, Plus, Download, FileText, Send, ExternalLink, AlertTriangle } from 'lucide-react';
import { api, ApiError, qs } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { money, date as fmtDate, downloadText, toCsv } from '../../lib/format';
import { toast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import { Banner, Boundary, Button, Card, CardHeader, DateRangePicker, Drawer, EmptyState, ErrorState, Field, KpiRow, LoadingBlock, PageHeader, Person, RangeSelect, StatusPill, PermissionDenied, Skeleton, type DateRange } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { ChartCard, TrendLine, TrackBars, fmtMoneyCompact } from '../../components/charts';
import { Money, period, hoursOf, PAY_ITEM_STATUSES, RUN_STATUSES } from './shared';
import './payroll.css';

function lastMonths(n: number) {
  const out: { value: string; label: string }[] = []; const d = new Date(); d.setDate(1);
  for (let i = 0; i < n; i++) { const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; out.push({ value: v, label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) }); d.setMonth(d.getMonth() - 1); }
  return out;
}

export default function Payroll() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [months, setMonths] = useState(6);
  const [distMonths, setDistMonths] = useState(6);
  const [runOpen, setRunOpen] = useState(sp.get('run') === '1');
  const ov = useApi<any>(can('payroll', 'view') ? `/api/v1/payroll/overview?months=${months}&dist_months=${distMonths}` : null, [months, distMonths]);
  const range: DateRange | null = sp.get('from') && sp.get('to') ? { from: sp.get('from')!, to: sp.get('to')! } : null;
  const setParams = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } n.delete('page'); setSp(n, { replace: true }); };
  const scrollToList = () => setTimeout(() => document.getElementById('payroll-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  useEffect(() => { if (sp.get('run') === '1') setRunOpen(true); }, [sp]);
  if (!can('payroll', 'view')) return <PermissionDenied />;

  const exportPayroll = async () => {
    try {
      const f = Object.fromEntries(['status', 'month', 'company_id', 'from', 'to', 'search'].map(k => [k, sp.get(k) ?? '']));
      const r = await api.get<{ rows: any[] }>(`/api/v1/payroll/items${qs({ ...f, pageSize: 500 })}`);
      downloadText(`payroll-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(r.rows, [
        { key: 'worker_name', label: 'Employee' }, { key: 'employee_code', label: 'Employee code' }, { key: 'company_name', label: 'Client' }, { key: 'period_start', label: 'Period start' }, { key: 'period_end', label: 'Period end' },
        { key: 'hours', label: 'Hours', value: x => ((x.regular_minutes + x.ot_minutes) / 60).toFixed(2) }, { key: 'gross', label: 'Gross', value: x => (x.gross_cents / 100).toFixed(2) }, { key: 'ded', label: 'Deductions', value: x => (x.deductions_cents / 100).toFixed(2) },
        { key: 'net', label: 'Net', value: x => (x.net_cents / 100).toFixed(2) }, { key: 'currency', label: 'Currency' }, { key: 'pay_date', label: 'Pay date' }, { key: 'status', label: 'Status' }, { key: 'payslip_number', label: 'Payslip' },
      ]));
      api.post('/api/v1/exports/log', { resource: 'payroll', count: r.rows.length, filters: f }).catch(() => {});
      toast.success(`Exported ${r.rows.length} payroll rows`);
    } catch (e) { toast.error(e); }
  };

  const d = ov.data;
  const curMonth = d?.month?.slice(0, 7);
  const kp = d?.kpis;
  const latest = d?.trend?.[d.trend.length - 1];
  const prevT = d?.trend?.[d.trend.length - 2];
  const trendDelta = latest && prevT?.value ? ((latest.value - prevT.value) / prevT.value) * 100 : null;

  const itemCols: Column<any>[] = [
    { key: 'worker_name', label: 'Employee', sortable: true, mobile: 'title', render: r => <Person name={r.worker_name} sub={[r.employee_code, r.title].filter(Boolean).join(' · ')} size={30} /> },
    { key: 'company_name', label: 'Client', sortable: true, mobile: 'subtitle' },
    { key: 'period_start', label: 'Period', sortable: true, render: r => period(r.period_start, r.period_end), csv: r => `${r.period_start} – ${r.period_end}` },
    { key: 'hours', label: 'Hours', sortable: true, align: 'right', render: r => hoursOf(r.regular_minutes + r.ot_minutes), csv: r => ((r.regular_minutes + r.ot_minutes) / 60).toFixed(2) },
    { key: 'gross_cents', label: 'Gross', sortable: true, align: 'right', render: r => <Money cents={r.gross_cents} currency={r.currency} />, csv: r => r.gross_cents / 100 },
    { key: 'deductions_cents', label: 'Deductions', align: 'right', render: r => (r.deductions_cents ? <Money cents={-r.deductions_cents} currency={r.currency} /> : <span className="muted">—</span>), csv: r => r.deductions_cents / 100 },
    { key: 'net_cents', label: 'Net pay', sortable: true, align: 'right', render: r => <Money cents={r.net_cents} currency={r.currency} strong />, csv: r => r.net_cents / 100 },
    { key: 'pay_date', label: 'Pay date', sortable: true, render: r => fmtDate(r.pay_date) },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
  ];
  const runCols: Column<any>[] = [
    { key: 'period_start', label: 'Pay period', sortable: true, mobile: 'title', render: r => <b>{period(r.period_start, r.period_end)}</b> },
    { key: 'pay_date', label: 'Pay date', sortable: true, render: r => fmtDate(r.pay_date) },
    { key: 'worker_count', label: 'Workers', sortable: true, align: 'right' },
    { key: 'minutes', label: 'Hours', align: 'right', render: r => hoursOf(r.minutes) },
    { key: 'total_gross_cents', label: 'Gross', sortable: true, align: 'right', render: r => <Money cents={r.total_gross_cents} currency={r.currency} /> },
    { key: 'total_net_cents', label: 'Net', sortable: true, align: 'right', render: r => <Money cents={r.total_net_cents} currency={r.currency} strong /> },
    { key: 'status', label: 'Status', sortable: true, mobile: 'subtitle', render: r => <StatusPill status={r.status} /> },
    { key: 'payout_status', label: 'Payout', render: r => r.payout_status ? <span className="row" style={{ gap: 6 }}><StatusPill status={r.payout_status} />{r.failed_items > 0 && <span className="small" style={{ color: 'var(--danger)' }}>{r.failed_items} failed</span>}</span> : <span className="muted">Not started</span> },
  ];

  const due = d?.due;
  return (
    <div>
      <PageHeader title="Payroll Overview" actions={<>
        <DateRangePicker value={range ? { ...range, label: `${fmtDate(range.from, { month: 'short', day: 'numeric' })} – ${fmtDate(range.to)}` } : { from: '', to: '', label: 'All pay periods' }} onChange={r => { setParams({ from: r.from, to: r.to, month: null }); scrollToList(); }} />
        <Button icon={<Download size={16} />} onClick={exportPayroll}>Export Payroll</Button>
        {can('payroll', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setRunOpen(true)}>Run Payroll</Button>}
      </>} />

      {ov.error && !d ? <ErrorState error={ov.error} retry={ov.reload} /> : !d ? <><Skeleton h={54} style={{ marginBottom: 22 }} /><Skeleton h={110} style={{ marginBottom: 22 }} /><div className="grid-2"><Skeleton h={340} /><Skeleton h={340} /></div></> : <>
        <Boundary label="Payroll banner">
          {due && (due.days_until_pay >= 0
            ? <Banner tone={due.days_until_pay <= 2 ? 'warn' : 'info'}><b>Heads up! Payroll is due in {due.days_until_pay} day{due.days_until_pay === 1 ? '' : 's'}.</b>{' '}
              {due.pending_timesheets > 0 ? <>Review the <Link to="/time/timesheets?status=submitted">{due.pending_timesheets} pending timesheet{due.pending_timesheets === 1 ? '' : 's'}</Link> and approve the run for {period(due.period_start, due.period_end)} before {fmtDate(due.pay_date)}.</> : <>Approve the run for {period(due.period_start, due.period_end)} before {fmtDate(due.pay_date)}.</>}{' '}
              {due.run ? <Link to={`/finance/payroll/${due.run.id}`}>Open the {due.run.status.replace('_', ' ')} run →</Link> : can('payroll', 'create') && <a href="#" onClick={e => { e.preventDefault(); setRunOpen(true); }}>Run payroll now →</a>}</Banner>
            : <Banner tone="danger"><b>Payroll for {period(due.period_start, due.period_end)} is {Math.abs(due.days_until_pay)} day{Math.abs(due.days_until_pay) === 1 ? '' : 's'} overdue.</b> {hoursOf(due.unpaid_minutes)} of approved time is still unpaid. {due.run ? <Link to={`/finance/payroll/${due.run.id}`}>Open the run →</Link> : can('payroll', 'create') && <a href="#" onClick={e => { e.preventDefault(); setRunOpen(true); }}>Run payroll now →</a>}</Banner>)}
          {d.actions.failed_payout_items > 0 && <Banner tone="danger" icon={<AlertTriangle size={20} />}><b>{d.actions.failed_payout_items} payout{d.actions.failed_payout_items === 1 ? '' : 's'} failed.</b> Workers have not been paid yet. <Link to="/finance/payouts?has_failed=true">Review and retry →</Link></Banner>}
        </Boundary>

        <Boundary label="Payroll KPIs">
          <KpiRow items={[
            { label: 'Total Payroll This Month', icon: <Wallet size={18} />, value: money(kp.total_payroll.value, 'USD', { noCents: true }), delta: kp.total_payroll.delta, onClick: () => { setParams({ month: curMonth, status: null, from: null, to: null, company_id: null }); scrollToList(); } },
            { label: 'Employees Paid', icon: <Users size={18} />, value: <>{kp.employees_paid.value}<span className="muted" style={{ fontSize: 18, fontWeight: 500 }}> / {kp.employees_paid.of}</span></>, delta: kp.employees_paid.delta, onClick: () => { setParams({ month: curMonth, status: 'paid', from: null, to: null, company_id: null }); scrollToList(); } },
            { label: 'Average Pay', icon: <TrendingUp size={18} />, value: money(kp.average_pay.value, 'USD', { noCents: true }), delta: kp.average_pay.delta, onClick: () => { setParams({ month: curMonth, status: 'paid', from: null, to: null, company_id: null }); scrollToList(); } },
          ]} />
        </Boundary>

        <div className="grid-2">
          <Boundary label="Monthly Payroll Trend">
            <ChartCard title="Monthly Payroll Trend" control={<RangeSelect value={months} onChange={setMonths} />} big={money(latest?.value ?? 0, 'USD', { noCents: true })} delta={trendDelta === null ? <span className="muted">No prior month</span> : <span><b className={trendDelta >= 0 ? 'up' : 'down'}>{trendDelta >= 0 ? '+' : ''}{trendDelta.toFixed(1)}%</b> from last month</span>}>
              {d.trend.some((t: any) => t.value > 0) ? <TrendLine data={d.trend} fmt={fmtMoneyCompact} onPointClick={p => { setParams({ month: p.month.slice(0, 7), status: null, from: null, to: null }); scrollToList(); }} /> : <EmptyState title="No payroll yet" text="Run payroll to see the trend." />}
            </ChartCard>
          </Boundary>
          <Boundary label="Payroll Distribution by Client">
            <ChartCard title="Payroll Distribution by Client" control={<RangeSelect value={distMonths} onChange={setDistMonths} />} big={money(d.distribution.reduce((a: number, x: any) => a + x.value, 0), 'USD', { noCents: true })} delta={<span className="muted">{d.distribution.length} client{d.distribution.length === 1 ? '' : 's'} · last {d.distribution_months} months</span>}>
              {d.distribution.length ? <TrackBars data={d.distribution} fmt={fmtMoneyCompact} valueName="Gross payroll" onBarClick={b => { if (b.company_id) { setParams({ company_id: b.company_id, month: null }); scrollToList(); } }} /> : <EmptyState title="No payroll yet" />}
            </ChartCard>
          </Boundary>
        </div>
      </>}

      <div id="payroll-list" className="pr-section">
        {sp.get('company_id') && <div className="row mb-2"><span className="small muted">Filtered to one client.</span><Button size="xs" variant="ghost" onClick={() => setParams({ company_id: null })}>Clear client filter</Button></div>}
        <DataTable title="Payroll List" endpoint="/api/v1/payroll/items" columns={itemCols} exportName="payroll-list" exportResource="payroll"
          params={{ company_id: sp.get('company_id') ?? undefined, from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined }}
          filters={[{ key: 'status', label: 'Status', options: opts(PAY_ITEM_STATUSES) }, { key: 'month', label: 'Month', options: lastMonths(12) }]}
          searchPlaceholder="Search employee, client, payslip"
          rowActions={r => [
            { label: 'View payslip', icon: <FileText size={15} />, onClick: () => window.open(`/api/v1/payroll/items/${r.id}/payslip`, '_blank') },
            { label: 'Download payslip', icon: <Download size={15} />, onClick: () => window.open(`/api/v1/payroll/items/${r.id}/payslip?download=1`, '_blank') },
            { label: 'Send payslip to worker', icon: <Send size={15} />, hidden: !can('payroll', 'edit') || ['calculated', 'review'].includes(r.run_status), onClick: async () => { try { const x = await api.post(`/api/v1/payroll/items/${r.id}/send-payslip`); toast.success(`Payslip sent${x.sent_to ? ' to ' + x.sent_to : ''}`); } catch (e) { toast.error(e); } } },
            { label: 'Open payroll run', icon: <ExternalLink size={15} />, onClick: () => nav(`/finance/payroll/${r.run_id}`) },
          ]}
          emptyTitle="No payroll items" emptyText="Payroll items appear here once a run is calculated." />
      </div>

      <div className="pr-section">
        <DataTable title="Payroll Runs" endpoint="/api/v1/payroll/runs" columns={runCols} rowLink={r => `/finance/payroll/${r.id}`} urlState={false} exportName="payroll-runs" exportResource="payroll"
          filters={[{ key: 'status', label: 'Status', options: [{ value: 'open', label: 'Needs action' }, ...opts(RUN_STATUSES)] }]} pageSize={10}
          emptyTitle="No payroll runs yet" emptyAction={can('payroll', 'create') ? <Button variant="primary" icon={<Plus size={16} />} onClick={() => setRunOpen(true)}>Run Payroll</Button> : undefined} />
      </div>

      {runOpen && <RunPayrollDrawer onClose={() => { setRunOpen(false); if (sp.get('run')) setParams({ run: null }); }} />}
    </div>
  );
}

function RunPayrollDrawer({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const next = useApi<any>('/api/v1/payroll/next-period');
  const [form, setForm] = useState<{ period_start: string; period_end: string; pay_date: string; notes: string }>({ period_start: '', period_end: '', pay_date: '', notes: '' });
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { if (next.data && !form.period_start) setForm(f => ({ ...f, period_start: next.data.period_start, period_end: next.data.period_end, pay_date: next.data.pay_date })); }, [next.data]); // eslint-disable-line
  const set = (k: string, v: string) => { setForm(f => ({ ...f, [k]: v })); setPreview(null); };
  const doPreview = async () => {
    setBusy('preview'); setErrors({});
    try { const p = await api.post('/api/v1/payroll/preview', { period_start: form.period_start, period_end: form.period_end }); setPreview(p); if (!form.pay_date || preview === null) setForm(f => ({ ...f, pay_date: f.pay_date || p.pay_date })); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(null); }
  };
  useEffect(() => { if (form.period_start && form.period_end && !preview && next.data && form.period_start === next.data.period_start) doPreview(); }, [form.period_start]); // eslint-disable-line
  const create = async () => {
    setBusy('create');
    try {
      const r = await api.post('/api/v1/payroll/runs', { period_start: form.period_start, period_end: form.period_end, pay_date: form.pay_date || null, notes: form.notes || null });
      if (r.existing) toast.info('Payroll for this period already exists — opening it'); else toast.success('Payroll calculated');
      nav(`/finance/payroll/${r.run.id}`);
    } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(e); } finally { setBusy(null); }
  };
  const items: any[] = preview?.items ?? [];
  return (
    <Drawer open onClose={onClose} wide title="Run payroll" footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button onClick={doPreview} loading={busy === 'preview'} disabled={!form.period_start || !form.period_end}>Preview</Button>
      {preview?.existing_run ? <Button variant="primary" onClick={() => nav(`/finance/payroll/${preview.existing_run.id}`)}>Open existing run</Button>
        : <Button variant="primary" loading={busy === 'create'} disabled={!preview || !items.length || preview.problems?.length > 0} onClick={create}>Create payroll run</Button>}
    </>}>
      {next.loading && !next.data ? <LoadingBlock rows={3} /> : <>
        <div className="form-grid">
          <Field label="Period start" htmlFor="pr-ps" error={errors.period_start}><input id="pr-ps" type="date" className="input" value={form.period_start} onChange={e => set('period_start', e.target.value)} /></Field>
          <Field label="Period end" htmlFor="pr-pe" error={errors.period_end}><input id="pr-pe" type="date" className="input" value={form.period_end} onChange={e => set('period_end', e.target.value)} /></Field>
          <Field label="Pay date" htmlFor="pr-pd" hint={next.data ? `Frequency: ${next.data.frequency.replace('_', '-')}` : undefined}><input id="pr-pd" type="date" className="input" value={form.pay_date} onChange={e => setForm(f => ({ ...f, pay_date: e.target.value }))} /></Field>
          <Field label="Notes" htmlFor="pr-notes"><input id="pr-notes" className="input" value={form.notes} placeholder="Optional" onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
        </div>
        <div className="small muted mt-2">Only approved timesheet days that have not been paid are included. Re-running the same period returns the existing run — nobody is paid twice.</div>
        {busy === 'preview' && !preview && <LoadingBlock rows={4} />}
        {preview && <div className="mt-3">
          {preview.existing_run && <Banner tone="warn">A payroll run already exists for this period (<StatusPill status={preview.existing_run.status} />). <Link to={`/finance/payroll/${preview.existing_run.id}`}>Open it</Link>.</Banner>}
          {preview.pending_timesheets > 0 && <Banner tone="warn">{preview.pending_timesheets} timesheet{preview.pending_timesheets === 1 ? ' is' : 's are'} still open or awaiting approval for this period and will not be paid in this run. <Link to="/time/timesheets?status=submitted">Review timesheets</Link></Banner>}
          {preview.problems?.length > 0 && <Banner tone="danger">{preview.problems.join(' · ')}</Banner>}
          <div className="pr-strip">
            <div><div className="lbl">Workers</div><div className="val">{preview.totals.workers}</div></div>
            <div><div className="lbl">Hours</div><div className="val">{hoursOf(preview.totals.minutes)}</div></div>
            <div><div className="lbl">Gross</div><div className="val">{money(preview.totals.gross_cents)}</div></div>
            <div><div className="lbl">Net pay</div><div className="val">{money(preview.totals.net_cents)}</div></div>
          </div>
          {items.length ? <Card><div className="table-wrap"><table className="table"><thead><tr><th>Worker</th><th>Client</th><th style={{ textAlign: 'right' }}>Regular</th><th style={{ textAlign: 'right' }}>OT</th><th style={{ textAlign: 'right' }}>Earnings</th><th style={{ textAlign: 'right' }}>Deductions</th><th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Net</th></tr></thead>
            <tbody>{items.map(i => <tr key={i.placement_id}><td><Person name={i.worker_name} sub={i.title} size={28} /></td><td>{i.company_name}</td><td className="money">{hoursOf(i.regular_minutes)}</td><td className="money">{i.ot_minutes ? hoursOf(i.ot_minutes) : '—'}</td>
              <td className="money" title={i.earnings.map((e: any) => e.description).join('\n')}>{i.earnings_cents ? money(i.earnings_cents, i.currency) : '—'}</td><td className="money">{i.deductions_cents ? money(-i.deductions_cents, i.currency) : '—'}</td>
              <td className="money">{money(i.gross_cents, i.currency)}</td><td className="money"><b>{money(i.net_cents, i.currency)}</b></td></tr>)}</tbody></table></div></Card>
            : <EmptyState title="Nothing to pay in this period" text="There is no approved, unpaid time between these dates." />}
        </div>}
      </>}
    </Drawer>
  );
}

