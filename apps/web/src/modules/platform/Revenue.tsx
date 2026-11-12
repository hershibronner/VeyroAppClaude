import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CreditCard, FilePlus2, Pencil } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { date, money } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Dialog, ErrorState, Field, LoadingBlock, PageHeader, StatusPill, useConfirm } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';
import { ChartCard, TrackBars } from '../../components/charts';
import { FormDrawer } from '../../components/FormDrawer';

const INV_TABS = [{ key: '', label: 'All' }, { key: 'open', label: 'Open' }, { key: 'failed', label: 'Failed' }, { key: 'paid', label: 'Paid' }, { key: 'comped', label: 'Comped' }, { key: 'void', label: 'Void' }];

export function InvoicesPage() {
  const [sp, setSp] = useSearchParams();
  const [rk, setRk] = useState(0);
  const [gen, setGen] = useState(false);
  const [month, setMonth] = useState(() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); });
  const [busy, setBusy] = useState(false);
  const view = sp.get('invoice');
  const status = sp.get('status') ?? '';
  const setQ = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const sum = useApi<any>('/api/v1/platform/invoices-summary', [rk]);
  const agencies = useApi<any>('/api/v1/platform/agencies?pageSize=500&sort=name&dir=asc');
  const act = useInvoiceAction(() => { setRk(k => k + 1); });
  const s = sum.data;
  return (
    <div className="stack">
      <PageHeader title="Subscriptions & invoices" sub="Monthly invoices to agencies: seat-days × plan price + add-ons − discounts and comps + tax. Payments are simulated."
        actions={<Button variant="primary" icon={<FilePlus2 size={16} />} onClick={() => setGen(true)}>Generate monthly invoices</Button>} />
      {s && <div className="st-sumstrip">
        <div><span>Outstanding</span><b>{money(s.outstanding_cents, 'USD', { noCents: true })}</b></div>
        <div className={s.failed ? 'warn' : ''}><span>Failed payments</span><b>{s.failed ? `${s.failed} · ${money(s.failed_cents, 'USD', { noCents: true })}` : 0}</b></div>
        <div><span>Collected this month</span><b>{money(s.collected_mtd_cents, 'USD', { noCents: true })}</b></div>
        <div><span>Collected this year</span><b>{money(s.collected_ytd_cents, 'USD', { noCents: true })}</b></div>
        <div><span>Invoices</span><b>{s.total}</b></div>
      </div>}
      <div className="tabs st-tabs" role="tablist">{INV_TABS.map(t => {
        const n = t.key ? s?.[t.key] ?? 0 : s?.total;
        if (t.key && !n && status !== t.key) return null;
        return <button key={t.key} role="tab" aria-selected={status === t.key} className={status === t.key ? 'on' : ''} onClick={() => setQ({ status: t.key, page: null })}>{t.label}{n != null && <span className="count">{n}</span>}</button>;
      })}</div>
      <DataTable<any> title="Invoices" endpoint="/api/v1/platform/invoices" reloadKey={rk} exportName="saas-invoices" onRowClick={r => setQ({ invoice: r.id })}
        params={{ status: status || undefined }} searchPlaceholder="Search invoice number or agency"
        filters={[{ key: 'organization_id', label: 'Agency', options: (agencies.data?.rows ?? []).map((a: any) => ({ value: a.id, label: a.name })) }]}
        columns={[
          { key: 'number', label: 'Invoice', mobile: 'title', render: r => <span className="bold mono">{r.number}</span> },
          { key: 'org_name', label: 'Agency', sortable: true, mobile: 'subtitle' },
          { key: 'period_start', label: 'Month', sortable: true, render: r => date(r.period_start, { month: 'short', year: 'numeric' }) },
          { key: 'avg_seats', label: 'Avg seats', align: 'right', render: r => Number(r.avg_seats).toFixed(1) },
          { key: 'subtotal_cents', label: 'Subtotal', align: 'right', render: r => money(r.subtotal_cents), csv: r => r.subtotal_cents / 100 },
          { key: 'discount_cents', label: 'Discount', align: 'right', render: r => r.discount_cents ? `−${money(r.discount_cents)}` : <span className="muted">—</span>, csv: r => r.discount_cents / 100 },
          { key: 'total_cents', label: 'Total', align: 'right', sortable: true, render: r => <b>{money(r.total_cents)}</b>, csv: r => r.total_cents / 100 },
          { key: 'status', label: 'Status', sortable: true, render: r => <span><StatusPill status={r.status} />{r.failure_reason && <div className="tiny" style={{ color: 'var(--danger)', marginTop: 2 }}>{r.failure_reason}</div>}</span> },
        ]}
        rowActions={(r, reload) => ['open', 'failed'].includes(r.status) ? [
          { label: 'Charge card on file', onClick: () => act(r, 'charge', reload) }, { label: 'Simulate failed payment', onClick: () => act(r, 'simulate-failure', reload) },
          { label: 'Mark as paid', onClick: () => act(r, 'mark-paid', reload) }, { label: 'Void', danger: true, onClick: () => act(r, 'void', reload) },
        ] : [{ label: 'View invoice', onClick: () => setQ({ invoice: r.id }) }]} />
      <Dialog open={gen} onClose={() => setGen(false)} title="Generate monthly invoices" footer={<><Button onClick={() => setGen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { const r = await api.post('/api/v1/platform/invoices/generate-all', { month }); toast.success(`${r.created} new invoice${r.created === 1 ? '' : 's'} for ${r.month} (${r.agencies - r.created} already existed)`); setRk(k => k + 1); setGen(false); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Generate</Button></>}>
        <p className="small muted">Creates one invoice per agency for a completed month. Safe to run again — existing invoices are never duplicated.</p>
        <Field label="Month" htmlFor="ga-m"><input id="ga-m" type="month" className="input" value={month} onChange={e => setMonth(e.target.value)} /></Field>
      </Dialog>
      <InvoiceView id={view} onClose={() => setQ({ invoice: null })} onChanged={() => setRk(k => k + 1)} />
    </div>
  );
}

/** Charge / simulate failure / mark paid / void, with an audited reason where money changes by hand. */
function useInvoiceAction(after: () => void) {
  const confirm = useConfirm();
  return async (i: any, action: string, reload?: () => void) => {
    let body: any = {};
    if (action === 'mark-paid' || action === 'void') { const r = await confirm({ title: action === 'void' ? `Void ${i.number}?` : `Mark ${i.number} paid?`, danger: action === 'void', reason: { label: 'Reason (audited)', required: true } }); if (!r.ok) return; body = { reason: r.reason }; }
    try { const r = await api.post(`/api/v1/platform/invoices/${i.id}/${action}`, body); if (r.message) (r.ok ? toast.success : toast.error)(r.message); else toast.success('Invoice updated'); reload?.(); after(); } catch (e) { toast.error(e); }
  };
}

function InvoiceView({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const st = useApi<any>(id ? `/api/v1/platform/invoices/${id}` : null, [id]);
  const act = useInvoiceAction(() => { st.reload(); onChanged(); });
  const i = st.data;
  const payable = i && ['open', 'failed'].includes(i.status);
  const lines = i ? (i.lines?.length ? i.lines : [{ label: `Seats — ${i.seat_days} seat-days`, amount_cents: i.subtotal_cents }]) : [];
  return (
    <Dialog open={!!id} onClose={onClose} title={i ? `Invoice ${i.number}` : 'Invoice'} wide
      footer={i && <>
        <Link to={`/platform/agencies/${i.organization_id}?tab=billing`} className="btn" style={{ marginRight: 'auto' }}>Open agency</Link>
        {payable && <><Button onClick={() => act(i, 'void')} variant="ghost">Void</Button><Button onClick={() => act(i, 'mark-paid')}>Mark as paid</Button><Button variant="primary" icon={<CreditCard size={15} />} onClick={() => act(i, 'charge')}>Charge {i.card_last4 ? `•••• ${i.card_last4}` : 'card'}</Button></>}
        {!payable && <Button onClick={onClose}>Close</Button>}
      </>}>
      {!i ? <LoadingBlock /> : (
        <div className="st-invoice">
          <div className="st-inv-head">
            <div><div className="tiny muted">BILL TO</div><b>{i.org_name}</b><div className="small muted">{i.billing_email ?? 'No billing email on file'}</div></div>
            <div style={{ textAlign: 'right' }}><StatusPill status={i.status} /><div className="small muted mt-1">{date(i.period_start)} – {date(i.period_end)}</div>{i.paid_at && <div className="small muted">Paid {date(i.paid_at)}</div>}</div>
          </div>
          {i.failure_reason && <Banner tone="danger">Last payment attempt failed: {i.failure_reason} · {i.attempts} attempt{i.attempts === 1 ? '' : 's'}</Banner>}
          <table className="table st-inv-lines"><thead><tr><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead><tbody>
            {lines.map((l: any, k: number) => <tr key={k}><td>{l.label}</td><td className="money">{money(l.amount_cents)}</td></tr>)}
          </tbody></table>
          <div className="st-inv-totals">
            <div><span>Subtotal</span><span>{money(i.subtotal_cents)}</span></div>
            {i.discount_cents > 0 && <div><span>Discount</span><span>−{money(i.discount_cents)}</span></div>}
            <div><span>Tax</span><span>{money(i.tax_cents)}</span></div>
            <div className="total"><span>Total</span><span>{money(i.total_cents)}</span></div>
          </div>
          <div className="tiny muted">{i.seat_days} seat-days · average {Number(i.avg_seats ?? 0).toFixed(1)} seats · card on file {i.card_last4 ? `${i.card_brand ?? 'Card'} •••• ${i.card_last4}` : 'none'}</div>
        </div>
      )}
    </Dialog>
  );
}

export function SeatsPage() {
  const st = useApi<any>('/api/v1/platform/seats/summary');
  const nav = useNavigate();
  const [months, setMonths] = useState(12);
  const agencies = st.data?.rows ?? [];
  return (
    <div className="stack">
      <PageHeader title="Seat usage" sub="Seats start on placement activation and stop when a placement ends. Every seat-day is billable unless comped or in trial." />
      {st.error && !st.data ? <ErrorState error={st.error} retry={st.reload} /> : !st.data ? <Card><LoadingBlock /></Card> : <div className="grid-2">
        <ChartCard title="Average active seats — all agencies" control={<select className="select input-sm" style={{ width: 'auto', height: 32 }} aria-label="Range" value={months} onChange={e => setMonths(Number(e.target.value))}>{[3, 6, 12].map(m => <option key={m} value={m}>Last {m} months</option>)}</select>}>
          <TrackBars data={st.data.history.slice(-months).map((h: any) => ({ label: h.label, value: h.avg_seats }))} fmt={v => `${v} seats`} height={240} />
        </ChartCard>
        <Card><CardHeader title="By agency (this month)" />
          <div className="table-wrap"><table className="table"><thead><tr><th>Agency</th><th style={{ textAlign: 'right' }}>Seats now</th><th style={{ textAlign: 'right' }}>Seat-days MTD</th><th style={{ textAlign: 'right' }}>Estimate</th></tr></thead><tbody>
            {agencies.map((a: any) => <tr key={a.id} className="clickable" onClick={() => nav(`/platform/agencies/${a.id}`)}><td className="bold">{a.name}{a.comped && <span className="tiny muted"> · comped</span>}</td><td className="money">{a.seats_now}</td><td className="money">{a.seat_days_mtd}</td><td className="money">{money(a.estimate_cents)}</td></tr>)}
          </tbody></table></div>
        </Card>
      </div>}
      <DataTable<any> title="Seats" endpoint="/api/v1/platform/seats" exportName="platform-seats"
        filters={[{ key: 'status', label: 'Status', options: opts(['active', 'ended']) }, { key: 'organization_id', label: 'Agency', options: agencies.map((a: any) => ({ value: a.id, label: a.name })) }]}
        columns={[
          { key: 'worker_name', label: 'Worker', mobile: 'title' }, { key: 'org_name', label: 'Agency', sortable: true, mobile: 'subtitle' }, { key: 'company_name', label: 'Client' },
          { key: 'started_at', label: 'Started', sortable: true, render: r => date(r.started_at) }, { key: 'ended_at', label: 'Ended', sortable: true, render: r => r.ended_at ? date(r.ended_at) : <StatusPill status="active" /> },
          { key: 'days_active', label: 'Seat-days', align: 'right' },
        ]} />
    </div>
  );
}

export function PlansPage() {
  const st = useApi<any[]>('/api/v1/platform/plans');
  const [edit, setEdit] = useState<any>(null);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  return (
    <div className="stack">
      <PageHeader title="Plans & pricing" sub="Price changes apply to the next invoice generated; issued invoices never change." />
      {!st.data ? <Card><LoadingBlock /></Card> : <div className="grid-3">
        {st.data.map(p => (
          <div key={p.key} className="st-plan">
            <div className="row" style={{ justifyContent: 'space-between' }}><b>{p.name}</b><StatusPill status={p.active ? 'active' : 'disabled'} label={p.active ? 'Available' : 'Hidden'} /></div>
            <div><span className="price">{money(p.price_per_seat_cents)}</span><span className="small muted"> / seat / month</span></div>
            {p.features?.addon_monthly_cents > 0 && <div className="small">+ {money(p.features.addon_monthly_cents)} / month add-on</div>}
            <div className="small muted" style={{ flex: 1 }}>{p.description ?? '—'}</div>
            <div className="small">{p.trial_days ? `${p.trial_days}-day trial · ` : ''}{p.subscribers} agenc{p.subscribers === 1 ? 'y' : 'ies'} · key <span className="mono">{p.key}</span></div>
            <Button icon={<Pencil size={15} />} onClick={() => setEdit(p)}>Edit plan</Button>
          </div>
        ))}
      </div>}
      <FormDrawer open={!!edit} onClose={() => setEdit(null)} title={edit ? `Edit ${edit.name}` : ''} submitLabel="Save plan" initial={edit ? { name: edit.name, price_per_seat_cents: edit.price_per_seat_cents, trial_days: edit.trial_days, addon_monthly_cents: edit.features?.addon_monthly_cents ?? 0, description: edit.description ?? '', active: edit.active } : {}}
        fields={[{ name: 'name', label: 'Name', required: true }, { name: 'price_per_seat_cents', label: 'Price per seat / month', type: 'money', required: true }, { name: 'addon_monthly_cents', label: 'Monthly add-on', type: 'money' }, { name: 'trial_days', label: 'Trial days', type: 'number' }, { name: 'description', label: 'Description', type: 'textarea', full: true }, { name: 'active', label: 'Available', type: 'checkbox', placeholder: 'Agencies can choose this plan' }]}
        onSubmit={async v => { await api.patch(`/api/v1/platform/plans/${edit.key}`, { name: v.name, price_per_seat_cents: v.price_per_seat_cents ?? 0, addon_monthly_cents: v.addon_monthly_cents ?? 0, trial_days: Number(v.trial_days ?? 0), description: v.description || null, active: !!v.active }); toast.success('Plan saved (audited)'); st.reload(); }} />
    </div>
  );
}
