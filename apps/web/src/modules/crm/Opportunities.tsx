import { useState, type DragEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, LayoutGrid, List, CircleDollarSign, Scale, Trophy, Percent } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { money, shortDate, humanize, num } from '../../lib/format';
import { Banner, Boundary, Button, Card, ErrorState, KpiRow, LoadingBlock, MemberSelect, PageHeader, Person, RangeSelect, Segmented, StatusPill, SearchInput, useConfirm } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { ChartCard, TrackBars, fmtMoneyCompact } from '../../components/charts';
import { OPP_STAGES, sourceOpts, companyLink } from './common';
import { OpportunityForm, WonDialog } from './forms';

export default function Opportunities() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') === 'table' ? 'table' : 'board';
  const [months, setMonths] = useState(6);
  const [creating, setCreating] = useState(false);
  const [rk, setRk] = useState(0);
  const st = useApi<any>(`/api/v1/opportunities/stats?months=${months}`, [months, rk]);
  const s = st.data;
  const setView = (v: string) => { const n = new URLSearchParams(sp); if (v === 'board') n.delete('view'); else n.set('view', v); setSp(n, { replace: true }); };
  return (
    <div>
      <PageHeader title="Opportunities" sub="Deals in the sales pipeline. Winning one can activate the client and open a position."
        actions={<>
          <Segmented value={view} onChange={setView} options={[{ key: 'board', label: <><LayoutGrid size={14} /> Board</> }, { key: 'table', label: <><List size={14} /> Table</> }]} />
          <Button onClick={() => nav('/crm/opportunities?view=table&overdue=true')}>Past close date</Button>
          {can('opportunities', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New Opportunity</Button>}
        </>} />
      {s && s.overdue_close > 0 && <Banner tone="warn"><b>{s.overdue_close} open opportunit{s.overdue_close > 1 ? 'ies are' : 'y is'} past the expected close date.</b> <Link to="/crm/opportunities?view=table&overdue=true">Update them</Link>{s.closing_30d ? ` · ${s.closing_30d} expected to close in the next 30 days.` : ''}</Banner>}
      <Boundary label="Opportunity KPIs">
        {st.error ? <ErrorState error={st.error} retry={st.reload} /> : (
          <KpiRow items={[
            { label: 'Open pipeline', icon: <CircleDollarSign size={16} />, value: s ? money(s.pipeline_cents, 'USD', { noCents: true }) : '…', deltaText: s ? <span className="muted">{s.open_count} open deals</span> : undefined, suffix: '', to: '/crm/opportunities?view=table&open=true' },
            { label: 'Weighted pipeline', icon: <Scale size={16} />, value: s ? money(s.weighted_cents, 'USD', { noCents: true }) : '…', deltaText: s ? <span className="muted">value × probability</span> : undefined, suffix: '', to: '/crm/opportunities?view=table&open=true&sort=weighted_cents' },
            { label: 'Won this month', icon: <Trophy size={16} />, value: s ? num(s.won_this_month) : '…', delta: s?.won_delta, to: s ? `/crm/opportunities?view=table&stage=won&closed_from=${s.month_start}` : undefined },
            { label: 'Win rate', icon: <Percent size={16} />, value: s ? (s.win_rate === null ? '—' : `${s.win_rate}%`) : '…', deltaText: s ? <span className="muted">{s.won_total} won · {s.lost_total} lost</span> : undefined, suffix: '', to: '/crm/opportunities?view=table&stage=won,lost' },
          ]} />
        )}
      </Boundary>
      <div className="mb-3">
        <Boundary label="Won revenue">
          <ChartCard title="Won deal value" big={s ? money(s.won_trend.reduce((a: number, t: any) => a + t.value, 0), 'USD', { noCents: true }) : undefined} delta={<span className="muted">monthly value won in the period</span>} control={<RangeSelect value={months} onChange={setMonths} />}>
            {!s ? <LoadingBlock rows={3} /> : <TrackBars data={s.won_trend} fmt={fmtMoneyCompact} height={200} valueName="Won" />}
          </ChartCard>
        </Boundary>
      </div>
      {view === 'board' ? <OppBoard reloadKey={rk} onChanged={() => setRk(k => k + 1)} /> : <OppTable reloadKey={rk} />}
      <OpportunityForm open={creating} onClose={() => setCreating(false)} onSaved={r => { setRk(k => k + 1); nav(`/crm/opportunities/${r.id}`); }} />
    </div>
  );
}

