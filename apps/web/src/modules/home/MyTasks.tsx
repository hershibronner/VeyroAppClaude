import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { CheckCircle2, RotateCcw, PlayCircle, ListChecks, Plus } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date, humanize } from '../../lib/format';
import { Button, PageHeader, StatusPill, Tabs, Banner } from '../../components/ui';
import { DataTable, opts, type Column } from '../../components/DataTable';
import { useQuickCreate } from '../../components/QuickCreate';
import './insights.css';

type Tab = 'open' | 'overdue' | 'today' | 'week' | 'done';

export default function MyTasks() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQuickCreate();
  const taskItem = qc.items.find(i => i.key === 'task');
  const status = (sp.get('status') as Tab) || 'open';
  const focus = sp.get('task');
  const [reloadKey, setReloadKey] = useState(0);
  const counts = useApi<any>(`/api/v1/dashboard/my-tasks?status=open&pageSize=1&k=${reloadKey}`);
  const c = counts.data?.counts;
  const setStatus = async (id: string, s: 'open' | 'in_progress' | 'done', reload: () => void) => {
    try { await api.post(`/api/v1/dashboard/my-tasks/${id}/status`, { status: s }); toast.success(s === 'done' ? 'Task completed' : s === 'in_progress' ? 'Task started' : 'Task reopened'); reload(); setReloadKey(k => k + 1); } catch (e) { toast.error(e); }
  };
  const columns: Column<any>[] = [
    { key: 'title', label: 'Task', mobile: 'title', sortable: true, render: t => <div style={{ minWidth: 0 }}><div className="bold">{t.title}</div>{t.description && <div className="small muted truncate" style={{ maxWidth: 420 }}>{t.description}</div>}</div> },
    { key: 'due_date', label: 'Due', sortable: true, render: t => t.due_date ? <span className={t.overdue ? 'down bold' : ''}>{date(t.due_date)}{t.due_time ? ` · ${String(t.due_time).slice(0, 5)}` : ''}</span> : <span className="muted">—</span>, csv: t => t.due_date },
    { key: 'priority', label: 'Priority', sortable: true, render: t => <StatusPill status={t.priority} /> },
    { key: 'related_label', label: 'Related to', render: t => t.related_label ? (t.related_link ? <Link to={t.related_link} onClick={e => e.stopPropagation()}>{t.related_label}</Link> : t.related_label) : <span className="muted">—</span>, csv: t => t.related_label },
    { key: 'status', label: 'Status', render: t => <StatusPill status={t.overdue ? 'overdue' : t.status} label={t.overdue ? 'Overdue' : humanize(t.status)} /> },
    { key: 'created_by_name', label: 'Created by', mobile: 'hidden' },
  ];
  return (
    <div>
      <PageHeader title="My Tasks" sub="Everything assigned to you across clients, candidates, placements and invoices."
        actions={<>
          <Button icon={<ListChecks size={16} />} onClick={() => nav('/crm/tasks')}>All team tasks</Button>
          {taskItem && <Button variant="primary" icon={<Plus size={16} />} onClick={() => qc.open('task')}>New task</Button>}
          {qc.element}
        </>} />
      {c?.overdue > 0 && status !== 'overdue' && <Banner tone="warn">You have {c.overdue} overdue task{c.overdue === 1 ? '' : 's'}. <a href="#" onClick={e => { e.preventDefault(); const n = new URLSearchParams(sp); n.set('status', 'overdue'); n.delete('page'); setSp(n); }}>Show overdue</a></Banner>}
      {focus && <Banner>Showing one task. <a href="#" onClick={e => { e.preventDefault(); const n = new URLSearchParams(sp); n.delete('task'); setSp(n); }}>Show all my tasks</a></Banner>}
      <Tabs<Tab> value={status} onChange={k => { const n = new URLSearchParams(sp); n.set('status', k); n.delete('page'); n.delete('task'); setSp(n); }} tabs={[
        { key: 'open', label: 'Open', count: c?.open }, { key: 'overdue', label: 'Overdue', count: c?.overdue }, { key: 'today', label: 'Due today', count: c?.today },
        { key: 'week', label: 'Next 7 days', count: c?.week }, { key: 'done', label: 'Completed', count: c?.done },
      ]} />
      <div className="mt-3">
        <DataTable endpoint="/api/v1/dashboard/my-tasks" params={{ status: focus ? 'all' : status, task: focus ?? undefined }} columns={columns} reloadKey={`${status}-${focus}-${reloadKey}`}
          filters={[{ key: 'priority', label: 'Priority', options: opts(['low', 'medium', 'high', 'urgent']) }]}
          exportName="my-tasks" exportResource="tasks" defaultSort="due_date" defaultDir="asc"
          emptyTitle={status === 'done' ? 'No completed tasks yet' : 'Nothing to do here'} emptyText={status === 'open' ? 'Tasks assigned to you by teammates or automations appear here.' : undefined}
          rowLink={t => t.related_link}
          rowActions={(t, reload) => [
            { label: 'Mark done', icon: <CheckCircle2 size={15} />, onClick: () => setStatus(t.id, 'done', reload), hidden: t.status === 'done' },
            { label: 'Start', icon: <PlayCircle size={15} />, onClick: () => setStatus(t.id, 'in_progress', reload), hidden: t.status !== 'open' },
            { label: 'Reopen', icon: <RotateCcw size={15} />, onClick: () => setStatus(t.id, 'open', reload), hidden: t.status === 'open' },
          ]}
          bulkActions={[{ label: 'Mark done', icon: <CheckCircle2 size={14} />, onClick: async (ids, reload) => { for (const id of ids) await api.post(`/api/v1/dashboard/my-tasks/${id}/status`, { status: 'done' }).catch(toast.error); toast.success(`${ids.length} task${ids.length === 1 ? '' : 's'} completed`); reload(); setReloadKey(k => k + 1); } }]}
        />
      </div>
    </div>
  );
}
