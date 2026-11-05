import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LogIn, LogOut, Coffee, Play, Radio, AlarmClock, UserX, Clock as ClockIcon, Lock, User } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Avatar, KpiRow, EmptyState, ErrorState, LoadingBlock, Banner, Boundary, Segmented, Dialog, Field, StatusPill, PermissionDenied } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { useApi, useInterval } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { relTime, duration, time as fmtTime } from '../../lib/format';
import { useRealtime, useTicker, hm } from '../workforce/shared';
import './time.css';

type Action = 'clock-in' | 'start-break' | 'end-break' | 'clock-out';
type View = 'all' | 'attention' | 'in' | 'done' | 'off';
const VIEWS: Record<View, string[] | null> = { all: null, attention: ['late', 'absent', 'not_clocked_in'], in: ['working', 'on_break'], done: ['clocked_out'], off: ['off_today', 'time_off', 'elsewhere'] };
const TONE: Record<string, string> = { working: 'green', on_break: 'amber', late: 'amber', absent: 'red', not_clocked_in: 'blue', clocked_out: 'gray', elsewhere: 'purple', time_off: 'purple', off_today: 'gray' };
const ACTION: Record<Action, { label: string; icon: JSX.Element; variant: 'primary' | 'outline' | 'danger' | 'success'; verb: string }> = {
  'clock-in': { label: 'Clock in', icon: <LogIn size={14} />, variant: 'primary', verb: 'Clock in' },
  'start-break': { label: 'Start break', icon: <Coffee size={14} />, variant: 'outline', verb: 'Start a break for' },
  'end-break': { label: 'End break', icon: <Play size={14} />, variant: 'outline', verb: 'End the break for' },
  'clock-out': { label: 'Clock out', icon: <LogOut size={14} />, variant: 'outline', verb: 'Clock out' },
};
const tzCity = (tz: string) => tz.split('/').pop()?.replace(/_/g, ' ') ?? tz;

/** Ticking session timer: net seconds at fetch time + elapsed since (paused while on break). */
function SessionTimer({ sec, fetchedAt, running }: { sec: number | null; fetchedAt: number; running: boolean }) {
  useTicker(running);
  if (sec === null || sec === undefined) return <span className="muted">—</span>;
  const s = sec + (running ? Math.max(0, (Date.now() - fetchedAt) / 1000) : 0);
  return <span className="tm-timer">{duration(s)}</span>;
}

