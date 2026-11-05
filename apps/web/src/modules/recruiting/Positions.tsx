import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Lock } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { shortDate, humanize, money } from '../../lib/format';
import { Avatar, Banner, Button, PageHeader, StatusPill } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { PositionForm, useHiddenParams } from './shared';

export default function Positions() {
  const { can, me } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [rk, setRk] = useState(0);
  const hidden = useHiddenParams(sp, setSp, ['mine', 'unassigned']);
  const scope = me?.workspace?.recruitingScope;
  const cols: Column<any>[] = [
    { key: 'title', label: 'Position', sortable: true, mobile: 'title', render: r => <div><div className="bold">{r.title}{!r.can_edit && <Lock size={12} style={{ marginLeft: 6, color: 'var(--muted)' }} aria-label="Read only" />}</div><div className="small muted">{humanize(r.employment_type)}{r.weekly_hours ? ` · ${r.weekly_hours}h/wk` : ''}{r.timezone ? ` · ${r.timezone.split('/').pop()?.replace('_', ' ')}` : ''}</div></div> },
    { key: 'company_name', label: 'Client', sortable: true, mobile: 'subtitle', render: r => r.company_name ?? <span className="muted">No client yet</span> },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.status} /> },
    { key: 'urgency', label: 'Urgency', sortable: true, render: r => <StatusPill status={r.urgency} /> },
    { key: 'recruiters', label: 'Recruiters', render: r => r.recruiters?.length ? <div className="row" style={{ gap: 4 }}>{r.recruiters.slice(0, 3).map((u: any) => <span key={u.id} title={`${u.name}${u.is_lead ? ' (lead)' : ''}`} style={{ outline: u.is_lead ? '2px solid var(--primary)' : undefined, borderRadius: '50%' }}><Avatar name={u.name} color={u.avatar_color} size={26} /></span>)}{r.recruiters.length > 3 && <span className="small muted">+{r.recruiters.length - 3}</span>}</div> : <span className="muted">Unassigned</span>, csv: r => (r.recruiters ?? []).map((u: any) => u.name).join('; ') },
    { key: 'openings', label: 'Openings', align: 'right', sortable: true, render: r => `${r.placed_count}/${r.openings}` },
    { key: 'active_pipeline', label: 'Pipeline', align: 'right', sortable: true, render: r => r.active_pipeline },
    { key: 'applications_count', label: 'Applications', align: 'right' },
    { key: 'pay', label: 'Target pay', align: 'right', render: r => r.pay_min_cents ? `${money(r.pay_min_cents, r.currency)}–${money(r.pay_max_cents, r.currency)}` : '—', csv: r => r.pay_min_cents ? `${r.pay_min_cents / 100}-${(r.pay_max_cents ?? 0) / 100}` : '' },
    { key: 'created_at', label: 'Created', sortable: true, render: r => shortDate(r.created_at) },
  ];
  return (
    <div>
      <PageHeader title="Positions" sub={scope === 'assigned' ? 'Positions you are assigned to. Ask a manager to be added to others.' : 'Every open requisition, its recruiters and pipeline.'}
        actions={can('positions', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New position</Button>} />
      {scope === 'assigned' && <Banner>Your recruiting scope is <b>Assigned</b>: you see and edit only positions you are assigned to.</Banner>}
      <DataTable title="All positions" endpoint="/api/v1/positions" exportName="positions" exportResource="positions" columns={cols} reloadKey={rk} params={hidden.params} headerExtra={hidden.chips}
        filters={[{ key: 'status', label: 'Status', options: opts(['draft', 'open', 'on_hold', 'filled', 'closed']) }, { key: 'urgency', label: 'Urgency', options: opts(['critical', 'high', 'normal', 'low']) }, { key: 'recruiter_id', label: 'Recruiter', type: 'member' }, { key: 'health', label: 'Health', options: opts(['on_track', 'at_risk', 'critical']) }]}
        rowLink={r => `/recruiting/positions/${r.id}`} searchPlaceholder="Search title, client, skill"
        rowActions={(r, reload) => [
          { label: 'Open', onClick: () => nav(`/recruiting/positions/${r.id}`) },
          { label: 'Pipeline', onClick: () => nav(`/recruiting/positions/${r.id}?tab=pipeline`) },
          { label: 'Find best matches', onClick: () => nav(`/recruiting/positions/${r.id}?tab=matches`) },
          { label: 'Sourcing link & QR', onClick: () => nav(`/recruiting/positions/${r.id}?tab=sourcing`) },
          ...(r.can_edit && r.status === 'draft' ? [{ label: 'Open for sourcing', onClick: async () => { try { await api.post(`/api/v1/positions/${r.id}/status`, { status: 'open' }); toast.success('Position opened'); reload(); } catch (e) { toast.error(e); } } }] : []),
          ...(r.can_edit && r.status === 'open' ? [{ label: 'Put on hold', onClick: async () => { try { await api.post(`/api/v1/positions/${r.id}/status`, { status: 'on_hold' }); toast.success('Position on hold'); reload(); } catch (e) { toast.error(e); } } }] : []),
        ]}
        emptyTitle={scope === 'assigned' ? 'No positions assigned to you yet' : 'No positions yet'} emptyAction={can('positions', 'create') ? <Button size="sm" onClick={() => setCreating(true)}>Create a position</Button> : undefined} />
      <PositionForm open={creating} onClose={() => setCreating(false)} onSaved={p => { setRk(k => k + 1); nav(`/recruiting/positions/${p.id}`); }} />
    </div>
  );
}
