import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FilePlus2, Pencil } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { date, money } from '../../lib/format';
import { Button, Card, CardHeader, Dialog, ErrorState, Field, LoadingBlock, PageHeader, StatusPill, useConfirm, Drawer, KV } from '../../components/ui';
import { DataTable, opts } from '../../components/DataTable';
import { ChartCard, TrackBars } from '../../components/charts';
import { FormDrawer } from '../../components/FormDrawer';

export function InvoicesPage() {
  const [rk, setRk] = useState(0);
  const [gen, setGen] = useState(false);
  const [month, setMonth] = useState(() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); });
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const confirm = useConfirm();
  const agencies = useApi<any>('/api/v1/platform/agencies?pageSize=200');
  const act = async (i: any, action: string, reload: () => void) => {
    let body: any = {};
    if (action === 'mark-paid' || action === 'void') { const r = await confirm({ title: action === 'void' ? `Void ${i.number}?` : `Mark ${i.number} paid?`, danger: action === 'void', reason: { label: 'Reason (audited)', required: true } }); if (!r.ok) return; body = { reason: r.reason }; }
    try { const r = await api.post(`/api/v1/platform/invoices/${i.id}/${action}`, body); if (r.message) (r.ok ? toast.success : toast.error)(r.message); else toast.success('Invoice updated'); reload(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="stack">
      <PageHeader title="Subscriptions & SaaS invoices" sub="Monthly invoices to agencies: seat-days × plan price + add-ons − discounts/comps + tax. Payments are simulated."
        actions={<Button variant="primary" icon={<FilePlus2 size={16} />} onClick={() => setGen(true)}>Generate monthly invoices</Button>} />
      <DataTable<any> title="Invoices" endpoint="/api/v1/platform/invoices" reloadKey={rk} exportName="saas-invoices" onRowClick={r => setView(r.id)}
        filters={[{ key: 'status', label: 'Status', options: opts(['open', 'paid', 'failed', 'comped', 'void']) }, { key: 'organization_id', label: 'Agency', options: (agencies.data?.rows ?? []).map((a: any) => ({ value: a.id, label: a.name })) }]}
        columns={[
          { key: 'number', label: 'Invoice', mobile: 'title', render: r => <span className="bold">{r.number}</span> },
          { key: 'org_name', label: 'Agency', sortable: true, mobile: 'subtitle' },
          { key: 'period_start', label: 'Month', sortable: true, render: r => date(r.period_start, { month: 'short', year: 'numeric' }) },
          { key: 'seat_days', label: 'Seat-days', align: 'right' },
          { key: 'avg_seats', label: 'Avg seats', align: 'right', render: r => Number(r.avg_seats).toFixed(1) },
          { key: 'subtotal_cents', label: 'Subtotal', align: 'right', render: r => money(r.subtotal_cents), csv: r => r.subtotal_cents / 100 },
          { key: 'discount_cents', label: 'Discount', align: 'right', render: r => r.discount_cents ? `−${money(r.discount_cents)}` : '—', csv: r => r.discount_cents / 100 },
          { key: 'total_cents', label: 'Total', align: 'right', sortable: true, render: r => <b>{money(r.total_cents)}</b>, csv: r => r.total_cents / 100 },
          { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
        ]}
        rowActions={(r, reload) => ['open', 'failed'].includes(r.status) ? [
          { label: 'Charge card on file', onClick: () => act(r, 'charge', reload) }, { label: 'Simulate failed payment', onClick: () => act(r, 'simulate-failure', reload) },
          { label: 'Mark as paid', onClick: () => act(r, 'mark-paid', reload) }, { label: 'Void', danger: true, onClick: () => act(r, 'void', reload) },
        ] : [{ label: 'View details', onClick: () => setView(r.id) }]} />
      <Dialog open={gen} onClose={() => setGen(false)} title="Generate monthly invoices" footer={<><Button onClick={() => setGen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { const r = await api.post('/api/v1/platform/invoices/generate-all', { month }); toast.success(`${r.created} new invoice${r.created === 1 ? '' : 's'} for ${r.month} (${r.agencies - r.created} already existed)`); setRk(k => k + 1); setGen(false); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Generate</Button></>}>
        <p className="small muted">Creates one invoice per agency for a completed month. Safe to run again — existing invoices are never duplicated.</p>
        <Field label="Month" htmlFor="ga-m"><input id="ga-m" type="month" className="input" value={month} onChange={e => setMonth(e.target.value)} /></Field>
      </Dialog>
      <InvoiceView id={view} onClose={() => setView(null)} />
    </div>
  );
}

function InvoiceView({ id, onClose }: { id: string | null; onClose: () => void }) {
  const st = useApi<any>(id ? `/api/v1/platform/invoices/${id}` : null, [id]);
  const i = st.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={i?.number ?? 'Invoice'}>
      {!i ? <LoadingBlock /> : <div className="stack" style={{ gap: 14 }}>
        <KV items={[['Agency', i.org_name], ['Period', `${date(i.period_start)} – ${date(i.period_end)}`], ['Status', <StatusPill key="s" status={i.status} />], ['Attempts', i.attempts], ['Failure', i.failure_reason ?? '—'], ['Paid', i.paid_at ? date(i.paid_at) : '—']]} />
        <table className="table"><tbody>{(i.lines?.length ? i.lines : [{ label: `Seats — ${i.seat_days} seat-days`, amount_cents: i.subtotal_cents }]).map((l: any, k: number) => <tr key={k}><td>{l.label}</td><td className="money">{money(l.amount_cents)}</td></tr>)}<tr><td className="bold">Total</td><td className="money bold">{money(i.total_cents)}</td></tr></tbody></table>
      </div>}
    </Drawer>
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
