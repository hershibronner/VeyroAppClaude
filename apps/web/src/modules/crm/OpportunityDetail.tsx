import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Building2, User, Calendar, Trophy, Pencil, ListTodo, Archive, ArrowRight, XCircle, RotateCcw, PhoneCall } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { money, date, dateTime, humanize } from '../../lib/format';
import { Avatar, Banner, Button, Card, CardHeader, ErrorState, KV, LoadingBlock, Menu, Meter, PageHeader, StatusPill, Tabs, useConfirm } from '../../components/ui';
import { Timeline } from '../../components/Timeline';
import { companyLink } from './common';
import { LogActivityDialog, OpportunityForm, TaskForm, WonDialog } from './forms';
import { RelatedTasks } from './panels';

export default function OpportunityDetail() {
  const { id } = useParams();
  const { can, scope, me } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [rk, setRk] = useState(0);
  const st = useApi<any>(`/api/v1/opportunities/${id}`, [rk]);
  const [tab, setTab] = useState<'overview' | 'activity' | 'tasks'>('overview');
  const [dialog, setDialog] = useState<null | 'edit' | 'won' | 'task' | 'log'>(null);
  const reload = () => setRk(k => k + 1);
  if (st.error && !st.data) return <div><PageHeader title="Opportunity" back="/crm/opportunities" /><ErrorState error={st.error} retry={st.reload} /></div>;
  if (!st.data) return <LoadingBlock rows={6} />;
  const o = st.data;
  const editable = can('opportunities', 'edit');
  const next: string[] = o.allowed_next;
  const forward = next.filter(s => !['won', 'lost'].includes(s) && ['new', 'discovery', 'proposal', 'negotiation'].indexOf(s) > ['new', 'discovery', 'proposal', 'negotiation'].indexOf(o.stage));
  const move = async (stage: string) => {
    let lost_reason: string | undefined;
    if (stage === 'lost') { const c = await confirm({ title: `Mark ${o.name} as lost?`, danger: true, confirmLabel: 'Mark lost', reason: { label: 'Why was it lost?', required: true } }); if (!c.ok) return; lost_reason = c.reason; }
    try { await api.post(`/api/v1/opportunities/${o.id}/stage`, { stage, lost_reason }); toast.success(`Moved to ${humanize(stage)}`); reload(); } catch (e) { toast.error(e); }
  };
  const canDelete = scope('opportunities', 'delete') === 'all' || (scope('opportunities', 'delete') === 'own' && (o.owner_id === me?.user.id));
  const archive = async () => {
    const c = await confirm({ title: `Archive ${o.name}?`, danger: true, confirmLabel: 'Archive' });
    if (!c.ok) return; try { await api.del(`/api/v1/opportunities/${o.id}`); toast.success('Opportunity archived'); nav('/crm/opportunities'); } catch (e) { toast.error(e); }
  };
  return (
    <div>
      <PageHeader title={o.name} back="/crm/opportunities" />
      <Card className="mb-3">
        <div className="detail-head">
          <Avatar name={o.company_name ?? o.name} size={52} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="row" style={{ gap: 10 }}><StatusPill status={o.stage} /><b>{money(Number(o.value_cents), o.currency)}</b><span className="muted small">/ month · {o.probability}% probability</span></div>
            <div className="detail-meta">
              <span><Building2 size={14} /> {o.company_id ? <Link to={companyLink({ id: o.company_id, stage: o.company_stage })}>{o.company_name}</Link> : 'No company'}</span>
              <span><User size={14} /> Owner: {o.owner_name ?? 'Unassigned'}</span>
              {o.contact_name && <span><User size={14} /> <Link to={`/crm/contacts/${o.contact_id}`}>{o.contact_name}</Link></span>}
              {o.expected_close && <span><Calendar size={14} /> Close {date(o.expected_close)}</span>}
            </div>
          </div>
          <div className="crm-head-actions">
            {editable && forward[0] && <Button icon={<ArrowRight size={16} />} onClick={() => move(forward[0])}>Move to {humanize(forward[0])}</Button>}
            {editable && next.includes('won') && <Button variant="success" icon={<Trophy size={16} />} onClick={() => setDialog('won')}>Mark won</Button>}
            <Menu items={[
              { label: 'Edit', icon: <Pencil size={15} />, onClick: () => setDialog('edit'), hidden: !editable },
              { label: 'Log call / email / meeting', icon: <PhoneCall size={15} />, onClick: () => setDialog('log') },
              { label: 'Create task', icon: <ListTodo size={15} />, onClick: () => setDialog('task'), hidden: !can('tasks', 'create') },
              ...next.filter(s => !['won', 'lost'].includes(s) && s !== forward[0]).map(s => ({ label: `Move to ${humanize(s)}`, icon: s === 'new' ? <RotateCcw size={15} /> : <ArrowRight size={15} />, onClick: () => move(s), hidden: !editable })),
              { sep: true },
              { label: 'Mark lost', icon: <XCircle size={15} />, danger: true, onClick: () => move('lost'), hidden: !editable || !next.includes('lost') },
              { label: 'Archive', icon: <Archive size={15} />, danger: true, onClick: archive, hidden: !canDelete || o.stage === 'won' },
            ]} />
          </div>
        </div>
      </Card>
      {o.stage === 'lost' && <Banner tone="danger">Lost{o.lost_reason ? `: ${o.lost_reason}` : ''}{o.closed_at ? ` · ${date(o.closed_at)}` : ''}.</Banner>}
      {o.stage === 'won' && <Banner tone="success">Won on {date(o.closed_at)}.{o.positions.length ? ` ${o.positions.length} position${o.positions.length > 1 ? 's' : ''} linked.` : ''}</Banner>}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'activity', label: 'Activity' }, { key: 'tasks', label: 'Tasks' }]} />
      {tab === 'overview' && (
        <div className="grid-main-side">
          <Card><CardHeader title="Deal details" /><div style={{ padding: 22 }}><KV items={[
            ['Stage', <StatusPill key="s" status={o.stage} />], ['Monthly value', money(Number(o.value_cents), o.currency)], ['Weighted value', money(Number(o.weighted_cents), o.currency)],
            ['Estimated workers', o.est_workers], ['Probability', <div key="p" style={{ maxWidth: 220 }}><Meter value={o.probability} /> <span className="small">{o.probability}%</span></div>],
            ['Expected close', o.expected_close ? date(o.expected_close) : null], ['Source', o.source], ['Campaign', o.campaign], ['Created', `${dateTime(o.created_at)}${o.created_by_name ? ` by ${o.created_by_name}` : ''}`],
          ]} /></div></Card>
          <div className="stack">
            <Card pad><b>Positions</b>{o.positions.length === 0 ? <div className="muted small mt-1">{o.stage === 'won' ? 'No position was created for this deal.' : 'A position can be created when the deal is won.'}</div> : o.positions.map((p: any) => (
              <div key={p.id} className="row small mt-2" style={{ justifyContent: 'space-between' }}><Link to={`/recruiting/positions/${p.id}`}>{p.title}</Link><span><StatusPill status={p.status} /> {p.filled}/{p.openings}</span></div>
            ))}</Card>
            {o.contact_name && <Card pad><b>Contact</b><div className="small mt-1"><Link to={`/crm/contacts/${o.contact_id}`}>{o.contact_name}</Link>{o.contact_title ? ` · ${o.contact_title}` : ''}</div><div className="small muted">{[o.contact_email, o.contact_phone].filter(Boolean).join(' · ') || '—'}</div></Card>}
          </div>
        </div>
      )}
      {tab === 'activity' && <Card pad><Timeline type="opportunity" id={o.id} reloadKey={rk} /></Card>}
      {tab === 'tasks' && <Card pad><RelatedTasks type="opportunity" id={o.id} label={o.name} /></Card>}
      <OpportunityForm open={dialog === 'edit'} onClose={() => setDialog(null)} opp={o} onSaved={reload} />
      <WonDialog open={dialog === 'won'} onClose={() => setDialog(null)} opp={o} onDone={reload} />
      <TaskForm open={dialog === 'task'} onClose={() => setDialog(null)} related={{ type: 'opportunity', id: o.id, label: o.name }} onSaved={() => setTab('tasks')} />
      <LogActivityDialog open={dialog === 'log'} onClose={() => setDialog(null)} type="opportunity" id={o.id} onDone={() => { reload(); setTab('activity'); }} />
    </div>
  );
}
