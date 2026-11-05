import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, ListTodo, AlarmClock, CalendarCheck, CheckCircle2, Bell, X, Pencil, Trash2, UserPlus, RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { dateTime, humanize, shortDate, date } from '../../lib/format';
import { Banner, Boundary, Button, Dialog, Drawer, ErrorState, Field, KpiRow, KV, LoadingBlock, MemberSelect, PageHeader, StatusPill, Tabs, useConfirm } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { Timeline } from '../../components/Timeline';
import { Assignees, relatedLink, RELATED_LABEL, TASK_PRIORITIES } from './common';
import { TaskForm } from './forms';

type View = 'my' | 'team' | 'overdue';

export default function Tasks() {
  const { can, scope } = useAuth();
  const [sp, setSp] = useSearchParams();
  const view = (['my', 'team', 'overdue'].includes(sp.get('view') ?? '') ? sp.get('view') : 'my') as View;
  const openTask = sp.get('task');
  const [rk, setRk] = useState(0);
  const [creating, setCreating] = useState(false);
  const [assign, setAssign] = useState<{ ids: string[]; reload: () => void } | null>(null);
  const stats = useApi<any>('/api/v1/tasks/stats', [rk]);
  const s = stats.data;
  const setParam = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k === 'view') n.delete('page'); setSp(n, { replace: k !== 'task' }); };
  const bump = () => setRk(k => k + 1);
  const toggle = async (t: any, reload?: () => void) => {
    try { await api.post(`/api/v1/tasks/${t.id}/${t.status === 'done' ? 'reopen' : 'complete'}`); toast.success(t.status === 'done' ? 'Task reopened' : 'Task completed'); reload?.(); bump(); } catch (e) { toast.error(e); }
  };
  const columns: Column<any>[] = [
    { key: 'done', label: 'Done', width: 50, align: 'center', mobile: 'hidden', render: r => <input type="checkbox" className="crm-check" aria-label={r.status === 'done' ? `Reopen ${r.title}` : `Complete ${r.title}`} checked={r.status === 'done'} disabled={!can('tasks', 'edit')} onClick={e => e.stopPropagation()} onChange={() => toggle(r)} />, csv: r => (r.status === 'done' ? 'Yes' : 'No') },
    { key: 'title', label: 'Task', sortable: true, mobile: 'title', render: r => <div><span className={r.status === 'done' ? 'crm-task-done' : 'bold'}>{r.title}</span>{r.next_reminder_at && r.status !== 'done' && <span className="muted small" title={`Reminder ${dateTime(r.next_reminder_at)}`}> <Bell size={12} /></span>}</div> },
    { key: 'related_label', label: 'Related to', mobile: 'subtitle', render: r => r.related_type ? (r.related_label ? <Link to={relatedLink(r.related_type, r.related_id, r.related_stage) ?? '#'} onClick={e => e.stopPropagation()}>{r.related_label}</Link> : <span className="muted">{RELATED_LABEL[r.related_type]}</span>) : <span className="muted">—</span>, csv: r => r.related_label },
    { key: 'priority', label: 'Priority', sortable: true, render: r => <StatusPill status={r.priority} /> },
    { key: 'status', label: 'Status', sortable: true, render: r => <StatusPill status={r.is_overdue ? 'overdue' : r.status} label={r.is_overdue ? 'Overdue' : undefined} />, csv: r => (r.is_overdue ? 'overdue' : r.status) },
    { key: 'due_date', label: 'Due', sortable: true, render: r => r.due_date ? <span className={r.is_overdue ? 'down bold' : ''}>{shortDate(r.due_date)}{r.due_time ? ` ${r.due_time}` : ''}</span> : <span className="muted">—</span> },
    { key: 'assignees', label: 'Assignees', render: r => <Assignees list={r.assignees} />, csv: r => r.assignees.map((a: any) => a.name).join('; ') },
  ];
  return (
    <div>
      <PageHeader title="Tasks" sub="Follow-ups and to-dos across leads, clients, candidates, placements and invoices."
        actions={<>
          <Button icon={<AlarmClock size={16} />} onClick={() => setParam('view', 'overdue')}>Overdue{s ? ` (${s.overdue})` : ''}</Button>
          {can('tasks', 'create') && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New Task</Button>}
        </>} />
      {s && s.my_overdue > 0 && <Banner tone="warn"><b>You have {s.my_overdue} overdue task{s.my_overdue > 1 ? 's' : ''}.</b> <a href="#" onClick={e => { e.preventDefault(); setParam('view', 'overdue'); }}>Review them</a>{s.my_due_today ? ` · ${s.my_due_today} due today.` : ''}</Banner>}
      <Boundary label="Task KPIs">
        {stats.error ? <ErrorState error={stats.error} retry={stats.reload} /> : (
          <KpiRow items={[
            { label: 'My open tasks', icon: <ListTodo size={16} />, value: s?.my_open ?? '…', deltaText: s ? <span className="muted">{s.high_priority} high priority (team)</span> : undefined, suffix: '', onClick: () => { setParam('view', 'my'); } },
            { label: 'Due today', icon: <CalendarCheck size={16} />, value: s?.my_due_today ?? '…', deltaText: <span className="muted">assigned to me</span>, suffix: '', onClick: () => { const n = new URLSearchParams(sp); n.set('view', 'my'); n.set('due', 'today'); setSp(n, { replace: true }); } },
            { label: 'Overdue', icon: <AlarmClock size={16} />, value: s?.overdue ?? '…', invert: true, deltaText: s ? <span className={s.my_overdue ? 'down' : 'muted'}>{s.my_overdue} mine</span> : undefined, suffix: '', onClick: () => setParam('view', 'overdue') },
            { label: 'Completed this week', icon: <CheckCircle2 size={16} />, value: s?.done_this_week ?? '…', delta: s && s.done_last_week ? ((s.done_this_week - s.done_last_week) / s.done_last_week) * 100 : null, suffix: 'vs last week', onClick: () => { const n = new URLSearchParams(sp); n.set('view', 'team'); n.set('status', 'done'); if (s) n.set('completed_from', s.week_start); setSp(n, { replace: true }); } },
          ]} />
        )}
      </Boundary>
      <Tabs value={view} onChange={v => setParam('view', v)} tabs={[{ key: 'my', label: 'My Tasks', count: s?.my_open }, { key: 'team', label: scope('tasks', 'view') === 'own' ? 'All my tasks' : 'Team', count: s?.team_open }, { key: 'overdue', label: 'Overdue', count: s?.overdue }]} />
      <DataTable key={view} title={view === 'my' ? 'Assigned to me' : view === 'team' ? 'Team tasks' : 'Overdue tasks'} endpoint="/api/v1/tasks" params={{ view }} columns={columns} reloadKey={rk} exportName="tasks" exportResource="tasks"
        onRowClick={r => setParam('task', r.id)}
        filters={[
          { key: 'status', label: 'Status', options: [{ value: 'active', label: 'Open & in progress' }, ...opts(['open', 'in_progress', 'done', 'cancelled'])] },
          { key: 'priority', label: 'Priority', options: opts(TASK_PRIORITIES) },
          ...(view !== 'my' ? [{ key: 'assignee', label: 'Assignee', type: 'member' as const }] : []),
          { key: 'related_type', label: 'Related to', options: Object.entries(RELATED_LABEL).filter(([k]) => ['company', 'contact', 'opportunity', 'position', 'candidate', 'placement', 'invoice', 'worker'].includes(k)).map(([value, label]) => ({ value, label })) },
          { key: 'due', label: 'Due', options: [{ value: 'today', label: 'Today' }, { value: 'week', label: 'Next 7 days' }, { value: 'none', label: 'No due date' }] },
          { key: 'completed_from', label: 'Completed from', type: 'date' },
        ]}
        rowActions={(r, reload) => [
          { label: r.status === 'done' ? 'Reopen' : 'Mark complete', onClick: () => toggle(r, reload), hidden: !can('tasks', 'edit') },
          { label: 'Open details', onClick: () => setParam('task', r.id) },
        ]}
        bulkActions={can('tasks', 'edit') ? [
          { label: 'Complete', icon: <CheckCircle2 size={14} />, onClick: async (ids, reload) => { try { const r = await api.post('/api/v1/tasks/bulk', { ids, action: 'complete' }); toast.success(`${r.count} task(s) completed`); reload(); bump(); } catch (e) { toast.error(e); } } },
          { label: 'Reopen', icon: <RotateCcw size={14} />, onClick: async (ids, reload) => { try { const r = await api.post('/api/v1/tasks/bulk', { ids, action: 'reopen' }); toast.success(`${r.count} task(s) reopened`); reload(); bump(); } catch (e) { toast.error(e); } } },
          { label: 'Add assignee', icon: <UserPlus size={14} />, onClick: (ids, reload) => setAssign({ ids, reload }) },
        ] : undefined}
        emptyTitle={view === 'overdue' ? 'Nothing overdue' : 'No tasks'} emptyText={view === 'overdue' ? 'Everything is on track.' : 'Create a task to plan your follow-ups.'} />
      <TaskForm open={creating} onClose={() => setCreating(false)} onSaved={r => { bump(); setParam('task', r.id); }} />
      {openTask && <TaskDrawer id={openTask} onClose={() => setParam('task', null)} onChanged={bump} />}
      <BulkAssign state={assign} onClose={() => setAssign(null)} onDone={bump} />
    </div>
  );
}

