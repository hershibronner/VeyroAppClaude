import { Download, FileText } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { money, date as fmtDate, humanize } from '../../lib/format';
import { Banner, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Menu, PageHeader, StatusPill } from '../../components/ui';
import { Money, period, hoursOf } from './shared';
import './payroll.css';

export default function WorkerPay() {
  const st = useApi<any>('/api/v1/portal/worker/pay');
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={8} />;
  const d = st.data;
  const failed = d.payslips.filter((p: any) => p.status === 'failed');
  const pdf = (id: string, dl = false) => window.open(`/api/v1/portal/worker/pay/payslips/${id}/pdf${dl ? '?download=1' : ''}`, '_blank');
  return (
    <div>
      <PageHeader title="Pay & Payslips" sub={`${humanize(d.payout.method)}${d.payout.account_label ? ` · ${d.payout.account_label}` : ''}${d.payout.employee_code ? ` · ${d.payout.employee_code}` : ''}`} />
      {failed.length > 0 && <Banner tone="danger"><b>A payment to you failed.</b> {failed[0].failure_reason ?? 'Your payout could not be delivered.'} The finance team has been notified and will retry — please check your payout details in your profile.</Banner>}
      <Banner>Next pay date: <b>{fmtDate(d.next_pay_date)}</b> for {period(d.next_period.start, d.next_period.end)}. {d.approved_unpaid_minutes > 0 ? <>You have <b>{hoursOf(d.approved_unpaid_minutes)}</b> of approved time waiting to be paid.</> : 'Approved hours appear here once your timesheet is approved.'}</Banner>
      <div className="pr-cards">
        <div className="kpi-tile"><div className="kpi-label">Net pay {d.ytd.year} YTD</div><div className="kpi-value">{money(d.ytd.net_cents)}</div></div>
        <div className="kpi-tile"><div className="kpi-label">Gross pay YTD</div><div className="kpi-value">{money(d.ytd.gross_cents)}</div></div>
        <div className="kpi-tile"><div className="kpi-label">Hours paid YTD</div><div className="kpi-value">{hoursOf(d.ytd.minutes)}</div></div>
        <div className="kpi-tile"><div className="kpi-label">Payslips YTD</div><div className="kpi-value">{d.ytd.payslips}</div></div>
      </div>
      <Card>
        <CardHeader title="Payslips" />
        {d.payslips.length === 0 ? <EmptyState title="No payslips yet" text="Your payslips appear here once a payroll run is approved." /> : <>
          <div className="table-wrap responsive"><table className="table">
            <thead><tr><th>Pay period</th><th>Client</th><th style={{ textAlign: 'right' }}>Hours</th><th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Deductions</th><th style={{ textAlign: 'right' }}>Net pay</th><th>Pay date</th><th>Status</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{d.payslips.map((p: any) => <tr key={p.id} className="clickable" onClick={() => pdf(p.id)}>
              <td><b>{period(p.period_start, p.period_end)}</b><div className="small muted">{p.payslip_number}</div></td>
              <td>{p.company_name ?? '—'}<div className="small muted">{p.title}</div></td>
              <td className="money">{hoursOf(p.regular_minutes + p.ot_minutes)}</td>
              <td className="money"><Money cents={p.gross_cents} currency={p.currency} /></td>
              <td className="money">{p.deductions_cents ? <Money cents={-p.deductions_cents} currency={p.currency} /> : '—'}</td>
              <td className="money"><Money cents={p.net_cents} currency={p.currency} strong /></td>
              <td>{fmtDate(p.pay_date)}</td>
              <td><StatusPill status={p.status} />{p.status === 'failed' && p.failure_reason && <div className="small" style={{ color: 'var(--danger)', maxWidth: 220 }}>{p.failure_reason}</div>}</td>
              <td className="act" onClick={e => e.stopPropagation()}><Menu items={[{ label: 'View payslip', icon: <FileText size={15} />, onClick: () => pdf(p.id) }, { label: 'Download PDF', icon: <Download size={15} />, onClick: () => pdf(p.id, true) }]} /></td>
            </tr>)}</tbody>
          </table></div>
          <div className="mobile-cards">{d.payslips.map((p: any) => <div key={p.id} className="mcard" onClick={() => pdf(p.id)}><div className="mmain">
            <div><b>{period(p.period_start, p.period_end)}</b></div><div className="muted small mt-1">{p.company_name}</div>
            <div className="mrow"><span>Net pay</span><b>{money(p.net_cents, p.currency)}</b></div><div className="mrow"><span>Hours</span><b>{hoursOf(p.regular_minutes + p.ot_minutes)}</b></div><div className="mrow"><span>Status</span><b><StatusPill status={p.status} /></b></div>
          </div></div>)}</div>
        </>}
      </Card>
    </div>
  );
}