/** Supervisor console: every placement scheduled today (in its own timezone), with on-behalf clock actions. */
export default function Clock() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const view = (sp.get('view') as View) || 'all';
  const company = sp.get('company_id') ?? '';
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const allowed = can('time', 'view');
  const st = useApi<any>(allowed ? `/api/v1/time/clock/today${qs({ company_id: company })}` : null);
  const me = useApi<any>('/api/v1/time/clock/me');
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  useEffect(() => { if (st.data) setFetchedAt(Date.now()); }, [st.data]);
  const [pending, setPending] = useState<{ row: any; action: Action; self?: boolean } | null>(null);
  const timer = useRef<number | null>(null);
  const soft = () => { if (timer.current) return; timer.current = window.setTimeout(() => { timer.current = null; st.reload(); me.reload(); }, 1200); };
  useRealtime('presence', soft);
  useInterval(() => { st.reload(); me.reload(); }, 60000);

  const d = st.data;
  const rows = useMemo(() => { const f = VIEWS[view]; return (d?.rows ?? []).filter((r: any) => !f || f.includes(r.status)); }, [d, view]);
  if (!allowed) return <PermissionDenied text="Your role cannot view the clock-in console." />;
  const c = d?.counts ?? {};
  const sm = d?.summary;
  const canEdit = !!d?.can_edit;
  const myRows: any[] = me.data?.is_worker ? me.data.rows : [];

  return (
    <div>
      <PageHeader title="Clock In" sub={d ? <>Today in each placement's own timezone · updated {relTime(d.as_of)} · live via realtime</> : 'Who is working right now, and clock actions on behalf of workers'} actions={<>
        <select className="select" style={{ width: 'auto', height: 38 }} aria-label="Client" value={company} onChange={e => set({ company_id: e.target.value || null })}><option value="">All clients</option>{(d?.companies ?? []).map((co: any) => <option key={co.id} value={co.id}>{co.name}</option>)}</select>
        <Button onClick={() => nav('/time/activity')}>Apps & Activity</Button>
        <Button variant="primary" icon={<Radio size={16} />} onClick={() => nav('/time/live')}>Live Now</Button>
      </>} />

      {st.error && !d ? <ErrorState error={st.error} retry={st.reload} /> : !d ? <LoadingBlock rows={8} /> : <>
        {(c.late > 0 || c.absent > 0)
          ? <Banner tone="warn"><b>{c.late} worker{c.late === 1 ? ' is' : 's are'} late</b>{c.absent ? <> and <b>{c.absent} missed their shift</b></> : null} with no clock-in. {canEdit ? 'If they are working but the tracker failed, clock them in with a reason.' : ''} <a href="?view=attention" onClick={e => { e.preventDefault(); set({ view: 'attention' }); }}>Show them →</a></Banner>
          : !canEdit ? <Banner tone="info">You can view today's clock status. Clocking in on behalf of workers needs the <b>Time: edit</b> permission (account managers, HR, owners).</Banner>
          : <Banner tone="info">Clock actions here create real time entries marked <b>manual</b>, attributed to you, logged in the audit trail, and the worker is notified. Approved weeks are locked.</Banner>}

        <KpiRow items={[
          { label: 'Clocked in now', icon: <Radio size={16} />, value: sm.clocked_in_now, deltaText: <span>{c.working} working · {c.on_break} on break</span>, suffix: '', onClick: () => set({ view: 'in' }) },
          { label: 'Late / missed', icon: <AlarmClock size={16} />, value: c.late + c.absent, deltaText: <span>{c.late} late · {c.absent} missed shift</span>, suffix: '', onClick: () => set({ view: 'attention' }) },
          { label: 'Not clocked in yet', icon: <UserX size={16} />, value: c.not_clocked_in, deltaText: <span>{sm.scheduled_today} scheduled today</span>, suffix: '', onClick: () => set({ view: 'attention' }) },
          { label: 'Hours today', icon: <ClockIcon size={16} />, value: hm(sm.minutes_today), deltaText: <span>{sm.on_behalf_today} on-behalf action{sm.on_behalf_today === 1 ? '' : 's'} (24h)</span>, suffix: '', to: '/time/timesheets' },
        ]} />

        {myRows.length > 0 && <Boundary label="My clock"><Card className="tm-mine" style={{ marginBottom: 20 }}>
          <CardHeader title={<span className="row" style={{ gap: 8 }}><User size={16} /> My clock</span>} sub="You are also a worker in this workspace" right={me.data.tracker_link ? <Link to={me.data.tracker_link} className="btn btn-sm">Open my tracker</Link> : undefined} />
          <div className="tm-clock-list">{myRows.map((r: any) => <ClockRow key={r.placement_id} r={r} fetchedAt={fetchedAt} canEdit onAction={a => setPending({ row: r, action: a, self: true })} self />)}</div>
        </Card></Boundary>}

        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <Segmented value={view} onChange={k => set({ view: k === 'all' ? null : k })} options={[
            { key: 'all', label: `All (${d.rows.length})` }, { key: 'attention', label: `Needs attention (${c.late + c.absent + c.not_clocked_in})` },
            { key: 'in', label: `Clocked in (${c.working + c.on_break})` }, { key: 'done', label: `Clocked out (${c.clocked_out})` }, { key: 'off', label: `Off / time off (${c.off_today + c.time_off + c.elsewhere})` },
          ]} />
          <span className="small muted">{sm.placements} active placement{sm.placements === 1 ? '' : 's'}</span>
        </div>

        <Boundary label="Clock console"><Card>
          {rows.length === 0 ? <div className="card-b"><EmptyState icon={<ClockIcon size={22} />} title={view === 'attention' ? 'Everyone scheduled is clocked in' : view === 'in' ? 'Nobody is clocked in right now' : 'No placements here'} text={view === 'all' ? 'Active placements appear here with their shift for today.' : undefined} /></div> :
            <div className="tm-clock-list">
              <div className="tm-clock-row head"><span>Worker</span><span>Status</span><span>Shift today (local)</span><span>Session · today</span><span style={{ textAlign: 'right' }}>{canEdit ? 'Actions on behalf' : ''}</span></div>
              {rows.map((r: any) => <ClockRow key={r.placement_id} r={r} fetchedAt={fetchedAt} canEdit={canEdit} onAction={a => setPending({ row: r, action: a })} onOpen={() => nav(`/workforce/placements/${r.placement_id}`)} />)}
            </div>}
        </Card></Boundary>
      </>}

      <ActionDialog pending={pending} onClose={() => setPending(null)} onDone={() => { setPending(null); st.reload(); me.reload(); }} />
    </div>
  );
}

