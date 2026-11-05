import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Calculator, Check, Plus, Wallet, X, Pencil, Trash2, Ban } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { money, humanize } from '../../lib/format';
import { toast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import { Boundary, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, LoadingBlock, Menu, MoneyInput, PageHeader, PermissionDenied, Person, StatusPill, Tabs, useConfirm } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { FormDrawer, type FieldDef } from '../../components/FormDrawer';
import { ChartCard, TrackBars, fmtMoneyCompact } from '../../components/charts';
import { Money, period, monthISO } from './shared';
import './payroll.css';

export default function Commissions() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as 'entitlements' | 'rules') ?? 'entitlements';
  if (!can('commissions', 'view')) return <PermissionDenied />;
  return (
    <div>
      <PageHeader title="Commissions" sub="Calculated from billed revenue minus worker cost of the same approved days." />
      <Tabs tabs={[{ key: 'entitlements', label: 'Entitlements' }, { key: 'rules', label: 'Rules' }]} value={tab} onChange={k => setSp(new URLSearchParams(k === 'rules' ? { tab: 'rules' } : {}), { replace: true })} />
      <div className="mt-3">{tab === 'rules' ? <Rules /> : <Entitlements />}</div>
    </div>
  );
}

function Entitlements() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const confirm = useConfirm();
  const [key, setKey] = useState(0);
  const [computeOpen, setComputeOpen] = useState(false);
  const [approve, setApprove] = useState<any>(null);
  const filterQs = new URLSearchParams(['status', 'month', 'user_id', 'search'].flatMap(k => (sp.get(k) ? [[k, sp.get(k)!]] : []))).toString();
  const totals = useApi<any>(`/api/v1/commissions?pageSize=1${filterQs ? '&' + filterQs : ''}`, [key]);
  const summary = useApi<any>('/api/v1/commissions/summary', [key]);
  const reload = () => setKey(k => k + 1);
  const t = totals.data?.totals;
  const cols: Column<any>[] = [
    { key: 'user_name', label: 'Person', sortable: true, mobile: 'title', render: r => <Person name={r.user_name} sub={humanize(r.applies_to)} size={30} /> },
    { key: 'rule_name', label: 'Rule', render: r => <span className="small">{r.rule_name}</span> },
    { key: 'worker_name', label: 'Placement', mobile: 'subtitle', render: r => <div><div>{r.worker_name ?? '—'}</div><div className="small muted">{[r.title, r.company_name].filter(Boolean).join(' · ')}</div></div> },
    { key: 'period_start', label: 'Period', sortable: true, render: r => period(r.period_start, r.period_end) },
    { key: 'revenue_cents', label: 'Revenue', align: 'right', render: r => <Money cents={r.revenue_cents} /> },
    { key: 'cost_cents', label: 'Cost', align: 'right', render: r => <Money cents={r.cost_cents} /> },
    { key: 'gp_cents', label: 'Gross profit', sortable: true, align: 'right', render: r => <Money cents={r.gp_cents} /> },
    { key: 'calculated_cents', label: 'Calculated', sortable: true, align: 'right', render: r => <Money cents={r.calculated_cents} strong /> },
    { key: 'approved_cents', label: 'Approved', align: 'right', render: r => r.approved_cents === null ? <span className="muted">—</span> : <Money cents={r.approved_cents} /> },
    { key: 'settled_cents', label: 'Settled', align: 'right', render: r => (r.settled_cents ? <Money cents={r.settled_cents} /> : <span className="muted">—</span>) },
    { key: 'status', label: 'Status', sortable: true, render: r => <span><StatusPill status={r.status} />{r.payout_item_id && r.status === 'approved' && <div className="small muted">In payout</div>}</span> },
  ];
  const settle = async (ids: string[], method: 'payout' | 'manual') => {
    const r = await confirm({ title: method === 'payout' ? 'Pay out via Wise?' : 'Mark as settled?', body: method === 'payout' ? `${ids.length} approved entitlement(s) will be paid in a separate commission payout batch.` : `${ids.length} approved entitlement(s) will be marked settled (e.g. paid through staff payroll).`, reason: method === 'manual' ? { label: 'How was it paid?', required: true } : undefined, confirmLabel: method === 'payout' ? 'Create payout' : 'Mark settled' });
    if (!r.ok) return;
    try { const x = await api.post('/api/v1/commissions/settle', { ids, method, reason: r.reason || undefined }); toast.success(method === 'payout' ? (x.duplicate ? 'Payout already exists' : 'Commission payout submitted') : `${x.settled} entitlement(s) settled`); reload(); } catch (e) { toast.error(e); }
  };
  return (
    <>
      <div className="row mb-2" style={{ justifyContent: 'flex-end' }}>
        {can('commissions', 'create') && <Button variant="primary" icon={<Calculator size={16} />} onClick={() => setComputeOpen(true)}>Compute commissions</Button>}
      </div>
      <Boundary label="Commission totals">
        {totals.error && !t ? <ErrorState error={totals.error} retry={totals.reload} /> : <div className="pr-strip">
          <div><div className="lbl">Calculated</div><div className="val">{t ? money(t.calculated) : '—'}</div><div className="sub">{t ? `${t.n} entitlements` : ''}</div></div>
          <div><div className="lbl">Approved</div><div className="val">{t ? money(t.approved) : '—'}</div><div className="sub">{t ? `${money(t.awaiting_approval)} awaiting approval` : ''}</div></div>
          <div><div className="lbl">Settled</div><div className="val">{t ? money(t.settled) : '—'}</div><div className="sub">{t ? `${money(t.awaiting_settlement)} approved, not yet paid` : ''}</div></div>
        </div>}
      </Boundary>
      {(summary.data?.by_user?.length ?? 0) > 0 && <Boundary label="Commission chart">
        <div className="mb-3"><ChartCard title="Calculated commission by person">
          <TrackBars data={summary.data.by_user.slice(0, 10).map((u: any) => ({ label: u.name, value: Number(u.calculated_cents) }))} fmt={fmtMoneyCompact} valueName="Calculated" height={240} />
        </ChartCard></div>
      </Boundary>}
      {summary.error && <ErrorState error={summary.error} retry={summary.reload} />}
      <DataTable title="Entitlements" endpoint="/api/v1/commissions" columns={cols} reloadKey={key} exportName="commissions" exportResource="commissions"
        filters={[{ key: 'status', label: 'Status', options: opts(['calculated', 'approved', 'settled', 'rejected']) }, { key: 'month', label: 'Month', options: lastMonths(12) }, { key: 'user_id', label: 'Person', type: 'member' }]}
        rowActions={(r) => [
          { label: 'Approve', icon: <Check size={15} />, hidden: r.status !== 'calculated' || !can('commissions', 'approve'), onClick: () => setApprove(r) },
          { label: 'Reject', icon: <X size={15} />, danger: true, hidden: !['calculated', 'approved'].includes(r.status) || !!r.payout_item_id || !can('commissions', 'approve'), onClick: async () => { const c = await confirm({ title: 'Reject entitlement?', danger: true, reason: { label: 'Reason', required: true }, confirmLabel: 'Reject' }); if (!c.ok) return; try { await api.post(`/api/v1/commissions/${r.id}/reject`, { reason: c.reason }); toast.success('Rejected'); reload(); } catch (e) { toast.error(e); } } },
          { label: 'Pay out via Wise', icon: <Wallet size={15} />, hidden: r.status !== 'approved' || !!r.payout_item_id || !can('commissions', 'approve'), onClick: () => settle([r.id], 'payout') },
          { label: 'Mark settled', icon: <Check size={15} />, hidden: r.status !== 'approved' || !!r.payout_item_id || !can('commissions', 'approve'), onClick: () => settle([r.id], 'manual') },
        ]}
        bulkActions={can('commissions', 'approve') ? [
          { label: 'Approve', icon: <Check size={14} />, onClick: async (ids) => { try { const x = await api.post('/api/v1/commissions/approve', { ids }); toast.success(`${x.approved} approved`); reload(); } catch (e) { toast.error(e); } } },
          { label: 'Pay out via Wise', icon: <Wallet size={14} />, onClick: ids => settle(ids, 'payout') },
          { label: 'Mark settled', onClick: ids => settle(ids, 'manual') },
        ] : undefined}
        emptyTitle="No commission entitlements" emptyText="Compute commissions for a month once its invoices are generated." />
      {computeOpen && <ComputeDialog onClose={() => setComputeOpen(false)} onDone={reload} />}
      {approve && <ApproveDialog row={approve} onClose={() => setApprove(null)} onDone={reload} />}
    </>
  );
}

