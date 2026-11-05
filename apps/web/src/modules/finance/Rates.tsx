import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { money, date, todayISO, humanize } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Banner, Button, Drawer, ErrorState, Field, LoadingBlock, MoneyInput, PageHeader, Person, PermissionDenied, StatusPill, Tabs, EmptyState } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { pctOf } from './shared';
import './finance.css';

export function useClientOptions() {
  const { data } = useApi<any>('/api/v1/companies?stage=client,inactive&pageSize=200&sort=name&dir=asc');
  return ((data?.rows ?? []) as any[]).map(c => ({ value: c.id, label: c.name }));
}

const perUnit = (cents: number | null | undefined, unit?: string, cur?: string) => (cents === null || cents === undefined ? '—' : `${money(cents, cur ?? 'USD')}/${unit === 'hour' || !unit ? 'h' : unit}`);

export default function Rates() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') ?? 'current') as 'current' | 'history';
  const [open, setOpen] = useState<any | null>(null);
  const [reload, setReload] = useState(0);
  const clients = useClientOptions();
  if (!can('rates', 'view')) return <PermissionDenied />;
  const cols: Column<any>[] = [
    { key: 'worker_name', label: 'Worker', sortable: true, mobile: 'title', render: r => <Person name={r.worker_name} sub={r.title} /> },
    { key: 'company_name', label: 'Client', sortable: true, mobile: 'subtitle' },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: 'pay_rate_cents', label: 'Pay', align: 'right', sortable: true, render: r => perUnit(r.pay_rate_cents, r.unit, r.currency), csv: r => r.pay_rate_cents / 100 },
    { key: 'bill_rate_cents', label: 'Bill', align: 'right', sortable: true, render: r => perUnit(r.bill_rate_cents, r.unit, r.currency), csv: r => r.bill_rate_cents / 100 },
    { key: 'margin_pct', label: 'Margin', align: 'right', sortable: true, render: r => pctOf(r.margin_pct) },
    { key: 'effective_from', label: 'Effective from', sortable: true, render: r => date(r.effective_from) },
    { key: 'rate_count', label: 'Changes', align: 'right', sortable: true, render: r => Math.max(0, (r.rate_count ?? 1) - 1) },
    { key: 'next_change', label: 'Next change', render: r => (r.next_change ? date(r.next_change) : '—') },
  ];
  const hist: Column<any>[] = [
    { key: 'created_at', label: 'Changed', sortable: true, render: r => date(r.created_at), mobile: 'meta' },
    { key: 'worker_name', label: 'Worker', mobile: 'title', render: r => <Person name={r.worker_name} sub={`${r.title} · ${r.company_name}`} /> },
    { key: 'effective_from', label: 'Effective', sortable: true, render: r => `${date(r.effective_from)}${r.effective_to ? ' – ' + date(r.effective_to) : ''}` },
    { key: 'pay', label: 'Pay', align: 'right', render: r => <>{r.previous ? <span className="muted">{money(r.previous.pay_rate_cents)} → </span> : null}{perUnit(r.pay_rate_cents, r.unit, r.currency)}</>, csv: r => r.pay_rate_cents / 100 },
    { key: 'bill', label: 'Bill', align: 'right', render: r => <>{r.previous ? <span className="muted">{money(r.previous.bill_rate_cents)} → </span> : null}{perUnit(r.bill_rate_cents, r.unit, r.currency)}</>, csv: r => r.bill_rate_cents / 100 },
    { key: 'reason', label: 'Reason', mobile: 'subtitle' },
    { key: 'created_by_name', label: 'By' },
  ];
  return (
    <div>
      <PageHeader title="Rates" sub="Effective-dated pay and bill rates. Every change creates a new row and is audited; past invoices and payroll never change." />
      <Tabs tabs={[{ key: 'current', label: 'Current rates' }, { key: 'history', label: 'Change history' }]} value={tab} onChange={k => setSp(new URLSearchParams({ tab: k }), { replace: true })} />
      {tab === 'current' ? (
        <DataTable key="cur" title="Current rates" endpoint="/api/v1/rates" columns={cols} reloadKey={reload} exportName="rates" exportResource="rates"
          filters={[{ key: 'company_id', label: 'Client', options: clients }, { key: 'status', label: 'Status', options: opts(['active', 'onboarding', 'on_leave', 'notice', 'ended']) }, { key: 'changed', label: 'Changed', options: [{ value: 'recent', label: 'Last 90 days' }] }]}
          onRowClick={r => setOpen(r)} rowActions={r => [{ label: 'Rate timeline', onClick: () => setOpen(r) }]} searchPlaceholder="Search worker, client, role" emptyTitle="No placements with rates" />
      ) : (
        <DataTable key="hist" title="Rate changes" endpoint="/api/v1/rates/history" columns={hist} exportName="rate-history" exportResource="rates" reloadKey={reload}
          filters={[{ key: 'company_id', label: 'Client', options: clients }]} onRowClick={r => setOpen({ placement_id: r.placement_id, worker_name: r.worker_name, title: r.title, company_name: r.company_name })} searchPlaceholder="Search worker, client, reason" />
      )}
      {open && <RateDrawer placement={open} onClose={() => setOpen(null)} onChanged={() => setReload(x => x + 1)} />}
    </div>
  );
}