function ClockRow({ r, fetchedAt, canEdit, onAction, onOpen, self }: { r: any; fetchedAt: number; canEdit: boolean; onAction: (a: Action) => void; onOpen?: () => void; self?: boolean }) {
  const btn = (a: Action, enabled: boolean) => enabled ? <Button key={a} size="xs" variant={ACTION[a].variant} icon={ACTION[a].icon} onClick={() => onAction(a)}>{ACTION[a].label}</Button> : null;
  const live = r.status === 'working' || r.status === 'on_break';
  const shift = r.scheduled ? `${fmtTime(r.shift_start_at)} – ${fmtTime(r.shift_end_at)}` : 'Not scheduled today';
  return (
    <div className="tm-clock-row">
      <div className="who" onClick={onOpen} role={onOpen ? 'link' : undefined}>
        <Avatar name={r.worker_name} color={r.avatar_color} size={34} />
        <div style={{ minWidth: 0 }}><div className="bold truncate">{self ? `${r.title}` : r.worker_name}</div><div className="small muted truncate">{self ? r.company_name : `${r.title} · ${r.company_name}`}</div></div>
      </div>
      <div className="st"><StatusPill status={r.status} label={r.status === 'late' && r.late_minutes ? `Late ${r.late_minutes}m` : r.idle ? 'Working (idle)' : r.status_label} tone={TONE[r.status]} /></div>
      <div className="cell small"><span className="lbl">Shift</span><span><span className="bold">{r.scheduled ? `${r.shift_start}–${r.shift_end}` : '—'}</span> <span className="muted">{tzCity(r.timezone)} · now {r.local_time}</span>{r.scheduled && <div className="muted">{shift} your time</div>}</span></div>
      <div className="cell small"><span className="lbl">Session</span><span>
        {live ? <><SessionTimer sec={r.session_sec} fetchedAt={fetchedAt} running={r.status === 'working'} /> <span className="muted">{r.status === 'on_break' ? `· break since ${fmtTime(r.break_started_at)}` : `· since ${fmtTime(r.session_started_at)}`}</span></> : <span className="muted">{r.last_ended_at ? `Out at ${fmtTime(r.last_ended_at)}` : r.first_started_at ? '' : 'No session'}</span>}
        <div className="muted">Today {hm(r.today_minutes)}{r.clocked_in_by_name ? ` · clocked in by ${r.clocked_in_by_name}` : r.session_source === 'tracker' ? ' · via tracker' : ''}</div>
      </span></div>
      <div className="acts">
        {r.week_locked ? <span className="small muted row" style={{ gap: 4 }} title="This week's timesheet is approved — use a timesheet adjustment"><Lock size={13} /> Week {r.week_status}</span>
          : r.status === 'elsewhere' ? <span className="small muted">Clocked in on another placement</span>
          : r.status === 'time_off' ? <span className="small muted">Approved time off</span>
          : canEdit ? <>{btn('clock-in', r.actions.clock_in)}{btn('start-break', r.actions.start_break)}{btn('end-break', r.actions.end_break)}{btn('clock-out', r.actions.clock_out)}</> : null}
      </div>
    </div>
  );
}

