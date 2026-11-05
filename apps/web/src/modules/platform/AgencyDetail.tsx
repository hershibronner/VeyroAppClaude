import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Armchair, Ban, CreditCard, FilePlus2, PlayCircle, ShieldAlert, Users, Wallet, Zap, AlertTriangle, Pencil } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { date, dateTime, hours, money, relTime, humanize } from '../../lib/format';
import { Banner, Button, Card, CardHeader, Dialog, ErrorState, Field, KpiRow, KV, LoadingBlock, Menu, PageHeader, StatusPill, useConfirm, EmptyState } from '../../components/ui';
import { ChartCard, TrackBars } from '../../components/charts';
import { FormDrawer } from '../../components/FormDrawer';
import { Toggle } from '../settings/common';

export default function AgencyDetail() {
  const { id } = useParams();
  const st = useApi<any>(`/api/v1/platform/agencies/${id}`, [id]);
  const confirm = useConfirm();
  const [editSub, setEditSub] = useState(false);
  const [gen, setGen] = useState(false);
  const [imp, setImp] = useState<any>(null);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <div className="stack"><PageHeader title="Agency" back="/platform/agencies" /><Card><LoadingBlock rows={10} /></Card></div>;
  const d = st.data; const s = d.subscription; const o = d.org;
  const status = async (action: string, title: string, body: string, danger = false) => {
    const r = await confirm({ title, body, danger, confirmLabel: title.replace('?', ''), reason: { label: 'Reason (audited)', required: true } });
    if (!r.ok) return;
    try { await api.post(`/api/v1/platform/agencies/${o.id}/status`, { action, reason: r.reason }); toast.success('Subscription updated'); st.reload(); } catch (e) { toast.error(e); }
  };
  const invAct = async (inv: any, action: string) => {
    let body: any = {};
    if (action === 'mark-paid' || action === 'void') { const r = await confirm({ title: action === 'void' ? `Void ${inv.number}?` : `Mark ${inv.number} as paid?`, danger: action === 'void', reason: { label: 'Reason (audited)', required: true } }); if (!r.ok) return; body = { reason: r.reason }; }
    try { const r = await api.post(`/api/v1/platform/invoices/${inv.id}/${action}`, body); if (r.message) (r.ok ? toast.success : toast.error)(r.message); else toast.success('Invoice updated'); st.reload(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="stack">
      <PageHeader back="/platform/agencies" title={<span className="row" style={{ gap: 10 }}>{o.name} <StatusPill status={s?.status} />{s?.comped && <StatusPill status="comped" label="Comped" tone="purple" />}</span>} sub={`${o.slug} · ${s?.plan_name ?? 'No plan'} · created ${date(o.created_at)}`}
        actions={<><Button icon={<Pencil size={16} />} onClick={() => setEditSub(true)}>Edit subscription</Button><Button variant="primary" icon={<FilePlus2 size={16} />} onClick={() => setGen(true)}>Generate invoice</Button>
          <Menu items={[
            { label: 'Start grace period (simulate failed payment)', icon: <AlertTriangle size={15} />, hidden: ['grace', 'suspended'].includes(s?.status), onClick: () => status('start_grace', 'Start grace period?', 'Owners are emailed and get 7 days to update their card before the workspace becomes read-only.') },
            { label: 'End grace now (simulate 7 days later)', icon: <Zap size={15} />, hidden: s?.status !== 'grace', onClick: () => status('end_grace_now', 'End grace period now?', 'The workspace is suspended immediately (read-only until paid).', true) },
            { label: 'Suspend agency', icon: <Ban size={15} />, danger: true, hidden: s?.status === 'suspended', onClick: () => status('suspend', 'Suspend agency?', 'All users keep read access but cannot change anything until reactivated.', true) },
            { label: 'Reactivate agency', icon: <PlayCircle size={15} />, hidden: !['suspended', 'grace', 'past_due'].includes(s?.status), onClick: () => status('reactivate', 'Reactivate agency?', 'Restores full access. Failed invoices stay failed until paid or voided.') },
          ]} /></>} />
      {s?.status === 'suspended' && <Banner tone="danger">Suspended {relTime(s.suspended_at)} — the workspace is read-only. Paying or voiding the failed invoice (or reactivating) restores access.</Banner>}
      {s?.status === 'grace' && <Banner tone="warn">In grace period until {dateTime(s.grace_ends_at)}.</Banner>}
      <KpiRow items={[
        { label: 'Active seats', value: d.seats_now, icon: <Armchair size={16} />, deltaText: `${d.estimate.seat_days} seat-days this month`, suffix: '', to: `/platform/seats?organization_id=${o.id}&status=active` },
        { label: 'MRR (billable)', value: money(d.mrr.net), icon: <Wallet size={16} />, deltaText: `${money(d.mrr.gross)} gross`, suffix: '' },
        { label: 'This month so far', value: money(d.estimate.total_cents), icon: <CreditCard size={16} />, deltaText: d.estimate.comped ? 'comped' : d.estimate.trial ? 'trial' : `to ${date(d.estimate.metered_to)}`, suffix: '' },
        { label: 'Staff users', value: d.usage?.staff ?? 0, icon: <Users size={16} />, deltaText: `${d.usage?.client_users ?? 0} client users (free)`, suffix: '' },
      ]} />
      <div className="grid-2">
        <ChartCard title="Average seats per month"><TrackBars data={d.seat_history.map((h: any) => ({ label: h.label, value: h.avg_seats }))} fmt={v => `${v} seats`} height={220} /></ChartCard>
        <Card>
          <CardHeader title="Subscription & usage" />
          <div className="card-b"><KV items={[
            ['Plan', s ? `${s.plan_name} · ${money(s.price_per_seat_cents)}/seat${s.features?.addon_monthly_cents ? ` + ${money(s.features.addon_monthly_cents)} add-on` : ''}` : '—'],
            ['Discount / tax', s ? `${s.discount_pct}% · ${(s.tax_bp / 100).toFixed(2)}% tax` : '—'],
            ['Trial ends', s?.trial_ends_at ? date(s.trial_ends_at) : '—'],
            ['Card on file', s?.card_last4 ? `${s.card_brand ?? 'Card'} •••• ${s.card_last4}${s.card_fails ? ' (test decline card)' : ''}` : 'None'],
            ['Billing email', s?.billing_email ?? '—'],
            ['Workers / active placements', `${d.usage?.workers ?? 0} / ${d.usage?.active_placements ?? 0}`],
            ['Clients / candidates', `${d.usage?.clients ?? 0} / ${d.usage?.candidates ?? 0}`],
            ['Approved hours (30 days)', hours(d.usage?.approved_minutes_30d ?? 0, 0)],
            ['Branding', d.branding ? `${d.branding.custom_domain ?? 'No custom domain'}${d.branding.domain_verified ? ' (verified)' : ''}${d.branding.hide_powered_by ? ' · white-labelled' : ''}` : '—'],
            ['Notes', s?.notes ?? '—'],
          ]} /></div>
        </Card>
      </div>
      <Card>
        <CardHeader title="SaaS invoices" sub="Seat-days × $29/seat/month + add-ons − discounts + tax" />
        {d.invoices.length === 0 ? <EmptyState title="No invoices yet" text="Generate the first one after a month ends." /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Invoice</th><th>Period</th><th style={{ textAlign: 'right' }}>Seat-days</th><th style={{ textAlign: 'right' }}>Subtotal</th><th style={{ textAlign: 'right' }}>Discount</th><th style={{ textAlign: 'right' }}>Tax</th><th style={{ textAlign: 'right' }}>Total</th><th>Status</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead><tbody>
            {d.invoices.map((i: any) => <tr key={i.id}><td className="bold">{i.number}{i.failure_reason && <div className="tiny" style={{ color: 'var(--danger)' }}>{i.failure_reason}</div>}</td><td>{date(i.period_start, { month: 'short', year: 'numeric' })}</td><td className="money">{i.seat_days}</td><td className="money">{money(i.subtotal_cents)}</td><td className="money">{i.discount_cents ? `−${money(i.discount_cents)}` : '—'}</td><td className="money">{money(i.tax_cents)}</td><td className="money bold">{money(i.total_cents)}</td><td><StatusPill status={i.status} /></td>
              <td className="act"><Menu items={[
                { label: 'Charge card on file', onClick: () => invAct(i, 'charge'), hidden: !['open', 'failed'].includes(i.status) },
                { label: 'Simulate failed payment', onClick: () => invAct(i, 'simulate-failure'), hidden: !['open', 'failed'].includes(i.status) },
                { label: 'Mark as paid', onClick: () => invAct(i, 'mark-paid'), hidden: !['open', 'failed'].includes(i.status) },
                { label: 'Void invoice', danger: true, onClick: () => invAct(i, 'void'), hidden: !['open', 'failed'].includes(i.status) },
              ]} /></td></tr>)}
          </tbody></table></div>
        )}
      </Card>
      <div className="grid-2">
        <Card>
          <CardHeader title="Feature flags" sub="Changes are audited in the agency's log" />
          <div className="card-b">{d.flags.map((f: any) => <Toggle key={f.key} id={`ff-${f.key}`} checked={f.enabled} label={humanize(f.key)} hint={`updated ${relTime(f.updated_at)}`} onChange={async v => { try { await api.put(`/api/v1/platform/agencies/${o.id}/flags/${f.key}`, { enabled: v }); toast.success(`${humanize(f.key)} ${v ? 'enabled' : 'disabled'}`); st.reload(); } catch (e) { toast.error(e); } }} />)}</div>
        </Card>
        <Card>
          <CardHeader title="Integrations" right={<Link to="/platform/providers" className="small">Provider health</Link>} />
          <div className="table-wrap"><table className="table"><tbody>{d.integrations.map((i: any) => <tr key={i.key}><td><div className="bold small">{i.provider}</div><div className="tiny muted">{i.category}{i.last_error ? ` · ${i.last_error}` : ''}</div></td><td><StatusPill status={i.status} /></td><td className="small muted">{i.last_sync_at ? relTime(i.last_sync_at) : '—'}</td></tr>)}</tbody></table></div>
        </Card>
      </div>
      <Card>
        <CardHeader title="Users" sub="Start a support session to see exactly what a user sees. Requires a reason; everything is audited." />
        <div className="table-wrap"><table className="table"><thead><tr><th>User</th><th>Role</th><th>Last sign-in</th><th className="act"><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {d.members.map((m: any) => <tr key={m.id}><td><div className="bold">{m.name}</div><div className="small muted">{m.email}</div></td><td>{m.role_name} <span className="tiny muted">({m.role_kind})</span></td><td>{m.last_login_at ? relTime(m.last_login_at) : 'Never'}</td><td className="act"><Button size="xs" icon={<ShieldAlert size={13} />} onClick={() => setImp(m)}>Impersonate</Button></td></tr>)}
        </tbody></table></div>
      </Card>
      <div className="grid-2">
        <Card><CardHeader title="Support tickets" right={<Link to={`/platform/tickets?organization_id=${o.id}`} className="small">All tickets</Link>} />{d.tickets.length === 0 ? <EmptyState title="No tickets" /> : <div className="card-b" style={{ paddingTop: 4 }}>{d.tickets.map((t: any) => <Link key={t.id} to={`/platform/tickets?ticket=${t.id}`} className="checklist-item" style={{ textDecoration: 'none', color: 'inherit' }}><div style={{ flex: 1 }}><div className="small bold">{t.subject}</div><div className="tiny muted">{relTime(t.created_at)}</div></div><StatusPill status={t.priority} /><StatusPill status={t.status} /></Link>)}</div>}</Card>
        <Card><CardHeader title="Recent audit events" right={<Link to={`/platform/security?organization_id=${o.id}`} className="small">Full log</Link>} />{d.activity.length === 0 ? <EmptyState title="No events" /> : <div className="card-b" style={{ paddingTop: 4 }}>{d.activity.map((a: any) => <div key={a.id} className="checklist-item"><div style={{ flex: 1, minWidth: 0 }}><div className="small"><b>{a.actor_label ?? 'System'}</b> <span className="mono">{a.action}</span> {a.entity_label ?? ''}</div><div className="tiny muted">{dateTime(a.created_at)}{a.impersonated ? ' · support mode' : ''}</div></div></div>)}</div>}</Card>
      </div>
      <FormDrawer open={editSub} onClose={() => setEditSub(false)} title={`Subscription — ${o.name}`} submitLabel="Save subscription"
        initial={{ plan_key: s?.plan_key, comped: s?.comped, discount_pct: s?.discount_pct, tax_pct: (s?.tax_bp ?? 0) / 100, trial_ends_at: s?.trial_ends_at ? String(s.trial_ends_at).slice(0, 10) : '', notes: s?.notes ?? '' }}
        fields={[{ name: 'plan_key', label: 'Plan', type: 'select', required: true, options: [{ value: 'trial', label: 'Trial' }, { value: 'standard', label: 'Standard' }, { value: 'white_label', label: 'White Label' }] },
          { name: 'comped', label: 'Comped', type: 'checkbox', placeholder: 'Comp this agency (seats still metered, $0 invoices)' }, { name: 'discount_pct', label: 'Discount %', type: 'number' }, { name: 'tax_pct', label: 'Tax %', type: 'number' },
          { name: 'trial_ends_at', label: 'Trial ends', type: 'date', hidden: v => v.plan_key !== 'trial' }, { name: 'notes', label: 'Internal notes', type: 'textarea', full: true }, { name: 'reason', label: 'Reason for change (audited)', required: true, full: true }]}
        onSubmit={async v => { await api.patch(`/api/v1/platform/agencies/${o.id}/subscription`, { plan_key: v.plan_key, comped: !!v.comped, discount_pct: Number(v.discount_pct ?? 0), tax_bp: Math.round(Number(v.tax_pct ?? 0) * 100), trial_ends_at: v.plan_key === 'trial' && v.trial_ends_at ? `${v.trial_ends_at}T23:59:59Z` : undefined, notes: v.notes || null, reason: v.reason }); toast.success('Subscription saved'); st.reload(); }} />
      <GenerateDialog open={gen} onClose={() => setGen(false)} orgId={o.id} defaultMonth={d.last_month} onDone={st.reload} />
      <ImpersonateDialog member={imp} orgId={o.id} orgName={o.name} onClose={() => setImp(null)} />
    </div>
  );
}

function GenerateDialog({ open, onClose, orgId, defaultMonth, onDone }: { open: boolean; onClose: () => void; orgId: string; defaultMonth: string; onDone: () => void }) {
  const [month, setMonth] = useState(defaultMonth);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title="Generate SaaS invoice" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { const r = await api.post(`/api/v1/platform/agencies/${orgId}/invoices`, { month }); toast.success(r.existing ? `${r.invoice.number} already exists for this month` : `${r.invoice.number} created: ${money(r.invoice.total_cents)}`); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Generate</Button></>}>
      <p className="small muted">Meters every seat that was active during the month (seat-days), applies the plan price, add-ons, discount, comp and tax. Generating twice for the same month returns the existing invoice.</p>
      <Field label="Month" htmlFor="gen-m"><input id="gen-m" type="month" className="input" value={month} onChange={e => setMonth(e.target.value)} /></Field>
    </Dialog>
  );
}

function ImpersonateDialog({ member, orgId, orgName, onClose }: { member: any; orgId: string; orgName: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={!!member} onClose={onClose} title={member ? `Support session as ${member.name}` : ''} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" icon={<ShieldAlert size={16} />} disabled={reason.trim().length < 10} loading={busy} onClick={async () => { setBusy(true); try { const r = await api.post('/api/v1/platform/impersonation/start', { user_id: member.id, organization_id: orgId, reason }); window.location.href = r.redirect; } catch (e) { toast.error(e); setBusy(false); } }}>Start support session</Button></>}>
      <Banner tone="warn">You will see {orgName} exactly as {member?.name} ({member?.role_name}). A "Support mode" banner stays visible, sessions expire automatically (Platform settings), and every action is audited with your name.</Banner>
      <Field label="Reason (required, 10+ characters)" htmlFor="imp-r"><textarea id="imp-r" className="textarea" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Ticket: client cannot see invoices — reproducing the issue" /></Field>
    </Dialog>
  );
}
