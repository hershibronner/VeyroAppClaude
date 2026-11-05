import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Mail, Phone, User, Globe, Briefcase, UserPlus, ListTodo, Receipt, Send, Pencil, PowerOff, Power, Trash2, AlertTriangle, Upload, Plus, X, Users, Clock } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { money, date, humanize, hours, shortDate, relTime } from '../../lib/format';
import { Avatar, Banner, Boundary, Button, Card, CardHeader, EmptyState, ErrorState, Field, KV, LoadingBlock, Menu, PageHeader, StatusPill, Tabs, useConfirm, Person } from '../../components/ui';
import { Timeline } from '../../components/Timeline';
import { ChartCard, TrendLine, fmtMoneyCompact } from '../../components/charts';
import { ClientForm, ContactForm, TaskForm, InvitePortalDialog, PermanentDeleteDialog, CreatePositionForm, CreateInvoiceForm } from './forms';
import { CompanyContacts } from './panels';

type TabKey = 'overview' | 'contacts' | 'hiring' | 'workforce' | 'finance' | 'documents' | 'onboarding' | 'activity';

export default function ClientDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [rk, setRk] = useState(0);
  const st = useApi<any>(`/api/v1/companies/${id}`, [rk]);
  const [tab, setTab] = useState<TabKey>('overview');
  const [dialog, setDialog] = useState<null | 'edit' | 'contact' | 'task' | 'invite' | 'delete' | 'position' | 'invoice'>(null);
  const reload = () => setRk(k => k + 1);
  if (st.error && !st.data) return <div><PageHeader title="Client" back="/crm/clients" /><ErrorState error={st.error} retry={st.reload} /></div>;
  if (!st.data) return <LoadingBlock rows={8} />;
  const c = st.data;
  if (c.stage === 'lead' || c.stage === 'qualified') return <Navigate to={`/crm/leads/${c.id}`} replace />;
  const k = c.counts;
  const pc = c.primary_contact;
  const active = c.stage === 'client';

  const deactivate = async () => {
    const r = await confirm({ title: `Deactivate ${c.name}?`, body: 'Open positions will be closed. Placements must be ended first. History, invoices and documents are kept.', danger: true, confirmLabel: 'Deactivate', reason: { label: 'Reason', required: true } });
    if (!r.ok) return;
    try { await api.post(`/api/v1/companies/${c.id}/deactivate`, { reason: r.reason }); toast.success(`${c.name} deactivated`); reload(); } catch (e) { toast.error(e); }
  };
  const reactivate = async () => { try { await api.post(`/api/v1/companies/${c.id}/reactivate`); toast.success(`${c.name} reactivated`); reload(); } catch (e) { toast.error(e); } };

  return (
    <div>
      <PageHeader title={c.name} back="/crm/clients" />
      <Card className="mb-3">
        <div className="detail-head">
          <Avatar name={c.name} size={52} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="row" style={{ gap: 10 }}>
              <StatusPill status={active ? 'active' : 'inactive'} label={active ? 'Active client' : 'Inactive'} tone={active ? 'green' : 'gray'} />
              {c.industry && <span className="muted small">{humanize(c.industry)}</span>}
              {c.attention_reasons.length > 0 && <span className="pill pill-red"><AlertTriangle size={12} /> {c.attention_reasons.join(' · ')}</span>}
            </div>
            <div className="detail-meta">
              <span><User size={14} /> AM: {c.account_manager_name ?? 'Unassigned'}</span>
              {pc && <span><Users size={14} /> {[pc.first_name, pc.last_name].filter(Boolean).join(' ')}{pc.title ? `, ${pc.title}` : ''}</span>}
              {(pc?.email || c.email) && <span><Mail size={14} /> <a href={`mailto:${pc?.email ?? c.email}`}>{pc?.email ?? c.email}</a></span>}
              {(pc?.phone || c.phone) && <span><Phone size={14} /> <a href={`tel:${pc?.phone ?? c.phone}`}>{pc?.phone ?? c.phone}</a></span>}
              {c.website && <span><Globe size={14} /> <a href={c.website} target="_blank" rel="noreferrer">{c.domain ?? c.website}</a></span>}
            </div>
          </div>
          <div className="crm-head-actions">
            {active && c.can.create_position && <Button variant="primary" icon={<Briefcase size={16} />} onClick={() => setDialog('position')}>Create Position</Button>}
            <Menu items={[
              { label: 'Edit client', icon: <Pencil size={15} />, onClick: () => setDialog('edit'), hidden: !c.can.edit },
              { label: 'Add contact', icon: <UserPlus size={15} />, onClick: () => setDialog('contact'), hidden: !can('contacts', 'create') },
              { label: 'Create task', icon: <ListTodo size={15} />, onClick: () => setDialog('task'), hidden: !c.can.create_task },
              { label: 'Create invoice', icon: <Receipt size={15} />, onClick: () => setDialog('invoice'), hidden: !c.can.create_invoice },
              { label: 'Invite to portal', icon: <Send size={15} />, onClick: () => setDialog('invite'), hidden: !c.can.edit || !active },
              { sep: true },
              { label: 'Deactivate', icon: <PowerOff size={15} />, danger: true, onClick: deactivate, hidden: !c.can.edit || !active },
              { label: 'Reactivate', icon: <Power size={15} />, onClick: reactivate, hidden: !c.can.edit || active },
              { label: 'Permanently delete', icon: <Trash2 size={15} />, danger: true, onClick: () => setDialog('delete'), hidden: !c.can.delete_permanent },
            ]} />
          </div>
        </div>
      </Card>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: 'Overview' }, { key: 'contacts', label: 'Contacts', count: k.contacts_count }, { key: 'hiring', label: 'Hiring', count: k.open_roles },
        { key: 'workforce', label: 'Workforce', count: k.active_workers }, { key: 'finance', label: 'Finance', hidden: !c.can.finance }, { key: 'documents', label: 'Documents', hidden: !c.can.documents },
        { key: 'onboarding', label: 'Onboarding Requirements' }, { key: 'activity', label: 'Activity' },
      ]} />
      {tab === 'overview' && <Overview c={c} onTab={setTab} reloadKey={rk} onChanged={reload} />}
      {tab === 'contacts' && <Card pad><CompanyContacts companyId={c.id} reloadKey={rk} onChanged={reload} hideAdd /></Card>}
      {tab === 'hiring' && <Boundary label="Hiring"><Hiring id={c.id} /></Boundary>}
      {tab === 'workforce' && <Boundary label="Workforce"><Workforce id={c.id} /></Boundary>}
      {tab === 'finance' && c.can.finance && <Boundary label="Finance"><Finance id={c.id} /></Boundary>}
      {tab === 'documents' && <Boundary label="Documents"><Documents id={c.id} canUpload={c.can.upload_documents} /></Boundary>}
      {tab === 'onboarding' && <Boundary label="Onboarding requirements"><Onboarding id={c.id} /></Boundary>}
      {tab === 'activity' && <Card pad><Timeline type="company" id={c.id} reloadKey={rk} /></Card>}

      <ClientForm open={dialog === 'edit'} onClose={() => setDialog(null)} client={c} onSaved={reload} />
      <ContactForm open={dialog === 'contact'} onClose={() => setDialog(null)} companyId={c.id} onSaved={() => { reload(); setTab('contacts'); }} />
      <TaskForm open={dialog === 'task'} onClose={() => setDialog(null)} related={{ type: 'company', id: c.id, label: c.name }} onSaved={reload} />
      <InvitePortalDialog open={dialog === 'invite'} onClose={() => setDialog(null)} company={c} onDone={reload} />
      <CreatePositionForm open={dialog === 'position'} onClose={() => setDialog(null)} company={c} />
      <CreateInvoiceForm open={dialog === 'invoice'} onClose={() => setDialog(null)} company={c} />
      {c.can.delete_permanent && <PermanentDeleteDialog open={dialog === 'delete'} onClose={() => setDialog(null)} company={c} onDeleted={() => nav('/crm/clients')} />}
    </div>
  );
}