const OFFSETS = [0, 5, 10, 15, 30, 45, 60, 90, 120];

function ActionDialog({ pending, onClose, onDone }: { pending: { row: any; action: Action; self?: boolean } | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [ago, setAgo] = useState(0);
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = pending ? `${pending.row.placement_id}:${pending.action}` : '';
  useEffect(() => { setReason(''); setAgo(0); setMemo(''); setErr(null); }, [key]);
  if (!pending) return null;
  const { row, action, self } = pending;
  const a = ACTION[action];
  const needReason = !self;
  const sessionStart = row.session_started_at ? new Date(row.session_started_at).getTime() : null;
  const offsets = OFFSETS.filter(m => action === 'clock-in' || !sessionStart || Date.now() - m * 60000 >= sessionStart);
  const submit = async () => {
    if (needReason && reason.trim().length < 3) { setErr('Give a reason (at least 3 characters)'); return; }
    setBusy(true);
    try {
      const body: any = { reason: reason.trim() || null, memo: memo.trim() || null };
      if (ago) body.at = new Date(Date.now() - ago * 60000).toISOString();
      await api.post(`/api/v1/time/clock/${self ? 'me/' : ''}${row.placement_id}/${action}`, body);
      toast.success(self ? `${a.label} recorded` : `${a.label} recorded for ${row.worker_name}`);
      onDone();
    } catch (e: any) {
      if (e?.fields?.reason) setErr(e.fields.reason); else toast.error(e);
    } finally { setBusy(false); }
  };
  const target = self ? 'yourself' : row.worker_name;
  return (
    <Dialog open onClose={onClose} title={self ? `${a.label} — ${row.company_name}` : `${a.verb} ${row.worker_name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={action === 'clock-in' ? 'primary' : 'dark'} icon={a.icon} loading={busy} disabled={needReason && !reason.trim()} onClick={submit}>{a.label}</Button></>}>
      <div className="muted" style={{ marginBottom: 14 }}>
        {row.title} at {row.company_name} · {row.scheduled ? `shift ${row.shift_start}–${row.shift_end}` : 'not scheduled today'} ({tzCity(row.timezone)}, now {row.local_time}).
        {!self && <> This creates a <b>manual</b> time record attributed to you, is written to the audit log, and {target} is notified.</>}
      </div>
      <Field label={needReason ? 'Reason *' : 'Note (optional)'} htmlFor="tm-reason" error={err}>
        <textarea id="tm-reason" className="textarea" autoFocus value={reason} onChange={e => { setReason(e.target.value); setErr(null); }} placeholder={needReason ? 'e.g. Tracker would not start on the worker\'s laptop — confirmed by phone' : ''} maxLength={500} />
      </Field>
      <Field label="Effective time" htmlFor="tm-at" hint="Backdate up to 2 hours if the worker started or stopped earlier.">
        <select id="tm-at" className="select" value={ago} onChange={e => setAgo(Number(e.target.value))}>
          {offsets.map(m => <option key={m} value={m}>{m === 0 ? 'Now' : `${m} minutes ago (${fmtTime(new Date(Date.now() - m * 60000).toISOString())})`}</option>)}
        </select>
      </Field>
      {(action === 'clock-in' || action === 'clock-out') && <Field label="Session memo (optional)" htmlFor="tm-memo"><input id="tm-memo" className="input" value={memo} onChange={e => setMemo(e.target.value)} maxLength={500} placeholder="What they are working on" /></Field>}
    </Dialog>
  );
}
