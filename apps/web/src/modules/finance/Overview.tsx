import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DollarSign, Wallet, TrendingUp, Receipt, Plus, Play } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { money, date } from '../../lib/format';
import { Banner, Boundary, Button, ErrorState, KpiRow, LoadingBlock, PageHeader, RangeSelect, EmptyState, type KpiItem } from '../../components/ui';
import { ChartCard, TrendLine, TrackBars, SimpleBars, fmtMoney, fmtMoneyCompact } from '../../components/charts';
import { hoursOf } from './shared';
import './finance.css';

export default function Overview() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [months, setMonths] = useState(6);
  const st = useApi<any>(`/api/v1/finance/overview?months=${months}`);
  const d = st.data;
  const actions = (
    <>
      <RangeSelect value={months} onChange={setMonths} options={[3, 6, 12]} />
      {can('payroll', 'create') && <Button icon={<Play size={16} />} onClick={() => nav('/finance/payroll?run=1')}>Run Payroll</Button>}
      {can('invoices', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => nav('/finance/invoices/new')}>New Invoice</Button>}
    </>
  );
  if (st.error && !d) return <><PageHeader title="Finance" actions={actions} /><ErrorState error={st.error} retry={st.reload} /></>;
  if (!d) return <><PageHeader title="Finance" actions={actions} /><LoadingBlock rows={8} /></>;
  const a = d.attention ?? {};
  const k = d.kpis ?? {};
  const kpis: KpiItem[] = [];
  if (k.revenue) kpis.push({ label: 'Revenue this month', icon: <DollarSign size={16} />, value: money(k.revenue.value, 'USD', { noCents: true }), delta: k.revenue.delta, to: '/finance/margin?group_by=month' });
  if (k.payroll_cost) kpis.push({ label: 'Payroll cost', icon: <Wallet size={16} />, value: money(k.payroll_cost.value, 'USD', { noCents: true }), delta: k.payroll_cost.delta, to: '/finance/payroll', invert: true });
  if (k.gross_margin) kpis.push({ label: 'Gross margin', icon: <TrendingUp size={16} />, value: <>{money(k.gross_margin.value, 'USD', { noCents: true })} <span className="muted" style={{ fontSize: '0.5em' }}>{k.gross_margin.pct.toFixed(1)}%</span></>, delta: k.gross_margin.delta, to: '/finance/margin' });
  if (k.ar) kpis.push({ label: 'AR outstanding', icon: <Receipt size={16} />, value: money(k.ar.value, 'USD', { noCents: true }), deltaText: k.ar.overdue_n ? <><b className="down">{money(k.ar.overdue_cents, 'USD', { noCents: true })}</b> overdue across {k.ar.overdue_n} invoice{k.ar.overdue_n === 1 ? '' : 's'}</> : 'Nothing overdue', suffix: '', to: '/finance/ar' });
  const p = a.payroll;
  return (
    <div>
      <PageHeader title="Finance" sub={`Earned figures from approved time · ${date(d.month, { month: 'long', year: 'numeric' })}`} actions={actions} />
      <div className="fin-banners">
        {p && <Banner tone={p.days_until_pay < 0 ? 'danger' : p.days_until_pay <= 3 ? 'warn' : 'info'}>
          {p.days_until_pay >= 0 ? <><b>Heads up!</b> Payroll for {date(p.period_start, { month: 'short', day: 'numeric' })} – {date(p.period_end)} is due in {p.days_until_pay} day{p.days_until_pay === 1 ? '' : 's'} (pay date {date(p.pay_date)}).</> : <><b>Payroll is overdue:</b> {date(p.period_start, { month: 'short', day: 'numeric' })} – {date(p.period_end)} should have been paid on {date(p.pay_date)}.</>}
          {p.pending_timesheets > 0 && <> {p.pending_timesheets} timesheet{p.pending_timesheets === 1 ? ' is' : 's are'} still waiting for approval.</>} <Link to="/finance/payroll">Open payroll</Link>
        </Banner>}
        {a.invoices?.overdue_n > 0 && <Banner tone="danger">{a.invoices.overdue_n} overdue invoice{a.invoices.overdue_n === 1 ? '' : 's'} totalling {money(a.invoices.overdue_cents)}. <Link to="/finance/invoices?status=overdue">Review overdue invoices</Link></Banner>}
        {a.failed_payouts?.n > 0 && <Banner tone="danger">{a.failed_payouts.n} worker payout{a.failed_payouts.n === 1 ? '' : 's'} failed ({money(a.failed_payouts.cents)}). <Link to={a.failed_payouts.payout_id ? `/finance/payouts/${a.failed_payouts.payout_id}` : '/finance/payouts?has_failed=true'}>Retry payouts</Link></Banner>}
        {a.unbilled?.minutes > 0 && can('invoices', 'create') && <Banner tone="warn">{hoursOf(a.unbilled.minutes)} of approved time across {a.unbilled.clients} client{a.unbilled.clients === 1 ? '' : 's'} has not been invoiced yet. <Link to="/finance/invoices/new">Generate invoices</Link></Banner>}
        {a.sync_failed > 0 && <Banner tone="warn">{a.sync_failed} record{a.sync_failed === 1 ? '' : 's'} failed to sync to QuickBooks. <Link to="/finance/ar?tab=accounting">Fix sync errors</Link></Banner>}
        {a.commissions?.awaiting_n > 0 && <Banner>{a.commissions.awaiting_n} commission entitlement{a.commissions.awaiting_n === 1 ? '' : 's'} ({money(a.commissions.awaiting)}) waiting for approval. <Link to="/finance/commissions?status=calculated">Review commissions</Link></Banner>}
      </div>
      {kpis.length > 0 && <KpiRow items={kpis} />}
      {d.comp ? (
        <div className="grid-2 mb-3">
          <Boundary label="Revenue trend">
            <ChartCard title="Revenue vs payroll cost" big={money(d.trend.reduce((s: number, t: any) => s + t.revenue, 0), 'USD', { noCents: true })} delta={<span className="muted">earned over the last {months} months</span>}>
              {d.trend.some((t: any) => t.revenue) ? <TrendLine data={d.trend.map((t: any) => ({ label: t.label, revenue: t.revenue, cost: t.cost, month: t.month }))} series={[{ key: 'revenue', name: 'Revenue' }, { key: 'cost', name: 'Payroll cost' }]} fmt={fmtMoneyCompact} onPointClick={() => nav('/finance/margin?group_by=month')} /> : <EmptyState title="No approved time yet" />}
            </ChartCard>
          </Boundary>
          <Boundary label="Margin by client">
            <ChartCard title="Gross margin by client" big={money(d.by_client.reduce((s: number, c: any) => s + c.gp_cents, 0), 'USD', { noCents: true })} delta={<span className="muted">top {d.by_client.length} clients</span>}>
              {d.by_client.length ? <TrackBars data={d.by_client.map((c: any) => ({ label: c.label, value: c.gp_cents }))} fmt={fmtMoney} onBarClick={() => nav('/finance/margin?group_by=client')} /> : <EmptyState title="No margin data" />}
            </ChartCard>
          </Boundary>
        </div>
      ) : null}
      {can('invoices', 'view') && (
        <Boundary label="AR aging">
          <ChartCard title="Accounts receivable aging" big={money(d.aging.reduce((s: number, b: any) => s + b.value, 0), 'USD', { noCents: true })} delta={<span className="muted">{d.aging.reduce((s: number, b: any) => s + b.count, 0)} open invoices</span>} control={<Link className="small" to="/finance/ar">Open AR</Link>}>
            <SimpleBars data={d.aging.map((b: any) => ({ label: b.label, value: b.value, key: b.key }))} fmt={fmtMoney} onBarClick={(x: any) => nav(`/finance/invoices?aging=${x.key}`)} />
          </ChartCard>
        </Boundary>
      )}
    </div>
  );
}
