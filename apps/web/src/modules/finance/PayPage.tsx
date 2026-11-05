import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, CreditCard, Download, Lock, XCircle } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { money, date as fmtDate, humanize, dateTime } from '../../lib/format';
import { Banner, Button, Card, EmptyState, Field, LoadingBlock, MoneyInput, StatusPill } from '../../components/ui';
import './payroll.css';

const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const fmtCard = (v: string) => v.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');
const fmtExp = (v: string) => { const d = v.replace(/\D/g, '').slice(0, 4); return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; };

export default function PayPage() {
  const { token } = useParams();
  const st = useApi<any>(`/api/v1/public/pay/${token}`, [token]);
  const [form, setForm] = useState({ name: '', email: '', card_number: '', exp: '', cvc: '' });
  const [amount, setAmount] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const attempt = useRef(uuid());
  const d = st.data;
  useEffect(() => { if (d) { setAmount(a => (a === null ? Number(d.invoice.balance_cents) : a)); setForm(f => ({ ...f, email: f.email || d.contact_email || '' })); document.title = `Pay invoice ${d.invoice.number} — ${d.org.name}`; } }, [d]);

  if (st.error && !d) return <Shell><Card pad><EmptyState icon={<XCircle size={22} />} title={(st.error as ApiError).status === 404 ? 'This payment link is invalid or has expired' : 'Could not load this invoice'} text={(st.error as ApiError).status === 404 ? 'Ask the sender for a new invoice link.' : st.error.message} action={(st.error as ApiError).status !== 404 ? <Button onClick={st.reload}>Try again</Button> : undefined} /></Card></Shell>;
  if (!d) return <Shell><LoadingBlock rows={8} /></Shell>;
  const inv = d.invoice; const cur = inv.currency;
  const primary = d.org.primary_color || '#345CFF';
  const set = (k: keyof typeof form, v: string) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: '' })); };

  const pay = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const errs: Record<string, string> = {};
    if (form.name.trim().length < 2) errs.name = 'Enter the name on the card';
    if (form.card_number.replace(/\s/g, '').length < 12) errs.card_number = 'Enter your card number';
    if (!/^\d{2}\/\d{2}$/.test(form.exp)) errs.exp = 'Use MM/YY';
    if (!/^\d{3,4}$/.test(form.cvc)) errs.cvc = 'Enter the 3–4 digit code';
    if (!amount || amount <= 0) errs.amount_cents = 'Enter an amount';
    else if (amount > Number(inv.balance_cents)) errs.amount_cents = `You can pay at most ${money(inv.balance_cents, cur)}`;
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    try {
      const r = await api.post(`/api/v1/public/pay/${token}`, { ...form, card_number: form.card_number.replace(/\s/g, ''), email: form.email || undefined, amount_cents: amount, idempotency_key: attempt.current });
      setResult(r);
      attempt.current = uuid();
      if (!r.declined) { st.reload(); }
    } catch (err) {
      if (err instanceof ApiError) { const f = err.fields ?? (err.details && typeof err.details === 'object' && !Array.isArray(err.details) ? err.details : null); if (f) setErrors(f); }
      setResult({ error: err instanceof Error ? err.message : String(err) });
      attempt.current = uuid();
    } finally { setBusy(false); }
  };

  const success = result && !result.declined && !result.error && result.receipt;
  return (
    <Shell org={d.org}>
      <div className="pr-pay-grid">
        <Card pad>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div><div className="muted small">Invoice {inv.number} · {inv.company_name}</div><div className="pr-pay-total">{money(inv.balance_cents, cur)}</div><div className="small muted">{Number(inv.balance_cents) > 0 ? `Due ${fmtDate(inv.due_date)}` : 'Nothing left to pay'}</div></div>
            <StatusPill status={inv.status} />
          </div>
          {inv.period_start && <div className="small muted mt-1">Service period {fmtDate(inv.period_start)} – {fmtDate(inv.period_end)} · issued {fmtDate(inv.issue_date)}</div>}
          <div className="divider" />
          {d.lines.map((l: any, i: number) => <div key={i} className="pr-line"><span>{l.description}{l.minutes != null && <span className="muted small"> · {(l.minutes / 60).toFixed(2)}h × {money(l.unit_price_cents, cur)}</span>}</span><b className="num nowrap">{money(l.amount_cents, cur)}</b></div>)}
          <div className="divider" />
          <div className="pr-tot"><span>Subtotal</span><span className="num">{money(inv.subtotal_cents, cur)}</span></div>
          {Number(inv.discount_cents) > 0 && <div className="pr-tot"><span>Discount</span><span className="num">−{money(inv.discount_cents, cur)}</span></div>}
          {Number(inv.tax_cents) > 0 && <div className="pr-tot"><span>Tax ({(inv.tax_bp / 100).toFixed(2)}%)</span><span className="num">{money(inv.tax_cents, cur)}</span></div>}
          {Number(inv.credit_cents) > 0 && <div className="pr-tot"><span>Credits</span><span className="num">−{money(inv.credit_cents, cur)}</span></div>}
          {Number(inv.late_fee_cents) > 0 && <div className="pr-tot"><span>Late fee</span><span className="num">{money(inv.late_fee_cents, cur)}</span></div>}
          {Number(inv.previous_balance_cents) > 0 && <div className="pr-tot"><span>Previous balance</span><span className="num">{money(inv.previous_balance_cents, cur)}</span></div>}
          <div className="pr-tot big"><span>Total</span><span className="num">{money(inv.total_cents, cur)}</span></div>
          {Number(inv.paid_cents) > 0 && <div className="pr-tot"><span>Paid</span><span className="num">−{money(inv.paid_cents, cur)}</span></div>}
          <div className="pr-tot big"><span>Balance due</span><span className="num">{money(inv.balance_cents, cur)}</span></div>
          {inv.notes && <div className="small muted mt-2">{inv.notes}</div>}
          <div className="mt-3"><a className="btn btn-sm" href={`/api/v1/public/pay/${token}/pdf`} target="_blank" rel="noreferrer"><Download size={14} /> Download PDF</a></div>
          {d.payments.filter((p: any) => p.status !== 'failed').length > 0 && <><div className="divider" /><div className="bold small mb-2">Payments</div>
            {d.payments.filter((p: any) => p.status !== 'failed').map((p: any, i: number) => <div key={i} className="pr-line small"><span>{dateTime(p.received_at)} · {p.card_brand ? `${humanize(p.card_brand)} •••• ${p.card_last4}` : humanize(p.method)}{p.receipt_number ? ` · ${p.receipt_number}` : ''}</span><b className="num">{money(p.amount_cents - (p.refunded_cents ?? 0), p.currency)}</b></div>)}</>}
        </Card>

        <Card pad>
          {success ? <div className="pr-success">
            <div className="ok"><CheckCircle2 size={30} /></div>
            <h2 style={{ margin: 0 }}>Payment received</h2>
            <div className="muted mt-1">Thank you! {money(result.receipt.amount_cents, result.receipt.currency)} was charged to {humanize(result.receipt.card_brand)} •••• {result.receipt.card_last4}.</div>
            <div className="kv mt-3" style={{ textAlign: 'left' }}>
              <dt>Receipt</dt><dd>{result.receipt.number}</dd>
              <dt>Date</dt><dd>{dateTime(result.receipt.received_at)}</dd>
              <dt>Invoice status</dt><dd><StatusPill status={result.invoice.status} /></dd>
              <dt>Remaining balance</dt><dd>{money(result.invoice.balance_cents, cur)}</dd>
              {result.receipt.emailed_to && <><dt>Receipt sent to</dt><dd>{result.receipt.emailed_to}</dd></>}
            </div>
            {Number(result.invoice.balance_cents) > 0 && <Button className="mt-3" onClick={() => { setResult(null); setAmount(Number(result.invoice.balance_cents)); setForm(f => ({ ...f, card_number: '', exp: '', cvc: '' })); }}>Pay the remaining balance</Button>}
          </div> : !d.payable ? <EmptyState icon={<CheckCircle2 size={22} />} title={inv.status === 'paid' ? 'This invoice is paid in full' : `This invoice is ${humanize(inv.status).toLowerCase()}`} text={inv.status === 'paid' ? 'Thank you — there is nothing left to pay.' : 'Online payment is not available for this invoice.'} /> : <form onSubmit={pay} noValidate>
            <h2 className="row" style={{ gap: 8, margin: '0 0 14px' }}><CreditCard size={20} /> Pay by card</h2>
            {result?.declined && <Banner tone="danger"><b>Payment declined.</b> {result.message} Try another card.</Banner>}
            {result?.error && <Banner tone="danger">{result.error}</Banner>}
            <div className="stack" style={{ gap: 12 }}>
              <Field label="Name on card" htmlFor="pp-name" error={errors.name}><input id="pp-name" className={`input ${errors.name ? 'invalid' : ''}`} autoComplete="cc-name" value={form.name} onChange={e => set('name', e.target.value)} /></Field>
              <Field label="Email for receipt" htmlFor="pp-email" error={errors.email}><input id="pp-email" type="email" className="input" autoComplete="email" value={form.email} onChange={e => set('email', e.target.value)} /></Field>
              <Field label="Card number" htmlFor="pp-card" error={errors.card_number}><input id="pp-card" className={`input ${errors.card_number ? 'invalid' : ''}`} inputMode="numeric" autoComplete="cc-number" placeholder="1234 1234 1234 1234" value={form.card_number} onChange={e => set('card_number', fmtCard(e.target.value))} /></Field>
              <div className="pr-card-row">
                <Field label="Expiry" htmlFor="pp-exp" error={errors.exp}><input id="pp-exp" className={`input ${errors.exp ? 'invalid' : ''}`} inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" value={form.exp} onChange={e => set('exp', fmtExp(e.target.value))} /></Field>
                <Field label="CVC" htmlFor="pp-cvc" error={errors.cvc}><input id="pp-cvc" className={`input ${errors.cvc ? 'invalid' : ''}`} inputMode="numeric" autoComplete="cc-csc" placeholder="123" value={form.cvc} onChange={e => set('cvc', e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
              </div>
              <Field label="Amount" htmlFor="pp-amt" error={errors.amount_cents} hint={`Open balance ${money(inv.balance_cents, cur)} — you can pay part of it.`}><MoneyInput id="pp-amt" cents={amount} onChange={setAmount} /></Field>
              <div className="pr-hints"><b>Test mode.</b> Use any future expiry and any CVC.<br />{d.test_cards.map((c: any) => <span key={c.number} style={{ display: 'block' }}><button type="button" onClick={() => set('card_number', c.number)}>{c.number}</button> — {c.result}</span>)}</div>
              <button type="submit" className="btn btn-primary btn-block" disabled={busy} style={{ background: primary, borderColor: primary }}>{busy ? <span className="spinner" /> : <Lock size={16} />} Pay {money(amount ?? 0, cur)}</button>
            </div>
          </form>}
        </Card>
      </div>
      <div className="pr-foot"><Lock size={12} /> Secured by Stripe (simulated) · test mode{!d.org.hide_powered_by && <> · Powered by VeyroApp</>}{d.org.support_email && <> · Questions? <a href={`mailto:${d.org.support_email}`}>{d.org.support_email}</a></>}</div>
    </Shell>
  );
}

function Shell({ org, children }: { org?: any; children: React.ReactNode }) {
  const primary = org?.primary_color || '#345CFF';
  const name = org?.logo_text || org?.name;
  return (
    <div className="pr-pay">
      <div className="pr-pay-wrap">
        {org && <div className="pr-pay-brand"><span className="pr-pay-logo" style={{ background: primary }}>{String(name).split(/\s+/).map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}</span><b style={{ fontSize: 18 }}>{name}</b></div>}
        {children}
      </div>
    </div>
  );
}
