import { useState } from 'react';
import { Plus, Receipt } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { money, date as fmtDate, humanize, todayISO } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Banner, Button, Card, CardHeader, Drawer, EmptyState, ErrorState, Field, LoadingBlock, MoneyInput, PageHeader } from '../../components/ui';
import { Money, period, ExpenseStatus, EXPENSE_CATEGORIES } from './shared';
import './payroll.css';

export default function WorkerExpenses() {
  const st = useApi<any>('/api/v1/portal/worker/expenses?pageSize=200');
  const [open, setOpen] = useState(false);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={8} />;
  const d = st.data; const s = d.summary;
  const rejected = d.rows.filter((r: any) => r.status === 'rejected');
  const note = (r: any) => r.status === 'rejected' ? r.decision_note
    : r.status === 'reimbursed' ? `Paid${r.payroll_pay_date ? ` on ${fmtDate(r.payroll_pay_date)}` : ''}`
    : r.status === 'approved' ? (r.payroll_period_start ? `In payroll ${period(r.payroll_period_start, r.payroll_period_end)}` : 'Will be paid in your next payroll')
    : r.status === 'submitted' ? 'Waiting for approval' : null;
  return (
    <div>
      <PageHeader title="Expenses" sub="Submit work expenses with a receipt. Approved expenses are reimbursed in your next payroll." actions={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>Submit expense</Button>} />
      {rejected.length > 0 && <Banner tone="warn"><b>{rejected.length} expense{rejected.length === 1 ? ' was' : 's were'} not approved.</b> {rejected[0].decision_note ? `Reason: ${rejected[0].decision_note}` : ''} You can submit a corrected expense with a clear receipt.</Banner>}
      <div className="pr-cards">
        <div className="kpi-tile"><div className="kpi-label">Waiting for approval</div><div className="kpi-value">{money(s.pending_cents, s.currency)}</div><div className="small muted">{s.pending_count} expense{s.pending_count === 1 ? '' : 's'}</div></div>
        <div className="kpi-tile"><div className="kpi-label">Approved, to be paid</div><div className="kpi-value">{money(s.approved_unpaid_cents, s.currency)}</div></div>
        <div className="kpi-tile"><div className="kpi-label">Reimbursed {s.year}</div><div className="kpi-value">{money(s.reimbursed_ytd_cents, s.currency)}</div></div>
      </div>
      <Card>
        <CardHeader title="My expenses" sub={`${d.total} total`} />
        {d.rows.length === 0 ? <EmptyState title="No expenses yet" text="Bought something you need for work? Submit it with a photo of the receipt." action={<Button variant="primary" size="sm" onClick={() => setOpen(true)}>Submit expense</Button>} /> : <>
          <div className="table-wrap responsive"><table className="table">
            <thead><tr><th>Date</th><th>Expense</th><th>Category</th><th style={{ textAlign: 'right' }}>Amount</th><th>Receipt</th><th>Status</th></tr></thead>
            <tbody>{d.rows.map((r: any) => <tr key={r.id}>
              <td>{fmtDate(r.expense_date)}</td>
              <td><b>{r.description}</b>{r.company_name && <div className="small muted">{r.company_name}</div>}</td>
              <td>{humanize(r.category)}</td>
              <td className="money"><Money cents={r.amount_cents} currency={r.currency} strong /></td>
              <td>{r.receipt_url ? <a href={r.receipt_url} target="_blank" rel="noreferrer"><Receipt size={14} /> View</a> : <span className="muted">None</span>}</td>
              <td><ExpenseStatus status={r.status} />{note(r) && <div className="small" style={{ color: r.status === 'rejected' ? 'var(--danger)' : 'var(--muted)', maxWidth: 240 }}>{note(r)}</div>}</td>
            </tr>)}</tbody>
          </table></div>
          <div className="mobile-cards">{d.rows.map((r: any) => <div key={r.id} className="mcard"><div className="mmain">
            <div><b>{r.description}</b></div><div className="muted small mt-1">{fmtDate(r.expense_date)} · {humanize(r.category)}</div>
            <div className="mrow"><span>Amount</span><b>{money(r.amount_cents, r.currency)}</b></div>
            <div className="mrow"><span>Status</span><b><ExpenseStatus status={r.status} /></b></div>
            {note(r) && <div className="small muted mt-1">{note(r)}</div>}
            {r.receipt_url && <div className="mrow"><span>Receipt</span><a href={r.receipt_url} target="_blank" rel="noreferrer">View</a></div>}
          </div></div>)}</div>
        </>}
      </Card>
      {open && <SubmitExpense placements={d.placements} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); st.reload(); }} />}
    </div>
  );
}

function SubmitExpense({ placements, onClose, onSaved }: { placements: any[]; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<any>({ category: '', description: '', expense_date: todayISO(), amount_cents: null, placement_id: placements[0]?.id ?? '' });
  const [file, setFile] = useState<File | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (p: any) => setV((x: any) => ({ ...x, ...p }));
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!v.category) e.category = 'Choose a category';
    if (!v.description.trim()) e.description = 'Describe the expense';
    if (!v.amount_cents || v.amount_cents <= 0) e.amount_cents = 'Enter an amount';
    if (!file) e.receipt = 'Attach a receipt';
    setErrs(e); if (Object.keys(e).length) return;
    const f = new FormData();
    for (const k of ['category', 'description', 'expense_date']) f.append(k, v[k]);
    f.append('amount_cents', String(v.amount_cents));
    if (v.placement_id) f.append('placement_id', v.placement_id);
    f.append('receipt', file!);
    setBusy(true);
    try { await api.upload('/api/v1/portal/worker/expenses', f); toast.success('Expense submitted — you’ll be notified when it’s reviewed'); onSaved(); }
    catch (err) { if (err instanceof ApiError) setErrs({ ...(err.fields ?? {}), ...(err.details ?? {}) }); toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Drawer open onClose={onClose} title="Submit expense" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Submit</Button></>}>
      <div className="form-grid">
        <Field label="Category" htmlFor="we-c" error={errs.category}><select id="we-c" className="select" value={v.category} onChange={e => set({ category: e.target.value })}><option value="">Select…</option>{EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>
        <Field label="Date" htmlFor="we-d" error={errs.expense_date}><input id="we-d" type="date" className="input" max={todayISO()} value={v.expense_date} onChange={e => set({ expense_date: e.target.value })} /></Field>
        <Field label="What was it for?" htmlFor="we-desc" error={errs.description} full><input id="we-desc" className="input" value={v.description} placeholder="e.g. Headset for client calls" onChange={e => set({ description: e.target.value })} /></Field>
        <Field label="Amount" htmlFor="we-a" error={errs.amount_cents}><MoneyInput id="we-a" cents={v.amount_cents} onChange={c => set({ amount_cents: c })} /></Field>
        {placements.length > 1 && <Field label="Client" htmlFor="we-p" error={errs.placement_id}><select id="we-p" className="select" value={v.placement_id} onChange={e => set({ placement_id: e.target.value })}>{placements.map(p => <option key={p.id} value={p.id}>{p.company_name} — {p.title}</option>)}</select></Field>}
        <Field label="Receipt" htmlFor="we-r" error={errs.receipt} full hint="PDF or photo (PNG, JPG, WEBP), up to 10 MB"><input id="we-r" type="file" className="input" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*" capture="environment" onChange={e => setFile(e.target.files?.[0] ?? null)} /></Field>
      </div>
    </Drawer>
  );
}
