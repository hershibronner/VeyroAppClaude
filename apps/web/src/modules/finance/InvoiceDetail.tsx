import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Send, Banknote, FileDown, FileText, Link2, Bell, MinusCircle, Percent, XCircle, Undo2, Ban, RefreshCw, Trash2, Plus, Receipt } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { money, date, dateTime, humanize, todayISO } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Banner, Boundary, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, LoadingBlock, Menu, MoneyInput, PageHeader, StatusPill, useConfirm, BackButton } from '../../components/ui';
import { Timeline } from '../../components/Timeline';
import { Money, hoursOf, period } from './shared';
import './finance.css';

type DialogKind = null | 'payment' | 'credit' | { refund: any };

export default function InvoiceDetail() {
  const { id } = useParams();
  const st = useApi<any>(`/api/v1/invoices/${id}`);
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [dlg, setDlg] = useState<DialogKind>(null);
  const [tlKey, setTlKey] = useState(0);
  const reload = () => { st.reload(); setTlKey(k => k + 1); };
  const act = async (key: string, fn: () => Promise<any>, ok: string | ((r: any) => string)) => {
    setBusy(key);
    try { const r = await fn(); toast.success(typeof ok === 'function' ? ok(r) : ok); reload(); return r; } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  if (st.error && !st.data) return <><BackButton fallback="/finance/invoices" /><ErrorState error={st.error} retry={st.reload} /></>;
  if (!st.data) return <LoadingBlock rows={8} />;
  const { invoice: inv, contact, lines, history, payments, credit_notes, allowed, can } = st.data;
  const cur = inv.currency;
  const isDraft = inv.status === 'draft';
  const open = ['sent', 'viewed', 'partially_paid', 'overdue'].includes(inv.status);
  const p = (path: string, body: unknown = {}) => api.post(`/api/v1/invoices/${id}/${path}`, body);

  let primary = null;
  if (isDraft && can.approve) primary = <Button variant="primary" icon={<CheckCircle2 size={16} />} loading={busy === 'approve'} onClick={() => act('approve', () => p('approve'), 'Invoice approved')}>Approve</Button>;
  else if (inv.status === 'approved' && can.edit) primary = <Button variant="primary" icon={<Send size={16} />} loading={busy === 'send'} onClick={() => act('send', () => p('send'), r => `Invoice sent to ${r.sent_to}`)}>Send</Button>;
  else if (open && can.pay) primary = <Button variant="primary" icon={<Banknote size={16} />} onClick={() => setDlg('payment')}>Record payment</Button>;

  const more = [
    { label: 'Download PDF', icon: <FileDown size={15} />, onClick: () => window.open(`/api/v1/invoices/${id}/pdf?download=1`, '_blank') },
    { label: 'View PDF', icon: <FileText size={15} />, onClick: () => window.open(`/api/v1/invoices/${id}/pdf`, '_blank') },
    { label: 'Copy pay link', icon: <Link2 size={15} />, hidden: !open || !inv.pay_url, onClick: async () => { try { await navigator.clipboard.writeText(inv.pay_url); toast.success('Pay link copied'); } catch { toast.info(inv.pay_url); } } },
    { label: 'Send reminder', icon: <Bell size={15} />, hidden: !open || !can.edit, onClick: () => act('remind', () => p('remind'), r => `Reminder sent to ${r.sent_to}`) },
    { label: 'Record manual payment', icon: <Banknote size={15} />, hidden: !open || !can.pay || !!(primary && open), onClick: () => setDlg('payment') },
    { sep: true },
    { label: 'Credit note', icon: <MinusCircle size={15} />, hidden: !can.approve || ['paid', 'written_off', 'void'].includes(inv.status) || inv.balance_cents <= 0, onClick: () => setDlg('credit') },
    { label: 'Apply late fee', icon: <Percent size={15} />, hidden: inv.status !== 'overdue' || !can.edit, onClick: async () => { const r = await confirm({ title: 'Apply late fee?', body: 'The late fee from your invoice settings is applied to the open balance and the total is recalculated.' }); if (r.ok) act('fee', () => p('late-fee'), 'Late fee applied'); } },
    { label: 'Write off', icon: <XCircle size={15} />, danger: true, hidden: !can.approve || !allowed.includes('written_off'), onClick: async () => { const r = await confirm({ title: `Write off ${money(inv.balance_cents, cur)}?`, body: 'The open balance is recorded as a write-off credit note and the invoice closes. This is audited.', danger: true, confirmLabel: 'Write off', reason: { label: 'Reason', required: true } }); if (r.ok) act('wo', () => p('write-off', { reason: r.reason }), 'Invoice written off'); } },
    { label: 'Return to draft', icon: <Undo2 size={15} />, hidden: inv.status !== 'approved' || !can.approve, onClick: () => act('revert', () => p('revert'), 'Returned to draft') },
    { label: 'Void draft', icon: <Ban size={15} />, danger: true, hidden: !isDraft || !can.edit, onClick: async () => { const r = await confirm({ title: `Void ${inv.number}?`, body: 'The approved timesheet days on this draft are released so they can be invoiced again.', danger: true, confirmLabel: 'Void draft', reason: { label: 'Reason', required: true } }); if (r.ok) act('void', () => p('void', { reason: r.reason }), 'Draft voided'); } },
    { sep: true },
    { label: 'Sync to accounting', icon: <RefreshCw size={15} />, hidden: ['draft', 'void'].includes(inv.status) || !can.edit, onClick: () => act('sync', () => p('sync'), r => (r.log?.status === 'synced' ? `Synced (${r.log.external_id})` : `Sync failed: ${r.log?.error ?? 'unknown error'}`)) },
  ];

  return (
    <div>
      <PageHeader back="/finance/invoices"
        title={<span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{inv.number} <StatusPill status={inv.status} /></span>}
        sub={<div className="fin-head-meta">
          <span><Link to={`/crm/clients/${inv.company_id}`}>{inv.company_name}</Link></span>
          <span>AM: {inv.account_manager_name ?? '—'}</span>
          <span>{contact?.email ? `${contact.name} <${contact.email}>` : 'No billing contact email'}</span>
          <span>Due {date(inv.due_date)}{inv.days_overdue > 0 && <b className="fin-red"> · {inv.days_overdue} days overdue</b>}</span>
          <span>Balance <b style={{ color: 'var(--text)' }}>{money(inv.balance_cents, cur)}</b></span>
        </div>}
        actions={<>{primary}<Menu items={more} /></>} />
      {inv.status === 'approved' && !contact?.email && <Banner tone="warn">This client has no billing contact email — add one before sending.</Banner>}
      {inv.status === 'draft' && <Banner>Draft — edit lines, tax, discount and notes, then approve. Approved time on this draft is reserved and can’t be billed twice.</Banner>}
      <div className="grid-main-side">
        <div className="fin-stack">
          {isDraft && can.edit && <Boundary label="Billable expenses"><BillableExpenses inv={inv} onAdded={reload} /></Boundary>}
          <Boundary label="Lines"><LinesCard inv={inv} lines={lines} editable={isDraft && can.edit} onChanged={reload} /></Boundary>
          <Boundary label="Payments">
            <Card>
              <CardHeader title="Payments" sub={`${payments.filter((x: any) => x.status !== 'failed').length} received · ${money(inv.paid_cents, cur)}`} />
              {payments.length === 0 ? <EmptyState title="No payments yet" text={open ? 'Share the pay link or record a manual payment.' : undefined} /> : (
                <div className="fin-scroll"><table className="fin-lines"><thead><tr><th>Date</th><th>Method</th><th>Receipt</th><th>Status</th><th className="r">Amount</th><th /></tr></thead>
                  <tbody>{payments.map((x: any) => <tr key={x.id}>
                    <td>{dateTime(x.received_at)}</td>
                    <td>{x.method === 'card' ? `${humanize(x.card_brand ?? 'card')} •••• ${x.card_last4 ?? ''}` : humanize(x.method)}{x.provider_ref && x.method !== 'card' ? <div className="small muted">{x.provider_ref}</div> : null}</td>
                    <td>{x.receipt_number ?? '—'}</td>
                    <td><StatusPill status={x.status} />{x.failure_reason && <div className="small muted">{x.failure_reason}</div>}{Number(x.refunded_cents) > 0 && <div className="small muted">Refunded {money(x.refunded_cents, x.currency)}</div>}</td>
                    <td className="r">{money(x.amount_cents, x.currency)}</td>
                    <td className="r">{x.status === 'succeeded' && can.refund && <Button size="xs" onClick={() => setDlg({ refund: x })}>Refund</Button>}</td>
                  </tr>)}</tbody></table></div>
              )}
            </Card>
          </Boundary>
          {credit_notes.length > 0 && <Boundary label="Credit notes"><Card><CardHeader title="Credit notes, refunds & write-offs" />
            <div className="fin-scroll"><table className="fin-lines"><thead><tr><th>Number</th><th>Type</th><th>Reason</th><th>By</th><th className="r">Amount</th></tr></thead>
              <tbody>{credit_notes.map((c: any) => <tr key={c.id}><td>{c.number}<div className="small muted">{date(c.created_at)}</div></td><td><StatusPill status={c.kind} tone={c.kind === 'write_off' ? 'red' : c.kind === 'refund' ? 'amber' : 'blue'} /></td><td>{c.reason}</td><td>{c.created_by_name ?? '—'}</td><td className="r">{money(c.amount_cents, c.currency)}</td></tr>)}</tbody></table></div></Card></Boundary>}
          <Boundary label="Activity"><Card><CardHeader title="Activity" /><div className="card-b"><Timeline type="invoice" id={id!} reloadKey={tlKey} /></div></Card></Boundary>
        </div>
        <div className="fin-stack">
          <Boundary label="Totals"><TotalsCard inv={inv} editable={isDraft && can.edit} onChanged={reload} /></Boundary>
          <Boundary label="Details"><Card><CardHeader title="Details" /><div className="card-b">
            <dl className="kv">
              <dt>Service period</dt><dd>{period(inv.period_start, inv.period_end)}</dd>
              <dt>Issued</dt><dd>{date(inv.issue_date)}</dd>
              <dt>Created by</dt><dd>{inv.created_by_name ?? '—'}</dd>
              <dt>Approved</dt><dd>{inv.approved_at ? `${inv.approved_by_name ?? '—'} · ${dateTime(inv.approved_at)}` : '—'}</dd>
              <dt>Sent</dt><dd>{dateTime(inv.sent_at)}</dd>
              <dt>Viewed</dt><dd>{dateTime(inv.viewed_at)}</dd>
              <dt>Paid</dt><dd>{dateTime(inv.paid_at)}</dd>
              <dt>Accounting</dt><dd>{inv.sync ? <><StatusPill status={inv.sync.status} /> {inv.sync.external_id ?? ''}{inv.sync.error && <div className="small fin-red">{inv.sync.error}</div>}</> : inv.accounting_external_id ?? 'Not synced'}</dd>
            </dl>
          </div></Card></Boundary>
          <Boundary label="History"><Card><CardHeader title="Recalculation history" sub="Every total change is recorded" />
            <div className="card-b stack" style={{ gap: 10 }}>{history.length === 0 ? <span className="muted small">No history</span> : history.map((h: any) => <div key={h.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}><div style={{ minWidth: 0 }}><div className="small">{h.reason}</div><div className="tiny muted">{h.actor_name ?? 'System'} · {dateTime(h.created_at)}</div></div><b className="num small">{money(h.total_cents, cur)}</b></div>)}</div>
          </Card></Boundary>
        </div>
      </div>
      {dlg === 'payment' && <PaymentDialog inv={inv} onClose={() => setDlg(null)} onDone={() => { setDlg(null); reload(); }} />}
      {dlg === 'credit' && <AmountReasonDialog title="Issue credit note" max={inv.balance_cents} currency={cur} cta="Issue credit" onClose={() => setDlg(null)} onSubmit={b => p('credit-notes', b).then(() => { toast.success('Credit note issued'); setDlg(null); reload(); })} />}
      {dlg && typeof dlg === 'object' && 'refund' in dlg && <AmountReasonDialog title={`Refund ${dlg.refund.receipt_number ?? 'payment'}`} max={Number(dlg.refund.amount_cents) - Number(dlg.refund.refunded_cents)} currency={cur} cta="Refund" onClose={() => setDlg(null)} onSubmit={b => api.post(`/api/v1/payments/${dlg.refund.id}/refund`, b).then(() => { toast.success('Refund issued'); setDlg(null); reload(); })} />}
    </div>
  );
}

function TotalsCard({ inv, editable, onChanged }: { inv: any; editable: boolean; onChanged: () => void }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const cur = inv.currency;
  const start = () => { setV({ tax_pct: (inv.tax_bp / 100).toString(), discount_cents: Number(inv.discount_cents), previous_balance_cents: Number(inv.previous_balance_cents), due_date: inv.due_date, notes: inv.notes ?? '' }); setEdit(true); };
  const save = async () => {
    setBusy(true);
    try { await api.patch(`/api/v1/invoices/${inv.id}`, { tax_bp: Math.round(Number(v.tax_pct || 0) * 100), discount_cents: v.discount_cents ?? 0, previous_balance_cents: v.previous_balance_cents ?? 0, due_date: v.due_date, notes: v.notes || null }); toast.success('Invoice updated'); setEdit(false); onChanged(); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const row = (label: string, cents: number, neg?: boolean) => <><dt>{label}</dt><dd>{neg && cents ? '−' : ''}{money(cents, cur)}</dd></>;
  return (
    <Card>
      <CardHeader title="Totals" right={editable && !edit ? <Button size="sm" onClick={start}>Edit</Button> : undefined} />
      <div className="card-b">
        {edit ? (
          <div className="stack" style={{ gap: 10 }}>
            <Field label="Tax %" htmlFor="t-tax"><input id="t-tax" className="input" inputMode="decimal" value={v.tax_pct} onChange={e => setV({ ...v, tax_pct: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
            <Field label="Discount" htmlFor="t-disc"><MoneyInput id="t-disc" cents={v.discount_cents} onChange={c => setV({ ...v, discount_cents: c })} /></Field>
            <Field label="Previous balance" htmlFor="t-prev"><MoneyInput id="t-prev" cents={v.previous_balance_cents} onChange={c => setV({ ...v, previous_balance_cents: c })} /></Field>
            <Field label="Due date" htmlFor="t-due"><input id="t-due" type="date" className="input" value={v.due_date} onChange={e => setV({ ...v, due_date: e.target.value })} /></Field>
            <Field label="Notes" htmlFor="t-notes"><textarea id="t-notes" className="textarea" value={v.notes} onChange={e => setV({ ...v, notes: e.target.value })} /></Field>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}><Button onClick={() => setEdit(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save & recalculate</Button></div>
          </div>
        ) : (
          <dl className="fin-totals">
            {row('Subtotal', Number(inv.subtotal_cents))}
            {Number(inv.discount_cents) > 0 && row('Discount', Number(inv.discount_cents), true)}
            {row(`Tax (${(inv.tax_bp / 100).toFixed(2)}%)`, Number(inv.tax_cents))}
            {Number(inv.credit_cents) > 0 && row('Credits', Number(inv.credit_cents), true)}
            {Number(inv.late_fee_cents) > 0 && row('Late fee', Number(inv.late_fee_cents))}
            {Number(inv.previous_balance_cents) > 0 && row('Previous balance', Number(inv.previous_balance_cents))}
            <dt className="fin-total-row">Total</dt><dd className="fin-total-row">{money(inv.total_cents, cur)}</dd>
            {row('Paid', Number(inv.paid_cents), true)}
            <dt className="bold">Balance due</dt><dd className="bold">{money(inv.balance_cents, cur)}</dd>
          </dl>
        )}
        {!edit && inv.notes && <div className="small muted mt-2">{inv.notes}</div>}
      </div>
    </Card>
  );
}

function LinesCard({ inv, lines, editable, onChanged }: { inv: any; lines: any[]; editable: boolean; onChanged: () => void }) {
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState<any>({ kind: 'manual', description: '', quantity: 1, unit_price_cents: null });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const e: Record<string, string> = {};
    if (!v.description.trim()) e.description = 'Required';
    if (v.unit_price_cents === null) e.unit_price_cents = 'Required';
    setErrs(e); if (Object.keys(e).length) return;
    setBusy(true);
    try { await api.post(`/api/v1/invoices/${inv.id}/lines`, { ...v, quantity: Number(v.quantity) }); toast.success('Line added'); setAdding(false); setV({ kind: 'manual', description: '', quantity: 1, unit_price_cents: null }); onChanged(); }
    catch (err) { if (err instanceof ApiError && err.fields) setErrs(err.fields); toast.error(err); } finally { setBusy(false); }
  };
  const del = async (l: any) => {
    const r = await confirm({ title: 'Remove line?', body: l.kind === 'time' ? 'The approved timesheet days on this line are released so they can be billed later.' : undefined, danger: true, confirmLabel: 'Remove' });
    if (!r.ok) return;
    try { await api.del(`/api/v1/invoices/${inv.id}/lines/${l.id}`); toast.success('Line removed'); onChanged(); } catch (e) { toast.error(e); }
  };
  return (
    <Card>
      <CardHeader title="Lines" sub={`${lines.length} line${lines.length === 1 ? '' : 's'} · one per worker per rate period`} right={editable && !adding ? <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add line</Button> : undefined} />
      {lines.length === 0 ? <EmptyState title="No lines" /> : (
        <div className="fin-scroll"><table className="fin-lines">
          <thead><tr><th>Description</th><th>Period</th><th className="r">Hours / Qty</th><th className="r">Rate</th><th className="r">Amount</th>{editable && <th />}</tr></thead>
          <tbody>{lines.map(l => <tr key={l.id}>
            <td>{l.worker_name ? <b>{l.worker_name}</b> : null}<div className={l.worker_name ? 'small muted' : ''}>{l.description}</div>{l.kind !== 'time' && <span className="small muted">{humanize(l.kind)}{!l.taxable ? ' · not taxed' : ''}</span>}</td>
            <td>{period(l.period_start, l.period_end)}</td>
            <td className="r">{l.minutes != null ? hoursOf(l.minutes) : Number(l.quantity)}</td>
            <td className="r">{money(l.unit_price_cents, inv.currency)}{l.minutes != null ? '/h' : ''}</td>
            <td className="r"><Money cents={l.amount_cents} currency={inv.currency} /></td>
            {editable && <td className="r"><button className="icon-btn" aria-label="Remove line" onClick={() => del(l)}><Trash2 size={15} /></button></td>}
          </tr>)}</tbody>
        </table></div>
      )}
      {adding && <div className="card-b">
        <div className="fin-form-row">
          <Field label="Description" htmlFor="nl-d" error={errs.description}><input id="nl-d" className="input" value={v.description} onChange={e => setV({ ...v, description: e.target.value })} /></Field>
          <Field label="Qty" htmlFor="nl-q" error={errs.quantity}><input id="nl-q" type="number" className="input" value={v.quantity} onChange={e => setV({ ...v, quantity: e.target.value })} /></Field>
          <Field label="Unit price" htmlFor="nl-p" error={errs.unit_price_cents}><MoneyInput id="nl-p" cents={v.unit_price_cents} onChange={c => setV({ ...v, unit_price_cents: c })} /></Field>
          <Field label="Type" htmlFor="nl-k"><select id="nl-k" className="select" value={v.kind} onChange={e => setV({ ...v, kind: e.target.value })}><option value="manual">Service</option><option value="reimbursement">Reimbursement</option><option value="adjustment">Adjustment</option></select></Field>
        </div>
        <div className="row mt-2" style={{ justifyContent: 'flex-end', gap: 8 }}><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={add}>Add line</Button></div>
      </div>}
    </Card>
  );
}

/** Approved, billable expenses for this client that are not on any invoice yet → add as reimbursement lines. */
function BillableExpenses({ inv, onAdded }: { inv: any; onAdded: () => void }) {
  const st = useApi<any>(`/api/v1/invoices/${inv.id}/billable-expenses`, [inv.total_cents]);
  const [busy, setBusy] = useState(false);
  const d = st.data;
  if (!d || !d.can_add || d.rows.length === 0) return null;
  const add = async () => {
    setBusy(true);
    try { const r = await api.post<any>(`/api/v1/invoices/${inv.id}/expenses`, {}); toast.success(`Added ${r.added} expense${r.added === 1 ? '' : 's'} (${money(r.total_cents, inv.currency)})`); st.reload(); onAdded(); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Banner icon={<Receipt size={20} />}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span><b>{d.rows.length} approved billable expense{d.rows.length === 1 ? '' : 's'} ({money(d.total_cents, d.currency)})</b> for {inv.company_name} {d.rows.length === 1 ? 'is' : 'are'} not invoiced yet: {d.rows.slice(0, 3).map((r: any) => `${r.person_name ?? 'Staff'} — ${r.description}`).join('; ')}{d.rows.length > 3 ? '…' : ''}</span>
        <Button size="sm" icon={<Plus size={14} />} loading={busy} onClick={add}>Add approved expenses</Button>
      </div>
    </Banner>
  );
}

function PaymentDialog({ inv, onClose, onDone }: { inv: any; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<any>({ amount_cents: inv.balance_cents, method: 'ach', reference: '', received_at: todayISO(), allow_overpay: false });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const over = (v.amount_cents ?? 0) > inv.balance_cents;
  const submit = async () => {
    if (!v.amount_cents) { setErrs({ amount_cents: 'Enter an amount' }); return; }
    if (over && !v.allow_overpay) { setErrs({ amount_cents: `Exceeds the open balance of ${money(inv.balance_cents, inv.currency)}` }); return; }
    setBusy(true);
    try { await api.post(`/api/v1/invoices/${inv.id}/payments`, { ...v, reference: v.reference || null }); toast.success('Payment recorded'); onDone(); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrs(e.fields); toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={`Record payment · ${inv.number}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Record payment</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="small muted">Open balance {money(inv.balance_cents, inv.currency)}</div>
        <Field label="Amount *" htmlFor="pd-a" error={errs.amount_cents}><MoneyInput id="pd-a" cents={v.amount_cents} onChange={c => setV({ ...v, amount_cents: c })} /></Field>
        <Field label="Method" htmlFor="pd-m"><select id="pd-m" className="select" value={v.method} onChange={e => setV({ ...v, method: e.target.value })}>{['ach', 'wire', 'check', 'cash'].map(m => <option key={m} value={m}>{m === 'ach' ? 'ACH' : humanize(m)}</option>)}</select></Field>
        <Field label="Reference" htmlFor="pd-r" hint="Bank reference or check number"><input id="pd-r" className="input" value={v.reference} onChange={e => setV({ ...v, reference: e.target.value })} /></Field>
        <Field label="Received on" htmlFor="pd-d"><input id="pd-d" type="date" className="input" value={v.received_at} onChange={e => setV({ ...v, received_at: e.target.value })} /></Field>
        {over && <label className="check"><input type="checkbox" checked={v.allow_overpay} onChange={e => setV({ ...v, allow_overpay: e.target.checked })} /> Accept overpayment of {money((v.amount_cents ?? 0) - inv.balance_cents, inv.currency)} as a client credit</label>}
      </div>
    </Dialog>
  );
}

function AmountReasonDialog({ title, max, currency, cta, onClose, onSubmit }: { title: string; max: number; currency: string; cta: string; onClose: () => void; onSubmit: (b: { amount_cents: number; reason: string }) => Promise<unknown> }) {
  const [amount, setAmount] = useState<number | null>(max);
  const [reason, setReason] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!amount || amount <= 0) e.amount_cents = 'Enter an amount';
    else if (amount > max) e.amount_cents = `At most ${money(max, currency)}`;
    if (reason.trim().length < 3) e.reason = 'A reason is required';
    setErrs(e); if (Object.keys(e).length) return;
    setBusy(true);
    try { await onSubmit({ amount_cents: amount!, reason: reason.trim() }); } catch (err) { if (err instanceof ApiError && err.fields) setErrs(err.fields); toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>{cta}</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="Amount *" htmlFor="ar-a" error={errs.amount_cents} hint={`Maximum ${money(max, currency)}`}><MoneyInput id="ar-a" cents={amount} onChange={setAmount} /></Field>
        <Field label="Reason *" htmlFor="ar-r" error={errs.reason}><textarea id="ar-r" className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}
