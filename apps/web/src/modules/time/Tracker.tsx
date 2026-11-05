// Worker Portal web Time Tracker: clock in/out, breaks, memo, monitoring disclosure, real screen capture
// (getDisplayMedia at a random moment in each interval), activity counts (never content), idle prompt,
// offline queue with sync indicator, manual time requests and demo simulation.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Coffee, Play, Square, MonitorUp, MonitorOff, ShieldCheck, Wifi, WifiOff, RefreshCw, Wand2, CalendarPlus, Eye, Trash2 } from 'lucide-react';
import { Card, CardHeader, Button, Dialog, Field, Banner, StatusPill, EmptyState, ErrorState, LoadingBlock, useConfirm } from '../../components/ui';
import { FormDrawer } from '../../components/FormDrawer';
import { useApi } from '../../lib/hooks';
import { api, ApiError } from '../../lib/api';
import { useWorkspace } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { duration, time as fmtTime, dateTime, todayISO, date } from '../../lib/format';
import { hm, scheduleText, Lightbox, type Shot } from '../workforce/shared';

type QEvent = { client_event_id: string; type: 'clock_in' | 'clock_out' | 'break' | 'resume' | 'heartbeat' | 'idle' | 'memo'; at: string; data: Record<string, unknown> };
const uid = () => (crypto as any).randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function useQueue(workerId: string) {
  const key = `veyro.tracker.queue.${workerId}`;
  const read = useCallback((): QEvent[] => { try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; } }, [key]);
  const [q, setQ] = useState<QEvent[]>(read);
  const write = (items: QEvent[]) => { const v = items.slice(-500); localStorage.setItem(key, JSON.stringify(v)); setQ(v); };
  return { q, push: (e: QEvent) => write([...read(), e]), remove: (ids: string[]) => write(read().filter(e => !ids.includes(e.client_event_id))), read };
}

