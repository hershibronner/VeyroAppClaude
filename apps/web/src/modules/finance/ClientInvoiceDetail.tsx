import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CreditCard, Download } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { money, date as fmtDate, dateTime, humanize } from '../../lib/format';
import { toast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import { Banner, Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, StatusPill } from '../../components/ui';
import { Money, period, hoursOf } from './shared';
import './payroll.css';

export default function ClientInvoiceDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { me } = useAuth();
  const st = useApi<any>(`/api/v1/portal/client/invoices/${id}`, [id]);
  const [busy, setBusy] = useState(false);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={8} />;
  const { invoice: inv, lines, payments, credit_notes } = st.data;
  const cur = inv.currency;
  const canPay = me?.workspace?.role.key !== 'client_viewer' && !!inv.pay_url;
  const pay = async () => { setBusy(true); try { const r = await api.post(`/api/v1/portal/client/invoices/${id}/pay`); nav(r.pay_url); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return (
    <div>
      <PageHeader back="/portal/client/invoices" title={<span className="row" style={{ gap: 12 }}>Invoice {inv.number} <StatusPill status={inv.status} /></span>}
        sub={<>Issued {fmtDate(inv.issue_date)} · due {fmtDate(inv.due_date)}{inv.period_start ? ` · service period ${period(inv.period_start, inv.period_end)}` : ''}</>}
        actions={<>
          <a className="btn" href={`/api/v1/portal/client/invoices/${id}/pdf`} target="_blank" rel="noreferrer"><Download size={16} /> Download PDF</a>
          {canPay && <Button variant="primary" icon={<CreditCard size={16} />} loading={busy} onClick={pay}>Pay {money(inv.balance_cents, cur)}</Button>}
        </>} />
      {inv.status === 'overdue' && <Banner tone="danger">This invoice is past due. {money(inv.balance_cents, cur)} is outstanding.</Banner>}
      <div className="grid-main-side">
        <Card>
          <CardHeader title="Line items" />
          {lines.length === 0 ? <EmptyState title="No lines" /> : <div className="table-wrap"><table className="table">
            <thead><tr><th>Description</th><th style={{ textAlign: 'right' }}>Hours / qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>{lines.map((l: any) => <tr key={l.id}><td>{l.description}{l.worker_name && l.kind === 'time' && <div className="small muted">{humanize(l.kind)} · {period(l.period_start, l.period_end)}</div>}</td>
              <td className="money">{l.minutes != null ? hoursOf(l.minutes) : Number(l.quantity)}</td><td className="money">{money(l.unit_price_cents, cur)}{l.minutes != null ? '/h' : ''}</td><td className="money"><b>{money(l.amount_cents, cur)}</b></td></tr>)}</tbody>
          </table></div>}
        </Card>
        <div className="stack">
          <Card pad>
            <div className="pr-tot"><span>Subtotal</span><Money cents={inv.subtotal_cents} currency={cur} /></div>
            {Number(inv.discount_cents) > 0 && <div className="pr-tot"><span>Discount</span><Money cents={-inv.discount_cents} currency={cur} /></div>}
            <div className="pr-tot"><span>Tax ({(inv.tax_bp / 100).toFixed(2)}%)</span><Money cents={inv.tax_cents} currency={cur} /></div>
            {Number(inv.credit_cents) > 0 && <div className="pr-tot"><span>Credits</span><Money cents={-inv.credit_cents} currency={cur} /></div>}
            {Number(inv.late_fee_cents) > 0 && <div className="pr-tot"><span>Late fee</span><Money cents={inv.late_fee_cents} currency={cur} /></div>}
            {Number(inv.previous_balance_cents) > 0 && <div className="pr-tot"><span>Previous balance</span><Money cents={inv.previous_balance_cents} currency={cur} /></div>}
            <div className="pr-tot big"><span>Total</span><Money cents={inv.total_cents} currency={cur} /></div>
            <div className="pr-tot"><span>Paid</span><Money cents={-inv.paid_cents} currency={cur} /></div>
            <div className="pr-tot big"><span>Balance due</span><Money cents={inv.balance_cents} currency={cur} /></div>
          </Card>
          <Card><CardHeader title="Payments" />
            <div className="card-b">{payments.length ? payments.map((p: any) => <div key={p.id} className="pr-line small"><span>{dateTime(p.received_at)} · {p.card_brand ? `${humanize(p.card_brand)} •••• ${p.card_last4}` : humanize(p.method)}{p.receipt_number ? <div className="muted">{p.receipt_number}</div> : null}</span><span><b className="num">{money(p.amount_cents, p.currency)}</b>{p.refunded_cents > 0 && <div className="muted">−{money(p.refunded_cents, p.currency)} refunded</div>}</span></div>) : <div className="muted small">No payments yet.</div>}</div>
          </Card>
          {credit_notes.length > 0 && <Card><CardHeader title="Credits & adjustments" />
            <div className="card-b">{credit_notes.map((c: any) => <div key={c.number} className="pr-line small"><span>{c.number} · {humanize(c.kind)}<div className="muted">{c.reason}</div></span><b className="num">{money(c.amount_cents, c.currency)}</b></div>)}</div>
          </Card>}
        </div>
      </div>
    </div>
  );
}
