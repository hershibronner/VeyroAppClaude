// Shared helpers for WORKFORCE + TIME modules (not auto-loaded: folder starts with "_").
import { addDays, weekStart, dateInTz, zonedToUtc, isoDow, mockDesktopSvg, MOCK_APPS } from '@veyro/shared';
import { ZodError } from 'zod';
import { one, q, pool, type Db } from '../../core/db';
import { publishOrg } from '../../core/realtime';
import { saveFile, signedUrl } from '../../core/storage';

export const WNAME = `(cd.first_name || COALESCE(' ' || cd.last_name, ''))`;
/** Net minutes of a time entry (open entries count up to now): elapsed − breaks − discarded idle. */
export const ENTRY_MIN = (a = 'e') => `GREATEST(0, floor((EXTRACT(EPOCH FROM (COALESCE(${a}.ended_at, now()) - ${a}.started_at)) - ${a}.break_seconds - ${a}.discarded_idle_seconds) / 60))::int`;
export const ENTRY_SEC = (a = 'e') => `GREATEST(0, floor(EXTRACT(EPOCH FROM (COALESCE(${a}.ended_at, now()) - ${a}.started_at)) - ${a}.break_seconds - ${a}.discarded_idle_seconds - COALESCE((SELECT EXTRACT(EPOCH FROM now() - b.started_at) FROM breaks b WHERE b.time_entry_id=${a}.id AND b.ended_at IS NULL LIMIT 1), 0)))::int`;
export const MOCK_FILE_COUNT = 24;

export const nowIso = () => new Date().toISOString();
export const todayIn = (tz: string) => dateInTz(new Date(), tz || 'America/New_York');
export const hhmm = (t: string | null | undefined) => (t ?? '00:00').slice(0, 5);
export function minutesOf(t: string) { const [h, m] = hhmm(t).split(':').map(Number); return h * 60 + m; }
export function fmtClock(d: Date, tz: string) { return d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }); }
export function rand(a: number, b: number) { return a + Math.floor(Math.random() * (b - a + 1)); }
export function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

/** Wraps an SVG screenshot in a gaussian blur (privacy policy). */
export function blurSvg(svg: string): string {
  return svg.replace(/<defs>/, '<defs><filter id="pv"><feGaussianBlur stdDeviation="9"/></filter>').replace(/(<rect width="1280" height="800" fill="url\(#wp\)"\/>)/, '$1<g filter="url(#pv)">').replace(/<\/svg>$/, '</g></svg>');
}

export async function placementFull(orgId: string, id: string, db: Db = pool) {
  return one<any>(`SELECT p.*, ${WNAME} worker_name, cd.email worker_email, cd.id candidate_id, w.user_id worker_user_id, w.status worker_status, co.name company_name, co.timesheet_approval, co.portal_screenshots,
      mp.name policy_name, mp.screenshots_enabled, mp.screenshot_interval_min, mp.blur, mp.activity_tracking, mp.idle_minutes, mp.retention_days, mp.worker_delete_window_min, mp.client_can_view
    FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=p.company_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id
    WHERE p.id=$1 AND p.organization_id=$2`, [id, orgId], db);
}

export function eventPayload(p: any, extra: Record<string, unknown> = {}) {
  return { worker_id: p.worker_id, worker_name: p.worker_name, placement_id: p.id, placement_title: p.title, company_id: p.company_id, company_name: p.company_name, account_manager_id: p.account_manager_id, recruiter_id: p.recruiter_id, sales_id: p.sales_id, ...extra };
}

