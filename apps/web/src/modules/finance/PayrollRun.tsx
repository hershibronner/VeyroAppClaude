import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, ChevronDown, ChevronRight, Download, FileText, Send, Trash2, Undo2, Wallet, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi, useInterval } from '../../lib/hooks';
import { money, date as fmtDate, dateTime, downloadText, toCsv, humanize } from '../../lib/format';
import { toast } from '../../lib/toast';
import { realtime } from '../../lib/realtime';
import { Banner, Boundary, Button, Card, CardHeader, ErrorState, LoadingBlock, Menu, MoneyInput, PageHeader, Person, StatusPill, useConfirm, EmptyState } from '../../components/ui';
import { Timeline } from '../../components/Timeline';
import { Money, period, hoursOf } from './shared';
import './payroll.css';

const EARN = ['bonus', 'commission', 'reimbursement', 'leave_pay', 'adjustment'];
const DED = ['advance', 'equipment', 'other', 'adjustment'];

export default function PayrollRun() {
  const { id } = useParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const st = useApi<any>(`/api/v1/payroll/runs/${id}`, [id]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tlKey, setTlKey] = useState(0);
  useEffect(() => realtime.on('payout', () => st.reload()), [st.reload]);
  useInterval(() => st.reload(), st.data?.run?.status === 'payment_initiated' ? 5000 : null);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={8} />;
  const { run, items, payouts, can } = st.data;
  const editable = ['calculated', 'review'].includes(run.status) && can.edit;
  const payout = payouts[0];
  const refresh = () => { st.reload(); setTlKey(k => k + 1); };

  const act = async (path: string, msg: string, body: unknown = {}) => {
    setBusy(true);
    try { await api.post(`/api/v1/payroll/runs/${id}/${path}`, body); toast.success(msg); refresh(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const approve = async () => {
    const r = await confirm({ title: 'Approve payroll?', body: <>You are approving {run.worker_count} payslips for {period(run.period_start, run.period_end)} with net pay of <b>{money(run.total_net_cents, run.currency)}</b>. This is audited.</>, confirmLabel: 'Approve payroll', reason: { label: 'Note (optional)' } });
    if (r.ok) act('approve', 'Payroll approved', { reason: r.reason || undefined });
  };
  const initiate = async () => {
    const r = await confirm({ title: 'Send payouts to Wise?', body: <>{items.length} transfers totalling <b>{money(run.total_net_cents, run.currency)}</b> will be submitted. Duplicate submission is blocked by an idempotency key.</>, confirmLabel: 'Initiate payout' });
    if (!r.ok) return;
    setBusy(true);
    try { const x = await api.post(`/api/v1/payroll/runs/${id}/payout`); toast.success(x.duplicate ? 'Payout already submitted — opening it' : 'Payout batch submitted'); nav(`/finance/payouts/${x.payout.id}`); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const discard = async () => {
    const r = await confirm({ title: 'Discard this payroll run?', body: 'The run is deleted and its timesheet days become available for a new run. This is audited.', danger: true, typeToConfirm: 'DISCARD', confirmLabel: 'Discard run' });
    if (!r.ok) return;
    try { await api.del(`/api/v1/payroll/runs/${id}`); toast.success('Payroll run discarded'); nav('/finance/payroll'); } catch (e) { toast.error(e); }
  };
  const exportCsv = () => downloadText(`payroll-${run.period_start}-${run.period_end}.csv`, toCsv(items, [
    { key: 'worker_name', label: 'Employee' }, { key: 'employee_code', label: 'Code' }, { key: 'company_name', label: 'Client' }, { key: 'h', label: 'Regular hours', value: r => (r.regular_minutes / 60).toFixed(2) }, { key: 'o', label: 'OT hours', value: r => (r.ot_minutes / 60).toFixed(2) },
    { key: 'g', label: 'Gross', value: r => (r.gross_cents / 100).toFixed(2) }, { key: 'd', label: 'Deductions', value: r => (r.deductions_cents / 100).toFixed(2) }, { key: 'n', label: 'Net', value: r => (r.net_cents / 100).toFixed(2) }, { key: 'pay_status', label: 'Status' }, { key: 'payslip_number', label: 'Payslip' },
  ]));

  let primary = null;
  if (run.status === 'calculated' && can.edit) primary = <Button variant="primary" loading={busy} icon={<Send size={16} />} onClick={() => act('submit', 'Submitted for review')}>Submit for review</Button>;
  else if (run.status === 'review' && can.approve) primary = <Button variant="primary" loading={busy} icon={<CheckCircle2 size={16} />} onClick={approve}>Approve payroll</Button>;
  else if (run.status === 'approved' && can.payout) primary = <Button variant="primary" loading={busy} icon={<Wallet size={16} />} onClick={initiate}>Initiate payout</Button>;
  else if (payout) primary = <Button variant="primary" onClick={() => nav(`/finance/payouts/${payout.id}`)}>View payout</Button>;
  const failed = items.filter((i: any) => i.pay_status === 'failed');

  return (
    <div>
      <PageHeader back="/finance/payroll" title={<span className="row" style={{ gap: 12 }}>Payroll {period(run.period_start, run.period_end)} <StatusPill status={run.status} /></span>}
        sub={<>Pay date {fmtDate(run.pay_date)} · {humanize(run.frequency)} · created by {run.created_by_name ?? 'System'}{run.approved_by_name ? ` · approved by ${run.approved_by_name} ${dateTime(run.approved_at)}` : ''}</>}
        actions={<>{primary}<Menu items={[
          { label: 'Send back to calculated', icon: <Undo2 size={15} />, hidden: run.status !== 'review' || !can.edit, onClick: () => act('send-back', 'Sent back') },
          { label: 'Export CSV', icon: <Download size={15} />, onClick: exportCsv },
          { label: 'Discard run', icon: <Trash2 size={15} />, danger: true, hidden: !editable, onClick: discard },
        ]} /></>} />
      {run.status === 'review' && !can.approve && <Banner>Waiting for someone with payroll approval permission to approve this run.</Banner>}
      {failed.length > 0 && payout && <Banner tone="danger"><b>{failed.length} payout{failed.length > 1 ? 's' : ''} failed</b> ({failed.map((f: any) => f.worker_name).join(', ')}). <Link to={`/finance/payouts/${payout.id}`}>Retry from the payout batch →</Link></Banner>}
      {run.status === 'payment_initiated' && <Banner>Payouts are processing with Wise (simulated). This page updates automatically.</Banner>}
      <div className="pr-strip">
        <div><div className="lbl">Workers</div><div className="val">{run.worker_count}</div></div>
        <div><div className="lbl">Hours</div><div className="val">{hoursOf(items.reduce((a: number, i: any) => a + i.regular_minutes + i.ot_minutes, 0))}</div><div className="sub">{hoursOf(items.reduce((a: number, i: any) => a + i.ot_minutes, 0))} overtime</div></div>
        <div><div className="lbl">Gross pay</div><div className="val">{money(run.total_gross_cents, run.currency)}</div></div>
        <div><div className="lbl">Deductions</div><div className="val">{money(items.reduce((a: number, i: any) => a + i.deductions_cents, 0), run.currency)}</div></div>
        <div><div className="lbl">Net pay</div><div className="val">{money(run.total_net_cents, run.currency)}</div><div className="sub">{run.idempotency_key}</div></div>
      </div>
      <div className="grid-main-side">
        <Card>
          <CardHeader title="Payslips" sub={editable ? 'Expand a row to add bonuses, reimbursements, leave pay or deductions.' : undefined} />
          {items.length === 0 ? <EmptyState title="No items" /> : <div className="table-wrap"><table className="table pr-items">
            <thead><tr><th style={{ width: 30 }} /><th>Employee</th><th>Client</th><th style={{ textAlign: 'right' }}>Hours</th><th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Net</th><th>Status</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{items.map((i: any) => <Fragment key={i.id}>
              <tr className="clickable" onClick={() => setOpen(o => (o === i.id ? null : i.id))}>
                <td>{open === i.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                <td><Person name={i.worker_name} sub={[i.employee_code, i.payslip_number].filter(Boolean).join(' · ')} size={30} /></td>
                <td>{i.company_name ?? '—'}<div className="sub">{i.title}</div></td>
                <td className="money">{hoursOf(i.regular_minutes + i.ot_minutes)}{i.ot_minutes > 0 && <div className="sub">{hoursOf(i.ot_minutes)} OT</div>}</td>
                <td className="money"><Money cents={i.gross_cents} currency={i.currency} /></td>
                <td className="money"><Money cents={i.net_cents} currency={i.currency} strong /></td>
                <td><StatusPill status={i.pay_status} />{i.failure_reason && i.pay_status === 'failed' && <div className="sub" style={{ color: 'var(--danger)', maxWidth: 220 }}>{i.failure_reason}</div>}</td>
                <td className="act" onClick={e => e.stopPropagation()}><Menu items={[
                  { label: 'View payslip', icon: <FileText size={15} />, onClick: () => window.open(`/api/v1/payroll/items/${i.id}/payslip`, '_blank') },
                  { label: 'Download payslip', icon: <Download size={15} />, onClick: () => window.open(`/api/v1/payroll/items/${i.id}/payslip?download=1`, '_blank') },
                  { label: 'Send payslip to worker', icon: <Send size={15} />, hidden: editable || !can.edit, onClick: async () => { try { const x = await api.post(`/api/v1/payroll/items/${i.id}/send-payslip`); toast.success(`Payslip sent${x.sent_to ? ' to ' + x.sent_to : ''}`); setTlKey(k => k + 1); } catch (e) { toast.error(e); } } },
                ]} /></td>
              </tr>
              {open === i.id && <tr className="pr-expand"><td colSpan={8}><ItemDetail runId={run.id} item={i} editable={editable} onChange={refresh} /></td></tr>}
            </Fragment>)}</tbody>
          </table></div>}
        </Card>
        <div className="stack">
          {payouts.length > 0 && <Card><CardHeader title="Payouts" />
            <div className="card-b stack" style={{ gap: 10 }}>{payouts.map((p: any) => <Link key={p.id} to={`/finance/payouts/${p.id}`} className="row" style={{ justifyContent: 'space-between', textDecoration: 'none', color: 'inherit' }}>
              <span><b>{money(p.total_cents, p.currency)}</b><div className="small muted">{p.paid_items}/{p.items} paid{p.failed_items ? ` · ${p.failed_items} failed` : ''} · {dateTime(p.created_at)}</div></span><StatusPill status={p.status} /></Link>)}</div></Card>}
          <Card><CardHeader title="Activity" /><div className="card-b"><Boundary label="Timeline"><Timeline type="payroll_run" id={run.id} reloadKey={tlKey} /></Boundary></div></Card>
        </div>
      </div>
    </div>
  );
}

function ItemDetail({ runId, item, editable, onChange }: { runId: string; item: any; editable: boolean; onChange: () => void }) {
  const lines: any[] = Array.isArray(item.lines) ? item.lines : [];
  return (
    <div className="pr-adj-grid">
      <div>
        <div className="bold mb-2">Time</div>
        {lines.length ? lines.map((l, k) => <div key={k}>
          {l.regularMinutes > 0 && <div className="pr-adj-row"><span>Regular {period(l.from, l.to)} · {hoursOf(l.regularMinutes)} × {money(l.rateCents, l.currency)}/h</span><b className="num">{money(l.regularCents, l.currency)}</b></div>}
          {l.otMinutes > 0 && <div className="pr-adj-row"><span>Overtime ×{(l.otMultiplierBp / 10000).toFixed(2)} · {hoursOf(l.otMinutes)}</span><b className="num">{money(l.otCents, l.currency)}</b></div>}
        </div>) : <div className="muted small">No time in this period.</div>}
        <Adjustments title="Earnings" kinds={EARN} rows={item.earnings ?? []} path="earnings" runId={runId} itemId={item.id} editable={editable} onChange={onChange} />
      </div>
      <div>
        <Adjustments title="Deductions" kinds={DED} rows={item.deductions ?? []} path="deductions" runId={runId} itemId={item.id} editable={editable} onChange={onChange} negative />
        <div className="pr-adj-row mt-2"><span>Gross</span><b className="num">{money(item.gross_cents, item.currency)}</b></div>
        <div className="pr-adj-row"><span>Net pay</span><b className="num">{money(item.net_cents, item.currency)}</b></div>
      </div>
    </div>
  );
}

function Adjustments({ title, kinds, rows, path, runId, itemId, editable, onChange, negative }: { title: string; kinds: string[]; rows: any[]; path: 'earnings' | 'deductions'; runId: string; itemId: string; editable: boolean; onChange: () => void; negative?: boolean }) {
  const [kind, setKind] = useState(kinds[0]);
  const [desc, setDesc] = useState('');
  const [amt, setAmt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!desc.trim() || !amt) { toast.error('Add a description and an amount'); return; }
    setBusy(true);
    try { await api.post(`/api/v1/payroll/runs/${runId}/items/${itemId}/${path}`, { kind, description: desc, amount_cents: amt }); setDesc(''); setAmt(null); toast.success(`${title.slice(0, -1)} added`); onChange(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const del = async (rid: string) => { try { await api.del(`/api/v1/payroll/runs/${runId}/${path}/${rid}`); onChange(); } catch (e) { toast.error(e); } };
  return (
    <div className="mt-2">
      <div className="bold mb-2">{title}</div>
      {rows.length ? rows.map(r => <div key={r.id} className="pr-adj-row"><span>{humanize(r.kind)}{r.description ? ` — ${r.description}` : ''}</span><span className="row" style={{ gap: 6 }}><b className="num">{money(negative ? -r.amount_cents : r.amount_cents)}</b>{editable && <button className="icon-btn" aria-label={`Remove ${r.kind}`} onClick={() => del(r.id)}><X size={14} /></button>}</span></div>)
        : <div className="muted small">None</div>}
      {editable && <div className="pr-adj-form">
        <select className="select input-sm" aria-label={`${title} type`} value={kind} onChange={e => setKind(e.target.value)}>{kinds.map(k => <option key={k} value={k}>{humanize(k)}</option>)}</select>
        <input className="input input-sm" aria-label="Description" placeholder="Description" value={desc} onChange={e => setDesc(e.target.value)} />
        <MoneyInput cents={amt} onChange={setAmt} />
        <Button size="sm" loading={busy} onClick={add}>Add</Button>
      </div>}
    </div>
  );
}
