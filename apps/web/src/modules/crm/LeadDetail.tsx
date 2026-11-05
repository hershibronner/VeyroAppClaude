import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, ArrowRightLeft, Mail, Phone, Globe, User, Calendar, PhoneCall, ListTodo, Send, XCircle, Pencil, RotateCcw, Archive, Trash2, Target } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { money, date, dateTime, humanize, relTime } from '../../lib/format';
import { Avatar, Banner, Boundary, Button, Card, CardHeader, ErrorState, KV, LoadingBlock, Menu, Meter, PageHeader, StatusPill, Tabs, useConfirm } from '../../components/ui';
import { Timeline } from '../../components/Timeline';
import { ScoreBadge, DuplicateWarning } from './common';
import { ConvertDialog, LeadForm, LogActivityDialog, SendEmailDialog, TaskForm, PermanentDeleteDialog } from './forms';
import { CompanyContacts, RelatedTasks } from './panels';

type TabKey = 'overview' | 'contacts' | 'activity' | 'tasks';

export default function LeadDetail() {
  const { id } = useParams();
  const { can, scope, me } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [rk, setRk] = useState(0);
  const st = useApi<any>(`/api/v1/leads/${id}`, [rk]);
  const [tab, setTab] = useState<TabKey>('overview');
  const [dialog, setDialog] = useState<null | 'edit' | 'convert' | 'log' | 'task' | 'email' | 'delete'>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => setRk(k => k + 1);

  if (st.error && !st.data) return <div><PageHeader title="Lead" back="/crm/leads" /><ErrorState error={st.error} retry={st.reload} /></div>;
  if (!st.data) return <LoadingBlock rows={8} />;
  const l = st.data;
  if (l.stage === 'client' || l.stage === 'inactive') return <Navigate to={`/crm/clients/${l.id}`} replace />;
  const status = l.lead_status ?? 'new';
  const editable = can('leads', 'edit');
  const pc = l.primary_contact;
  const canDelete = scope('leads', 'delete') === 'all' || (scope('leads', 'delete') === 'own' && (l.owner_id === me?.user.id || l.created_by === me?.user.id));
  const isOwnerAdmin = ['owner', 'admin'].includes(me?.workspace?.role.key ?? '');

  const qualify = async () => { setBusy(true); try { await api.post(`/api/v1/leads/${l.id}/qualify`); toast.success(`${l.name} qualified`); reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  const disqualify = async () => {
    const c = await confirm({ title: `Disqualify ${l.name}?`, body: 'The lead moves to Unqualified. You can reopen it later.', danger: true, confirmLabel: 'Disqualify', reason: { label: 'Reason', required: true, placeholder: 'e.g. Budget too small, chose a competitor…' } });
    if (!c.ok) return;
    try { await api.post(`/api/v1/leads/${l.id}/disqualify`, { reason: c.reason }); toast.success('Lead disqualified'); reload(); } catch (e) { toast.error(e); }
  };
  const reopen = async () => { try { await api.post(`/api/v1/leads/${l.id}/status`, { status: 'new' }); toast.success('Lead reopened'); reload(); } catch (e) { toast.error(e); } };
  const archive = async () => {
    const c = await confirm({ title: `Archive ${l.name}?`, body: 'Archived leads are hidden from lists and the board. History is kept.', danger: true, confirmLabel: 'Archive' });
    if (!c.ok) return;
    try { await api.del(`/api/v1/leads/${l.id}`); toast.success('Lead archived'); nav('/crm/leads'); } catch (e) { toast.error(e); }
  };

  return (
    <div>
      <PageHeader title={l.name} back="/crm/leads" />
      <Card className="mb-3">
        <div className="detail-head">
          <Avatar name={l.name} size={52} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="row" style={{ gap: 10 }}>
              <StatusPill status={status} />
              <ScoreBadge score={l.lead_score} />
              <span className="muted small">{l.source ?? 'Unknown source'}{l.campaign ? ` · ${l.campaign}` : ''}</span>
            </div>
            <div className="detail-meta">
              <span><User size={14} /> Owner: {l.owner_name ?? 'Unassigned'}</span>
              {pc && <span><Target size={14} /> {[pc.first_name, pc.last_name].filter(Boolean).join(' ')}{pc.title ? `, ${pc.title}` : ''}</span>}
              {pc?.email && <span><Mail size={14} /> <a href={`mailto:${pc.email}`}>{pc.email}</a></span>}
              {pc?.phone && <span><Phone size={14} /> <a href={`tel:${pc.phone}`}>{pc.phone}</a></span>}
              {l.website && <span><Globe size={14} /> <a href={l.website} target="_blank" rel="noreferrer">{l.domain ?? l.website}</a></span>}
              {l.next_follow_up && <span className={l.next_follow_up < new Date().toISOString().slice(0, 10) ? 'down' : ''}><Calendar size={14} /> Follow up {date(l.next_follow_up)}</span>}
            </div>
          </div>
          <div className="crm-head-actions">
            {editable && ['new', 'contacted'].includes(status) && <Button icon={<CheckCircle2 size={16} />} loading={busy} onClick={qualify}>Qualify</Button>}
            {editable && can('clients', 'create') && l.can_convert && <Button variant="primary" icon={<ArrowRightLeft size={16} />} onClick={() => setDialog('convert')}>Convert</Button>}
            <Menu items={[
              { label: 'Log call / email / meeting', icon: <PhoneCall size={15} />, onClick: () => setDialog('log'), hidden: !can('activities', 'create') && !editable },
              { label: 'Create follow-up task', icon: <ListTodo size={15} />, onClick: () => setDialog('task'), hidden: !can('tasks', 'create') },
              { label: 'Send email', icon: <Send size={15} />, onClick: () => setDialog('email'), hidden: !editable },
              { label: 'Edit lead', icon: <Pencil size={15} />, onClick: () => setDialog('edit'), hidden: !editable },
              { sep: true },
              { label: 'Reopen lead', icon: <RotateCcw size={15} />, onClick: reopen, hidden: !editable || status !== 'unqualified' },
              { label: 'Disqualify', icon: <XCircle size={15} />, danger: true, onClick: disqualify, hidden: !editable || !['new', 'contacted', 'qualified'].includes(status) },
              { label: 'Archive', icon: <Archive size={15} />, danger: true, onClick: archive, hidden: !canDelete },
              { label: 'Permanently delete', icon: <Trash2 size={15} />, danger: true, onClick: () => setDialog('delete'), hidden: !isOwnerAdmin },
            ]} />
          </div>
        </div>
      </Card>
      {status === 'unqualified' && <Banner tone="danger">Disqualified{l.disqualify_reason ? `: ${l.disqualify_reason}` : ''}.</Banner>}

      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'contacts', label: 'Contacts', count: l.contacts.length }, { key: 'activity', label: 'Activity' }, { key: 'tasks', label: 'Tasks', count: l.open_tasks }]} />
      {tab === 'overview' && (
        <div className="grid-main-side">
          <Boundary label="Lead details">
            <Card>
              <CardHeader title="Lead details" />
              <div className="card-b" style={{ padding: 22 }}>
                <KV items={[
                  ['Company', l.name], ['Website', l.website ? <a href={l.website} target="_blank" rel="noreferrer">{l.website}</a> : null], ['Industry', l.industry ? humanize(l.industry) : null], ['Size', l.size ? `${l.size} employees` : null],
                  ['Country', l.country], ['Phone', l.phone], ['Email', l.email], ['Source', l.source], ['Campaign', l.campaign], ['Owner', l.owner_name],
                  ['Estimated workers', l.est_workers], ['Estimated monthly value', l.est_monthly_value_cents ? money(Number(l.est_monthly_value_cents), l.currency) : null],
                  ['Next follow-up', l.next_follow_up ? date(l.next_follow_up) : null], ['Created', `${dateTime(l.created_at)}${l.created_by_name ? ` by ${l.created_by_name}` : ''}`], ['Notes', l.notes ? <span style={{ whiteSpace: 'pre-wrap' }}>{l.notes}</span> : null],
                ]} />
                <DuplicateWarning name={l.name} website={l.website ?? ''} email={pc?.email ?? ''} exclude={l.id} />
              </div>
            </Card>
          </Boundary>
          <div className="stack">
            <Card pad>
              <div className="row" style={{ justifyContent: 'space-between' }}><b>Lead score</b><ScoreBadge score={l.lead_score} /></div>
              <div className="mt-2"><Meter value={l.lead_score} /></div>
              <div className="mt-2">{l.score_events.length === 0 ? <div className="muted small">Calls, meetings and emails raise the score.</div> : l.score_events.map((e: any, i: number) => (
                <div key={i} className="row small" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-2)' }}><span>{e.reason}</span><span><b className={e.delta >= 0 ? 'up' : 'down'}>{e.delta >= 0 ? '+' : ''}{e.delta}</b> <span className="muted">{relTime(e.created_at)}</span></span></div>
              ))}</div>
            </Card>
            {can('opportunities', 'view') && (
              <Card pad>
                <b>Opportunities</b>
                {l.opportunities.length === 0 ? <div className="muted small mt-1">None yet — one can be created when converting.</div> : l.opportunities.map((o: any) => (
                  <div key={o.id} className="row small mt-2" style={{ justifyContent: 'space-between' }}><Link to={`/crm/opportunities/${o.id}`}>{o.name}</Link><span><StatusPill status={o.stage} /> {money(Number(o.value_cents), o.currency, { noCents: true })}</span></div>
                ))}
              </Card>
            )}
          </div>
        </div>
      )}
      {tab === 'contacts' && <Card pad><CompanyContacts companyId={l.id} onChanged={reload} /></Card>}
      {tab === 'activity' && <Card pad><Timeline type="company" id={l.id} reloadKey={rk} /></Card>}
      {tab === 'tasks' && <Card pad><RelatedTasks type="company" id={l.id} label={l.name} onChanged={reload} /></Card>}

      <LeadForm open={dialog === 'edit'} onClose={() => setDialog(null)} lead={l} onSaved={reload} />
      <ConvertDialog open={dialog === 'convert'} onClose={() => setDialog(null)} lead={l} />
      <LogActivityDialog open={dialog === 'log'} onClose={() => setDialog(null)} type="company" id={l.id} onDone={() => { reload(); setTab('activity'); }} />
      <TaskForm open={dialog === 'task'} onClose={() => setDialog(null)} related={{ type: 'company', id: l.id, label: l.name }} onSaved={() => { reload(); setTab('tasks'); }} />
      <SendEmailDialog open={dialog === 'email'} onClose={() => setDialog(null)} leadId={l.id} contacts={l.contacts} onDone={() => { reload(); setTab('activity'); }} />
      {isOwnerAdmin && <PermanentDeleteDialog open={dialog === 'delete'} onClose={() => setDialog(null)} company={l} onDeleted={() => nav('/crm/leads')} />}
    </div>
  );
}
