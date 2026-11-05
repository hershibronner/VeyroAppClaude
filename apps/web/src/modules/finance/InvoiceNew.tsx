import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, Plus, Trash2, ArrowLeft, ArrowRight } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { money, todayISO, addDaysISO } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Banner, Button, Card, EmptyState, ErrorState, Field, LoadingBlock, MoneyInput, PageHeader, PermissionDenied } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { hoursOf, period } from './shared';
import { useClientOptions } from './Rates';
import './finance.css';

interface Manual { kind: 'manual' | 'reimbursement'; description: string; quantity: number; unit_price_cents: number | null }

function prevMonth() {
  const t = todayISO();
  const first = t.slice(0, 8) + '01';
  const end = addDaysISO(first, -1);
  return { from: end.slice(0, 8) + '01', to: end };
}

/** Invoice generator: client + period → preview lines (one per rate period) → Draft. */
export function InvoiceGenerator({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const unbilled = useApi<{ rows: any[] }>('/api/v1/invoices/unbilled');
  const clients = useClientOptions();
  const [step, setStep] = useState(1);
  const [companyId, setCompanyId] = useState<string>(sp.get('company_id') ?? '');
  const pm = prevMonth();
  const [from, setFrom] = useState(pm.from);
  const [to, setTo] = useState(pm.to);
  const [preview, setPreview] = useState<any | null>(null);
  const [pvErr, setPvErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<Manual[]>([]);
  const [discount, setDiscount] = useState<number | null>(null);
  const [prevBal, setPrevBal] = useState<number | null>(null);
  const [due, setDue] = useState('');
  const [notes, setNotes] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});

  const pickClient = (id: string) => {
    setCompanyId(id);
    const u = unbilled.data?.rows.find(r => r.company_id === id);
    if (u) { setFrom(u.first_date); setTo(u.last_date); }
  };
  useEffect(() => { if (companyId && unbilled.data) { const u = unbilled.data.rows.find(r => r.company_id === companyId); if (u) { setFrom(u.first_date); setTo(u.last_date); } } /* eslint-disable-next-line */ }, [unbilled.data]);

  const runPreview = async () => {
    if (!companyId) { setErrs({ company_id: 'Pick a client' }); return; }
    if (!from || !to || from > to) { setErrs({ period_end: 'End must be on or after start' }); return; }
    setErrs({}); setBusy(true); setPvErr(null);
    try {
      const p = await api.post('/api/v1/invoices/preview', { company_id: companyId, period_start: from, period_end: to });
      setPreview(p); setStep(2);
      if (!due) setDue(addDaysISO(todayISO(), p.company.payment_terms_days ?? 15));
    } catch (e) { setPvErr(e); if (e instanceof ApiError && e.fields) setErrs(e.fields); } finally { setBusy(false); }
  };
  const manualValid = manual.filter(m => m.description.trim() && m.unit_price_cents);
  const manualTotal = manualValid.reduce((s, m) => s + Math.round(m.quantity * (m.unit_price_cents ?? 0)), 0);
  const est = useMemo(() => {
    if (!preview) return null;
    const time = preview.totals.subtotalCents as number;
    const taxable = time + manualValid.filter(m => m.kind === 'manual').reduce((s, m) => s + Math.round(m.quantity * (m.unit_price_cents ?? 0)), 0);
    const tax = Math.round(Math.max(0, taxable - (discount ?? 0)) * preview.tax_bp / 10000);
    return { subtotal: time + manualTotal, tax, total: time + manualTotal + tax - (discount ?? 0) + (prevBal ?? 0) };
  }, [preview, manualValid, manualTotal, discount, prevBal]);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/v1/invoices', { company_id: companyId, period_start: from, period_end: to, due_date: due || null, notes: notes || null, discount_cents: discount ?? 0, previous_balance_cents: prevBal ?? 0, manual_lines: manualValid.map(m => ({ kind: m.kind, description: m.description.trim(), quantity: m.quantity, unit_price_cents: m.unit_price_cents })) });
      toast.success(`Draft ${r.invoice.number} created`);
      onDone?.();
      nav(`/finance/invoices/${r.invoice.id}`);
    } catch (e) { if (e instanceof ApiError && e.fields) setErrs(e.fields); toast.error(e); } finally { setBusy(false); }
  };

  const clientName = preview?.company?.name ?? unbilled.data?.rows.find(r => r.company_id === companyId)?.company_name ?? clients.find(c => c.value === companyId)?.label;
  const steps = ['Client & period', 'Review lines', 'Create draft'];
  return (
    <div>
      <div className="fin-steps">{steps.map((s, i) => <span key={s} className={`fin-step ${step === i + 1 ? 'on' : step > i + 1 ? 'done' : ''}`}>{step > i + 1 ? <Check size={14} /> : i + 1} {s}</span>)}</div>
      {step === 1 && (
        <div className="fin-stack">
          <div>
            <h3 className="mb-2">Clients with approved, un-invoiced time</h3>
            {unbilled.error ? <ErrorState error={unbilled.error} retry={unbilled.reload} /> : !unbilled.data ? <LoadingBlock rows={3} /> : unbilled.data.rows.length === 0 ? <EmptyState title="No approved time waiting" text="All approved timesheets are invoiced. You can still pick a client below to bill manual lines." /> : (
              <div className="fin-client-pick">
                {unbilled.data.rows.map(r => (
                  <button key={r.company_id} type="button" className={companyId === r.company_id ? 'on' : ''} onClick={() => pickClient(r.company_id)} aria-pressed={companyId === r.company_id}>
                    <b>{r.company_name}</b>
                    <span className="small muted">{hoursOf(r.minutes)} · {r.placements} worker{r.placements === 1 ? '' : 's'} · ≈ {money(r.estimated_cents)}</span>
                    <span className="small muted">{period(r.first_date, r.last_date)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="form-grid">
            <Field label="Client *" htmlFor="ig-client" error={errs.company_id}><select id="ig-client" className="select" value={companyId} onChange={e => pickClient(e.target.value)}><option value="">Select client…</option>{clients.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></Field>
            <div />
            <Field label="Period start *" htmlFor="ig-from" error={errs.period_start}><input id="ig-from" type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} /></Field>
            <Field label="Period end *" htmlFor="ig-to" error={errs.period_end}><input id="ig-to" type="date" className="input" value={to} onChange={e => setTo(e.target.value)} /></Field>
          </div>
          {pvErr ? <ErrorState error={pvErr} /> : null}
          <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="primary" loading={busy} icon={<ArrowRight size={16} />} onClick={runPreview} disabled={!companyId}>Preview lines</Button></div>
        </div>
      )}
      {step >= 2 && preview && (
        <div className="fin-stack">
          <div><b>{clientName}</b> <span className="muted">· {period(preview.period_start, preview.period_end)} · tax {(preview.tax_bp / 100).toFixed(2)}%</span></div>
          {preview.problems?.length > 0 && <Banner tone="danger">Some approved time cannot be priced: {preview.problems.join('; ')}. Fix the placement rates first.</Banner>}
          {preview.pending_timesheets > 0 && <Banner tone="warn">{preview.pending_timesheets} timesheet{preview.pending_timesheets === 1 ? '' : 's'} in this period ({hoursOf(preview.pending_minutes)}) are not approved yet and are excluded.</Banner>}
          {preview.lines.length === 0 ? <EmptyState title="No approved, un-invoiced time in this period" text="Pick another period, or add manual lines below to invoice anyway." /> : (
            <div className="fin-scroll">
              <table className="fin-lines">
                <thead><tr><th>Worker</th><th>Description</th><th>Period</th><th className="r">Hours</th><th className="r">Rate</th><th className="r">Amount</th></tr></thead>
                <tbody>{preview.lines.map((l: any, i: number) => <tr key={i}><td>{l.worker_name}</td><td>{l.kind === 'adjustment' ? l.description : l.title}</td><td>{period(l.period_start, l.period_end)}</td><td className="r">{l.hours.toFixed(2)}</td><td className="r">{money(l.unit_price_cents, l.currency)}/{l.unit === 'hour' ? 'h' : l.unit}</td><td className="r">{money(l.amount_cents, l.currency)}</td></tr>)}</tbody>
                <tfoot><tr><td colSpan={3}>Time subtotal ({preview.lines.length} line{preview.lines.length === 1 ? '' : 's'})</td><td className="r">{(preview.lines.reduce((s: number, l: any) => s + l.minutes, 0) / 60).toFixed(2)}</td><td /><td className="r">{money(preview.totals.subtotalCents)}</td></tr></tfoot>
              </table>
            </div>
          )}
          <Card pad>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}><h3>Manual lines</h3><Button size="sm" icon={<Plus size={14} />} onClick={() => setManual(m => [...m, { kind: 'manual', description: '', quantity: 1, unit_price_cents: null }])}>Add line</Button></div>
            {manual.length === 0 ? <div className="small muted">Optional: setup fees, reimbursements (not taxed), adjustments.</div> : manual.map((m, i) => (
              <div key={i} className="fin-form-row mb-2">
                <Field label={i === 0 ? 'Description' : undefined}><input aria-label="Description" className="input" value={m.description} onChange={e => setManual(a => a.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} /></Field>
                <Field label={i === 0 ? 'Qty' : undefined}><input aria-label="Quantity" type="number" className="input" value={m.quantity} onChange={e => setManual(a => a.map((x, j) => j === i ? { ...x, quantity: Number(e.target.value) || 0 } : x))} /></Field>
                <Field label={i === 0 ? 'Unit price' : undefined}><MoneyInput cents={m.unit_price_cents} onChange={c => setManual(a => a.map((x, j) => j === i ? { ...x, unit_price_cents: c } : x))} /></Field>
                <div className="row" style={{ gap: 6 }}>
                  <select aria-label="Line type" className="select" value={m.kind} onChange={e => setManual(a => a.map((x, j) => j === i ? { ...x, kind: e.target.value as Manual['kind'] } : x))}><option value="manual">Service</option><option value="reimbursement">Reimbursement</option></select>
                  <button className="icon-btn" aria-label="Remove line" onClick={() => setManual(a => a.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
          </Card>
          <div className="form-grid">
            <Field label="Discount" htmlFor="ig-disc" error={errs.discount_cents}><MoneyInput id="ig-disc" cents={discount} onChange={setDiscount} /></Field>
            <Field label="Previous balance" htmlFor="ig-prev" hint="Carried-forward amount owed from before"><MoneyInput id="ig-prev" cents={prevBal} onChange={setPrevBal} /></Field>
            <Field label="Due date" htmlFor="ig-due" error={errs.due_date}><input id="ig-due" type="date" className="input" value={due} onChange={e => setDue(e.target.value)} /></Field>
            <Field label="Notes (shown on invoice)" htmlFor="ig-notes" full><textarea id="ig-notes" className="textarea" value={notes} onChange={e => setNotes(e.target.value)} /></Field>
          </div>
          {est && <Card pad><dl className="fin-totals"><dt>Subtotal</dt><dd>{money(est.subtotal)}</dd>{discount ? <><dt>Discount</dt><dd>−{money(discount)}</dd></> : null}<dt>Tax ({(preview.tax_bp / 100).toFixed(2)}%)</dt><dd>{money(est.tax)}</dd>{prevBal ? <><dt>Previous balance</dt><dd>{money(prevBal)}</dd></> : null}<dt className="fin-total-row">Estimated total</dt><dd className="fin-total-row">{money(est.total)}</dd></dl><div className="small muted mt-1">Final totals are computed by the server and recorded in the recalculation history.</div></Card>}
          <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <Button icon={<ArrowLeft size={16} />} onClick={() => setStep(1)}>Back</Button>
            <Button variant="primary" loading={busy} disabled={preview.lines.length === 0 && manualValid.length === 0 || preview.problems?.length > 0} onClick={create}>Create draft invoice</Button>
          </div>
        </div>
      )}
      {compact && step === 1 && <div className="small muted mt-2">Drafts can be edited before approval and sending.</div>}
    </div>
  );
}

export default function InvoiceNew() {
  const { can } = useAuth();
  if (!can('invoices', 'create')) return <PermissionDenied />;
  return (
    <div>
      <PageHeader title="New invoice" sub="Generate from approved timesheets — one line per worker per rate period." back="/finance/invoices" />
      <Card pad><InvoiceGenerator /></Card>
    </div>
  );
}
