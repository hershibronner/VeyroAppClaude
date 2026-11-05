import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Radio, Activity, AlarmClock, UserX, MonitorOff, Image as ImageIcon } from 'lucide-react';
import { PageHeader, Banner, KpiRow, Button, Avatar, Segmented, EmptyState, ErrorState, LoadingBlock } from '../../components/ui';
import { useApi, useInterval } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { relTime } from '../../lib/format';
import { LivePill, SinceTimer, ActivityMeter, Lightbox, useRealtime, hrs, type Shot } from '../workforce/shared';

type View = 'live' | 'attention' | 'all';

export default function Live() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const view = (sp.get('view') as View) || 'live';
  const company = sp.get('company_id') ?? '';
  const st = useApi<any>(`/api/v1/time/live${company ? `?company_id=${company}` : ''}`);
  const [lb, setLb] = useState<{ shots: Shot[]; i: number } | null>(null);
  const pending = useRef<number | null>(null);
  const softReload = () => { if (pending.current) return; pending.current = window.setTimeout(() => { pending.current = null; st.reload(); }, 1500); };
  // Live updates: presence changes patch the row in place; screenshots swap the thumbnail.
  useRealtime('presence', d => {
    if (!st.data) return;
    const known = st.data.rows.some((r: any) => r.worker_id === d.worker_id);
    if (!known || (d.state === 'offline') !== (st.data.rows.find((r: any) => r.worker_id === d.worker_id)?.status === 'offline')) { softReload(); return; }
    st.setData({ ...st.data, rows: st.data.rows.map((r: any) => r.worker_id === d.worker_id ? { ...r, status: d.state === 'offline' ? r.status : d.state, activity_pct: d.activity_pct ?? r.activity_pct, session_started_at: d.session_started_at ?? r.session_started_at, latest_shot: d.latest_shot ?? r.latest_shot, today_minutes: d.today_minutes ?? r.today_minutes } : r) });
  });
  useRealtime('screenshot', d => { if (!st.data) return; st.setData({ ...st.data, rows: st.data.rows.map((r: any) => r.worker_id === d.worker_id ? { ...r, latest_shot: { id: d.id, url: d.url, taken_at: d.taken_at, app_label: d.app_label, activity_pct: d.activity_pct } } : r) }); });
  useInterval(() => st.reload(), 60000);
  const rows = useMemo(() => (st.data?.rows ?? []).filter((r: any) => view === 'all' ? true : view === 'live' ? ['working', 'idle', 'on_break'].includes(r.status) : ['late', 'absent'].includes(r.status) || (['working', 'idle'].includes(r.status) && ['declined', 'unsupported'].includes(r.screen_share))), [st.data, view]);
  if (st.error && !st.data) return <ErrorState error={st.error} retry={st.reload} />;
  const d = st.data;
  const c = d?.counts ?? {};
  return (
    <div>
      <PageHeader title="Live Now" sub={d ? `Updated ${relTime(d.as_of)} · live via realtime` : 'Workers clocked in right now'} actions={<>
        <select className="select" style={{ width: 'auto', height: 38 }} aria-label="Client" value={company} onChange={e => { const n = new URLSearchParams(sp); e.target.value ? n.set('company_id', e.target.value) : n.delete('company_id'); setSp(n, { replace: true }); }}><option value="">All clients</option>{(d?.companies ?? []).map((co: any) => <option key={co.id} value={co.id}>{co.name}</option>)}</select>
        <Button variant="primary" icon={<ImageIcon size={16} />} onClick={() => nav('/time/screenshots')}>Screenshots & Activity</Button>
      </>} />
      {d && (c.late > 0 || c.absent > 0) && <Banner tone="warn"><b>{c.late} worker{c.late === 1 ? ' is' : 's are'} late</b>{c.absent ? <> and <b>{c.absent} absent</b></> : null} for their scheduled shift. <a href="?view=attention" onClick={e => { e.preventDefault(); setSp({ view: 'attention' }, { replace: true }); }}>Show them →</a></Banner>}
      {d && <KpiRow items={[
        { label: 'Clocked in', icon: <Radio size={16} />, value: d.clocked_in, deltaText: <span>{c.working} working · {c.idle} idle · {c.on_break} on break</span>, suffix: '', onClick: () => setSp({ view: 'live' }, { replace: true }) },
        { label: 'Avg. activity (10 min)', icon: <Activity size={16} />, value: d.avg_activity !== null ? `${d.avg_activity}%` : '—', deltaText: <span>keyboard & mouse counts only</span>, suffix: '', to: '/time/screenshots' },
        { label: 'Late now', icon: <AlarmClock size={16} />, value: c.late, deltaText: <span>past shift start + grace</span>, suffix: '', onClick: () => setSp({ view: 'attention' }, { replace: true }) },
        { label: 'Absent today', icon: <UserX size={16} />, value: c.absent, deltaText: <span>{d.screen_declined} declined screen share</span>, suffix: '', to: '/time/attendance' },
      ]} />}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <Segmented value={view} onChange={k => { const n = new URLSearchParams(sp); n.set('view', k); setSp(n, { replace: true }); }} options={[{ key: 'live', label: `Clocked in (${d?.clocked_in ?? 0})` }, { key: 'attention', label: `Needs attention (${(c.late ?? 0) + (c.absent ?? 0)})` }, { key: 'all', label: `All active (${d?.rows.length ?? 0})` }]} />
        <span className="small muted">{c.offline ?? 0} offline · {c.time_off ?? 0} on time off</span>
      </div>
      {!d ? <LoadingBlock rows={6} /> : rows.length === 0 ? <EmptyState icon={<Radio size={22} />} title={view === 'live' ? 'Nobody is clocked in right now' : view === 'attention' ? 'Everyone is on time' : 'No active placements'} text={view === 'live' ? 'Workers appear here the moment they clock in.' : undefined} /> : (
        <div className="wf-live-grid">
          {rows.map((r: any) => (
            <div key={r.worker_id} className="wf-live-card">
              <button className="thumb" onClick={() => r.latest_shot ? setLb({ shots: [{ ...r.latest_shot, worker_name: r.worker_name }], i: 0 }) : nav(`/time/screenshots?worker_id=${r.worker_id}`)} aria-label={`Latest screenshot of ${r.worker_name}`}>
                {r.latest_shot?.url && can('screenshots', 'view') ? <><img src={r.latest_shot.url} alt="" loading="lazy" /><span className="ago">{relTime(r.latest_shot.taken_at)}</span></> : <span className="noshot">{['declined', 'unsupported'].includes(r.screen_share) ? <span><MonitorOff size={18} /><br />Screen share declined</span> : r.screenshots_enabled === false ? 'Screenshots off for this policy' : 'No screenshot yet'}</span>}
              </button>
              <div className="body">
                <div className="top">
                  <div className="row" style={{ gap: 10, minWidth: 0, cursor: 'pointer' }} onClick={() => nav(`/workforce/workers/${r.worker_id}`)}><Avatar name={r.worker_name} color={r.avatar_color} size={34} /><div style={{ minWidth: 0 }}><div className="bold truncate">{r.worker_name}</div><div className="small muted truncate">{r.company_name}</div></div></div>
                  <LivePill status={r.status} />
                </div>
                {['working', 'idle', 'on_break'].includes(r.status) ? <>
                  <div className="meta"><span>Session <SinceTimer from={r.session_started_at} /></span><span>Today {hrs(r.today_minutes)}</span></div>
                  <ActivityMeter value={r.activity_pct} />
                </> : <div className="meta"><span>{r.status === 'late' ? `Shift ${r.shift} · ${r.late_minutes ?? 0} min late` : r.status === 'absent' ? `No clock-in · shift ${r.shift ?? '—'}` : r.shift ? `Shift ${r.shift} (${r.timezone.split('/')[1]?.replace('_', ' ')})` : 'Not scheduled today'}</span><span>Today {hrs(r.today_minutes)}</span></div>}
                <div className="meta"><span className="truncate">{r.title}</span><a href={`/time/screenshots?worker_id=${r.worker_id}`} onClick={e => { e.preventDefault(); nav(`/time/screenshots?worker_id=${r.worker_id}`); }}>Timeline →</a></div>
              </div>
            </div>
          ))}
        </div>
      )}
      {lb && <Lightbox shots={lb.shots} index={lb.i} onIndex={i => setLb({ ...lb, i })} onClose={() => setLb(null)} canFlag={can('screenshots', 'view')} />}
    </div>
  );
}
