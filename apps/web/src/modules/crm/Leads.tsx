import { useState, type DragEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Target, Sparkles, CheckCircle2, ArrowRightLeft, Plus, Upload, LayoutGrid, List, UserPlus, Archive } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { money, shortDate, relTime, humanize, num } from '../../lib/format';
import { Banner, Boundary, Button, Card, EmptyState, ErrorState, KpiRow, LoadingBlock, MemberSelect, Dialog, Field, PageHeader, Person, Segmented, StatusPill, useConfirm, SearchInput } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { Funnel, TrackBars, fmtMoneyCompact } from '../../components/charts';
import { LEAD_STATUSES, ScoreBadge, sourceOpts } from './common';
import { ConvertDialog, LeadForm } from './forms';

export default function Leads() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') === 'kanban' ? 'kanban' : 'table';
  const [creating, setCreating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const stats = useApi<any>('/api/v1/leads/stats', [reloadKey]);
  const s = stats.data;
  const setView = (v: string) => { const n = new URLSearchParams(sp); if (v === 'table') n.delete('view'); else n.set('view', v); setSp(n, { replace: true }); };

  return (
    <div>
      <PageHeader title="Leads" sub="Prospect companies and their contacts — the same records become clients when converted."
        actions={<>
          <Segmented value={view} onChange={setView} options={[{ key: 'table', label: <><List size={14} /> Table</> }, { key: 'kanban', label: <><LayoutGrid size={14} /> Kanban</> }]} />
          {can('imports', 'create') && <Button icon={<Upload size={16} />} onClick={() => nav('/settings/import?type=leads')}>Import CSV</Button>}
          {can('leads', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New Lead</Button>}
        </>} />
      {s && (s.follow_up_overdue > 0 || s.stale_new > 0) && (
        <Banner tone="warn">
          <b>Heads up!</b>{' '}
          {s.follow_up_overdue > 0 && <><Link to="/crm/leads?follow_up=overdue">{s.follow_up_overdue} lead{s.follow_up_overdue > 1 ? 's have' : ' has'} an overdue follow-up</Link>{s.stale_new > 0 ? ' and ' : '.'}</>}
          {s.stale_new > 0 && <><Link to="/crm/leads?stale=true">{s.stale_new} new lead{s.stale_new > 1 ? 's' : ''} not contacted for 3+ days</Link>.</>}
          {s.follow_up_today > 0 && <> {s.follow_up_today} follow-up{s.follow_up_today > 1 ? 's' : ''} due today.</>}
        </Banner>
      )}
      <Boundary label="Lead KPIs">
        {stats.error ? <ErrorState error={stats.error} retry={stats.reload} /> : (
          <KpiRow items={[
            { label: 'Open leads', icon: <Target size={16} />, value: s ? num(s.open) : '…', delta: s?.open_delta, to: '/crm/leads' },
            { label: 'New this month', icon: <Sparkles size={16} />, value: s ? num(s.new_this_month) : '…', delta: s?.new_delta, to: s ? `/crm/leads?created_from=${s.month_start}` : undefined },
            { label: 'Qualified', icon: <CheckCircle2 size={16} />, value: s ? num(s.qualified) : '…', deltaText: s ? <b className="up">{s.qualified_this_month} qualified</b> : undefined, suffix: 'this month', to: '/crm/leads?status=qualified' },
            { label: 'Converted this month', icon: <ArrowRightLeft size={16} />, value: s ? num(s.converted_this_month) : '…', delta: s?.converted_delta, deltaText: s && s.converted_delta === null ? <span className="muted">{s.converted_last_month} last month</span> : undefined, suffix: '', to: s ? `/crm/leads?status=converted&converted_from=${s.month_start}` : undefined },
          ]} />
        )}
      </Boundary>
      <div className="grid-2 mb-3">
        <Boundary label="Lead source analytics"><SourceAnalytics /></Boundary>
        <Boundary label="Lead funnel"><LeadFunnel /></Boundary>
      </div>
      {view === 'table' ? <LeadTable reloadKey={reloadKey} onChanged={() => setReloadKey(k => k + 1)} /> : <LeadKanban reloadKey={reloadKey} onChanged={() => setReloadKey(k => k + 1)} />}
      <LeadForm open={creating} onClose={() => setCreating(false)} onSaved={r => { setReloadKey(k => k + 1); nav(`/crm/leads/${r.id}`); }} />
    </div>
  );
}

function SourceAnalytics() {
  const [months, setMonths] = useState(0);
  const nav = useNavigate();
  const st = useApi<any>(`/api/v1/leads/source-analytics?months=${months}`, [months]);
  const d = st.data;
  return (
    <Card pad>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="card-title-lg">Lead sources</div>
        <select className="select input-sm" style={{ width: 'auto', height: 32, fontSize: 13 }} aria-label="Period" value={months} onChange={e => setMonths(Number(e.target.value))}>
          <option value={0}>All time</option><option value={12}>Last 12 months</option><option value={6}>Last 6 months</option><option value={3}>Last 3 months</option>
        </select>
      </div>
      {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <LoadingBlock rows={4} /> : d.rows.length === 0 ? <EmptyState title="No leads in this period" /> : (
        <>
          {d.revenue_visible && <div className="mt-2"><TrackBars data={d.rows.map((r: any) => ({ label: r.source, value: r.revenue_cents }))} fmt={fmtMoneyCompact} height={170} valueName="Revenue" onBarClick={(x: any) => nav(`/crm/leads?source=${encodeURIComponent(x.label)}`)} /></div>}
          <div className="table-wrap mt-2">
            <table className="crm-source-table">
              <thead><tr><th>Source</th><th>Leads</th><th>Qualified</th><th>Converted</th><th className="hide-sm">Placements</th>{d.revenue_visible && <th>Revenue</th>}</tr></thead>
              <tbody>{d.rows.map((r: any) => (
                <tr key={r.source} className="clickable" onClick={() => nav(`/crm/leads?source=${encodeURIComponent(r.source)}`)} title={`Open ${r.source} leads`}>
                  <td><b>{r.source}</b></td><td>{r.leads}</td><td>{r.qualified}</td><td>{r.converted} <span className="muted small">({r.conversion_pct}%)</span></td><td className="hide-sm">{r.placements}</td>{d.revenue_visible && <td>{money(r.revenue_cents, 'USD', { noCents: true })}</td>}
                </tr>
              ))}</tbody>
              <tfoot><tr><td>Total</td><td>{d.totals.leads}</td><td>{d.totals.qualified}</td><td>{d.totals.converted}</td><td className="hide-sm">{d.totals.placements}</td>{d.revenue_visible && <td>{money(d.totals.revenue_cents, 'USD', { noCents: true })}</td>}</tr></tfoot>
            </table>
          </div>
          <div className="muted small mt-2">Revenue = issued invoices of companies from each source. Click a source to see its open leads.</div>
        </>
      )}
    </Card>
  );
}

function LeadFunnel() {
  const nav = useNavigate();
  const st = useApi<any>('/api/v1/leads/source-analytics?months=0');
  const t = st.data?.totals;
  return (
    <Card pad>
      <div className="card-title-lg">Pipeline funnel</div>
      <div className="muted small mt-1">All companies that entered the lead pipeline</div>
      <div className="mt-3">
        {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !t ? <LoadingBlock rows={4} /> : (
          <Funnel steps={[{ label: 'Leads', value: t.leads, key: '' }, { label: 'Qualified', value: t.qualified, key: 'qualified' }, { label: 'Converted', value: t.converted, key: 'converted' }, { label: 'Placements', value: t.placements, key: 'placements' }]}
            onStepClick={s => nav(s.key === 'placements' ? '/workforce/placements' : s.key === 'converted' ? '/crm/clients' : s.key ? `/crm/leads?status=${s.key}` : '/crm/leads')} />
        )}
      </div>
    </Card>
  );
}

function LeadTable({ reloadKey, onChanged }: { reloadKey: number; onChanged: () => void }) {
  const { can, scope } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [assign, setAssign] = useState<{ ids: string[]; reload: () => void } | null>(null);
  const [convert, setConvert] = useState<any>(null);
  const columns: Column<any>[] = [
    { key: 'name', label: 'Company', sortable: true, mobile: 'title', render: r => <div><Link to={`/crm/leads/${r.id}`} className="bold" onClick={e => e.stopPropagation()}>{r.name}</Link><div className="muted small">{[r.industry && humanize(r.industry), r.country].filter(Boolean).join(' · ') || '—'}</div></div> },
    { key: 'contact_name', label: 'Primary contact', mobile: 'subtitle', render: r => r.contact_name ? <div><div>{r.contact_name}</div><div className="muted small">{r.contact_email ?? r.contact_phone ?? r.contact_title ?? ''}</div></div> : <span className="muted">—</span>, csv: r => r.contact_name },
    { key: 'lead_status', label: 'Status', sortable: true, render: r => <StatusPill status={r.lead_status ?? 'new'} /> },
    { key: 'lead_score', label: 'Score', sortable: true, align: 'center', render: r => <ScoreBadge score={r.lead_score} /> },
    { key: 'source', label: 'Source', sortable: true },
    { key: 'owner_name', label: 'Owner', sortable: true, render: r => r.owner_name ? <Person name={r.owner_name} color={r.owner_color} size={24} /> : <span className="muted">Unassigned</span> },
    { key: 'est_monthly_value_cents', label: 'Est. value / mo', sortable: true, align: 'right', render: r => r.est_monthly_value_cents ? money(Number(r.est_monthly_value_cents), r.currency, { noCents: true }) : <span className="muted">—</span>, csv: r => (r.est_monthly_value_cents ? Number(r.est_monthly_value_cents) / 100 : '') },
    { key: 'next_follow_up', label: 'Follow-up', sortable: true, render: r => r.next_follow_up ? <span className={r.next_follow_up < new Date().toISOString().slice(0, 10) && !['converted', 'unqualified'].includes(r.lead_status) ? 'down bold' : ''}>{shortDate(r.next_follow_up)}</span> : <span className="muted">—</span> },
    { key: 'last_activity_at', label: 'Last activity', sortable: true, mobile: 'hidden', render: r => <span className="muted small">{relTime(r.last_activity_at)}</span> },
  ];
  return (
    <>
      <DataTable title="All leads" endpoint="/api/v1/leads" columns={columns} exportName="leads" exportResource="leads" reloadKey={reloadKey} defaultSort="created_at"
        rowLink={r => `/crm/leads/${r.id}`} searchPlaceholder="Search company, contact, email"
        filters={[
          { key: 'status', label: 'Status', options: opts(LEAD_STATUSES) }, { key: 'source', label: 'Source', options: sourceOpts }, { key: 'owner', label: 'Owner', type: 'member' },
          { key: 'score', label: 'Score', options: [{ value: 'hot', label: 'Hot (70+)' }, { value: 'warm', label: 'Warm (40–69)' }, { value: 'cold', label: 'Cold (<40)' }] },
          { key: 'follow_up', label: 'Follow-up', options: [{ value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Today' }, { value: 'week', label: 'Next 7 days' }, { value: 'none', label: 'Not set' }] },
          { key: 'created_from', label: 'Created from', type: 'date' }, { key: 'created_to', label: 'Created to', type: 'date' },
          { key: 'converted_from', label: 'Converted from', type: 'date' }, { key: 'stale', label: 'Not contacted 3+ days', type: 'boolean' },
        ]}
        emptyTitle="No leads yet" emptyText="Create a lead or import a CSV to start your pipeline."
        rowActions={(r, reload) => [
          { label: 'Open', onClick: () => nav(`/crm/leads/${r.id}`) },
          { label: 'Qualify', hidden: !can('leads', 'edit') || !['new', 'contacted'].includes(r.lead_status ?? 'new'), onClick: async () => { try { await api.post(`/api/v1/leads/${r.id}/qualify`); toast.success(`${r.name} qualified`); reload(); onChanged(); } catch (e) { toast.error(e); } } },
          { label: 'Convert to client', hidden: !can('leads', 'edit') || !can('clients', 'create') || !['new', 'contacted', 'qualified'].includes(r.lead_status ?? 'new'), onClick: async () => { try { setConvert(await api.get(`/api/v1/leads/${r.id}`)); } catch (e) { toast.error(e); } } },
          { label: 'Disqualify', danger: true, hidden: !can('leads', 'edit') || !['new', 'contacted', 'qualified'].includes(r.lead_status ?? 'new'), onClick: async () => {
            const c = await confirm({ title: `Disqualify ${r.name}?`, danger: true, confirmLabel: 'Disqualify', reason: { label: 'Reason', required: true, placeholder: 'e.g. No budget this year' } });
            if (!c.ok) return; try { await api.post(`/api/v1/leads/${r.id}/disqualify`, { reason: c.reason }); toast.success('Lead disqualified'); reload(); onChanged(); } catch (e) { toast.error(e); }
          } },
        ]}
        bulkActions={[
          ...(can('leads', 'edit') ? [{ label: 'Assign owner', icon: <UserPlus size={14} />, onClick: (ids: string[], reload: () => void) => setAssign({ ids, reload }) }] : []),
          ...(scope('leads', 'delete') !== 'none' ? [{ label: 'Archive', icon: <Archive size={14} />, danger: true, onClick: async (ids: string[], reload: () => void) => {
            const c = await confirm({ title: `Archive ${ids.length} lead(s)?`, body: scope('leads', 'delete') === 'own' ? 'You can archive leads you own or created.' : 'Archived leads are hidden from lists.', danger: true, confirmLabel: 'Archive' });
            if (!c.ok) return; try { const r = await api.post('/api/v1/leads/bulk', { ids, action: 'archive' }); toast.success(`${r.count} lead(s) archived`); reload(); onChanged(); } catch (e) { toast.error(e); }
          } }] : []),
        ]} />
      <AssignDialog state={assign} onClose={() => setAssign(null)} onDone={onChanged} />
      <ConvertDialog open={!!convert} onClose={() => setConvert(null)} lead={convert} />
    </>
  );
}

function AssignDialog({ state, onClose, onDone }: { state: { ids: string[]; reload: () => void } | null; onClose: () => void; onDone: () => void }) {
  const [owner, setOwner] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  return (
    <Dialog open={!!state} onClose={onClose} title={`Assign ${state?.ids.length ?? 0} lead(s)`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!owner} onClick={async () => {
      setBusy(true); try { const r = await api.post('/api/v1/leads/bulk', { ids: state!.ids, action: 'assign', owner_id: owner }); toast.success(`${r.count} lead(s) reassigned`); state!.reload(); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>Assign</Button></>}>
      <Field label="New owner" htmlFor="as-o"><MemberSelect id="as-o" value={owner} onChange={setOwner} /></Field>
    </Dialog>
  );
}

/* ── Kanban with drag & drop between statuses (persists + writes an Activity) ── */
function LeadKanban({ reloadKey, onChanged }: { reloadKey: number; onChanged: () => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const filters = { search: sp.get('search') ?? '', source: sp.get('source') ?? '', owner: sp.get('owner') ?? '' };
  const setF = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const [search, setSearch] = useState(filters.search);
  const board = useApi<any>(`/api/v1/leads/board${qs(filters)}`, [reloadKey]);
  const [drag, setDrag] = useState<any>(null);
  const [over, setOver] = useState<string | null>(null);
  const [convert, setConvert] = useState<any>(null);
  const editable = can('leads', 'edit');

  const drop = async (to: string) => {
    const card = drag; setDrag(null); setOver(null);
    if (!card || (card.lead_status ?? 'new') === to) return;
    if (to === 'converted') { try { setConvert(await api.get(`/api/v1/leads/${card.id}`)); } catch (e) { toast.error(e); } return; }
    let reason: string | null = null;
    if (to === 'unqualified') { const c = await confirm({ title: `Disqualify ${card.name}?`, danger: true, confirmLabel: 'Disqualify', reason: { label: 'Reason', required: true } }); if (!c.ok) return; reason = c.reason; }
    // optimistic move
    board.setData((d: any) => d && ({ columns: d.columns.map((c: any) => c.status === to ? { ...c, count: c.count + 1, items: [{ ...card, lead_status: to }, ...c.items] } : c.status === (card.lead_status ?? 'new') ? { ...c, count: c.count - 1, items: c.items.filter((i: any) => i.id !== card.id) } : c) }));
    try { await api.post(`/api/v1/leads/${card.id}/status`, { status: to, reason }); toast.success(`${card.name} → ${humanize(to)}`); onChanged(); }
    catch (e) { toast.error(e); board.reload(); }
  };

  return (
    <Card>
      <div className="table-toolbar">
        <h3>Pipeline board</h3>
        <form onSubmit={e => { e.preventDefault(); setF('search', search); }}><SearchInput value={search} onChange={v => { setSearch(v); if (!v) setF('search', ''); }} placeholder="Search and press Enter" /></form>
        <select className="select input-sm" style={{ width: 'auto', minWidth: 140, height: 34, fontSize: 13 }} aria-label="Source" value={filters.source} onChange={e => setF('source', e.target.value)}><option value="">Source: All</option>{sourceOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        <div style={{ minWidth: 160 }}><MemberSelect value={filters.owner || null} onChange={v => setF('owner', v ?? '')} placeholder="Owner: All" /></div>
        {editable && <span className="muted small">Drag cards between columns to change status.</span>}
      </div>
      <div style={{ padding: 16 }}>
        {board.error ? <ErrorState error={board.error} retry={board.reload} /> : !board.data ? <LoadingBlock rows={6} /> : (
          <div className="kanban crm-kanban">
            {board.data.columns.map((col: any) => {
              const allowed = drag ? col.allowed_from.includes(drag.lead_status ?? 'new') : true;
              return (
                <div key={col.status} className={`kcol ${over === col.status && allowed ? 'drop' : ''} ${drag && !allowed && col.status !== (drag.lead_status ?? 'new') ? 'blocked' : ''}`}
                  onDragOver={(e: DragEvent) => { if (drag && allowed) { e.preventDefault(); setOver(col.status); } }} onDragLeave={() => setOver(o => (o === col.status ? null : o))}
                  onDrop={(e: DragEvent) => { e.preventDefault(); if (allowed) drop(col.status); }} aria-label={`${col.label} column`}>
                  <div className="kcol-h"><span><StatusPill status={col.status} /> <span className="muted">{col.count}</span></span><span className="sum">{col.value_cents ? money(col.value_cents, 'USD', { compact: true }) + '/mo' : ''}</span></div>
                  {col.items.length === 0 && <div className="kcol-empty">{col.status === 'converted' ? 'Converted in the last 90 days appear here' : 'No leads'}</div>}
                  {col.items.map((c: any) => (
                    <div key={c.id} className={`kcard ${drag?.id === c.id ? 'dragging' : ''}`} draggable={editable && col.status !== 'converted'} onDragStart={() => setDrag(c)} onDragEnd={() => { setDrag(null); setOver(null); }}>
                      <Link to={`/crm/leads/${c.id}`} className="t">{c.name}</Link>
                      <div className="m"><span className="truncate">{c.contact_name ?? 'No contact'}</span><ScoreBadge score={c.lead_score} /></div>
                      <div className="m"><span>{c.source ?? '—'}</span><span>{c.est_monthly_value_cents ? money(Number(c.est_monthly_value_cents), c.currency, { compact: true }) + '/mo' : ''}</span></div>
                      <div className="m"><span>{c.owner_name ?? 'Unassigned'}</span>{c.next_follow_up && <span title="Next follow-up">↻ {shortDate(c.next_follow_up)}</span>}</div>
                    </div>
                  ))}
                  {col.count > col.items.length && <Link className="small" to={`/crm/leads?status=${col.status}`}>View all {col.count}</Link>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <ConvertDialog open={!!convert} onClose={() => { setConvert(null); board.reload(); }} lead={convert} />
    </Card>
  );
}
