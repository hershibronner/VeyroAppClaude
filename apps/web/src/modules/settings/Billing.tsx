import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Armchair, CalendarClock, Check, CreditCard, Crown, Receipt, TrendingUp, Wallet } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { date, money, relTime } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Dialog, Drawer, ErrorState, Field, KpiRow, LoadingBlock, PageHeader, StatusPill, useConfirm, EmptyState } from '../../components/ui';
import { ChartCard, TrackBars } from '../../components/charts';
import { DataTable, opts } from '../../components/DataTable';
import { Gate, ReadOnlyNote } from './common';
import { useStripeTab } from './StripeConnect';

export default function BillingSettings() {
  return <Gate resource="billing">{editable => <BillingInner editable={editable} />}</Gate>;
}

function BillingInner({ editable }: { editable: boolean }) {
  const st = useApi<any>('/api/v1/billing');
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [cardOpen, setCardOpen] = useState(false);
  const [inv, setInv] = useState<string | null>(null);
  const [months, setMonths] = useState(6);
  const confirm = useConfirm();
  // Real cards: Stripe's secure page opens in a new tab; done once the saved card changes.
  const cardBefore = useRef('');
  const cardSig = (x: any) => x?.subscription?.card ? `${x.subscription.card.brand}${x.subscription.card.last4}${x.subscription.card.exp}` : '';
  const stripeCard = useStripeTab({
    getUrl: async () => { cardBefore.current = cardSig(st.data); return (await api.post('/api/v1/billing/payment-method/checkout')).url; },
    isDone: async () => { const x = await api.get('/api/v1/billing'); return !!x?.subscription?.card && cardSig(x) !== cardBefore.current; },
    onDone: () => { st.reload(); refresh(); },
    copy: { title: 'Adding your card', waiting: 'Enter your card in the Stripe tab', hint: 'Your card details go straight to Stripe — VeyroApp only keeps the brand and last 4 digits.', doneTitle: 'Card saved', doneBody: 'Your VeyroApp subscription will be charged to this card each month.' },
  });
  // This tab is the one Stripe sent back: confirm the saved card (and retry any unpaid invoice with it).
  useEffect(() => {
    const sid = sp.get('card_session'); if (!sid) return;
    sp.delete('card_session'); setSp(sp, { replace: true });
    api.get(`/api/v1/billing/payment-method/checkout/${encodeURIComponent(sid)}`).then((r: any) => {
      if (r.ok) { toast.success(`${r.card.brand} •••• ${r.card.last4} saved. You can close this tab.`); for (const x of r.retried ?? []) x.ok ? toast.success(x.message) : toast.error(x.message); }
      st.reload(); refresh();
    }).catch(e => toast.error(e));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <div className="stack"><PageHeader title="Billing & Subscription" /><Card><LoadingBlock rows={8} /></Card></div>;
  const d = st.data; const s = d.subscription; const est = d.estimate;
  const highlight = sp.get('upgrade');
  const changePlan = async (p: any) => {
    const up = p.price_per_seat_cents + (p.features?.addon_monthly_cents ?? 0) >= s.price_per_seat_cents + (s.addon_cents ?? 0);
    const r = await confirm({ title: `${up ? 'Upgrade' : 'Switch'} to ${p.name}?`, body: <>{p.description}<br /><br />{s.comped ? 'Your account is comped — seats stay metered but are not charged.' : `New price: ${money(p.price_per_seat_cents)} per active worker seat / month${p.features?.addon_monthly_cents ? ` + ${money(p.features.addon_monthly_cents)} / month add-on` : ''}, prorated by seat-day. Simulated checkout — no real charge.`}</>, confirmLabel: up ? 'Upgrade now' : 'Switch plan' });
    if (!r.ok) return;
    try { await api.post('/api/v1/billing/change-plan', { plan_key: p.key }); toast.success(`You're on ${p.name}`); await refresh(); st.reload(); }
    catch (e) { if (e instanceof ApiError && e.details?.needs_card) { toast.error(e); setCardOpen(true); } else toast.error(e); }
  };
  const hist = d.history.slice(-months);
  const open = d.invoices.filter((i: any) => ['open', 'failed'].includes(i.status));
  return (
    <div className="stack">
      <PageHeader title="Billing & Subscription" sub="$29 per active worker seat per month, metered by seat-day. Client users and candidates are always free."
        actions={<>{editable && <Button icon={<CreditCard size={16} />} onClick={() => setCardOpen(true)}>{s.card ? 'Update card' : 'Add payment method'}</Button>}{editable && s.plan_key !== 'white_label' && <Button variant="primary" icon={<Crown size={16} />} onClick={() => { const wl = d.plans.find((p: any) => p.key === 'white_label'); if (wl) changePlan(wl); }}>Upgrade to White Label</Button>}</>} />
      <ReadOnlyNote show={!editable} />
      {s.status === 'suspended' && <Banner tone="danger">Your workspace is <b>suspended</b> and read-only because a payment failed and the grace period ended. {editable ? 'Update your card — failed invoices are retried automatically.' : 'Ask an Owner to update the payment method.'}</Banner>}
      {s.status === 'grace' && <Banner tone="warn">A payment failed. You have until <b>{date(s.grace_ends_at)}</b> ({relTime(s.grace_ends_at)}) to update your card before the workspace becomes read-only.</Banner>}
      {s.comped && <Banner tone="success">Your account is <b>comped</b> by VeyroApp. Seats are still metered ({est.seat_days} seat-days so far this month) so you can see what usage would cost — invoices total $0.00.</Banner>}
      {s.status === 'trialing' && s.trial_ends_at && <Banner>Your free trial ends <b>{date(s.trial_ends_at)}</b> ({relTime(s.trial_ends_at)}). {s.card ? 'Your card on file will be used for the Standard plan afterwards.' : 'Add a payment method to keep going after the trial.'}</Banner>}
      <KpiRow items={[
        { label: 'Active seats now', value: d.seats.now, icon: <Armchair size={16} />, deltaText: `+${d.seats.started_this_month} started · −${d.seats.ended_this_month} ended`, suffix: 'this month', onClick: () => nav('/settings/billing?status=active#seats') },
        { label: 'This month so far', value: money(est.total_cents), icon: <TrendingUp size={16} />, deltaText: `${est.seat_days} seat-days to ${date(est.metered_to)}`, suffix: '' , onClick: () => document.getElementById('seats')?.scrollIntoView({ behavior: 'smooth' }) },
        { label: 'Average seats', value: est.avg_seats.toFixed(1), icon: <CalendarClock size={16} />, deltaText: `over ${est.days} days`, suffix: '' },
        { label: 'Paid last 12 months', value: money(d.paid_12m_cents), icon: <Wallet size={16} />, deltaText: `${d.invoices.length} invoices`, suffix: '', onClick: () => document.getElementById('invoices')?.scrollIntoView({ behavior: 'smooth' }) },
      ]} />
      <div className="grid-2">
        <ChartCard title="Seats per month" big={`${hist[hist.length - 1]?.avg_seats ?? 0}`} delta={<span className="muted">average active seats this month</span>} control={<select className="select input-sm" style={{ width: 'auto', height: 32 }} aria-label="Range" value={months} onChange={e => setMonths(Number(e.target.value))}>{[3, 6, 12].map(m => <option key={m} value={m}>Last {m} months</option>)}</select>}>
          <TrackBars data={hist.map((h: any) => ({ label: h.label, value: h.avg_seats }))} fmt={v => `${v} seats`} height={230} />
        </ChartCard>
        <Card>
          <CardHeader title="Current plan" sub={`${s.plan_name} · ${s.status.replace('_', ' ')}`} right={<StatusPill status={s.status} />} />
          <div className="card-b stack" style={{ gap: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Price per active seat</span><b>{money(s.price_per_seat_cents)} / month</b></div>
            {s.addon_cents > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">White label add-on</span><b>{money(s.addon_cents)} / month</b></div>}
            {s.discount_pct > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Discount</span><b>{s.discount_pct}%</b></div>}
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Tax</span><b>{(s.tax_bp / 100).toFixed(2)}%</b></div>
            <div className="divider" style={{ margin: '4px 0' }} />
            <div className="small muted">Estimate for {date(est.period_start, { month: 'long', year: 'numeric' })}:</div>
            {est.lines.map((l: any, i: number) => <div key={i} className="row small" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}><span className="muted">{l.label}</span><b className="money">{money(l.amount_cents)}</b></div>)}
            <div className="row" style={{ justifyContent: 'space-between' }}><b>Estimated total</b><b className="money">{money(est.total_cents)}</b></div>
            <div className="divider" style={{ margin: '4px 0' }} />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 8 }}><CreditCard size={16} />{s.card ? <span>{s.card.brand} •••• {s.card.last4} <span className="muted small">exp {s.card.exp}</span></span> : <span className="muted">No payment method</span>}</span>
              {editable && d.card_mode !== 'unavailable' && <Button size="sm" loading={stripeCard.busy} onClick={() => d.card_mode === 'stripe' ? stripeCard.start() : setCardOpen(true)}>{s.card ? 'Replace' : 'Add card'}</Button>}
            </div>
          </div>
        </Card>
      </div>
      <Card>
        <CardHeader title="Plans" sub={d.card_mode === 'simulated' ? 'Simulated checkout — switching plans never charges a real card.' : 'Switching plans doesn’t charge now — the new price applies from your next monthly invoice.'} />
        <div className="card-b grid-3">
          {d.plans.filter((p: any) => p.key !== 'trial' || s.plan_key === 'trial').map((p: any) => (
            <div key={p.key} className={`st-plan ${p.key === s.plan_key ? 'current' : ''}`} style={highlight === p.key && p.key !== s.plan_key ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 3px rgba(112,68,255,.15)' } : undefined}>
              <div className="row" style={{ justifyContent: 'space-between' }}><b>{p.name}</b>{p.key === s.plan_key && <StatusPill status="active" label="Current plan" />}</div>
              <div><span className="price">{p.key === 'trial' ? 'Free' : money(p.price_per_seat_cents)}</span>{p.key !== 'trial' && <span className="muted small"> / seat / month</span>}</div>
              {p.features?.addon_monthly_cents > 0 && <div className="small">+ {money(p.features.addon_monthly_cents)} / month white-label add-on</div>}
              <div className="small muted" style={{ flex: 1 }}>{p.description}</div>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                <li>Unlimited staff, client users & candidates</li><li>All modules, portals and automations</li>
                {p.features?.white_label ? <><li>Custom domain & branded emails</li><li>No “Powered by VeyroApp”</li></> : <li>Your logo and colors</li>}
                {p.trial_days > 0 && <li>{p.trial_days}-day free trial</li>}
              </ul>
              {p.key !== s.plan_key && p.key !== 'trial' && editable && <Button variant={p.key === 'white_label' ? 'primary' : 'outline'} icon={p.key === 'white_label' ? <Crown size={15} /> : <Check size={15} />} onClick={() => changePlan(p)}>{p.key === 'white_label' ? 'Upgrade' : 'Switch to ' + p.name}</Button>}
            </div>
          ))}
        </div>
      </Card>
      <div id="invoices"><Card>
        <CardHeader title="VeyroApp invoices" sub="Generated monthly from seat-days." right={open.length > 0 && <StatusPill status="overdue" label={`${open.length} unpaid`} />} />
        {d.invoices.length === 0 ? <EmptyState icon={<Receipt size={22} />} title="No invoices yet" text="Your first invoice is created after your first full month." /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Invoice</th><th>Period</th><th style={{ textAlign: 'right' }}>Seat-days</th><th style={{ textAlign: 'right' }}>Avg seats</th><th style={{ textAlign: 'right' }}>Subtotal</th><th style={{ textAlign: 'right' }}>Total</th><th>Status</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{d.invoices.map((i: any) => (
              <tr key={i.id} className="clickable" onClick={() => setInv(i.id)}>
                <td className="bold">{i.number}</td><td>{date(i.period_start, { month: 'short', year: 'numeric' })}</td><td className="money">{i.seat_days.toLocaleString()}</td><td className="money">{Number(i.avg_seats).toFixed(1)}</td>
                <td className="money">{money(i.subtotal_cents)}</td><td className="money bold">{money(i.total_cents)}</td><td><StatusPill status={i.status} /></td>
                <td className="act" onClick={e => e.stopPropagation()}>{editable && ['open', 'failed'].includes(i.status) && <Button size="xs" variant="primary" onClick={async () => { try { const r = await api.post(`/api/v1/billing/invoices/${i.id}/pay`); r.ok ? toast.success(r.message) : toast.error(r.message); st.reload(); refresh(); } catch (e) { toast.error(e); } }}>Pay now</Button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card></div>
      <div id="seats"><DataTable<any> title="Seat history" endpoint="/api/v1/billing/seats" exportName="seat-history" exportResource="billing" defaultSort="started_at"
        filters={[{ key: 'status', label: 'Status', options: opts(['active', 'ended']) }]}
        emptyTitle="No seats yet" emptyText="A seat starts when a placement is activated and stops when it ends."
        columns={[
          { key: 'worker_name', label: 'Worker', sortable: true, mobile: 'title' },
          { key: 'company_name', label: 'Client', sortable: true, mobile: 'subtitle' },
          { key: 'title', label: 'Role' },
          { key: 'started_at', label: 'Seat started', sortable: true, render: r => date(r.started_at) },
          { key: 'ended_at', label: 'Seat ended', sortable: true, render: r => r.ended_at ? date(r.ended_at) : <StatusPill status="active" /> },
          { key: 'days_active', label: 'Seat-days', align: 'right' },
          { key: 'started_by_name', label: 'Started by' },
        ]} /></div>
      <PaymentMethodDialog open={cardOpen} onClose={() => setCardOpen(false)} onSaved={() => { st.reload(); refresh(); }} />
      <InvoiceDrawer id={inv} onClose={() => setInv(null)} />
      {stripeCard.modal}
    </div>
  );
}

function PaymentMethodDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ number: '', exp: '', cvc: '', name: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const fmtNum = (s: string) => s.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim();
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      const r = await api.post('/api/v1/billing/payment-method', v);
      toast.success(`${r.card.brand} •••• ${r.card.last4} saved`);
      for (const x of r.retried ?? []) x.ok ? toast.success(x.message) : toast.error(x.message);
      setV({ number: '', exp: '', cvc: '', name: '' }); onSaved(); onClose();
    } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); else toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Payment method" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save card</Button></>}>
      <Banner>Demo mode — simulated card vault. Use <b>4242 4242 4242 4242</b> (succeeds) or <b>4000 0000 0000 0002</b> (declines). Only the brand and last 4 digits are kept.</Banner>
      <div className="form-grid mt-2">
        <Field label="Name on card" htmlFor="pm-name" full error={errors.name}><input id="pm-name" className="input" autoComplete="cc-name" value={v.name} onChange={e => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Card number" htmlFor="pm-num" full error={errors.number}><input id="pm-num" className="input mono" inputMode="numeric" autoComplete="cc-number" placeholder="4242 4242 4242 4242" value={v.number} onChange={e => setV({ ...v, number: fmtNum(e.target.value) })} /></Field>
        <Field label="Expiry (MM/YY)" htmlFor="pm-exp" error={errors.exp}><input id="pm-exp" className="input" autoComplete="cc-exp" placeholder="12/29" value={v.exp} onChange={e => { let x = e.target.value.replace(/[^\d]/g, '').slice(0, 4); if (x.length > 2) x = x.slice(0, 2) + '/' + x.slice(2); setV({ ...v, exp: x }); }} /></Field>
        <Field label="CVC" htmlFor="pm-cvc" error={errors.cvc}><input id="pm-cvc" className="input" inputMode="numeric" autoComplete="cc-csc" placeholder="123" value={v.cvc} onChange={e => setV({ ...v, cvc: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></Field>
      </div>
    </Dialog>
  );
}

function InvoiceDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const st = useApi<any>(id ? `/api/v1/billing/invoices/${id}` : null, [id]);
  const i = st.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={i ? `Invoice ${i.number}` : 'Invoice'}>
      {!i ? <LoadingBlock /> : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><div><div className="small muted">Billed to</div><b>{i.bill_to}</b>{i.billing_email && <div className="small muted">{i.billing_email}</div>}</div><StatusPill status={i.status} /></div>
          <div className="small muted">Period {date(i.period_start)} – {date(i.period_end)} · issued {date(i.created_at)}{i.paid_at ? ` · paid ${date(i.paid_at)}` : ''}{i.card ? ` · ${i.card}` : ''}</div>
          {i.failure_reason && <Banner tone="danger">{i.failure_reason}</Banner>}
          <table className="table"><thead><tr><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead><tbody>
            {i.lines.map((l: any, k: number) => <tr key={k}><td>{l.label}</td><td className="money">{money(l.amount_cents)}</td></tr>)}
            <tr><td className="bold">Total</td><td className="money bold">{money(i.total_cents)}</td></tr>
          </tbody></table>
          <div className="small muted">{i.seat_days.toLocaleString()} seat-days ÷ days in month = {Number(i.avg_seats).toFixed(2)} average seats × $29.00. Seats start when a placement is activated and stop when it ends.</div>
        </div>
      )}
    </Drawer>
  );
}
