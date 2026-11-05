import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, PenLine, Upload, ClipboardList, AlertTriangle } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { date } from '../../lib/format';
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, StatusPill, KpiRow } from '../../components/ui';
import './insights.css';

export default function WorkerTasks() {
  const st = useApi<any>('/api/v1/portal/worker/tasks');
  const [busy, setBusy] = useState<string | null>(null);
  const d = st.data;
  const toggle = async (t: any) => {
    setBusy(t.id);
    try { await api.post(`/api/v1/portal/worker/tasks/${t.id}/status`, { status: t.status === 'done' ? 'open' : 'done' }); toast.success(t.status === 'done' ? 'Task reopened' : 'Nice work — task completed'); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  if (st.error && !d) return <><PageHeader title="Tasks" /><ErrorState error={st.error} retry={st.reload} /></>;
  if (!d) return <><PageHeader title="Tasks" /><LoadingBlock rows={6} /></>;
  const open = d.tasks.filter((t: any) => t.status !== 'done');
  const done = d.tasks.filter((t: any) => t.status === 'done');
  const actionCount = d.signatures.length + d.renewals.length + d.rejected.length + d.onboarding.length;
  return (
    <div>
      <PageHeader title="Tasks" sub="Things your agency needs from you, plus documents to sign or renew." />
      <KpiRow compact items={[
        { label: 'Open tasks', value: open.length, deltaText: <span className="muted">{open.filter((t: any) => t.overdue).length} overdue</span>, suffix: '' },
        { label: 'To sign', value: d.signatures.length, deltaText: <span className="muted">documents waiting</span>, suffix: '', to: '/portal/worker/documents' },
        { label: 'To renew', value: d.renewals.length + d.rejected.length, deltaText: <span className="muted">expiring or rejected</span>, suffix: '', to: '/portal/worker/documents' },
      ]} />
      {actionCount > 0 && (
        <Card className="mb-3">
          <CardHeader title="Action needed" />
          <div className="ins-list">
            {d.signatures.map((s: any) => <Link key={s.id} to={s.sign_url} className="ins-item"><PenLine size={16} className="muted" /><div style={{ flex: 1 }}><div className="t">Sign "{s.title}"</div><div className="s">Sent {date(s.created_at)}{s.expires_at ? ` · link expires ${date(s.expires_at)}` : ''}</div></div><span className="btn btn-sm btn-primary">Review & sign</span></Link>)}
            {d.rejected.map((r: any) => <Link key={r.id} to="/portal/worker/documents" className="ins-item"><AlertTriangle size={16} style={{ color: 'var(--danger)' }} /><div style={{ flex: 1 }}><div className="t">Re-upload "{r.name}"</div><div className="s">Rejected: {r.rejection_reason ?? 'see Documents'}</div></div></Link>)}
            {d.renewals.map((r: any) => <Link key={r.id} to="/portal/worker/documents" className="ins-item"><Upload size={16} className="muted" /><div style={{ flex: 1 }}><div className="t">Upload a renewed "{r.name}"</div><div className="s">{r.expired ? 'Expired' : 'Expires'} {date(r.expires_at)}</div></div></Link>)}
            {d.onboarding.map((o: any) => <Link key={o.id} to="/portal/worker/onboarding" className="ins-item"><ClipboardList size={16} className="muted" /><div style={{ flex: 1 }}><div className="t">{o.title}{o.required ? '' : ' (optional)'}</div><div className="s">Onboarding · {o.company_name}</div></div></Link>)}
          </div>
        </Card>
      )}
      <Card>
        <CardHeader title="My tasks" sub={`${open.length} open`} />
        {d.tasks.length === 0 ? <EmptyState icon={<CheckCircle2 size={22} />} title="No tasks right now" text="When your account manager assigns you something, it will show up here." /> : (
          <div>
            {[...open, ...done].map((t: any) => (
              <div key={t.id} className={`ins-task ${t.status === 'done' ? 'done' : ''}`}>
                <input type="checkbox" checked={t.status === 'done'} disabled={busy === t.id} onChange={() => toggle(t)} aria-label={t.status === 'done' ? `Reopen ${t.title}` : `Complete ${t.title}`} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="t">{t.title}</div>
                  {t.description && <div className="small muted">{t.description}</div>}
                  <div className="small muted mt-1">{t.status === 'done' ? `Completed ${date(t.completed_at)}` : t.due_date ? <span className={t.overdue ? 'down' : ''}>{t.overdue ? 'Overdue · was due ' : 'Due '}{date(t.due_date)}</span> : 'No due date'}</div>
                </div>
                {t.status !== 'done' && ['high', 'urgent'].includes(t.priority) && <StatusPill status={t.priority} />}
                {t.status !== 'done' && <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => toggle(t)}>Done</Button>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
