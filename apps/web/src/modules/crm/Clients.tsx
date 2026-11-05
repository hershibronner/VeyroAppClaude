import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, Users, Briefcase, AlertTriangle, Plus, Sparkles } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { humanize, num } from '../../lib/format';
import { Banner, Boundary, ErrorState, KpiRow, PageHeader, Person, StatusPill, RangeSelect, LoadingBlock, Button } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { ChartCard, TrackBars, TrendLine, fmtNum } from '../../components/charts';
import { industryOpts, sourceOpts } from './common';
import { ClientForm } from './forms';

export default function Clients() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [months, setMonths] = useState(6);
  const [creating, setCreating] = useState(false);
  const [rk, setRk] = useState(0);
  const st = useApi<any>(`/api/v1/companies/client-stats?months=${months}`, [months, rk]);
  const s = st.data;
  const columns: Column<any>[] = [
    { key: 'name', label: 'Client', sortable: true, mobile: 'title', render: r => <div><Link to={`/crm/clients/${r.id}`} className="bold" onClick={e => e.stopPropagation()}>{r.name}</Link><div className="muted small">{[r.industry && humanize(r.industry), r.country].filter(Boolean).join(' · ') || '—'}</div></div> },
    { key: 'stage', label: 'Status', render: r => <StatusPill status={r.stage === 'client' ? 'active' : 'inactive'} label={r.stage === 'client' ? 'Active' : 'Inactive'} tone={r.stage === 'client' ? 'green' : 'gray'} />, csv: r => (r.stage === 'client' ? 'Active' : 'Inactive') },
    { key: 'primary_contact_name', label: 'Primary contact', mobile: 'subtitle', render: r => r.primary_contact_name ? <div><div>{r.primary_contact_name}</div><div className="muted small">{r.primary_contact_email ?? r.primary_contact_phone ?? ''}</div></div> : <span className="muted">—</span> },
    { key: 'account_manager_name', label: 'Account manager', sortable: true, render: r => r.account_manager_name ? <Person name={r.account_manager_name} color={r.account_manager_color} size={24} /> : <span className="muted">Unassigned</span> },
    { key: 'open_roles', label: 'Open roles', sortable: true, align: 'center', render: r => r.open_roles || <span className="muted">0</span> },
    { key: 'active_workers', label: 'Active workers', sortable: true, align: 'center', render: r => <span>{r.active_workers}{r.onboarding_workers ? <span className="muted small"> +{r.onboarding_workers} onboarding</span> : null}</span>, csv: r => r.active_workers },
    { key: 'attention', label: 'Attention', render: r => r.attention ? <span className="pill pill-red" title={r.attention_reasons.join(', ')}><AlertTriangle size={12} /> {r.attention_reasons[0] ?? 'Needs attention'}{r.attention_reasons.length > 1 ? ` +${r.attention_reasons.length - 1}` : ''}</span> : <span className="muted small">OK</span>, csv: r => r.attention_reasons.join('; ') },
  ];
  return (
    <div>
      <PageHeader title="Clients" sub="Active and inactive client companies with live hiring and workforce counts."
        actions={<>
          <RangeSelect value={months} onChange={setMonths} />
          {can('leads', 'view') && <Button onClick={() => nav('/crm/leads?status=qualified')}>Qualified leads</Button>}
          {can('clients', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New Client</Button>}
        </>} />
      {s && s.needs_attention > 0 && <Banner tone="warn"><b>{s.needs_attention} client{s.needs_attention > 1 ? 's need' : ' needs'} attention</b> — {[s.overdue_invoices ? `${s.overdue_invoices} overdue invoice${s.overdue_invoices > 1 ? 's' : ''}` : null, s.late_today ? `${s.late_today} late/absent worker${s.late_today > 1 ? 's' : ''} today` : null, s.open_issues ? `${s.open_issues} open issue${s.open_issues > 1 ? 's' : ''}` : null].filter(Boolean).join(', ') || 'billing or workforce issues'}. <Link to="/crm/clients?attention=true&stage=client">Review them</Link>.</Banner>}
      <Boundary label="Client KPIs">
        {st.error ? <ErrorState error={st.error} retry={st.reload} /> : (
          <KpiRow items={[
            { label: 'Active clients', icon: <Building2 size={16} />, value: s ? num(s.active_clients) : '…', delta: s?.active_delta, to: '/crm/clients?stage=client' },
            { label: 'New this month', icon: <Sparkles size={16} />, value: s ? num(s.new_this_month) : '…', delta: s?.new_delta, deltaText: s && s.new_delta === null ? <span className="muted">{s.new_last_month} last month</span> : undefined, suffix: '', to: s ? `/crm/clients?stage=client&converted_from=${s.month_start}` : undefined },
            { label: 'Active workers', icon: <Users size={16} />, value: s ? num(s.active_workers) : '…', deltaText: s ? <span className="muted">at {s.clients_with_workers} client{s.clients_with_workers === 1 ? '' : 's'}</span> : undefined, suffix: '', to: '/crm/clients?stage=client&has_workers=true' },
            { label: 'Open roles', icon: <Briefcase size={16} />, value: s ? num(s.open_roles) : '…', deltaText: s ? <span className={s.needs_attention ? 'down' : 'muted'}>{s.needs_attention} need attention</span> : undefined, suffix: '', to: '/crm/clients?stage=client&open_roles=true' },
          ]} />
        )}
      </Boundary>
      <div className="grid-2 mb-3">
        <Boundary label="Active workers by client">
          <ChartCard title="Active workers by client" big={s ? num(s.active_workers) : undefined}>
            {!s ? <LoadingBlock rows={4} /> : s.workers_by_client.length === 0 ? <div className="muted">No active placements yet.</div> : <TrackBars data={s.workers_by_client} fmt={fmtNum} height={240} valueName="Workers" onBarClick={(d: any) => nav(`/crm/clients/${d.id}`)} />}
          </ChartCard>
        </Boundary>
        <Boundary label="Client growth">
          <ChartCard title="Client base" big={s ? num(s.client_trend.at(-1)?.value ?? 0) : undefined} control={<RangeSelect value={months} onChange={setMonths} />}>
            {!s ? <LoadingBlock rows={4} /> : <TrendLine data={s.client_trend} fmt={v => `${v} clients`} height={240} />}
          </ChartCard>
        </Boundary>
      </div>
      <DataTable title="All clients" endpoint="/api/v1/companies" params={{ stage: 'client,inactive' }} columns={columns} reloadKey={rk} exportName="clients" exportResource="clients" rowLink={r => `/crm/clients/${r.id}`} defaultSort="name" defaultDir="asc"
        filters={[
          { key: 'stage', label: 'Status', options: [{ value: 'client', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'client,inactive', label: 'All clients' }] },
          { key: 'account_manager', label: 'Account manager', type: 'member' }, { key: 'industry', label: 'Industry', options: industryOpts },
          { key: 'attention', label: 'Needs attention', type: 'boolean' }, { key: 'source', label: 'Source', options: sourceOpts },
          { key: 'has_workers', label: 'Has active workers', type: 'boolean' }, { key: 'open_roles', label: 'Has open roles', type: 'boolean' }, { key: 'converted_from', label: 'Client since', type: 'date' },
        ]}
        emptyTitle="No clients yet" emptyText="Convert a qualified lead or add a client directly." />
      <ClientForm open={creating} onClose={() => setCreating(false)} onSaved={r => { setRk(k => k + 1); nav(`/crm/clients/${r.id}`); }} />
    </div>
  );
}