function Overview({ c, onTab, reloadKey, onChanged }: { c: any; onTab: (t: TabKey) => void; reloadKey: number; onChanged: () => void }) {
  const { can } = useAuth();
  const k = c.counts;
  const opps = useApi<any>(can('opportunities', 'view') ? `/api/v1/opportunities?company_id=${c.id}&pageSize=10` : null, [reloadKey]);
  return (
    <div className="grid-main-side">
      <div className="stack">
        <div className="kpi-tiles" style={{ marginBottom: 0 }}>
          <Tile label="Open roles" value={k.open_roles} onClick={() => onTab('hiring')} />
          <Tile label="Active workers" value={k.active_workers} sub={k.onboarding_workers ? `+${k.onboarding_workers} onboarding` : undefined} onClick={() => onTab('workforce')} />
          <Tile label="In pipeline" value={k.in_pipeline} sub={`${k.hired} hired`} onClick={() => onTab('hiring')} />
          <Tile label="Hours (30 days)" value={hours(k.minutes_30d, 0)} onClick={() => onTab('workforce')} />
        </div>
        <Card>
          <CardHeader title="Company details" />
          <div style={{ padding: 22 }}>
            <KV items={[
              ['Website', c.website ? <a href={c.website} target="_blank" rel="noreferrer">{c.website}</a> : null], ['Industry', c.industry ? humanize(c.industry) : null], ['Size', c.size ? `${c.size} employees` : null], ['Country', c.country],
              ['Main phone', c.phone], ['Main email', c.email], ['Address', c.address], ['Account manager', c.account_manager_name], ['Sales owner', c.owner_name], ['Source', c.source],
              ['Timesheet approval', c.timesheet_approval === 'both' ? 'Agency, then client' : `${humanize(c.timesheet_approval)} approves`], ['Payment terms', `Net ${c.payment_terms_days}`],
              ['Portal screenshots', c.portal_screenshots ? 'Visible to client' : 'Hidden from client'], ['Client since', c.converted_at ? date(c.converted_at) : date(c.created_at)], ['Notes', c.notes ? <span style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</span> : null],
            ]} />
          </div>
        </Card>
      </div>
      <div className="stack">
        <PortalAccess c={c} reloadKey={reloadKey} onChanged={onChanged} />
        {can('opportunities', 'view') && (
          <Card pad>
            <div className="row" style={{ justifyContent: 'space-between' }}><b>Opportunities</b><Link className="small" to={`/crm/opportunities?company_id=${c.id}`}>View all</Link></div>
            {!opps.data ? <LoadingBlock rows={2} /> : opps.data.rows.length === 0 ? <div className="muted small mt-1">No opportunities.</div> : opps.data.rows.map((o: any) => (
              <div key={o.id} className="row small mt-2" style={{ justifyContent: 'space-between' }}><Link to={`/crm/opportunities/${o.id}`}>{o.name}</Link><span><StatusPill status={o.stage} /> {money(Number(o.value_cents), o.currency, { noCents: true })}</span></div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
function Tile({ label, value, sub, onClick }: { label: string; value: React.ReactNode; sub?: string; onClick?: () => void }) {
  return <button className="card card-pad" style={{ textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border)' }} onClick={onClick}><div className="muted small">{label}</div><div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', marginTop: 4 }}>{value}</div>{sub && <div className="muted small">{sub}</div>}</button>;
}

function PortalAccess({ c, reloadKey, onChanged }: { c: any; reloadKey: number; onChanged: () => void }) {
  const st = useApi<any>(`/api/v1/companies/${c.id}/portal-invitations`, [reloadKey]);
  const confirm = useConfirm();
  const revoke = async (inv: any) => {
    const r = await confirm({ title: `Revoke invitation for ${inv.email}?`, body: 'The link stops working immediately.', danger: true, confirmLabel: 'Revoke' });
    if (!r.ok) return;
    try { await api.post(`/api/v1/companies/${c.id}/portal-invitations/${inv.id}/revoke`); toast.success('Invitation revoked'); st.reload(); onChanged(); } catch (e) { toast.error(e); }
  };
  const d = st.data;
  return (
    <Card pad>
      <b>Client portal access</b>
      {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <LoadingBlock rows={2} /> : (
        <>
          {d.users.length === 0 && d.invitations.length === 0 && <div className="muted small mt-1">Nobody has portal access yet. Use More → Invite to portal.</div>}
          {d.users.map((u: any) => <div key={u.user_id} className="row small mt-2" style={{ justifyContent: 'space-between' }}><Person name={u.name} sub={`${u.role_name} · ${u.last_login_at ? 'last seen ' + relTime(u.last_login_at) : 'never signed in'}`} size={26} /><StatusPill status={u.status} /></div>)}
          {d.invitations.filter((i: any) => i.status !== 'accepted').slice(0, 6).map((i: any) => (
            <div key={i.id} className="row small mt-2" style={{ justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}><div className="truncate">{i.email}</div><div className="muted">{i.role_name} · {i.status === 'pending' ? `expires ${shortDate(i.expires_at)}` : `${humanize(i.status)}`} · by {i.invited_by_name ?? '—'}</div></div>
              {i.status === 'pending' ? <Button size="xs" variant="ghost" onClick={() => revoke(i)}>Revoke</Button> : <StatusPill status={i.status} />}
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

function Hiring({ id }: { id: string }) {
  const st = useApi<any>(`/api/v1/companies/${id}/positions`);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={4} />;
  if (st.data.restricted) return <Card pad><EmptyState title="Positions are not visible to your role" /></Card>;
  const rows: any[] = st.data.rows;
  return (
    <Card>
      <CardHeader title="Positions" sub={`${rows.filter(r => ['open', 'on_hold'].includes(r.status)).length} open · ${rows.length} total`} />
      {rows.length === 0 ? <EmptyState title="No positions yet" text="Use Create Position to open a role for this client." /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Position</th><th>Status</th><th>Openings</th><th>Pipeline</th><th>Recruiters</th><th>Created</th></tr></thead>
          <tbody>{rows.map(p => (
            <tr key={p.id}><td><Link to={`/recruiting/positions/${p.id}`} className="bold">{p.title}</Link><div className="muted small">{humanize(p.employment_type)} · {humanize(p.urgency)} urgency</div></td>
              <td><StatusPill status={p.status} /></td><td>{p.filled}/{p.openings}</td><td>{p.submissions} submitted · {p.applications} applied</td><td>{p.recruiters ?? <span className="muted">Unassigned</span>}</td><td>{shortDate(p.created_at)}</td></tr>
          ))}</tbody></table></div>
      )}
    </Card>
  );
}

function Workforce({ id }: { id: string }) {
  const st = useApi<any>(`/api/v1/companies/${id}/placements`);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={4} />;
  if (st.data.restricted) return <Card pad><EmptyState title="Placements are not visible to your role" /></Card>;
  const rows: any[] = st.data.rows;
  const comp = st.data.comp_visible;
  return (
    <Card>
      <CardHeader title="Placements" sub={`${rows.filter(r => ['active', 'on_leave', 'notice'].includes(r.status)).length} active · ${rows.filter(r => r.status === 'onboarding').length} onboarding · ${rows.filter(r => r.status === 'ended').length} ended`} />
      {rows.length === 0 ? <EmptyState title="No placements yet" text="Workers placed with this client appear here." /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Worker</th><th>Role</th><th>Status</th><th>Start</th><th>Account manager</th><th className="right">Hours (30d)</th>{comp && <th className="right">Pay / Bill</th>}</tr></thead>
          <tbody>{rows.map(p => (
            <tr key={p.id}>
              <td><Link to={`/workforce/workers/${p.worker_id}`}><Person name={p.worker_name} sub={[p.worker_country, p.presence && p.presence !== 'offline' ? humanize(p.presence) : null].filter(Boolean).join(' · ') || undefined} size={28} /></Link></td>
              <td><Link to={`/workforce/placements/${p.id}`}>{p.title}</Link></td><td><StatusPill status={p.status} /></td><td>{shortDate(p.start_date)}{p.end_date ? ` – ${shortDate(p.end_date)}` : ''}</td>
              <td>{p.account_manager_name ?? '—'}</td><td className="right money"><Clock size={12} /> {hours(p.minutes_30d, 0)}</td>
              {comp && <td className="right money">{p.pay_rate_cents != null ? `${money(Number(p.pay_rate_cents), p.currency)} / ${money(Number(p.bill_rate_cents), p.currency)}` : '—'}</td>}
            </tr>
          ))}</tbody></table></div>
      )}
    </Card>
  );
}

function Finance({ id }: { id: string }) {
  const st = useApi<any>(`/api/v1/companies/${id}/finance`);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={6} />;
  const { ar, invoices, trend, margin, currency } = st.data;
  return (
    <div className="stack">
      <div className="kpi-tiles" style={{ marginBottom: 0 }}>
        <Tile label="Outstanding (AR)" value={money(ar.outstanding_cents, currency)} sub={`${ar.open_count} open invoice${ar.open_count === 1 ? '' : 's'}`} />
        <Tile label="Overdue" value={<span className={ar.overdue_cents ? 'down' : ''}>{money(ar.overdue_cents, currency)}</span>} sub={`${ar.overdue_count} overdue`} />
        <Tile label="Billed (12 months)" value={money(ar.billed_12m_cents, currency, { noCents: true })} sub={`${money(ar.collected_12m_cents, currency, { noCents: true })} collected`} />
        <Tile label="Gross margin" value={margin ? (margin.margin_pct === null ? '—' : `${margin.margin_pct}%`) : '—'} sub={margin ? `${money(margin.margin_cents, currency, { noCents: true })} · ${margin.period}` : 'Requires margin access'} />
      </div>
      <ChartCard title="Billed per month" big={money(trend.reduce((a: number, t: any) => a + t.value, 0), currency, { noCents: true })} delta={<span className="muted">last 6 months</span>}>
        <TrendLine data={trend} fmt={fmtMoneyCompact} height={220} />
      </ChartCard>
      <Card>
        <CardHeader title="Invoices" right={<Link className="small" to={`/finance/invoices?company_id=${id}`}>Open in Finance</Link>} />
        {invoices.length === 0 ? <EmptyState title="No invoices yet" /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Number</th><th>Period</th><th>Issued</th><th>Due</th><th>Status</th><th className="right">Total</th><th className="right">Balance</th></tr></thead>
            <tbody>{invoices.map((i: any) => (
              <tr key={i.id}><td><Link to={`/finance/invoices/${i.id}`} className="bold">{i.number}</Link></td><td>{i.period_start ? `${shortDate(i.period_start)} – ${shortDate(i.period_end)}` : '—'}</td><td>{shortDate(i.issue_date)}</td><td>{shortDate(i.due_date)}</td>
                <td><StatusPill status={i.status} /></td><td className="right money">{money(Number(i.total_cents), i.currency)}</td><td className="right money">{money(Number(i.balance_cents), i.currency)}</td></tr>
            ))}</tbody></table></div>
        )}
      </Card>
    </div>
  );
}

function Documents({ id, canUpload }: { id: string; canUpload: boolean }) {
  const st = useApi<any>(`/api/v1/companies/${id}/documents`);
  const fileRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState('contract'); const [visibility, setVisibility] = useState('internal'); const [busy, setBusy] = useState(false);
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append('category', category); fd.append('visibility', visibility); fd.append('name', f.name); fd.append('file', f);
    setBusy(true);
    try { await api.upload(`/api/v1/companies/${id}/documents`, fd); toast.success(`${f.name} uploaded`); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={4} />;
  if (st.data.restricted) return <Card pad><EmptyState title="Documents are not visible to your role" /></Card>;
  const rows: any[] = st.data.rows;
  return (
    <Card>
      <CardHeader title="Documents" sub="Contracts, NDAs and policies for this client" right={canUpload && <>
        <select className="select input-sm" style={{ width: 'auto', height: 32 }} aria-label="Category" value={category} onChange={e => setCategory(e.target.value)}>{['contract', 'nda', 'policy', 'compliance', 'general'].map(x => <option key={x} value={x}>{humanize(x)}</option>)}</select>
        <select className="select input-sm" style={{ width: 'auto', height: 32 }} aria-label="Visibility" value={visibility} onChange={e => setVisibility(e.target.value)}><option value="internal">Internal only</option><option value="client">Visible to client</option></select>
        <input ref={fileRef} type="file" hidden onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
        <Button size="sm" icon={<Upload size={14} />} loading={busy} onClick={() => fileRef.current?.click()}>Upload</Button>
      </>} />
      {rows.length === 0 ? <EmptyState title="No documents" text={canUpload ? 'Upload the client contract or NDA.' : undefined} /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Category</th><th>Visibility</th><th>Signature</th><th>Expires</th><th>Added</th></tr></thead>
          <tbody>{rows.map(d => (
            <tr key={d.id}><td>{d.url ? <a href={d.url} target="_blank" rel="noreferrer" className="bold">{d.name}</a> : <b>{d.name}</b>}{d.download_url && <> · <a className="small" href={d.download_url}>Download</a></>}</td><td>{humanize(d.category)}</td><td>{humanize(d.visibility)}</td>
              <td>{d.signature_status ? <StatusPill status={d.signature_status} /> : <span className="muted">—</span>}</td><td>{d.expires_at ? date(d.expires_at) : '—'}</td><td>{shortDate(d.created_at)} · {d.created_by_name ?? 'System'}</td></tr>
          ))}</tbody></table></div>
      )}
    </Card>
  );
}

function Onboarding({ id }: { id: string }) {
  const st = useApi<any>(`/api/v1/companies/${id}/onboarding`);
  const confirm = useConfirm();
  const [title, setTitle] = useState(''); const [required, setRequired] = useState(true); const [owner, setOwner] = useState('agency'); const [busy, setBusy] = useState(false);
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <LoadingBlock rows={4} />;
  const d = st.data;
  const add = async () => {
    setBusy(true);
    try { await api.post(`/api/v1/companies/${id}/onboarding/items`, { title, required, owner }); setTitle(''); toast.success('Requirement added'); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const patch = async (item: any, body: any) => { try { await api.patch(`/api/v1/companies/${id}/onboarding/items/${item.id}`, body); st.reload(); } catch (e) { toast.error(e); } };
  const remove = async (item: any) => {
    const r = await confirm({ title: `Remove “${item.title}”?`, body: 'Future placements for this client will no longer include it.', danger: true, confirmLabel: 'Remove' });
    if (!r.ok) return; try { await api.del(`/api/v1/companies/${id}/onboarding/items/${item.id}`); toast.success('Requirement removed'); st.reload(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="grid-main-side">
      <Card>
        <CardHeader title="Client-specific requirements" sub="Added to every new placement for this client, on top of the agency defaults. Required items block activation." />
        <div style={{ padding: '6px 22px 18px' }}>
          {d.items.length === 0 ? <EmptyState title="No client-specific requirements" text="e.g. HIPAA training, client NDA, VPN setup." /> : d.items.map((it: any) => (
            <div key={it.id} className="checklist-item">
              <div style={{ flex: 1, minWidth: 0 }}><b>{it.title}</b><div className="muted small">Owner: {humanize(it.owner)}</div></div>
              {d.can_edit ? <>
                <label className="check small"><input type="checkbox" checked={it.required} onChange={e => patch(it, { required: e.target.checked })} /> Required</label>
                <select className="select input-sm" style={{ width: 'auto', height: 30 }} aria-label="Owner" value={it.owner} onChange={e => patch(it, { owner: e.target.value })}>{['agency', 'worker', 'client'].map(o => <option key={o} value={o}>{humanize(o)}</option>)}</select>
                <button className="icon-btn" aria-label={`Remove ${it.title}`} onClick={() => remove(it)}><X size={16} /></button>
              </> : <StatusPill status={it.required ? 'required' : 'optional'} label={it.required ? 'Required' : 'Optional'} tone={it.required ? 'amber' : 'gray'} />}
            </div>
          ))}
          {d.can_edit && (
            <div className="row mt-3" style={{ alignItems: 'flex-end' }}>
              <Field label="New requirement" htmlFor="ob-t"><input id="ob-t" className="input" value={title} placeholder="e.g. Complete HIPAA training" onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && title.trim().length >= 2) add(); }} /></Field>
              <Field label="Owner" htmlFor="ob-o"><select id="ob-o" className="select" value={owner} onChange={e => setOwner(e.target.value)}>{['agency', 'worker', 'client'].map(o => <option key={o} value={o}>{humanize(o)}</option>)}</select></Field>
              <label className="check" style={{ marginBottom: 10 }}><input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} /> Required</label>
              <Button variant="primary" icon={<Plus size={15} />} loading={busy} disabled={title.trim().length < 2} onClick={add} style={{ marginBottom: 2 }}>Add</Button>
            </div>
          )}
        </div>
      </Card>
      <div className="stack">
        {d.onboarding_placements > 0 && <Banner>{d.onboarding_placements} placement{d.onboarding_placements > 1 ? 's are' : ' is'} onboarding now — changes apply to new placements only.</Banner>}
        <Card pad>
          <b>Agency defaults</b><div className="muted small">Always included (managed in Settings → Onboarding)</div>
          {d.agency_items.length === 0 ? <div className="muted small mt-2">No agency defaults configured.</div> : d.agency_items.map((it: any) => (
            <div key={it.id} className="row small mt-2" style={{ justifyContent: 'space-between' }}><span>{it.title}</span><span className="muted">{it.required ? 'Required' : 'Optional'} · {humanize(it.owner)}</span></div>
          ))}
        </Card>
      </div>
    </div>
  );
}