function lastMonths(n: number) {
  const out: { value: string; label: string }[] = []; const d = new Date(); d.setDate(1);
  for (let i = 0; i < n; i++) { out.push({ value: monthISO(d), label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) }); d.setMonth(d.getMonth() - 1); }
  return out;
}

function ComputeDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const prev = new Date(); prev.setDate(1); prev.setMonth(prev.getMonth() - 1);
  const [month, setMonth] = useState(monthISO(prev));
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { const r = await api.post('/api/v1/commissions/compute', { month }); toast.success(`${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged across ${r.placements} placements`); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Compute commissions" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={run}>Compute</Button></>}>
      <Field label="Month" htmlFor="cm-month" hint="Uses billed approved days in the month. Approved or settled entitlements are never changed.">
        <select id="cm-month" className="select" value={month} onChange={e => setMonth(e.target.value)}>{lastMonths(12).map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
      </Field>
    </Dialog>
  );
}

function ApproveDialog({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const [amt, setAmt] = useState<number | null>(Number(row.calculated_cents));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = amt !== Number(row.calculated_cents);
  const go = async () => {
    if (amt === null) { toast.error('Enter an amount'); return; }
    if (changed && !note.trim()) { toast.error('Explain why the approved amount differs'); return; }
    setBusy(true);
    try { await api.post(`/api/v1/commissions/${row.id}/approve`, { approved_cents: amt, note: note || null }); toast.success('Commission approved'); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={`Approve commission — ${row.user_name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={go}>Approve</Button></>}>
      <div className="small muted mb-2">{row.rule_name} · {row.worker_name} · {period(row.period_start, row.period_end)} · GP {money(row.gp_cents)}</div>
      <Field label="Approved amount" htmlFor="ap-amt" hint={`Calculated: ${money(row.calculated_cents)}`}><MoneyInput id="ap-amt" cents={amt} onChange={setAmt} /></Field>
      <Field label={changed ? 'Reason for adjustment *' : 'Note (optional)'} htmlFor="ap-note"><textarea id="ap-note" className="textarea" value={note} onChange={e => setNote(e.target.value)} /></Field>
    </Dialog>
  );
}

function TiersEditor({ value, onChange }: { value: { upToCents: number | null; pctBp: number }[]; onChange: (v: any[]) => void }) {
  const rows = value?.length ? value : [{ upToCents: null, pctBp: 1000 }];
  const set = (i: number, patch: any) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div>
      {rows.map((t, i) => <div key={i} className="pr-tier">
        <MoneyInput cents={t.upToCents} onChange={c => set(i, { upToCents: c })} placeholder={i === rows.length - 1 ? 'No cap' : 'Up to GP'} />
        <div className="search-input"><input className="input" aria-label="Tier percent" inputMode="decimal" value={t.pctBp / 100} onChange={e => set(i, { pctBp: Math.round(Number(e.target.value || 0) * 100) })} /><span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }}>%</span></div>
        <button type="button" className="icon-btn" aria-label="Remove tier" disabled={rows.length === 1} onClick={() => onChange(rows.filter((_, k) => k !== i))}><X size={14} /></button>
      </div>)}
      <Button size="xs" icon={<Plus size={13} />} onClick={() => onChange([...rows, { upToCents: null, pctBp: 1000 }])}>Add tier</Button>
      <div className="small muted mt-1">Marginal tiers on gross profit; leave the last “up to” empty for no cap.</div>
    </div>
  );
}

function Rules() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const st = useApi<any>('/api/v1/commissions/rules');
  const [edit, setEdit] = useState<any>(null);
  const fields: FieldDef[] = [
    { name: 'name', label: 'Name', required: true, full: true },
    { name: 'applies_to', label: 'Paid to', type: 'select', required: true, options: opts(['recruiter', 'sales', 'account_manager']) },
    { name: 'kind', label: 'Type', type: 'select', required: true, options: [{ value: 'pct_gp', label: '% of gross profit' }, { value: 'fixed', label: 'Fixed per placement' }, { value: 'tiered', label: 'Tiered % of gross profit' }] },
    { name: 'pct', label: 'Percent of GP', type: 'number', required: true, placeholder: 'e.g. 10', hidden: v => v.kind !== 'pct_gp' },
    { name: 'fixed_cents', label: 'Amount per new placement', type: 'money', required: true, hidden: v => v.kind !== 'fixed', hint: 'Paid in the placement’s first month.' },
    { name: 'tiers', label: 'Tiers', type: 'custom', full: true, hidden: v => v.kind !== 'tiered', render: (v, set) => <TiersEditor value={v} onChange={set} /> },
    { name: 'months_limit', label: 'Time limit (months)', type: 'number', placeholder: 'No limit', hint: 'e.g. 6 = only the first 6 months of a placement' },
    { name: 'user_id', label: 'Only for this person', type: 'member', placeholder: 'Everyone in the role' },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'active', label: 'Active', type: 'checkbox', placeholder: 'Rule is active' },
  ];
  const submit = async (v: Record<string, any>) => {
    const body = { name: v.name, description: v.description || null, applies_to: v.applies_to, kind: v.kind, pct_bp: v.kind === 'pct_gp' ? Math.round(Number(v.pct) * 100) : null, fixed_cents: v.kind === 'fixed' ? v.fixed_cents : null, tiers: v.kind === 'tiered' ? (v.tiers?.length ? v.tiers : [{ upToCents: null, pctBp: 1000 }]) : null, months_limit: v.months_limit || null, user_id: v.user_id || null, active: !!v.active };
    try {
      if (edit?.id) await api.patch(`/api/v1/commissions/rules/${edit.id}`, body); else await api.post('/api/v1/commissions/rules', body);
      toast.success('Rule saved'); st.reload();
    } catch (e) { if (e instanceof ApiError && e.fields?.pct_bp) e.fields.pct = e.fields.pct_bp; throw e; }
  };
  const describe = (r: any) => r.kind === 'pct_gp' ? `${(r.pct_bp / 100).toFixed(2).replace(/\.00$/, '')}% of gross profit` : r.kind === 'fixed' ? `${money(r.fixed_cents)} per new placement` : `Tiered: ${(r.tiers ?? []).map((t: any) => `${t.pctBp / 100}%${t.upToCents ? ' up to ' + money(t.upToCents, 'USD', { noCents: true }) : ' above'}`).join(', ')}`;
  return (
    <Card>
      <CardHeader title="Commission rules" right={can('commissions', 'create') && <Button variant="primary" size="sm" icon={<Plus size={15} />} onClick={() => setEdit({ kind: 'pct_gp', applies_to: 'recruiter', active: true })}>Add rule</Button>} />
      {st.error && !st.data ? <ErrorState error={st.error} retry={st.reload} /> : !st.data ? <LoadingBlock /> : st.data.rows.length === 0 ? <EmptyState title="No commission rules" text="Add a rule to start computing commissions." /> :
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Rule</th><th>Paid to</th><th>Calculation</th><th>Time limit</th><th style={{ textAlign: 'right' }}>Calculated to date</th><th>Status</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{st.data.rows.map((r: any) => <tr key={r.id}>
            <td><b>{r.name}</b>{r.description && <div className="small muted">{r.description}</div>}</td>
            <td>{humanize(r.applies_to)}{r.user_name && <div className="small muted">{r.user_name} only</div>}</td>
            <td>{describe(r)}</td>
            <td>{r.months_limit ? `First ${r.months_limit} months` : 'None'}</td>
            <td className="money"><Money cents={r.calculated_cents} /><div className="small muted">{r.entitlements} entitlements</div></td>
            <td><StatusPill status={r.active ? 'active' : 'disabled'} label={r.active ? 'Active' : 'Inactive'} /></td>
            <td className="act">{can('commissions', 'edit') && <MenuFor r={r} onEdit={() => setEdit({ ...r, pct: r.pct_bp ? r.pct_bp / 100 : null })} onDelete={async () => {
              const c = await confirm({ title: r.entitlements ? 'Deactivate rule?' : 'Delete rule?', body: r.entitlements ? 'This rule has entitlements, so it will be deactivated (history is kept).' : 'The rule will be deleted.', danger: true, confirmLabel: r.entitlements ? 'Deactivate' : 'Delete' });
              if (!c.ok) return; try { const x = await api.del(`/api/v1/commissions/rules/${r.id}`); toast.success(x.deactivated ? 'Rule deactivated' : 'Rule deleted'); st.reload(); } catch (e) { toast.error(e); }
            }} />}</td>
          </tr>)}</tbody>
        </table></div>}
      <FormDrawer open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit commission rule' : 'New commission rule'} fields={fields} initial={edit ?? {}} onSubmit={submit} />
    </Card>
  );
}

function MenuFor({ r, onEdit, onDelete }: { r: any; onEdit: () => void; onDelete: () => void }) {
  return <Menu items={[{ label: 'Edit', icon: <Pencil size={15} />, onClick: onEdit }, { label: r.entitlements ? 'Deactivate' : 'Delete', icon: r.entitlements ? <Ban size={15} /> : <Trash2 size={15} />, danger: true, hidden: !r.active && !!r.entitlements, onClick: onDelete }]} />;
}
