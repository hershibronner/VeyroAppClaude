import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Download, CheckCircle2, XCircle, Receipt, Clock, Wallet, FileText, Send, ExternalLink, Banknote } from 'lucide-react';
import { api, ApiError, qs } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { money, date as fmtDate, humanize, relTime, todayISO, downloadText, toCsv } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Banner, Boundary, Button, DateRangePicker, Drawer, EntitySelect, Field, KpiRow, MemberSelect, MoneyInput, PageHeader, PermissionDenied, Person, Segmented, Skeleton, useConfirm } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { Money, period, ExpenseStatus, EXPENSE_CATEGORIES, EXPENSE_STATUSES } from './shared';
import { useClientOptions } from './Rates';
import './finance.css';

const FILTER_KEYS = ['status', 'category', 'company_id', 'kind', 'billable', 'reimbursable', 'decided', 'reimbursed', 'from', 'to', 'search'];

export default function Expenses() {
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const allowed = can('payroll', 'view') || can('invoices', 'view');
  const sum = useApi<any>(allowed ? '/api/v1/finance/expenses/summary' : null, [reloadKey]);
  const clients = useClientOptions();
  if (!allowed) return <PermissionDenied />;
  const s = sum.data;
  const canApprove = !!s?.can?.approve;
  const cur = s?.currency ?? 'USD';
  const refresh = () => { setReloadKey(k => k + 1); };
  const from = sp.get('from'); const to = sp.get('to');
  const setParams = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } n.delete('page'); setSp(n, { replace: true }); };
  const kpiTo = (patch: Record<string, string>) => `/finance/expenses${qs(patch)}`;

  const approve = async (r: any, reload: () => void) => {
    try { await api.post(`/api/v1/finance/expenses/${r.id}/approve`, {}); toast.success(`Approved ${money(r.amount_cents, r.currency)} for ${r.person_name ?? 'staff'}`); reload(); refresh(); } catch (e) { toast.error(e); }
  };
  const reject = async (r: any, reload: () => void) => {
    const c = await confirm({ title: `Reject ${money(r.amount_cents, r.currency)} expense?`, body: `${r.person_name ?? 'The submitter'} is notified with your reason and can resubmit.`, danger: true, confirmLabel: 'Reject', reason: { label: 'Reason', required: true } });
    if (!c.ok) return;
    try { await api.post(`/api/v1/finance/expenses/${r.id}/reject`, { reason: c.reason }); toast.success('Expense rejected'); reload(); refresh(); } catch (e) { toast.error(e); }
  };
  const post = async (r: any, path: string, ok: string, reload: () => void) => { try { await api.post(`/api/v1/finance/expenses/${r.id}/${path}`, {}); toast.success(ok); reload(); refresh(); } catch (e) { toast.error(e); } };

  const exportCsv = async () => {
    try {
      const f = Object.fromEntries(FILTER_KEYS.map(k => [k, sp.get(k) ?? '']));
      const r = await api.get<{ rows: any[] }>(`/api/v1/finance/expenses${qs({ ...f, pageSize: 5000 })}`);
      downloadText(`expenses-${todayISO()}.csv`, toCsv(r.rows, [
        { key: 'expense_date', label: 'Date' }, { key: 'person_name', label: 'Person' }, { key: 'employee_code', label: 'Employee code' }, { key: 'company_name', label: 'Client' }, { key: 'category', label: 'Category' },
        { key: 'description', label: 'Description' }, { key: 'amount', label: 'Amount', value: x => (x.amount_cents / 100).toFixed(2) }, { key: 'currency', label: 'Currency' }, { key: 'status', label: 'Status' },
        { key: 'billable_to_client', label: 'Billable', value: x => (x.billable_to_client ? 'yes' : 'no') }, { key: 'reimbursable_to_worker', label: 'Reimbursable', value: x => (x.reimbursable_to_worker ? 'yes' : 'no') },
        { key: 'decided_by_name', label: 'Decided by' }, { key: 'decision_note', label: 'Decision note' }, { key: 'invoice_number', label: 'Invoice' }, { key: 'receipt', label: 'Receipt', value: x => (x.receipt_url ? 'yes' : 'no') },
      ]));
      api.post('/api/v1/exports/log', { resource: 'expenses', count: r.rows.length, filters: f }).catch(() => {});
      toast.success(`Exported ${r.rows.length} expense${r.rows.length === 1 ? '' : 's'}`);
    } catch (e) { toast.error(e); }
  };

  const cols: Column<any>[] = [
    { key: 'expense_date', label: 'Date', sortable: true, render: r => fmtDate(r.expense_date) },
    { key: 'person_name', label: 'Person', sortable: true, mobile: 'title', render: r => <Person name={r.person_name ?? '—'} sub={r.person_kind === 'staff' ? 'Team expense' : [r.company_name, r.placement_title].filter(Boolean).join(' · ') || 'Worker'} size={30} /> },
    { key: 'category', label: 'Category', sortable: true, render: r => humanize(r.category) },
    { key: 'description', label: 'Description', mobile: 'subtitle', render: r => <div style={{ maxWidth: 320 }}>{r.description}<div className="small muted">{[r.billable_to_client && `Billable to ${r.company_name ?? 'client'}`, r.reimbursable_to_worker ? 'Reimbursable' : 'Not reimbursable'].filter(Boolean).join(' · ')}</div></div> },
    { key: 'amount_cents', label: 'Amount', sortable: true, align: 'right', render: r => <Money cents={r.amount_cents} currency={r.currency} strong />, csv: r => r.amount_cents / 100 },
    { key: 'receipt', label: 'Receipt', render: r => (r.receipt_url ? <a href={r.receipt_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="row" style={{ gap: 4, display: 'inline-flex' }}><Receipt size={14} /> View</a> : <span className="muted">None</span>), csv: r => (r.receipt_url ? 'yes' : 'no') },
    { key: 'status', label: 'Status', sortable: true, render: r => <div><ExpenseStatus status={r.status} />
      {r.status === 'rejected' && r.decision_note && <div className="small" style={{ color: 'var(--danger)', maxWidth: 220 }}>{r.decision_note}</div>}
      {r.payroll_run_id && <div className="small muted">{r.status === 'reimbursed' ? 'Paid in' : 'In'} payroll {period(r.payroll_period_start, r.payroll_period_end)}</div>}
      {r.invoice_number && <div className="small muted">Billed on {r.invoice_number}</div>}
      {r.status === 'approved' && r.reimbursable_to_worker && r.person_kind === 'worker' && !r.payroll_run_id && <div className="small muted">Next payroll run</div>}
    </div> },
    { key: 'decided_by_name', label: 'Decided', mobile: 'hidden', render: r => (r.decided_at ? <span>{r.decided_by_name ?? '—'}<div className="small muted">{relTime(r.decided_at)}</div></span> : <span className="muted">{r.submitted_at ? `Submitted ${relTime(r.submitted_at)}` : '—'}</span>) },
  ];

  const pendingAge = s?.pending?.oldest_at ? (Date.now() - new Date(s.pending.oldest_at).getTime()) / 86400000 : 0;
  return (
    <div>
      <PageHeader title="Expenses" sub="Worker and team expenses — approved reimbursements flow into the next payroll run; billable ones can be added to the client’s draft invoice."
        actions={<>
          <DateRangePicker value={from && to ? { from, to, label: `${fmtDate(from, { month: 'short', day: 'numeric' })} – ${fmtDate(to)}` } : { from: '', to: '', label: 'All dates' }} onChange={r => setParams({ from: r.from, to: r.to })} />
          <Button icon={<Download size={16} />} onClick={exportCsv}>Export</Button>
          {s?.can?.create && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>New expense</Button>}
        </>} />

      <Boundary label="Expense banner">
        {s && (s.pending.count > 0
          ? <Banner tone={pendingAge > 3 ? 'warn' : 'info'}><b>{s.pending.count} expense{s.pending.count === 1 ? '' : 's'} ({money(s.pending.cents, cur)}) waiting for approval.</b>{' '}
            Oldest submitted {relTime(s.pending.oldest_at)}.{s.pending.without_receipt > 0 && <> {s.pending.without_receipt} without a receipt.</>}{' '}
            {s.awaiting_payroll.count > 0 && <>{s.awaiting_payroll.count} approved reimbursement{s.awaiting_payroll.count === 1 ? '' : 's'} ({money(s.awaiting_payroll.cents, cur)}) will be added to the <Link to="/finance/payroll">next payroll run</Link>. </>}
            <Link to="/finance/expenses?status=submitted">Review now →</Link></Banner>
          : <Banner tone="success">No expenses waiting for approval.{s.awaiting_payroll.count > 0 && <> {s.awaiting_payroll.count} approved reimbursement{s.awaiting_payroll.count === 1 ? '' : 's'} ({money(s.awaiting_payroll.cents, cur)}) will be paid in the <Link to="/finance/payroll">next payroll run</Link>.</>}</Banner>)}
      </Boundary>

      <Boundary label="Expense KPIs">
        {s ? <KpiRow items={[
          { label: 'Pending approval', icon: <Clock size={16} />, value: money(s.pending.cents, cur), deltaText: `${s.pending.count} expense${s.pending.count === 1 ? '' : 's'}`, to: kpiTo({ status: 'submitted' }) },
          { label: 'Approved this month', icon: <CheckCircle2 size={16} />, value: money(s.approved_this_month.cents, cur), deltaText: `${s.approved_this_month.count} approved since ${fmtDate(s.month_start, { month: 'short', day: 'numeric' })}`, to: kpiTo({ decided: 'this_month' }) },
          { label: 'Reimbursed MTD', icon: <Wallet size={16} />, value: money(s.reimbursed_mtd.cents, cur), deltaText: `${s.reimbursed_mtd.count} paid via payroll or manually`, to: kpiTo({ reimbursed: 'this_month' }) },
          { label: 'Billable, not invoiced', icon: <FileText size={16} />, value: money(s.billable_uninvoiced.cents, cur), deltaText: `${s.billable_uninvoiced.count} across ${s.billable_uninvoiced.clients} client${s.billable_uninvoiced.clients === 1 ? '' : 's'}`, to: kpiTo({ billable: 'uninvoiced' }) },
        ]} /> : sum.error ? null : <Skeleton h={90} style={{ marginBottom: 24 }} />}
      </Boundary>

      <DataTable title="All expenses" endpoint="/api/v1/finance/expenses" columns={cols} reloadKey={reloadKey} exportName="expenses" exportResource="expenses"
        params={{ from: from ?? undefined, to: to ?? undefined }}
        filters={[
          { key: 'status', label: 'Status', options: [{ value: 'open', label: 'Draft or pending' }, ...EXPENSE_STATUSES.map(v => ({ value: v, label: v === 'submitted' ? 'Pending approval' : humanize(v) }))] },
          { key: 'category', label: 'Category', options: opts(EXPENSE_CATEGORIES) },
          { key: 'company_id', label: 'Client', options: clients },
          { key: 'kind', label: 'Person', options: [{ value: 'worker', label: 'Workers' }, { value: 'staff', label: 'Team members' }] },
          { key: 'billable', label: 'Billing', options: [{ value: 'true', label: 'Billable to client' }, { value: 'uninvoiced', label: 'Billable, not invoiced' }] },
          { key: 'reimbursable', label: 'Reimbursement', options: [{ value: 'pending', label: 'Approved, not yet reimbursed' }] },
          { key: 'decided', label: 'Decided', options: [{ value: 'this_month', label: 'Approved this month' }] },
          { key: 'reimbursed', label: 'Reimbursed', options: [{ value: 'this_month', label: 'Reimbursed this month' }] },
        ]}
        rowActions={(r, reload) => [
          { label: 'Approve', icon: <CheckCircle2 size={15} />, hidden: r.status !== 'submitted' || !canApprove, onClick: () => approve(r, reload) },
          { label: 'Reject…', icon: <XCircle size={15} />, danger: true, hidden: r.status !== 'submitted' || !canApprove, onClick: () => reject(r, reload) },
          { label: 'Submit for approval', icon: <Send size={15} />, hidden: !['draft', 'rejected'].includes(r.status) || !s?.can?.create, onClick: () => post(r, 'submit', 'Submitted for approval', reload) },
          { label: 'Mark reimbursed', icon: <Banknote size={15} />, hidden: r.person_kind !== 'staff' || !r.reimbursable_to_worker || r.reimbursed_at || !['approved', 'invoiced'].includes(r.status) || !canApprove, onClick: () => post(r, 'mark-reimbursed', 'Marked reimbursed', reload) },
          { label: 'View receipt', icon: <Receipt size={15} />, hidden: !r.receipt_url, onClick: () => window.open(r.receipt_url, '_blank') },
          { label: `Open ${r.invoice_number ?? 'invoice'}`, icon: <ExternalLink size={15} />, hidden: !r.invoice_id, onClick: () => nav(`/finance/invoices/${r.invoice_id}`) },
          { label: 'Open payroll run', icon: <ExternalLink size={15} />, hidden: !r.payroll_run_id, onClick: () => nav(`/finance/payroll/${r.payroll_run_id}`) },
        ]}
        bulkActions={canApprove ? [{ label: 'Approve selected', icon: <CheckCircle2 size={15} />, onClick: async (ids, reload) => {
          try { const r = await api.post<any>('/api/v1/finance/expenses/bulk-approve', { ids }); toast.success(`Approved ${r.approved} expense${r.approved === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} skipped (not pending)` : ''}`); reload(); refresh(); } catch (e) { toast.error(e); }
        } }] : undefined}
        searchPlaceholder="Search person, client, description" emptyTitle="No expenses match" emptyText="Expenses submitted by workers in their portal, or added here by the team, appear in this list."
        emptyAction={s?.can?.create ? <Button variant="primary" size="sm" onClick={() => setOpen(true)}>New expense</Button> : undefined} />

      {open && <NewExpense clients={clients} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); refresh(); }} />}
    </div>
  );
}

function NewExpense({ clients, onClose, onSaved }: { clients: { value: string; label: string }[]; onClose: () => void; onSaved: () => void }) {
  const [who, setWho] = useState<'worker' | 'staff'>('worker');
  const [v, setV] = useState<any>({ worker_id: null, staff_user_id: null, worker: null, category: '', description: '', expense_date: todayISO(), amount_cents: null, billable_to_client: false, reimbursable_to_worker: true, company_id: null });
  const [file, setFile] = useState<File | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (patch: any) => setV((x: any) => ({ ...x, ...patch }));
  const submit = async () => {
    const e: Record<string, string> = {};
    if (who === 'worker' && !v.worker_id) e.worker_id = 'Choose a worker';
    if (!v.category) e.category = 'Choose a category';
    if (!v.description.trim()) e.description = 'Describe the expense';
    if (!v.amount_cents || v.amount_cents <= 0) e.amount_cents = 'Enter an amount';
    if (!v.expense_date) e.expense_date = 'Required';
    if (v.billable_to_client && who === 'staff' && !v.company_id) e.company_id = 'Choose the client to bill';
    setErrs(e); if (Object.keys(e).length) return;
    const f = new FormData();
    if (who === 'worker') f.append('worker_id', v.worker_id); else if (v.staff_user_id) f.append('staff_user_id', v.staff_user_id);
    for (const k of ['category', 'description', 'expense_date']) f.append(k, v[k]);
    f.append('amount_cents', String(v.amount_cents));
    f.append('billable_to_client', String(!!v.billable_to_client)); f.append('reimbursable_to_worker', String(!!v.reimbursable_to_worker));
    if (v.company_id) f.append('company_id', v.company_id);
    if (file) f.append('receipt', file);
    setBusy(true);
    try { await api.upload('/api/v1/finance/expenses', f); toast.success('Expense submitted for approval'); onSaved(); }
    catch (err) { if (err instanceof ApiError) setErrs({ ...(err.fields ?? {}), ...(err.details ?? {}) }); toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Drawer open onClose={onClose} title="New expense" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Submit for approval</Button></>}>
      <div className="form-grid">
        <Field label="Expense for" full><Segmented options={[{ key: 'worker', label: 'A worker' }, { key: 'staff', label: 'A team member' }]} value={who} onChange={k => { setWho(k); set({ reimbursable_to_worker: true }); }} /></Field>
        {who === 'worker'
          ? <Field label="Worker" htmlFor="ex-w" error={errs.worker_id} full hint={v.worker?.company_name ? `Placement: ${v.worker.placement_title ?? '—'} at ${v.worker.company_name}` : undefined}><EntitySelect id="ex-w" endpoint="/api/v1/workers?status=active" value={v.worker_id} onChange={(id, row) => set({ worker_id: id, worker: row ?? null })} labelOf={r => `${r.name}${r.company_name ? ` — ${r.company_name}` : ''}`} placeholder="Select worker" /></Field>
          : <Field label="Team member" htmlFor="ex-s" error={errs.staff_user_id} full hint="Leave empty to record it as your own expense."><MemberSelect id="ex-s" value={v.staff_user_id} onChange={id => set({ staff_user_id: id })} placeholder="Me" /></Field>}
        <Field label="Category" htmlFor="ex-c" error={errs.category}><select id="ex-c" className="select" value={v.category} onChange={e => set({ category: e.target.value })}><option value="">Select…</option>{EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>
        <Field label="Date" htmlFor="ex-d" error={errs.expense_date}><input id="ex-d" type="date" className="input" max={todayISO()} value={v.expense_date} onChange={e => set({ expense_date: e.target.value })} /></Field>
        <Field label="Description" htmlFor="ex-desc" error={errs.description} full><input id="ex-desc" className="input" value={v.description} placeholder="e.g. Noise-cancelling headset for client calls" onChange={e => set({ description: e.target.value })} /></Field>
        <Field label="Amount" htmlFor="ex-a" error={errs.amount_cents}><MoneyInput id="ex-a" cents={v.amount_cents} onChange={c => set({ amount_cents: c })} /></Field>
        <Field label="Receipt" htmlFor="ex-r" error={errs.receipt} hint="PDF or image, up to 10 MB"><input id="ex-r" type="file" className="input" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></Field>
        <Field label="Billing & reimbursement" full>
          <label className="check"><input type="checkbox" checked={v.billable_to_client} onChange={e => set({ billable_to_client: e.target.checked })} /> Bill this expense to the client</label>
          <label className="check"><input type="checkbox" checked={v.reimbursable_to_worker} onChange={e => set({ reimbursable_to_worker: e.target.checked })} /> {who === 'worker' ? 'Reimburse the worker in the next payroll run' : 'Reimburse the team member'}</label>
        </Field>
        {v.billable_to_client && (who === 'staff' || !v.worker?.company_name) && <Field label="Client to bill" htmlFor="ex-co" error={errs.company_id} full><select id="ex-co" className="select" value={v.company_id ?? ''} onChange={e => set({ company_id: e.target.value || null })}><option value="">Select client…</option>{clients.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></Field>}
      </div>
    </Drawer>
  );
}
