import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Mail, Phone, MessageCircle, Star, Building2, Pencil, ListTodo, PhoneCall, Archive, Plus, X, Shield } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { money, dateTime, humanize, relTime } from '../../lib/format';
import { Avatar, Button, Card, CardHeader, ErrorState, Field, KV, LoadingBlock, Menu, PageHeader, StatusPill, Tabs, useConfirm, EmptyState } from '../../components/ui';
import { Timeline } from '../../components/Timeline';
import { companyLink } from './common';
import { ContactForm, LogActivityDialog, TaskForm } from './forms';
import { RelatedTasks } from './panels';

const ICON: Record<string, any> = { email: Mail, phone: Phone, whatsapp: MessageCircle };

export default function ContactDetail() {
  const { id } = useParams();
  const { can, scope, me } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [rk, setRk] = useState(0);
  const st = useApi<any>(`/api/v1/contacts/${id}`, [rk]);
  const [tab, setTab] = useState<'overview' | 'activity' | 'tasks'>('overview');
  const [dialog, setDialog] = useState<null | 'edit' | 'task' | 'log'>(null);
  const reload = () => setRk(k => k + 1);
  if (st.error && !st.data) return <div><PageHeader title="Contact" back="/crm/contacts" /><ErrorState error={st.error} retry={st.reload} /></div>;
  if (!st.data) return <LoadingBlock rows={6} />;
  const c = st.data;
  const editable = can('contacts', 'edit');
  const canDelete = scope('contacts', 'delete') === 'all' || (scope('contacts', 'delete') === 'own' && c.created_by === me?.user.id);
  const archive = async () => {
    const r = await confirm({ title: `Archive ${c.name}?`, danger: true, confirmLabel: 'Archive' });
    if (!r.ok) return; try { await api.del(`/api/v1/contacts/${c.id}`); toast.success('Contact archived'); nav('/crm/contacts'); } catch (e) { toast.error(e); }
  };
  const togglePrimary = async () => { try { await api.patch(`/api/v1/contacts/${c.id}`, { is_primary: !c.is_primary }); toast.success(c.is_primary ? 'No longer primary contact' : 'Set as primary contact'); reload(); } catch (e) { toast.error(e); } };

  return (
    <div>
      <PageHeader title={c.name} back="/crm/contacts" />
      <Card className="mb-3">
        <div className="detail-head">
          <Avatar name={c.name} size={52} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="row" style={{ gap: 10 }}>
              {c.title && <span className="bold">{c.title}</span>}
              {c.is_primary && <span className="pill pill-blue"><Star size={11} /> Primary contact</span>}
              {c.portal_access && <span className="pill pill-green"><Shield size={11} /> Portal: {c.portal_access.role_name}</span>}
            </div>
            <div className="detail-meta">
              <span><Building2 size={14} /> {c.company ? <Link to={companyLink(c.company)}>{c.company.name}</Link> : 'No company'}</span>
              {c.email && <span><Mail size={14} /> <a href={`mailto:${c.email}`}>{c.email}</a></span>}
              {c.phone && <span><Phone size={14} /> <a href={`tel:${c.phone}`}>{c.phone}</a></span>}
            </div>
          </div>
          <div className="crm-head-actions">
            {editable && <Button variant="primary" icon={<Pencil size={16} />} onClick={() => setDialog('edit')}>Edit</Button>}
            <Menu items={[
              { label: 'Log call / email / meeting', icon: <PhoneCall size={15} />, onClick: () => setDialog('log') },
              { label: 'Create task', icon: <ListTodo size={15} />, onClick: () => setDialog('task'), hidden: !can('tasks', 'create') },
              { label: c.is_primary ? 'Remove primary flag' : 'Make primary contact', icon: <Star size={15} />, onClick: togglePrimary, hidden: !editable || !c.company_id },
              { sep: true },
              { label: 'Archive', icon: <Archive size={15} />, danger: true, onClick: archive, hidden: !canDelete },
            ]} />
          </div>
        </div>
      </Card>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'activity', label: 'Activity' }, { key: 'tasks', label: 'Tasks' }]} />
      {tab === 'overview' && (
        <div className="grid-main-side">
          <div className="stack">
            <Methods c={c} editable={editable} onChanged={reload} />
            <Card><CardHeader title="Details" /><div style={{ padding: 22 }}><KV items={[
              ['Name', c.name], ['Title', c.title], ['Company', c.company ? <Link to={companyLink(c.company)}>{c.company.name}</Link> : null], ['Company type', c.company ? humanize(c.company.stage === 'qualified' ? 'lead' : c.company.stage) : null],
              ['Account manager', c.company?.account_manager_name], ['Created', `${dateTime(c.created_at)}${c.created_by_name ? ` by ${c.created_by_name}` : ''}`], ['Notes', c.notes ? <span style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</span> : null],
            ]} /></div></Card>
          </div>
          <div className="stack">
            {can('opportunities', 'view') && <Card pad><b>Opportunities</b>{c.opportunities.length === 0 ? <div className="muted small mt-1">None linked.</div> : c.opportunities.map((o: any) => <div key={o.id} className="row small mt-2" style={{ justifyContent: 'space-between' }}><Link to={`/crm/opportunities/${o.id}`}>{o.name}</Link><span><StatusPill status={o.stage} /> {money(Number(o.value_cents), o.currency, { noCents: true })}</span></div>)}</Card>}
            <Card pad><b>Portal access</b><div className="small mt-1">{c.portal_access ? <>{c.portal_access.role_name} · {humanize(c.portal_access.status)} · {c.portal_access.last_login_at ? `last seen ${relTime(c.portal_access.last_login_at)}` : 'never signed in'}</> : <span className="muted">No portal access. Invite from the client page.</span>}</div></Card>
          </div>
        </div>
      )}
      {tab === 'activity' && <Card pad><Timeline type="contact" id={c.id} reloadKey={rk} /></Card>}
      {tab === 'tasks' && <Card pad><RelatedTasks type="contact" id={c.id} label={c.name} /></Card>}
      <ContactForm open={dialog === 'edit'} onClose={() => setDialog(null)} contact={c} onSaved={reload} />
      <TaskForm open={dialog === 'task'} onClose={() => setDialog(null)} related={{ type: 'contact', id: c.id, label: c.name }} onSaved={() => setTab('tasks')} />
      <LogActivityDialog open={dialog === 'log'} onClose={() => setDialog(null)} type="contact" id={c.id} onDone={() => { reload(); setTab('activity'); }} />
    </div>
  );
}

