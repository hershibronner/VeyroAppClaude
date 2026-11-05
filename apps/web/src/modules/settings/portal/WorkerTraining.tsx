import { useState } from 'react';
import { BookOpen, CheckCircle2, Clock, ExternalLink, GraduationCap, PlayCircle, ShieldCheck } from 'lucide-react';
import { api } from '../../../lib/api';
import { useApi } from '../../../lib/hooks';
import { toast } from '../../../lib/toast';
import { date, humanize } from '../../../lib/format';
import { Banner, Button, Card, CardHeader, Drawer, EmptyState, ErrorState, KpiRow, LoadingBlock, Meter, PageHeader, StatusPill } from '../../../components/ui';
import '../settings.css';

const ICON: Record<string, any> = { reading: BookOpen, video: PlayCircle, policy: ShieldCheck, quiz: GraduationCap };

export default function WorkerTraining() {
  const st = useApi<any>('/api/v1/portal/worker/training');
  const [open, setOpen] = useState<any>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Card><LoadingBlock rows={6} /></Card>;
  const d = st.data;
  const start = async (m: any) => { setOpen(m); setAck(false); if (!m.status) { await api.post(`/api/v1/portal/worker/training/${m.id}/start`).catch(() => {}); st.reload(); } };
  const complete = async () => { setBusy(true); try { await api.post(`/api/v1/portal/worker/training/${open.id}/complete`, { acknowledged: ack }); toast.success(`Completed “${open.title}”`); setOpen(null); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return (
    <div className="stack">
      <PageHeader title="Training" sub="Complete required modules first. Your agency can see your progress." />
      {d.required_open > 0 && <Banner tone="warn">{d.required_open} required module{d.required_open === 1 ? '' : 's'} still to complete.</Banner>}
      <KpiRow items={[
        { label: 'Completed', value: `${d.completed} / ${d.total}`, icon: <CheckCircle2 size={16} />, deltaText: d.total ? `${Math.round((d.completed / d.total) * 100)}% done` : 'nothing assigned', suffix: '' },
        { label: 'Required remaining', value: d.required_open, icon: <ShieldCheck size={16} /> },
        { label: 'Time left', value: `${d.rows.filter((r: any) => r.status !== 'completed').reduce((a: number, r: any) => a + r.duration_min, 0)} min`, icon: <Clock size={16} /> },
      ]} />
      {d.total > 0 && <Meter value={(d.completed / d.total) * 100} />}
      {d.rows.length === 0 ? <Card><EmptyState icon={<GraduationCap size={22} />} title="No training assigned" text="Your agency hasn't published any training yet." /></Card> : (
        <Card>
          <CardHeader title="Modules" />
          <div className="card-b" style={{ paddingTop: 4 }}>
            {d.rows.map((m: any) => { const I = ICON[m.kind] ?? BookOpen; return (
              <div key={m.id} className="checklist-item">
                <I size={18} color={m.status === 'completed' ? 'var(--success)' : 'var(--primary)'} />
                <div style={{ flex: 1, minWidth: 0 }}><div className="bold small row" style={{ gap: 6 }}>{m.title}{m.required && <StatusPill status="required" label="Required" tone="amber" />}</div><div className="tiny muted">{humanize(m.kind)} · {m.duration_min} min{m.description ? ` · ${m.description}` : ''}</div></div>
                {m.status === 'completed' ? <StatusPill status="completed" label={`Done ${date(m.completed_at)}`} /> : <Button size="sm" variant={m.status ? 'outline' : 'primary'} onClick={() => start(m)}>{m.status ? 'Continue' : 'Start'}</Button>}
              </div>
            ); })}
          </div>
        </Card>
      )}
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open?.title ?? ''} wide footer={open && open.status !== 'completed' && <Button variant="primary" icon={<CheckCircle2 size={16} />} disabled={open.kind === 'policy' && !ack} loading={busy} onClick={complete}>{open.kind === 'policy' ? 'Accept & complete' : 'Mark as complete'}</Button>}>
        {open && <div className="stack" style={{ gap: 14 }}>
          <div className="small muted">{humanize(open.kind)} · about {open.duration_min} minutes{open.required ? ' · required' : ''}</div>
          {open.url && <a className="btn" href={open.url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open video / resource</a>}
          <div className="st-article" style={{ whiteSpace: 'pre-wrap' }}>{open.content || open.description || 'Follow the instructions from your account manager.'}</div>
          {open.kind === 'policy' && open.status !== 'completed' && <label className="check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> I have read and accept this policy</label>}
        </div>}
      </Drawer>
    </div>
  );
}