export default function Tracker() {
  const ws = useWorkspace();
  const workerId = ws.workerId ?? 'me';
  const st = useApi<any>('/api/v1/portal/worker/tracker/state');
  const confirm = useConfirm();
  const [s, setS] = useState<any>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [sel, setSel] = useState<string>('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [idle, setIdle] = useState<{ since: number } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const [, tick] = useState(0);
  const queue = useQueue(workerId);
  const shots = useApi<any>(`/api/v1/portal/worker/screenshots?date=${todayISO()}`);
  const [lb, setLb] = useState<number | null>(null);

  const apply = useCallback((state: any) => { setS(state); setFetchedAt(Date.now()); }, []);
  useEffect(() => { if (st.data) apply(st.data); }, [st.data, apply]);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, []);
  const active = useMemo(() => (s?.placements ?? []).filter((p: any) => ['active', 'notice'].includes(p.status)), [s]);
  useEffect(() => { if (s && !sel) setSel(s.current?.placement_id ?? active[0]?.id ?? ''); }, [s, sel, active]);
  const pl = (s?.placements ?? []).find((p: any) => p.id === (s?.current?.placement_id ?? sel));
  const cur = s?.current ?? null;
  const onBreak = !!cur?.open_break;
  useEffect(() => { if (pl && !pl.policy_accepted_at && ['active', 'notice'].includes(pl.status)) setPolicyOpen(true); }, [pl?.id, pl?.policy_accepted_at]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── activity counting (counts only — never key values) ──
  const counters = useRef({ keys: 0, mouse: 0, secs: new Set<number>(), lastInput: Date.now(), lastMove: 0, bucketStart: Date.now() });
  useEffect(() => {
    const mark = () => { const c = counters.current; c.lastInput = Date.now(); c.secs.add(Math.floor(Date.now() / 1000)); };
    const onKey = () => { counters.current.keys++; mark(); };
    const onMove = () => { const c = counters.current; if (Date.now() - c.lastMove > 120) { c.mouse++; c.lastMove = Date.now(); } mark(); };
    const onClick = () => { counters.current.mouse++; mark(); };
    window.addEventListener('keydown', onKey); window.addEventListener('mousemove', onMove); window.addEventListener('mousedown', onClick); window.addEventListener('wheel', onMove, { passive: true }); window.addEventListener('touchstart', onClick, { passive: true });
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousemove', onMove); window.removeEventListener('mousedown', onClick); window.removeEventListener('wheel', onMove); window.removeEventListener('touchstart', onClick); };
  }, []);

  // ── offline-aware action runner ──
  const sync = useCallback(async () => {
    const events = queue.read();
    if (!events.length) return;
    try {
      const r = await api.post('/api/v1/portal/worker/tracker/sync', { events });
      queue.remove(r.results.map((x: any) => x.client_event_id));
      const failed = r.results.filter((x: any) => !x.ok);
      setSyncErr(failed.length ? `${failed.length} queued event(s) could not be applied: ${failed[0].error}` : null);
      apply(r.state); setOnline(true);
      if (!failed.length) toast.success(`Synced ${r.results.length} offline event(s)`);
    } catch (e) { if (e instanceof ApiError && e.status === 0) setOnline(false); else setSyncErr((e as Error).message); }
  }, [queue, apply]);
  const syncRef = useRef(sync); syncRef.current = sync;
  useEffect(() => {
    const on = () => { setOnline(true); syncRef.current(); }, off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    const t = setInterval(() => { if (queue.read().length) syncRef.current(); }, 20000);
    if (queue.read().length) syncRef.current();
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); clearInterval(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (type: QEvent['type'], path: string, body: Record<string, unknown>, optimistic: (s: any) => any) => {
    setBusy(type);
    try { const r = await api.post(`/api/v1/portal/worker/tracker/${path}`, body); if (r?.placements) apply(r); return true; }
    catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        queue.push({ client_event_id: uid(), type, at: new Date().toISOString(), data: body });
        setOnline(false); setS((x: any) => optimistic(x)); setFetchedAt(Date.now());
        toast.info('You are offline — saved on this device and will sync automatically');
        return true;
      }
      if (e instanceof ApiError && e.details?.needs_policy) setPolicyOpen(true);
      toast.error(e); return false;
    } finally { setBusy(null); }
  };

  // ── screen capture (real, via getDisplayMedia) ──
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const capTimer = useRef<number | null>(null);
  const stopCapture = () => { if (capTimer.current) clearTimeout(capTimer.current); capTimer.current = null; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; setSharing(false); };
  const recentPct = () => { const c = counters.current; const span = Math.max(1, (Date.now() - c.bucketStart) / 1000); return Math.min(100, Math.round((c.secs.size / Math.min(span, 60)) * 100)); };
  const captureNow = useCallback(async (blur: boolean) => {
    const v = video.current;
    if (!stream.current || !v || !v.videoWidth) return;
    const scale = Math.min(1, 1280 / v.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale);
    const ctx = canvas.getContext('2d')!;
    if (blur) ctx.filter = 'blur(10px)';
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', 0.72));
    if (!blob) return;
    const f = new FormData();
    f.append('taken_at', new Date().toISOString()); f.append('activity_pct', String(recentPct())); f.append('blurred', String(blur));
    f.append('file', blob, 'screen.jpg');
    try { await api.upload('/api/v1/portal/worker/tracker/screenshot', f); shots.reload(); } catch { /* offline or policy change — skip this frame */ }
  }, [shots]);
  const scheduleWindow = useCallback((intervalMin: number, blur: boolean) => {
    const interval = Math.max(1, intervalMin) * 60000;
    const delay = Math.floor(interval * (0.05 + Math.random() * 0.9)); // random moment inside each interval
    capTimer.current = window.setTimeout(async () => { await captureNow(blur); capTimer.current = window.setTimeout(() => scheduleWindow(intervalMin, blur), interval - delay); }, delay);
  }, [captureNow]);
  const reportShare = (status: string) => api.post('/api/v1/portal/worker/tracker/screen-share', { status }).then(() => { shots.reload(); st.reload(); }).catch(() => {});
  const startShare = async (pending?: Promise<MediaStream>) => {
    if (!pl?.screenshots_enabled) return;
    const md: any = navigator.mediaDevices;
    if (!md?.getDisplayMedia) { reportShare('unsupported'); toast.info('Screen capture is not supported in this browser — demo screenshots will be generated'); return; }
    try {
      const ms: MediaStream = await (pending ?? md.getDisplayMedia({ video: { frameRate: 1 }, audio: false }));
      stream.current = ms; setSharing(true);
      if (video.current) { video.current.srcObject = ms; await video.current.play().catch(() => {}); }
      ms.getVideoTracks()[0]?.addEventListener('ended', () => { stopCapture(); reportShare('stopped'); toast.info('Screen sharing stopped — demo screenshots will be generated'); });
      reportShare('granted');
      scheduleWindow(pl.screenshot_interval_min, !!pl.blur);
      setTimeout(() => captureNow(!!pl.blur), 4000); // first frame shortly after sharing starts
    } catch { reportShare('declined'); toast.info('Screen sharing declined — your manager will see this; demo screenshots are generated instead'); }
  };
  useEffect(() => () => stopCapture(), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Clocked in after a reload without a stream: ask, and fall back to declined after 90s.
  useEffect(() => {
    if (!cur || onBreak || sharing || !pl?.screenshots_enabled) return;
    const t = setTimeout(() => { if (!stream.current && s?.presence?.screen_share === 'granted') reportShare('stopped'); }, 90000);
    return () => clearTimeout(t);
  }, [cur?.id, sharing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── heartbeat (every 60s) + idle detection ──
  useEffect(() => {
    if (!cur) return;
    const hb = setInterval(async () => {
      const c = counters.current;
      if (onBreak) { c.keys = 0; c.mouse = 0; c.secs.clear(); c.bucketStart = Date.now(); return; }
      const secs = Math.max(1, Math.min(600, Math.round((Date.now() - c.bucketStart) / 1000)));
      const activeS = Math.min(secs, c.secs.size);
      const body = { key_count: c.keys, mouse_count: c.mouse, active_seconds: activeS, idle_seconds: secs - activeS, bucket_start: new Date(c.bucketStart).toISOString(), idle: !!idle, app_label: 'VeyroApp Tracker' };
      c.keys = 0; c.mouse = 0; c.secs.clear(); c.bucketStart = Date.now();
      try { await api.post('/api/v1/portal/worker/tracker/heartbeat', body); setOnline(true); }
      catch (e) { if (e instanceof ApiError && e.status === 0) { queue.push({ client_event_id: uid(), type: 'heartbeat', at: body.bucket_start, data: body }); setOnline(false); } }
    }, 60000);
    const idleT = setInterval(() => {
      if (!pl || onBreak || idle) return;
      if (Date.now() - counters.current.lastInput > (pl.idle_minutes ?? 5) * 60000) setIdle({ since: counters.current.lastInput });
    }, 5000);
    return () => { clearInterval(hb); clearInterval(idleT); };
  }, [cur?.id, onBreak, idle, pl?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const decideIdle = async (decision: 'keep' | 'discard') => {
    if (!idle) return;
    const body = { started_at: new Date(idle.since).toISOString(), ended_at: new Date().toISOString(), decision };
    setIdle(null); counters.current.lastInput = Date.now();
    try { await api.post('/api/v1/portal/worker/tracker/idle', body); st.reload(); toast.success(decision === 'keep' ? 'Idle time kept' : 'Idle time discarded from your timesheet'); }
    catch (e) { if (e instanceof ApiError && e.status === 0) queue.push({ client_event_id: uid(), type: 'idle', at: body.ended_at, data: body }); else toast.error(e); }
  };

  // ── actions ──
  const clockIn = async () => {
    if (!pl) return;
    if (!pl.policy_accepted_at) { setPolicyOpen(true); return; }
    const md: any = navigator.mediaDevices;
    const pending: Promise<MediaStream> | undefined = pl.screenshots_enabled && md?.getDisplayMedia ? md.getDisplayMedia({ video: { frameRate: 1 }, audio: false }) : undefined; // keep the click gesture
    pending?.catch(() => {});
    counters.current = { ...counters.current, keys: 0, mouse: 0, secs: new Set(), bucketStart: Date.now(), lastInput: Date.now() };
    const ok = await run('clock_in', 'clock-in', { placement_id: pl.id, memo: memo || null }, x => ({ ...x, current: { id: 'offline', placement_id: pl.id, started_at: new Date().toISOString(), open_break: null, session_sec: 0, memo } }));
    if (ok && pl.screenshots_enabled) startShare(pending); else pending?.then(ms => ms.getTracks().forEach(t => t.stop())).catch(() => {});
  };
  const clockOut = async () => {
    const r = await confirm({ title: 'Clock out?', body: `Session ${duration(sessionSec)} will be saved to this week's timesheet.`, confirmLabel: 'Clock out' });
    if (!r.ok) return;
    if (await run('clock_out', 'clock-out', { memo: memo || null }, x => ({ ...x, current: null }))) { stopCapture(); setMemo(''); shots.reload(); }
  };
  const brk = () => run('break', 'break', {}, x => ({ ...x, current: { ...x.current, open_break: { started_at: new Date().toISOString() } } }));
  const resume = () => run('resume', 'resume', {}, x => ({ ...x, current: { ...x.current, open_break: null } }));
  const saveMemo = async () => { if (!cur) return; try { await api.post('/api/v1/portal/worker/tracker/memo', { memo }); toast.success('Memo saved'); } catch (e) { if (e instanceof ApiError && e.status === 0) queue.push({ client_event_id: uid(), type: 'memo', at: new Date().toISOString(), data: { memo } }); else toast.error(e); } };
  const accept = async () => { try { await api.post('/api/v1/portal/worker/tracker/accept-policy', { placement_id: pl.id }); setPolicyOpen(false); toast.success('Monitoring policy accepted'); st.reload(); } catch (e) { toast.error(e); } };
  const simDay = async () => {
    const r = await confirm({ title: 'Demo: simulate a workday?', body: 'Fast-forwards a full workday on the next unworked scheduled day this week: sessions with a lunch break, screenshots every interval and activity samples.', confirmLabel: 'Simulate workday' });
    if (!r.ok) return;
    setBusy('sim');
    try { const x = await api.post('/api/v1/portal/worker/tracker/simulate-day', { placement_id: pl.id }); apply(x.state); toast.success(`Simulated ${x.date}: ${hm(x.minutes)}, ${x.shots} screenshots`); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const simWeek = async () => {
    const r = await confirm({ title: 'Simulate the rest of the week & submit?', body: 'Fills every unworked scheduled day this week and submits your timesheet for approval.', confirmLabel: 'Simulate & submit' });
    if (!r.ok) return;
    setBusy('simw');
    try { const x = await api.post('/api/v1/portal/worker/tracker/simulate-week', { placement_id: pl.id, submit: true }); apply(x.state); toast.success(`Simulated ${x.days.length} day(s)${x.submitted ? ' — timesheet submitted' : ''}`); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const delShot = async (sh: Shot) => {
    const r = await confirm({ title: 'Delete this screenshot?', body: 'Deletion is allowed within your policy window and is logged.', danger: true, confirmLabel: 'Delete' });
    if (!r.ok) return;
    try { await api.del(`/api/v1/portal/worker/screenshots/${sh.id}`); toast.success('Screenshot deleted'); setLb(null); shots.reload(); } catch (e) { toast.error(e); }
  };

  if (st.error && !s) return <ErrorState error={st.error} retry={st.reload} />;
  if (!s) return <LoadingBlock rows={6} />;
  if (!s.placements.length) return <EmptyState title="No placement yet" text="Your tracker appears once your agency places you with a client." />;
  const elapsed = (Date.now() - fetchedAt) / 1000;
  const running = !!cur && !onBreak;
  const sessionSec = cur ? (cur.session_sec ?? 0) + (running ? elapsed : 0) : 0;
  const todaySec = s.totals.today_sec + (running ? elapsed : 0);
  const weekSec = s.totals.week_sec + (running ? elapsed : 0);
  const pendingQ = queue.q.length;
  const shotRows: Shot[] = shots.data?.rows ?? [];
  const share = s.presence?.screen_share;
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div><h1 style={{ margin: 0 }}>Time Tracker</h1><div className="muted small">{pl ? `${pl.title} · ${pl.company_name} · ${scheduleText(pl.schedule_days, pl.schedule_start, pl.schedule_end)} (${pl.timezone.replace('_', ' ')})` : ''}</div></div>
        <div className="row" style={{ gap: 8 }}>
          <span className={`wf-sync ${!online ? 'off' : syncErr ? 'err' : ''}`} role="status">{!online ? <><WifiOff size={13} /> Offline{pendingQ ? ` · ${pendingQ} queued` : ''}</> : pendingQ ? <><RefreshCw size={13} /> Syncing {pendingQ}…</> : syncErr ? <>Sync issue</> : <><Wifi size={13} /> Synced</>}</span>
          {pendingQ > 0 && online && <Button size="sm" onClick={sync}>Sync now</Button>}
        </div>
      </div>
      {syncErr && <Banner tone="danger">{syncErr}</Banner>}
      {active.length === 0 && <Banner tone="warn">None of your placements are active yet. {s.placements[0]?.status === 'onboarding' ? <Link to="/portal/worker/onboarding">Finish your onboarding items →</Link> : null}</Banner>}
      <div className="wf-tracker">
        <div className="stack" style={{ gap: 20 }}>
          <Card>
            <div className="wf-clock">
              {active.length > 1 && !cur && <Field label="Placement" htmlFor="tr-pl"><select id="tr-pl" className="select" value={sel} onChange={e => setSel(e.target.value)}>{active.map((p: any) => <option key={p.id} value={p.id}>{p.title} — {p.company_name}</option>)}</select></Field>}
              <div className="row" style={{ gap: 8 }}>{cur ? <StatusPill status={onBreak ? 'on_break' : idle ? 'idle' : 'working'} label={onBreak ? 'On break' : idle ? 'Idle?' : 'Working'} /> : <StatusPill status="offline" label="Not clocked in" tone="gray" />}{cur && pl?.screenshots_enabled && (sharing ? <StatusPill status="active" label="Screen shared" /> : <StatusPill status="warn" label={share === 'declined' || share === 'unsupported' ? 'Screen not shared — demo screenshots' : 'Screen not shared'} tone="amber" />)}</div>
              <div className="big-timer" aria-live="off">{duration(sessionSec)}</div>
              <div className="muted small">{cur ? `Session started ${fmtTime(cur.started_at)}${onBreak ? ` · on break since ${fmtTime(cur.open_break.started_at)}` : ''}` : 'Current session'}</div>
              {!cur ? <button className="clock-btn" disabled={!pl || !['active', 'notice'].includes(pl.status) || busy === 'clock_in'} onClick={clockIn} aria-label="Clock in">{busy === 'clock_in' ? <span className="spinner" /> : <><Play size={26} /><br />Clock In</>}</button>
                : <div className="row" style={{ gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
                  {onBreak ? <Button variant="primary" icon={<Play size={16} />} loading={busy === 'resume'} onClick={resume}>Resume</Button> : <Button icon={<Coffee size={16} />} loading={busy === 'break'} onClick={brk}>Take a break</Button>}
                  <button className="clock-btn out" style={{ width: 130, height: 130, fontSize: 17 }} onClick={clockOut} aria-label="Clock out"><Square size={20} /><br />Clock Out</button>
                </div>}
              <div className="wf-totals"><div><span className="small muted">Session</span><b>{duration(sessionSec)}</b></div><div><span className="small muted">Today</span><b>{duration(todaySec)}</b></div><div><span className="small muted">This week</span><b>{duration(weekSec)}</b></div></div>
              <div style={{ width: '100%' }}><Field label="What are you working on? (optional)" htmlFor="tr-memo"><div className="row" style={{ gap: 8 }}><input id="tr-memo" className="input" value={memo} onChange={e => setMemo(e.target.value)} placeholder={cur?.memo ?? 'e.g. Insurance verifications'} />{cur && <Button onClick={saveMemo} disabled={!memo.trim()}>Save</Button>}</div></Field></div>
              {cur && pl?.screenshots_enabled && !sharing && <Button icon={<MonitorUp size={16} />} onClick={() => startShare()}>Share my screen</Button>}
              {sharing && <Button variant="ghost" icon={<MonitorOff size={16} />} onClick={() => { stopCapture(); reportShare('stopped'); }}>Stop sharing</Button>}
            </div>
          </Card>
          <Card><CardHeader title="Today's sessions" sub={`${s.entries_today.length} session${s.entries_today.length === 1 ? "" : "s"} · ${date(s.today, { weekday: "long", month: "short", day: "numeric" })}`} />
            {s.entries_today.length ? <table className="table"><tbody>{s.entries_today.map((e: any) => <tr key={e.id}><td>{fmtTime(e.started_at)} – {e.ended_at ? fmtTime(e.ended_at) : <span className="pill pill-green">running</span>}</td><td className="small">{e.memo ?? '—'}{e.source !== 'tracker' && <span className="muted"> · {e.source}</span>}</td><td className="small muted">{e.break_seconds ? `${Math.round(e.break_seconds / 60)}m break` : ''}{e.discarded_idle_seconds ? ` · ${Math.round(e.discarded_idle_seconds / 60)}m idle discarded` : ''}</td><td className="right num">{hm(e.minutes)}</td></tr>)}</tbody></table> : <EmptyState title="No time tracked today" />}
          </Card>
          <Card><CardHeader title="My screenshots today" sub={pl?.screenshots_enabled ? `You can delete one within ${pl.worker_delete_window_min} min of capture (logged).` : 'Screenshots are off for your policy.'} />
            <div className="card-b">{shotRows.length ? <div className="shot-grid">{shotRows.map((sh, i) => <div key={sh.id} className="shot" onClick={() => setLb(i)} role="button" tabIndex={0} aria-label={`Screenshot ${fmtTime(sh.taken_at)}`}><img src={sh.url ?? ''} alt="" loading="lazy" /><div className="meta"><span>{fmtTime(sh.taken_at)} · {sh.kind === 'real' ? 'screen' : 'demo'}</span>{sh.can_delete && <button className="icon-btn" aria-label="Delete screenshot" onClick={e => { e.stopPropagation(); delShot(sh); }}><Trash2 size={13} /></button>}</div></div>)}</div> : <EmptyState title="No screenshots today" />}</div>
          </Card>
        </div>
        <div className="stack" style={{ gap: 20 }}>
          <Card pad>
            <div className="row" style={{ justifyContent: 'space-between' }}><div className="card-title-lg" style={{ fontSize: 16 }}><ShieldCheck size={16} /> Monitoring policy</div><Button size="sm" variant="ghost" icon={<Eye size={14} />} onClick={() => setPolicyOpen(true)}>View</Button></div>
            {pl && <div className="small muted" style={{ marginTop: 8 }}>{pl.policy_name}: {pl.screenshots_enabled ? `screenshots every ${pl.screenshot_interval_min} min${pl.blur ? ' (blurred)' : ''}` : 'no screenshots'}, activity {pl.activity_tracking ? 'counts' : 'off'}. {pl.policy_accepted_at ? `Accepted ${dateTime(pl.policy_accepted_at)}.` : 'Not yet accepted.'}</div>}
          </Card>
          <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}>Missed some time?</div><div className="small muted" style={{ margin: '6px 0 12px' }}>Ask your manager to add time you forgot to track.</div><Button block icon={<CalendarPlus size={16} />} onClick={() => setManualOpen(true)} disabled={!active.length}>Request manual time</Button></Card>
          <Card pad><div className="card-title-lg" style={{ fontSize: 16 }}><Wand2 size={16} /> Demo mode</div><div className="small muted" style={{ margin: '6px 0 12px' }}>Fast-forward realistic sessions, screenshots and activity for testing.</div>
            <div className="stack" style={{ gap: 8 }}><Button block loading={busy === 'sim'} disabled={!pl || !pl.policy_accepted_at || !['active', 'notice'].includes(pl.status)} onClick={simDay}>Demo: simulate a workday</Button><Button block loading={busy === 'simw'} disabled={!pl || !pl.policy_accepted_at || !!cur || !['active', 'notice'].includes(pl.status)} onClick={simWeek}>Simulate rest of week & submit</Button></div>
            {s.timesheets_this_week.map((t: any) => <div key={t.id} className="small" style={{ marginTop: 10 }}>This week: <StatusPill status={t.status} /> {hm(t.total_minutes)} · <Link to="/portal/worker/timesheets">Timesheets →</Link></div>)}
          </Card>
          <Card pad><div className="small muted">Activity tracking counts keyboard and mouse events inside this tab only — never what you type. Idle after {pl?.idle_minutes ?? 5} minutes asks whether to keep the time.</div></Card>
        </div>
      </div>
      <video ref={video} muted playsInline style={{ display: 'none' }} />
      <Dialog open={policyOpen && !!pl} onClose={() => setPolicyOpen(false)} title="Monitoring policy" footer={pl && !pl.policy_accepted_at ? <><Button onClick={() => setPolicyOpen(false)}>Not now</Button><Button variant="primary" icon={<ShieldCheck size={16} />} onClick={accept}>I understand and accept</Button></> : <Button onClick={() => setPolicyOpen(false)}>Close</Button>}>
        {pl && <div>
          <p style={{ marginTop: 0 }}>While you are clocked in for <b>{pl.company_name}</b>, the <b>{pl.policy_name}</b> policy applies:</p>
          <ul className="wf-policy">
            <li><b>Screenshots:</b> {pl.screenshots_enabled ? `one at a random moment in every ${pl.screenshot_interval_min}-minute interval, from the screen you choose to share${pl.blur ? ', blurred before upload' : ''}.` : 'off.'}</li>
            <li><b>Activity:</b> {pl.activity_tracking ? 'counts of keyboard and mouse events in the tracker tab. Keystroke content is never recorded.' : 'not tracked.'}</li>
            <li><b>Idle time:</b> after {pl.idle_minutes} minutes without input you are asked whether to keep or discard the time.</li>
            <li><b>Retention:</b> screenshots are deleted automatically after {pl.retention_days} days. You can delete a screenshot within {pl.worker_delete_window_min} minutes of capture (logged).</li>
            <li><b>Client visibility:</b> {pl.client_can_view ? 'your client can view screenshots and activity for this placement.' : 'only your agency can view screenshots.'}</li>
            <li>If you decline screen sharing, your manager is notified and demo screenshots are generated in this demo environment.</li>
          </ul>
          {pl.policy_accepted_at && <Banner tone="success">You accepted this policy on {dateTime(pl.policy_accepted_at)}.</Banner>}
        </div>}
      </Dialog>
      <Dialog open={!!idle} onClose={() => decideIdle('keep')} title="Are you still working?" footer={<><Button variant="danger" onClick={() => decideIdle('discard')}>Discard idle time</Button><Button variant="primary" onClick={() => decideIdle('keep')}>Yes — keep the time</Button></>}>
        {idle && <p style={{ margin: 0 }}>No keyboard or mouse activity since <b>{fmtTime(new Date(idle.since).toISOString())}</b> ({duration((Date.now() - idle.since) / 1000)}). Keep it if you were working away from the computer (calls, meetings); otherwise discard it from your timesheet.</p>}
      </Dialog>
      <FormDrawer open={manualOpen} onClose={() => setManualOpen(false)} title="Request manual time" submitLabel="Send request" initial={{ placement_id: pl?.id, work_date: todayISO(), start_time: '17:00', end_time: '18:00' }}
        fields={[
          { name: 'placement_id', label: 'Placement', type: 'select', required: true, options: active.map((p: any) => ({ value: p.id, label: `${p.title} — ${p.company_name}` })), full: true },
          { name: 'work_date', label: 'Date', type: 'date', required: true },
          { name: 'start_time', label: 'Start', type: 'time', required: true }, { name: 'end_time', label: 'End', type: 'time', required: true },
          { name: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'e.g. Stayed late to finish the month-end report' },
        ]}
        onSubmit={async v => { await api.post('/api/v1/portal/worker/manual-requests', v); toast.success('Request sent to your manager'); }} />
      {lb !== null && <Lightbox shots={shotRows} index={lb} onIndex={setLb} onClose={() => setLb(null)} onDelete={delShot} />}
    </div>
  );
}