function OppTable({ reloadKey }: { reloadKey: number }) {
  const columns: Column<any>[] = [
    { key: 'name', label: 'Opportunity', sortable: true, mobile: 'title', render: r => <Link to={`/crm/opportunities/${r.id}`} className="bold" onClick={e => e.stopPropagation()}>{r.name}</Link> },
    { key: 'company_name', label: 'Company', sortable: true, mobile: 'subtitle', render: r => r.company_id ? <Link to={companyLink({ id: r.company_id, stage: r.company_stage })} onClick={e => e.stopPropagation()}>{r.company_name}</Link> : <span className="muted">—</span> },
    { key: 'stage', label: 'Stage', sortable: true, render: r => <StatusPill status={r.stage} /> },
    { key: 'value_cents', label: 'Value / mo', sortable: true, align: 'right', render: r => money(Number(r.value_cents), r.currency, { noCents: true }), csv: r => Number(r.value_cents) / 100 },
    { key: 'probability', label: 'Prob.', sortable: true, align: 'center', render: r => `${r.probability}%` },
    { key: 'weighted_cents', label: 'Weighted', sortable: true, align: 'right', mobile: 'hidden', render: r => money(Number(r.weighted_cents), r.currency, { noCents: true }), csv: r => Number(r.weighted_cents) / 100 },
    { key: 'est_workers', label: 'Workers', align: 'center', mobile: 'hidden' },
    { key: 'expected_close', label: 'Expected close', sortable: true, render: r => r.expected_close ? <span className={r.expected_close < new Date().toISOString().slice(0, 10) && !['won', 'lost'].includes(r.stage) ? 'down bold' : ''}>{shortDate(r.expected_close)}</span> : <span className="muted">—</span> },
    { key: 'owner_name', label: 'Owner', sortable: true, render: r => r.owner_name ? <Person name={r.owner_name} color={r.owner_color} size={24} /> : <span className="muted">—</span> },
  ];
  return (
    <DataTable title="All opportunities" endpoint="/api/v1/opportunities" columns={columns} reloadKey={reloadKey} rowLink={r => `/crm/opportunities/${r.id}`} exportName="opportunities" exportResource="opportunities"
      filters={[{ key: 'stage', label: 'Stage', options: opts(OPP_STAGES) }, { key: 'owner', label: 'Owner', type: 'member' }, { key: 'source', label: 'Source', options: sourceOpts }, { key: 'open', label: 'Open only', type: 'boolean' }, { key: 'overdue', label: 'Past close date', type: 'boolean' }, { key: 'closed_from', label: 'Closed from', type: 'date' }]}
      emptyTitle="No opportunities yet" />
  );
}

function OppBoard({ reloadKey, onChanged }: { reloadKey: number; onChanged: () => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const filters = { search: sp.get('search') ?? '', owner: sp.get('owner') ?? '', company_id: sp.get('company_id') ?? '' };
  const setF = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const [search, setSearch] = useState(filters.search);
  const board = useApi<any>(`/api/v1/opportunities/board${qs(filters)}`, [reloadKey]);
  const [drag, setDrag] = useState<any>(null); const [over, setOver] = useState<string | null>(null);
  const [won, setWon] = useState<any>(null);
  const editable = can('opportunities', 'edit');
  const drop = async (to: string) => {
    const card = drag; setDrag(null); setOver(null);
    if (!card || card.stage === to) return;
    if (to === 'won') { setWon(card); return; }
    let lost_reason: string | undefined;
    if (to === 'lost') { const c = await confirm({ title: `Mark ${card.name} as lost?`, danger: true, confirmLabel: 'Mark lost', reason: { label: 'Why was it lost?', required: true } }); if (!c.ok) return; lost_reason = c.reason; }
    board.setData((d: any) => d && ({ columns: d.columns.map((c: any) => c.stage === to ? { ...c, count: c.count + 1, value_cents: c.value_cents + Number(card.value_cents), items: [{ ...card, stage: to }, ...c.items] } : c.stage === card.stage ? { ...c, count: c.count - 1, value_cents: c.value_cents - Number(card.value_cents), items: c.items.filter((i: any) => i.id !== card.id) } : c) }));
    try { await api.post(`/api/v1/opportunities/${card.id}/stage`, { stage: to, lost_reason }); toast.success(`${card.name} → ${humanize(to)}`); onChanged(); }
    catch (e) { toast.error(e); board.reload(); }
  };
  return (
    <Card>
      <div className="table-toolbar">
        <h3>Pipeline</h3>
        <form onSubmit={e => { e.preventDefault(); setF('search', search); }}><SearchInput value={search} onChange={v => { setSearch(v); if (!v) setF('search', ''); }} placeholder="Search and press Enter" /></form>
        <div style={{ minWidth: 160 }}><MemberSelect value={filters.owner || null} onChange={v => setF('owner', v ?? '')} placeholder="Owner: All" /></div>
        {editable && <span className="muted small">Drag deals between stages. Won/Lost show the last 90 days.</span>}
      </div>
      <div style={{ padding: 16 }}>
        {board.error ? <ErrorState error={board.error} retry={board.reload} /> : !board.data ? <LoadingBlock rows={6} /> : (
          <div className="kanban crm-kanban">
            {board.data.columns.map((col: any) => {
              const allowed = drag ? col.allowed_from.includes(drag.stage) : true;
              return (
                <div key={col.stage} className={`kcol ${over === col.stage && allowed ? 'drop' : ''} ${drag && !allowed && col.stage !== drag.stage ? 'blocked' : ''}`}
                  onDragOver={(e: DragEvent) => { if (drag && allowed) { e.preventDefault(); setOver(col.stage); } }} onDragLeave={() => setOver(o => (o === col.stage ? null : o))} onDrop={(e: DragEvent) => { e.preventDefault(); if (allowed) drop(col.stage); }}>
                  <div className="kcol-h"><span><StatusPill status={col.stage} /> <span className="muted">{col.count}</span></span><span className="sum">{money(col.value_cents, 'USD', { compact: true })}</span></div>
                  {col.items.length === 0 && <div className="kcol-empty">No deals</div>}
                  {col.items.map((o: any) => (
                    <div key={o.id} className={`kcard ${drag?.id === o.id ? 'dragging' : ''}`} draggable={editable && !['won'].includes(o.stage)} onDragStart={() => setDrag(o)} onDragEnd={() => { setDrag(null); setOver(null); }}>
                      <Link to={`/crm/opportunities/${o.id}`} className="t">{o.name}</Link>
                      <div className="m"><span className="truncate">{o.company_name ?? 'No company'}</span><b>{money(Number(o.value_cents), o.currency, { compact: true })}</b></div>
                      <div className="m"><span>{o.owner_name ?? 'Unassigned'}</span><span>{o.probability}%{o.expected_close ? ` · ${shortDate(o.expected_close)}` : ''}</span></div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <WonDialog open={!!won} onClose={() => setWon(null)} opp={won} onDone={() => { board.reload(); onChanged(); }} />
    </Card>
  );
}