function Methods({ c, editable, onChanged }: { c: any; editable: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState('email'); const [value, setValue] = useState(''); const [label, setLabel] = useState('Work'); const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setErr(null);
    try { await api.post(`/api/v1/contacts/${c.id}/methods`, { kind, value, label }); toast.success('Added'); setValue(''); setAdding(false); onChanged(); }
    catch (e: any) { setErr(e?.fields?.value ?? e.message); }
  };
  const primary = async (m: any) => { try { await api.patch(`/api/v1/contacts/${c.id}/methods/${m.id}`, { is_primary: true }); onChanged(); } catch (e) { toast.error(e); } };
  const remove = async (m: any) => { try { await api.del(`/api/v1/contacts/${c.id}/methods/${m.id}`); toast.success('Removed'); onChanged(); } catch (e) { toast.error(e); } };
  return (
    <Card>
      <CardHeader title="Emails & phones" right={editable && !adding && <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add</Button>} />
      <div style={{ padding: '4px 22px 14px' }}>
        {c.methods.length === 0 && !adding && <EmptyState title="No contact methods" />}
        {c.methods.map((m: any) => { const Ic = ICON[m.kind] ?? Mail; return (
          <div key={m.id} className="crm-method">
            <Ic size={16} className="muted" />
            <div className="v">{m.kind === 'email' ? <a href={`mailto:${m.value}`}>{m.value}</a> : <a href={`tel:${m.value}`}>{m.value}</a>} <span className="muted small">{m.label ?? humanize(m.kind)}{m.kind === 'whatsapp' ? ' · WhatsApp' : ''}</span></div>
            {m.is_primary ? <span className="pill pill-blue">Primary</span> : editable && <Button size="xs" variant="ghost" onClick={() => primary(m)}>Make primary</Button>}
            {editable && <button className="icon-btn" aria-label={`Remove ${m.value}`} onClick={() => remove(m)}><X size={15} /></button>}
          </div>
        ); })}
        {adding && (
          <div className="row mt-2" style={{ alignItems: 'flex-end' }}>
            <Field label="Type" htmlFor="m-k"><select id="m-k" className="select" value={kind} onChange={e => setKind(e.target.value)}><option value="email">Email</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option></select></Field>
            <Field label="Value" htmlFor="m-v" error={err}><input id="m-v" className="input" autoFocus value={value} onChange={e => setValue(e.target.value)} placeholder={kind === 'email' ? 'name@company.com' : '+1 555 0100'} /></Field>
            <Field label="Label" htmlFor="m-l"><select id="m-l" className="select" value={label} onChange={e => setLabel(e.target.value)}>{['Work', 'Mobile', 'Personal', 'Other'].map(x => <option key={x}>{x}</option>)}</select></Field>
            <Button variant="primary" disabled={value.trim().length < 3} onClick={add}>Save</Button><Button variant="ghost" onClick={() => { setAdding(false); setErr(null); }}>Cancel</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