/** Ensures the weekly timesheet row exists and refreshes its total while it is still editable. */
export async function rebuildTimesheet(orgId: string, placementId: string, wk: string, db: Db = pool) {
  const p = await one<any>(`SELECT id, worker_id, company_id FROM placements WHERE id=$1 AND organization_id=$2`, [placementId, orgId], db);
  if (!p) return null;
  await q(`INSERT INTO timesheets (organization_id, placement_id, worker_id, company_id, week_start) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (placement_id, week_start) DO NOTHING`, [orgId, placementId, p.worker_id, p.company_id, wk], db);
  return one<any>(`UPDATE timesheets t SET total_minutes = COALESCE((SELECT sum(${ENTRY_MIN()}) FROM time_entries e WHERE e.placement_id=t.placement_id AND e.work_date BETWEEN t.week_start AND t.week_start + 6), 0), updated_at=now()
    WHERE t.placement_id=$1 AND t.week_start=$2 AND t.organization_id=$3 AND t.status IN ('open','submitted','rejected') RETURNING *`, [placementId, wk, orgId], db)
    .then(async r => r ?? one<any>(`SELECT * FROM timesheets WHERE placement_id=$1 AND week_start=$2`, [placementId, wk], db));
}

/** Per-day minutes for a placement week from closed entries (used for the approval snapshot). */
export async function weekDays(placementId: string, wk: string, db: Db = pool, includeOpen = false) {
  const rows = await q<any>(`SELECT e.work_date::text d, sum(${ENTRY_MIN()})::int m FROM time_entries e WHERE e.placement_id=$1 AND e.work_date BETWEEN $2::date AND $2::date + 6 ${includeOpen ? '' : 'AND e.ended_at IS NOT NULL'} GROUP BY 1 ORDER BY 1`, [placementId, wk], db);
  return rows as { d: string; m: number }[];
}

/** Live row for one worker (used for realtime presence broadcasts and Live Now). */
export async function presenceRow(orgId: string, workerId: string, db: Db = pool) {
  const r = await one<any>(`SELECT wp.*, ${WNAME} worker_name, cd.avatar_color, co.name company_name, co.id company_id, p.title, p.timezone,
      (SELECT row_to_json(s) FROM (SELECT id, file, taken_at, app_label, blurred FROM screenshots WHERE worker_id=wp.worker_id AND deleted_at IS NULL ORDER BY taken_at DESC LIMIT 1) s) latest_shot,
      (SELECT COALESCE(sum(${ENTRY_MIN()}),0)::int FROM time_entries e WHERE e.worker_id=wp.worker_id AND e.work_date = (now() AT TIME ZONE COALESCE(p.timezone,'UTC'))::date) today_minutes
    FROM worker_presence wp JOIN workers w ON w.id=wp.worker_id JOIN candidates cd ON cd.id=w.candidate_id LEFT JOIN placements p ON p.id=wp.placement_id LEFT JOIN companies co ON co.id=p.company_id
    WHERE wp.worker_id=$1 AND wp.organization_id=$2`, [workerId, orgId], db);
  if (r?.latest_shot) r.latest_shot = { ...r.latest_shot, url: signedUrl(r.latest_shot.file, 3600), file: undefined };
  return r;
}
export async function broadcastPresence(orgId: string, workerId: string) {
  const r = await presenceRow(orgId, workerId);
  if (r) publishOrg(orgId, 'presence', { worker_id: workerId, state: r.state, activity_pct: r.activity_pct, session_started_at: r.session_started_at, latest_shot: r.latest_shot, company_name: r.company_name, worker_name: r.worker_name, today_minutes: r.today_minutes });
}

/** Generates and stores a realistic mock desktop screenshot (demo mode) and broadcasts it. */
export async function createMockShot(o: { orgId: string; workerId: string; placementId: string; entryId: string | null; at: Date; tz: string; blur: boolean; activityPct: number; writeFile?: boolean; db?: Db; broadcast?: boolean }) {
  const db = o.db ?? pool;
  const seed = Math.floor(Math.random() * 1e9);
  let file: string, app: string, url: string;
  if (o.writeFile === false) {
    const k = rand(0, MOCK_FILE_COUNT - 1);
    file = `mock/mock-${k}.svg`; app = MOCK_APPS[k % MOCK_APPS.length].app; url = MOCK_APPS[k % MOCK_APPS.length].url;
  } else {
    const g = mockDesktopSvg(seed, undefined, { clock: fmtClock(o.at, o.tz) });
    file = saveFile(`screenshots/${o.orgId}`, 'mock.svg', Buffer.from(o.blur ? blurSvg(g.svg) : g.svg));
    app = g.app; url = g.url;
  }
  const row = await one<any>(`INSERT INTO screenshots (organization_id, worker_id, placement_id, time_entry_id, taken_at, file, kind, app_label, url_label, activity_pct, blurred) VALUES ($1,$2,$3,$4,$5,$6,'mock',$7,$8,$9,$10) RETURNING *`,
    [o.orgId, o.workerId, o.placementId, o.entryId, o.at.toISOString(), file, app, url, o.activityPct, o.blur && o.writeFile !== false], db);
  if (o.broadcast !== false) publishOrg(o.orgId, 'screenshot', { id: row.id, worker_id: o.workerId, placement_id: o.placementId, taken_at: row.taken_at, app_label: app, activity_pct: o.activityPct, url: signedUrl(file, 3600) });
  return row;
}