function BulkAssign({ state, onClose, onDone }: { state: { ids: string[]; reload: () => void } | null; onClose: () => void; onDone: () => void }) {
  const [u, setU] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  return (
    <Dialog open={!!state} onClose={onClose} title={`Add an assignee to ${state?.ids.length ?? 0} task(s)`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!u} onClick={async () => {
      setBusy(true); try { const r = await api.post('/api/v1/tasks/bulk', { ids: state!.ids, action: 'assign', user_id: u }); toast.success(`${r.count} task(s) updated`); state!.reload(); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
    }}>Add assignee</Button></>}>
      <Field label="Person" htmlFor="ba-u"><MemberSelect id="ba-u" value={u} onChange={setU} /></Field>
    </Dialog>
  );
}

function TaskDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [rk, setRk] = useState(0);
  const st = useApi<any>(`/api/v1/tasks/${id}`, [rk]);
  const [editing, setEditing] = useState(false);
  const [remindAt, setRemindAt] = useState('');
  const t = st.data;
  const refresh = () => { setRk(k => k + 1); onChanged(); };
  const toggle = async () => { try { await api.post(`/api/v1/tasks/${t.id}/${t.status === 'done' ? 'reopen' : 'complete'}`); toast.success(t.status === 'done' ? 'Task reopened' : 'Task completed'); refresh(); } catch (e) { toast.error(e); } };
  const addReminder = async () => { try { await api.post(`/api/v1/tasks/${t.id}/reminders`, { reminder: 'custom', remind_at: remindAt }); setRemindAt(''); toast.success('Reminder set'); refresh(); } catch (e) { toast.error(e); } };
  const delReminder = async (r: any) => { try { await api.del(`/api/v1/tasks/${t.id}/reminders/${r.id}`); refresh(); } catch (e) { toast.error(e); } };
  const del = async () => {
    const c = await confirm({ title: 'Delete this task?', danger: true, confirmLabel: 'Delete' });
    if (!c.ok) return; try { await api.del(`/api/v1/tasks/${t.id}`); toast.success('Task deleted'); onChanged(); onClose(); } catch (e) { toast.error(e); }
  };
  return (
    <Drawer open onClose={onClose} wide title={t ? t.title : 'Task'} footer={t && <>
      {t.can_edit && <Button icon={<Trash2 size={15} />} variant="ghost" onClick={del}>Delete</Button>}
      {t.can_edit && <Button icon={<Pencil size={15} />} onClick={() => setEditing(true)}>Edit</Button>}
      {t.can_edit && <Button variant={t.status === 'done' ? 'outline' : 'success'} icon={t.status === 'done' ? <RotateCcw size={15} /> : <CheckCircle2 size={15} />} onClick={toggle}>{t.status === 'done' ? 'Reopen' : 'Mark complete'}</Button>}
    </>}>
      {st.error ? <ErrorState error={st.error} retry={st.reload} /> : !t ? <LoadingBlock rows={5} /> : (
        <div className="stack" style={{ gap: 18 }}>
          {t.is_overdue && <Banner tone="danger">Overdue — was due {date(t.due_date)}{t.due_time ? ` at ${t.due_time}` : ''}.</Banner>}
          <KV items={[
            ['Status', <StatusPill key="s" status={t.status} />], ['Priority', <StatusPill key="p" status={t.priority} />],
            ['Due', t.due_date ? `${date(t.due_date)}${t.due_time ? ` at ${t.due_time}` : ''}` : null], ['Assignees', <Assignees key="a" list={t.assignees} max={6} />],
            ['Related to', t.related_type ? (t.related_label ? <Link key="r" to={relatedLink(t.related_type, t.related_id, t.related_stage) ?? '#'}>{RELATED_LABEL[t.related_type]}: {t.related_label}</Link> : RELATED_LABEL[t.related_type]) : null],
            ['Created', `${dateTime(t.created_at)}${t.created_by_name ? ` by ${t.created_by_name}` : ''}`], ['Completed', t.completed_at ? dateTime(t.completed_at) : null],
            ['Details', t.description ? <span key="d" style={{ whiteSpace: 'pre-wrap' }}>{t.description}</span> : null],
          ]} />
          <div>
            <div className="crm-section-title"><Bell size={14} /> Reminders</div>
            {t.reminders.length === 0 && <div className="muted small">No reminders. Reminders send an in-app notification and an email to assignees.</div>}
            {t.reminders.map((r: any) => (
              <div key={r.id} className="row small" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
                <span>{dateTime(r.remind_at)} · {r.channels.map((c: string) => humanize(c)).join(' + ')}</span>
                {r.sent_at ? <span className="pill pill-green">Sent {dateTime(r.sent_at)}</span> : t.can_edit && <button className="icon-btn" aria-label="Remove reminder" onClick={() => delReminder(r)}><X size={14} /></button>}
              </div>
            ))}
            {t.can_edit && t.status !== 'done' && <div className="row mt-2"><input type="datetime-local" className="input input-sm" style={{ width: 'auto' }} aria-label="Reminder time" value={remindAt} onChange={e => setRemindAt(e.target.value)} /><Button size="sm" disabled={!remindAt} onClick={addReminder}>Add reminder</Button></div>}
          </div>
          <div><div className="crm-section-title">Activity & comments</div><Timeline type="task" id={t.id} reloadKey={rk} /></div>
          {can('tasks', 'edit') && <TaskForm open={editing} onClose={() => setEditing(false)} task={t} onSaved={refresh} />}
        </div>
      )}
    </Drawer>
  );
}
