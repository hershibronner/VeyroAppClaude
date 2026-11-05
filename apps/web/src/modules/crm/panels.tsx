// Reusable detail-page panels: related tasks, company contacts.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Mail, Phone, Star } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { shortDate } from '../../lib/format';
import { Avatar, Button, EmptyState, ErrorState, LoadingBlock, StatusPill, Menu } from '../../components/ui';
import { Assignees } from './common';
import { ContactForm, TaskForm } from './forms';

export function RelatedTasks({ type, id, label, reloadKey, onChanged }: { type: string; id: string; label?: string; reloadKey?: unknown; onChanged?: () => void }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const [k, setK] = useState(0);
  const st = useApi<any>(`/api/v1/tasks?related_type=${type}&related_id=${id}&pageSize=100`, [k, reloadKey]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const toggle = async (t: any) => {
    try { await api.post(`/api/v1/tasks/${t.id}/${t.status === 'done' ? 'reopen' : 'complete'}`); toast.success(t.status === 'done' ? 'Task reopened' : 'Task completed'); setK(x => x + 1); onChanged?.(); } catch (e) { toast.error(e); }
  };
  const rows: any[] = st.data?.rows ?? [];
  return (
    <div>
      <div className="row mb-2" style={{ justifyContent: 'space-between' }}>
        <div className="muted small">{rows.filter(r => !['done', 'cancelled'].includes(r.status)).length} open · {rows.filter(r => r.status === 'done').length} done</div>
        {can('tasks', 'create') && <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>New task</Button>}
      </div>
      {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !st.data ? <LoadingBlock rows={3} /> : rows.length === 0 ? <EmptyState title="No tasks" text="Create follow-ups so nothing slips." /> : (
        <div>
          {rows.map(t => (
            <div key={t.id} className="checklist-item">
              <input type="checkbox" className="crm-check" checked={t.status === 'done'} onChange={() => toggle(t)} aria-label={t.status === 'done' ? `Reopen ${t.title}` : `Complete ${t.title}`} disabled={!can('tasks', 'edit')} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={t.status === 'done' ? 'crm-task-done' : 'bold'}>{t.title}</div>
                <div className="muted small">{t.due_date ? <span className={t.is_overdue ? 'down bold' : ''}>Due {shortDate(t.due_date)}{t.due_time ? ` ${t.due_time}` : ''}</span> : 'No due date'} · <StatusPill status={t.priority} /></div>
              </div>
              <Assignees list={t.assignees} />
              <Menu items={[{ label: 'Edit', onClick: () => setEditing(t), hidden: !can('tasks', 'edit') }, { label: 'Open in Tasks', onClick: () => nav(`/crm/tasks?task=${t.id}`) }]} />
            </div>
          ))}
        </div>
      )}
      <TaskForm open={creating} onClose={() => setCreating(false)} related={{ type, id, label }} onSaved={() => { setK(x => x + 1); onChanged?.(); }} />
      <TaskForm open={!!editing} onClose={() => setEditing(null)} task={editing ?? undefined} onSaved={() => setK(x => x + 1)} />
    </div>
  );
}

export function CompanyContacts({ companyId, reloadKey, onChanged, hideAdd }: { companyId: string; reloadKey?: unknown; onChanged?: () => void; hideAdd?: boolean }) {
  const { can } = useAuth();
  const [k, setK] = useState(0);
  const st = useApi<any>(`/api/v1/contacts?company_id=${companyId}&pageSize=200&sort=name&dir=asc`, [k, reloadKey]);
  const [creating, setCreating] = useState(false);
  const rows: any[] = st.data?.rows ?? [];
  const makePrimary = async (c: any) => { try { await api.patch(`/api/v1/contacts/${c.id}`, { is_primary: true }); toast.success(`${c.name} is now the primary contact`); setK(x => x + 1); onChanged?.(); } catch (e) { toast.error(e); } };
  const unlink = async (c: any) => { try { await api.patch(`/api/v1/contacts/${c.id}`, { company_id: null }); toast.success(`${c.name} unlinked`); setK(x => x + 1); onChanged?.(); } catch (e) { toast.error(e); } };
  return (
    <div>
      <div className="row mb-2" style={{ justifyContent: 'space-between' }}>
        <div className="muted small">{rows.length} contact{rows.length === 1 ? '' : 's'}</div>
        {can('contacts', 'create') && !hideAdd && <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>Add contact</Button>}
      </div>
      {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !st.data ? <LoadingBlock rows={3} /> : rows.length === 0 ? <EmptyState title="No contacts" text="Add the people you work with at this company." /> : rows.map(c => (
        <div key={c.id} className="crm-contact-card">
          <Avatar name={c.name} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}><Link to={`/crm/contacts/${c.id}`} className="bold">{c.name}</Link>{c.is_primary && <span className="pill pill-blue"><Star size={11} /> Primary</span>}</div>
            <div className="muted small">{c.title ?? '—'}</div>
            <div className="row small mt-1" style={{ gap: 14 }}>
              {c.email && <a href={`mailto:${c.email}`}><Mail size={13} /> {c.email}</a>}
              {c.phone && <a href={`tel:${c.phone}`}><Phone size={13} /> {c.phone}</a>}
              {c.methods_count > 2 && <span className="muted">+{c.methods_count - 2} more</span>}
            </div>
          </div>
          {can('contacts', 'edit') && <Menu items={[{ label: 'Make primary', hidden: c.is_primary, onClick: () => makePrimary(c) }, { label: 'Unlink from company', onClick: () => unlink(c) }]} />}
        </div>
      ))}
      <ContactForm open={creating} onClose={() => setCreating(false)} companyId={companyId} onSaved={() => { setK(x => x + 1); onChanged?.(); }} />
    </div>
  );
}