export async function insertActivity(db: Db, o: { orgId: string; workerId: string; placementId: string; entryId: string | null; bucket: Date; pct: number; app?: string | null; seconds?: number }) {
  const secs = o.seconds ?? 600;
  const active = Math.round(secs * o.pct / 100);
  await q(`INSERT INTO activity_samples (organization_id, worker_id, placement_id, time_entry_id, bucket_start, bucket_seconds, key_count, mouse_count, active_seconds, idle_seconds, activity_pct, app_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [o.orgId, o.workerId, o.placementId, o.entryId, o.bucket.toISOString(), secs, Math.round(active * rand(6, 14) / 10), Math.round(active * rand(3, 9) / 10), active, secs - active, o.pct, o.app ?? null], db);
}

/** Creates a full realistic workday (one session with a lunch break, screenshots and activity) for a placement. */
export async function simulateWorkday(orgId: string, p: any, date: string, db: Db = pool, opts: { writeFiles?: boolean } = {}) {
  const tz = p.timezone || 'America/New_York';
  const sStart = minutesOf(p.schedule_start), sEnd = minutesOf(p.schedule_end);
  const startM = sStart + rand(-6, 4), endM = sEnd + rand(-3, 15);
  const lunch = Math.floor((sStart + sEnd) / 2) + rand(-15, 15), lunchLen = rand(30, 45);
  const t = (m: number) => zonedToUtc(date, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, tz);
  const st = t(startM), en = t(endM), bs = t(lunch), be = t(lunch + lunchLen);
  const entry = await one<any>(`INSERT INTO time_entries (organization_id, placement_id, worker_id, work_date, started_at, ended_at, memo, source, break_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7,'simulated',$8) RETURNING *`,
    [orgId, p.id, p.worker_id, date, st.toISOString(), en.toISOString(), pick(['Inbox + scheduling', 'Insurance verifications', 'Weekly report prep', 'Client callbacks', 'Data cleanup', 'CRM updates']), lunchLen * 60], db);
  await q(`INSERT INTO breaks (organization_id, time_entry_id, started_at, ended_at) VALUES ($1,$2,$3,$4)`, [orgId, entry.id, bs.toISOString(), be.toISOString()], db);
  const interval = Math.max(1, Math.round((p.screenshot_interval_min ?? 10) / 10)) * 600000;
  let shots = 0;
  for (let b = st.getTime(); b + 600000 <= en.getTime(); b += 600000) {
    if (b >= bs.getTime() && b < be.getTime()) continue;
    const pct = rand(42, 95);
    const app = pick(MOCK_APPS).app;
    if (p.activity_tracking !== false) await insertActivity(db, { orgId, workerId: p.worker_id, placementId: p.id, entryId: entry.id, bucket: new Date(b), pct, app });
    if (p.screenshots_enabled !== false && (b - st.getTime()) % interval === 0) {
      const at = new Date(b + rand(20, Math.floor(interval / 1000) - 20) * 1000);
      if (at < en && !(at >= bs && at < be)) { await createMockShot({ orgId, workerId: p.worker_id, placementId: p.id, entryId: entry.id, at, tz, blur: !!p.blur, activityPct: pct, db, broadcast: false, writeFile: opts.writeFiles !== false }); shots++; }
    }
  }
  const late = startM - sStart;
  if (late > 5) await q(`INSERT INTO attendance_events (organization_id, worker_id, placement_id, work_date, kind, minutes, note) VALUES ($1,$2,$3,$4,'late',$5,$6)`, [orgId, p.worker_id, p.id, date, late, `Clocked in ${late} min after shift start`], db);
  return { entry, shots, minutes: endM - startM - lunchLen };
}

/** Workdays (per placement schedule) of the week containing `date`. */
export function scheduledDays(p: { schedule_days: number[] }, wk: string) {
  return Array.from({ length: 7 }, (_, i) => addDays(wk, i)).filter(d => (p.schedule_days ?? [1, 2, 3, 4, 5]).includes(isoDow(d)));
}
export { weekStart, addDays, isoDow, zonedToUtc, dateInTz };

/** Derives the Live Now status for an active placement given presence/attendance/time-off. */
export function liveStatus(o: { state?: string | null; stale?: boolean; schedule_days: number[]; schedule_start: string; schedule_end: string; timezone: string; worked_today: boolean; absent_today: boolean; time_off_today: boolean; grace: number }) {
  if (o.state && o.state !== 'offline' && !o.stale) return o.state === 'working' ? 'working' : o.state === 'idle' ? 'idle' : 'on_break';
  if (o.time_off_today) return 'time_off';
  if (o.absent_today) return 'absent';
  const now = new Date();
  const today = dateInTz(now, o.timezone);
  if (!o.schedule_days.includes(isoDow(today)) || o.worked_today) return 'offline';
  const start = zonedToUtc(today, hhmm(o.schedule_start), o.timezone).getTime();
  const end = zonedToUtc(today, hhmm(o.schedule_end), o.timezone).getTime();
  if (now.getTime() > start + o.grace * 60000 && now.getTime() < end) return 'late';
  return 'offline';
}
export const STATUS_LABEL: Record<string, string> = { working: 'Working', idle: 'Idle', on_break: 'On Break', late: 'Late', absent: 'Absent', offline: 'Offline', time_off: 'Time off' };

/** Throws a 400 with inline field errors (rendered by FormDrawer). */
export function fieldErr(fields: Record<string, string>) { return new ZodError(Object.entries(fields).map(([k, m]) => ({ code: 'custom' as const, path: [k], message: m }))); }

/** Records a 'late' attendance event (once per placement/day) when a clock-in is after shift start + grace. */
export async function recordLateIfNeeded(orgId: string, p: any, startedAt: Date, grace: number, emitFn: (orgId: string, ev: string, payload: Record<string, unknown>) => Promise<void>) {
  const tz = p.timezone || 'America/New_York';
  const d = dateInTz(startedAt, tz);
  if (!(p.schedule_days ?? []).includes(isoDow(d))) return null;
  const start = zonedToUtc(d, hhmm(p.schedule_start), tz).getTime();
  const end = zonedToUtc(d, hhmm(p.schedule_end), tz).getTime();
  const late = Math.floor((startedAt.getTime() - start) / 60000);
  if (late <= grace || startedAt.getTime() > end) return null;
  const prior = await one<any>(`SELECT id, kind FROM attendance_events WHERE placement_id=$1 AND work_date=$2 AND kind IN ('late','absent')`, [p.id, d]);
  const earlier = await one(`SELECT 1 FROM time_entries WHERE placement_id=$1 AND work_date=$2 AND started_at < $3`, [p.id, d, startedAt.toISOString()]);
  if (earlier) return null;
  if (prior?.kind === 'late') { await q(`UPDATE attendance_events SET minutes=$2, note=$3 WHERE id=$1`, [prior.id, late, `Clocked in ${late} min after shift start`]); return null; }
  if (prior?.kind === 'absent') await q(`DELETE FROM attendance_events WHERE id=$1`, [prior.id]);
  await q(`INSERT INTO attendance_events (organization_id, worker_id, placement_id, work_date, kind, minutes, note) VALUES ($1,$2,$3,$4,'late',$5,$6)`, [orgId, p.worker_id, p.id, d, late, `Clocked in ${late} min after shift start`]);
  if (!prior) await emitFn(orgId, 'attendance.late', eventPayload(p, { minutes: late, work_date: d }));
  return late;
}
