import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Clock, Activity, Image as ImageIcon, Flag, Keyboard, MonitorOff } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Avatar, KpiRow, EmptyState, ErrorState, LoadingBlock, Banner, Boundary } from '../../components/ui';
import { ChartCard, SoftArea } from '../../components/charts';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { time as fmtTime, todayISO, addDaysISO, date, humanize } from '../../lib/format';
import { Lightbox, useRealtime, hrs, hm, type Shot } from '../workforce/shared';

/** Renders the 10-minute block timeline for a worker/day. Shared with the client portal. */
export function BlockTimeline({ data, canFlag, onChanged, workerName }: { data: any; canFlag?: boolean; onChanged?: () => void; workerName?: string }) {
  const [lb, setLb] = useState<number | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const all: Shot[] = useMemo(() => data.shots.map((s: any) => ({ ...s, worker_name: workerName })), [data.shots, workerName]);
  const openAt = (id: string) => { setShots(all); setLb(all.findIndex(s => s.id === id)); };
  if (!data.blocks.length) return <EmptyState icon={<Clock size={22} />} title="No tracked time on this day" text="Pick another day or worker." />;
  return (
    <>
      <div className="wf-actbar" aria-label="Activity per 10-minute block" style={{ marginBottom: 6 }}>{data.blocks.map((b: any) => <span key={b.start} title={`${fmtTime(b.start)} · ${b.activity_pct ?? 0}%`} className={b.activity_pct === null ? 'none' : b.activity_pct < 35 ? 'low' : ''} style={{ height: `${Math.max(4, b.activity_pct ?? 4)}%` }} />)}</div>
      <div className="row small muted" style={{ justifyContent: 'space-between', marginBottom: 14 }}><span>{fmtTime(data.blocks[0].start)}</span><span>{fmtTime(data.blocks[data.blocks.length - 1].end)} ({data.timezone.replace('_', ' ')} work date)</span></div>
      <div className="wf-blocks">
        {data.blocks.map((b: any) => {
          const s = b.shots[0];
          return (
            <div key={b.start} className={`wf-block ${!b.tracked ? 'untracked' : ''} ${b.on_break ? 'break' : ''}`}>
              <div className="bh"><span>{fmtTime(b.start)}</span><span className="bold" style={{ color: b.activity_pct === null ? undefined : b.activity_pct < 35 ? 'var(--warning)' : 'var(--success)' }}>{b.activity_pct !== null ? `${b.activity_pct}%` : '—'}</span></div>
              {s ? <button className={`bimg ${b.shots.some((x: any) => x.flagged) ? 'flagged' : ''}`} onClick={() => openAt(s.id)} aria-label={`Screenshot at ${fmtTime(s.taken_at)}`}><img src={s.url} alt="" loading="lazy" />{b.shots.length > 1 && <span className="more">+{b.shots.length - 1}</span>}</button>
                : <div className="bimg" style={{ cursor: 'default' }}><span className="empty-shot">{b.on_break ? 'On break' : !b.tracked ? 'Not tracked' : 'No screenshot'}</span></div>}
              <div className="bf"><span className="truncate" title={b.app_label ?? ''}>{b.app_label ?? (b.on_break ? 'Break' : '—')}</span>{b.url_label && <span className="muted truncate">{b.url_label}</span>}{(b.keys > 0 || b.mouse > 0) && <span className="muted"><Keyboard size={11} /> {b.keys} · mouse {b.mouse}</span>}</div>
            </div>
          );
        })}
      </div>
      {lb !== null && lb >= 0 && <Lightbox shots={shots} index={lb} onIndex={setLb} onClose={() => setLb(null)} canFlag={canFlag} onFlagged={s => { setShots(shots.map(x => x.id === s.id ? s : x)); onChanged?.(); }} />}
    </>
  );
}