export function RateDrawer({ placement, onClose, onChanged }: { placement: { placement_id?: string; id?: string; worker_name?: string; title?: string; company_name?: string }; onClose: () => void; onChanged?: () => void }) {
  const pid = placement.placement_id ?? placement.id!;
  const st = useApi<any>(`/api/v1/placements/${pid}/rates`);
  const [adding, setAdding] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  return (
    <Drawer open onClose={onClose} wide title={<>Rate timeline<div className="small muted" style={{ fontWeight: 400 }}>{placement.worker_name} · {placement.title}{placement.company_name ? ` · ${placement.company_name}` : ''}</div></>}
      footer={st.data?.can_edit && !adding ? <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>Add rate change</Button> : undefined}>
      {warnings.length > 0 && <Banner tone="warn">{warnings.map((w, i) => <div key={i}>{w}</div>)}</Banner>}
      {st.error && !st.data ? <ErrorState error={st.error} retry={st.reload} /> : !st.data ? <LoadingBlock /> : (
        <>
          {adding && <RateForm pid={pid} current={st.data.rates.find((r: any) => r.is_current) ?? st.data.rates[0]} today={st.data.today} onCancel={() => setAdding(false)} onSaved={w => { setWarnings(w); setAdding(false); st.reload(); onChanged?.(); }} />}
          {!st.data.can_view_comp && <Banner tone="warn">Your role can see the rate history but not compensation amounts.</Banner>}
          {st.data.rates.length === 0 ? <EmptyState title="No rates yet" /> : (
            <div className="fin-tl">
              {st.data.rates.map((r: any) => (
                <div key={r.id} className={`fin-tl-item ${r.is_current ? 'current' : r.is_future ? 'future' : ''}`}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <b>{date(r.effective_from)} – {r.effective_to ? date(r.effective_to) : 'open-ended'}</b>
                    <span>{r.is_current ? <StatusPill status="active" label="Current" /> : r.is_future ? <StatusPill status="scheduled" label="Scheduled" /> : <StatusPill status="closed" label="Past" tone="gray" />}</span>
                  </div>
                  {st.data.can_view_comp && <div className="fin-rate-nums">
                    <span>Pay <b>{perUnit(r.pay_rate_cents, r.unit, r.currency)}</b></span>
                    <span>Bill <b>{perUnit(r.bill_rate_cents, r.unit, r.currency)}</b></span>
                    <span>Margin <b>{pctOf(r.margin_pct)}</b></span>
                    <span className="muted">OT ×{(r.ot_multiplier_bp / 10000).toFixed(2)} after {(r.ot_threshold_minutes / 60).toFixed(0)}h/week</span>
                  </div>}
                  <div className="small muted mt-1">{r.reason ?? 'No reason given'} · {r.created_by_name ?? 'System'} · {date(r.created_at)}</div>
                  {(r.invoiced_days > 0 || r.paid_days > 0) && <div className="small mt-1">{r.invoiced_days} invoiced day{r.invoiced_days === 1 ? '' : 's'} · {r.paid_days} paid day{r.paid_days === 1 ? '' : 's'} (locked amounts)</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

function RateForm({ pid, current, today, onCancel, onSaved }: { pid: string; current: any; today: string; onCancel: () => void; onSaved: (warnings: string[]) => void }) {
  const [v, setV] = useState<any>({ effective_from: today ?? todayISO(), pay_rate_cents: current?.pay_rate_cents ?? null, bill_rate_cents: current?.bill_rate_cents ?? null, unit: current?.unit ?? 'hour', ot_multiplier_bp: current?.ot_multiplier_bp ?? 15000, ot_threshold_minutes: current?.ot_threshold_minutes ?? 2400, reason: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: string, x: any) => setV((s: any) => ({ ...s, [k]: x }));
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!v.effective_from) e.effective_from = 'Required';
    if (!v.pay_rate_cents) e.pay_rate_cents = 'Required';
    if (!v.bill_rate_cents) e.bill_rate_cents = 'Required';
    if (!v.reason?.trim() || v.reason.trim().length < 3) e.reason = 'Give a short reason (it is audited)';
    setErrs(e); if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await api.post(`/api/v1/placements/${pid}/rates`, { ...v, ot_multiplier_bp: Number(v.ot_multiplier_bp), ot_threshold_minutes: Number(v.ot_threshold_minutes) });
      toast.success('Rate change saved');
      onSaved(r.warnings ?? []);
    } catch (err) { if (err instanceof ApiError && err.fields) setErrs(err.fields); toast.error(err); } finally { setBusy(false); }
  };
  return (
    <div className="card card-pad mb-3">
      <h3 className="mb-2">New rate period</h3>
      <div className="form-grid">
        <Field label="Effective from *" htmlFor="rf-from" error={errs.effective_from}><input id="rf-from" type="date" className="input" value={v.effective_from} onChange={e => set('effective_from', e.target.value)} /></Field>
        <Field label="Unit" htmlFor="rf-unit"><select id="rf-unit" className="select" value={v.unit} onChange={e => set('unit', e.target.value)}>{['hour', 'day', 'week', 'month'].map(u => <option key={u} value={u}>{humanize(u)}</option>)}</select></Field>
        <Field label="Worker pay rate *" htmlFor="rf-pay" error={errs.pay_rate_cents}><MoneyInput id="rf-pay" cents={v.pay_rate_cents} onChange={c => set('pay_rate_cents', c)} /></Field>
        <Field label="Client bill rate *" htmlFor="rf-bill" error={errs.bill_rate_cents}><MoneyInput id="rf-bill" cents={v.bill_rate_cents} onChange={c => set('bill_rate_cents', c)} /></Field>
        <Field label="Overtime multiplier" htmlFor="rf-ot" error={errs.ot_multiplier_bp}><select id="rf-ot" className="select" value={v.ot_multiplier_bp} onChange={e => set('ot_multiplier_bp', Number(e.target.value))}>{[10000, 12500, 15000, 17500, 20000].map(b => <option key={b} value={b}>×{(b / 10000).toFixed(2)}</option>)}</select></Field>
        <Field label="OT threshold (hours / week)" htmlFor="rf-th" error={errs.ot_threshold_minutes}><input id="rf-th" type="number" className="input" min={0} value={v.ot_threshold_minutes / 60} onChange={e => set('ot_threshold_minutes', Math.round(Number(e.target.value) * 60))} /></Field>
        <Field full label="Reason *" htmlFor="rf-reason" error={errs.reason}><textarea id="rf-reason" className="textarea" value={v.reason} placeholder="e.g. Annual raise approved by client" onChange={e => set('reason', e.target.value)} /></Field>
      </div>
      {v.pay_rate_cents && v.bill_rate_cents ? <div className="small muted mt-2">Margin {pctOf(((v.bill_rate_cents - v.pay_rate_cents) / v.bill_rate_cents) * 100)} · {money(v.bill_rate_cents - v.pay_rate_cents)} per {v.unit}</div> : null}
      <div className="row mt-2" style={{ justifyContent: 'flex-end', gap: 8 }}><Button onClick={onCancel}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Save rate change</Button></div>
    </div>
  );
}