export default function Screenshots() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const day = sp.get('date') || todayISO();
  const company = sp.get('company_id') ?? '';
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const workers = useApi<any[]>(`/api/v1/time/screenshots/workers?date=${day}${company ? `&company_id=${company}` : ''}`);
  const sum = useApi<any>('/api/v1/time/screenshots/summary');
  const live = useApi<any>('/api/v1/time/live');
  const wid = sp.get('worker_id') || workers.data?.find(w => w.minutes > 0)?.id || workers.data?.[0]?.id || null;
  const tl = useApi<any>(wid ? `/api/v1/time/screenshots/day?worker_id=${wid}&date=${day}` : null);
  useRealtime('screenshot', d => { if (d.worker_id === wid && day === todayISO()) tl.reload(); });
  const companies = live.data?.companies ?? [];
  const t = tl.data;
  return (
    <div>
      <PageHeader title="Screenshots & Activity" sub="Per worker per day: 10-minute blocks with screenshots, activity % and app/URL labels (simulated in demo mode)." actions={<>
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" icon={<ChevronLeft size={14} />} aria-label="Previous day" onClick={() => set({ date: addDaysISO(day, -1) })} />
          <input type="date" className="input input-sm" aria-label="Date" value={day} max={todayISO()} onChange={e => set({ date: e.target.value })} style={{ width: 150 }} />
          <Button size="sm" icon={<ChevronRight size={14} />} aria-label="Next day" disabled={day >= todayISO()} onClick={() => set({ date: addDaysISO(day, 1) })} />
        </div>
        <select className="select" style={{ width: 'auto', height: 38 }} aria-label="Client" value={company} onChange={e => set({ company_id: e.target.value || null, worker_id: null })}><option value="">All clients</option>{companies.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <Button variant="primary" onClick={() => nav('/time/live')}>Live Now</Button>
      </>} />
      {sum.data && <KpiRow compact items={[
        { label: 'Screenshots (24h)', icon: <ImageIcon size={16} />, value: sum.data.last_24h.toLocaleString(), delta: sum.data.prev_24h ? ((sum.data.last_24h - sum.data.prev_24h) / sum.data.prev_24h) * 100 : null, suffix: 'vs previous 24h' },
        { label: 'Avg. activity (24h)', icon: <Activity size={16} />, value: sum.data.avg_activity_24h !== null ? `${sum.data.avg_activity_24h}%` : '—', deltaText: <span>{sum.data.real_7d} real captures (7 days)</span>, suffix: '' },
        { label: 'Flagged (30 days)', icon: <Flag size={16} />, value: sum.data.flagged_30d, deltaText: <span>review on the timeline</span>, suffix: '' },
        { label: 'Worker-deleted (30 days)', icon: <MonitorOff size={16} />, value: sum.data.worker_deleted_30d, deltaText: <span>within policy window, logged</span>, suffix: '' },
      ]} />}
      <div className="wf-grid-shots">
        <Card><CardHeader title="Workers" sub={date(day)} />
          {workers.error ? <div className="card-b"><ErrorState error={workers.error} retry={workers.reload} /></div> : !workers.data ? <LoadingBlock /> : !workers.data.length ? <EmptyState title="No workers" /> :
            <div className="wf-pick-list">{workers.data.map(w => <button key={w.id} className={w.id === wid ? 'on' : ''} onClick={() => set({ worker_id: w.id })}><Avatar name={w.name} color={w.avatar_color} size={30} /><div style={{ flex: 1, minWidth: 0 }}><div className="bold truncate">{w.name}</div><div className="small muted truncate">{w.company_name}</div></div><div className="right small"><div className="bold">{hrs(w.minutes)}</div><div className="muted">{w.shots} shots</div></div></button>)}</div>}
        </Card>
        <div className="stack" style={{ gap: 20, minWidth: 0 }}>
          {!wid ? <EmptyState title="Pick a worker" /> : tl.error ? <ErrorState error={tl.error} retry={tl.reload} /> : !t ? <LoadingBlock rows={6} /> : <>
            <Card pad>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                <div className="row" style={{ gap: 12, cursor: 'pointer' }} onClick={() => nav(`/workforce/workers/${t.worker.id}`)}><Avatar name={t.worker.name} color={t.worker.avatar_color} size={44} /><div><div className="bold" style={{ fontSize: 18 }}>{t.worker.name}</div><div className="small muted">{t.placements.map((p: any) => `${p.title} @ ${p.company_name}`).join(' · ')}</div></div></div>
                <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
                  <div><div className="small muted">Tracked</div><div className="bold">{hm(t.summary.tracked_minutes)}</div></div>
                  <div><div className="small muted">Activity</div><div className="bold">{t.summary.avg_activity !== null ? `${t.summary.avg_activity}%` : '—'}</div></div>
                  <div><div className="small muted">Screenshots</div><div className="bold">{t.summary.screenshots}</div></div>
                  <div><div className="small muted">Flagged</div><div className="bold">{t.summary.flagged}</div></div>
                  <div><div className="small muted">Idle discarded</div><div className="bold">{t.summary.idle_discarded_minutes}m</div></div>
                </div>
              </div>
              {t.events.length > 0 && <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>{t.events.map((e: any, i: number) => <span key={i} className={`pill ${e.kind === 'screen_declined' ? 'pill-amber' : e.kind === 'absent' ? 'pill-red' : 'pill-amber'}`}>{humanize(e.kind)}{e.note ? ` — ${e.note}` : ''}</span>)}</div>}
              {t.summary.worker_deleted > 0 && <div className="small muted" style={{ marginTop: 8 }}>{t.summary.worker_deleted} screenshot(s) deleted by the worker within the policy window (logged in audit).</div>}
            </Card>
            {!can('screenshots', 'view') && <Banner tone="info">Your role can see activity but not screenshot images.</Banner>}
            <Card><CardHeader title="Timeline" sub="Click a screenshot to open the viewer — use ← → to move between shots" />
              <div className="card-b"><Boundary label="Timeline"><BlockTimeline data={t} canFlag={can('screenshots', 'view')} onChanged={tl.reload} workerName={t.worker.name} /></Boundary></div>
            </Card>
            <Card><CardHeader title="Sessions" />
              {t.entries.length ? <table className="table"><thead><tr><th>Start</th><th>End</th><th>Client</th><th>Memo</th><th className="right">Breaks</th><th className="right">Net</th></tr></thead><tbody>{t.entries.map((e: any) => <tr key={e.id}><td>{fmtTime(e.started_at)}</td><td>{e.ended_at ? fmtTime(e.ended_at) : <span className="pill pill-green">Running</span>}</td><td>{e.company_name}</td><td className="small">{e.memo ?? '—'}{e.source !== 'tracker' && <span className="muted"> · {e.source}</span>}</td><td className="right">{Math.round(e.break_seconds / 60)}m</td><td className="right num">{hm(e.minutes)}</td></tr>)}</tbody></table> : <EmptyState title="No sessions" />}
            </Card>
          </>}
          {sum.data && <ChartCard title="Team activity — last 24 hours"><SoftArea data={sum.data.hourly} fmt={v => `${v}%`} /></ChartCard>}
        </div>
      </div>
    </div>
  );
}
