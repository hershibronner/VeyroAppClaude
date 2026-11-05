import { humanDate } from '../core/templates';
// TIME & MONITORING (agency side): Live Now, Screenshots & Activity, Attendance (+ late/absent detector),
// Timesheets (approve/reject/adjust), Manual time + Time-off approvals, monitoring policies, retention job.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { weekStart, addDays, isoDow, dateInTz, zonedToUtc, todayUtc } from '@veyro/shared';
import { q, one } from '../core/db';
import { staff, need, can, getOr404 } from '../core/context';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { every } from '../jobs/queue';
import { signedUrl, deleteFile } from '../core/storage';
import { getSetting } from '../core/settings';
import { WNAME, ENTRY_MIN, placementFull, eventPayload, rebuildTimesheet, todayIn, hhmm, liveStatus, STATUS_LABEL, fieldErr } from './_wf/lib';
import { timesheetDetail, approveTimesheet, rejectTimesheet, submitTimesheet } from './_wf/timesheets';

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
export async function orgToday(orgId: string) { const o = await one<any>(`SELECT timezone FROM organizations WHERE id=$1`, [orgId]); return dateInTz(new Date(), o?.timezone ?? 'America/New_York'); }
const shotOut = (s: any) => ({ ...s, url: signedUrl(s.file, 3600), file: undefined });

/** Live Now rows for all workers on active placements (one row per worker). */
export async function liveRows(orgId: string, opts: { companyId?: string | null; workerId?: string | null } = {}) {
  const params: unknown[] = [orgId]; const extra: string[] = [];
  if (opts.companyId) { params.push(opts.companyId); extra.push(`p.company_id=$${params.length}`); }
  if (opts.workerId) { params.push(opts.workerId); extra.push(`p.worker_id=$${params.length}`); }
  const rows = await q<any>(`SELECT DISTINCT ON (p.worker_id) p.id placement_id, p.worker_id, p.title, p.timezone, p.schedule_days, p.schedule_start::text, p.schedule_end::text, p.status placement_status, p.company_id, co.name company_name, co.portal_screenshots, ${WNAME} worker_name, cd.avatar_color, cd.country,
      am.name account_manager_name, mp.client_can_view, mp.screenshots_enabled, wp.state, wp.session_started_at, wp.last_heartbeat_at, wp.activity_pct, wp.screen_share, wp.simulated, wp.placement_id presence_placement_id, (SELECT te.source FROM time_entries te WHERE te.id=wp.time_entry_id) presence_source,
      (SELECT row_to_json(s) FROM (SELECT id, file, taken_at, app_label, blurred, kind FROM screenshots WHERE worker_id=p.worker_id AND deleted_at IS NULL ORDER BY taken_at DESC LIMIT 1) s) latest_shot,
      (SELECT COALESCE(sum(${ENTRY_MIN()}),0)::int FROM time_entries e WHERE e.worker_id=p.worker_id AND e.work_date=(now() AT TIME ZONE p.timezone)::date) today_minutes,
      EXISTS (SELECT 1 FROM time_entries e WHERE e.placement_id=p.id AND e.work_date=(now() AT TIME ZONE p.timezone)::date) worked_today,
      EXISTS (SELECT 1 FROM attendance_events a WHERE a.placement_id=p.id AND a.work_date=(now() AT TIME ZONE p.timezone)::date AND a.kind='absent') absent_today,
      (SELECT minutes FROM attendance_events a WHERE a.placement_id=p.id AND a.work_date=(now() AT TIME ZONE p.timezone)::date AND a.kind='late' LIMIT 1) late_minutes,
      EXISTS (SELECT 1 FROM time_off_requests r WHERE r.worker_id=p.worker_id AND r.status='approved' AND (now() AT TIME ZONE p.timezone)::date BETWEEN r.start_date AND r.end_date) time_off_today
    FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=p.company_id LEFT JOIN users am ON am.id=p.account_manager_id
      LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id LEFT JOIN worker_presence wp ON wp.worker_id=p.worker_id
    WHERE p.organization_id=$1 AND p.status IN ('active','notice','on_leave') ${extra.length ? 'AND ' + extra.join(' AND ') : ''}
    ORDER BY p.worker_id, (wp.placement_id = p.id) DESC NULLS LAST, p.start_date DESC`, params);
  const grace = (await getSetting<any>(orgId, 'time_tracking')).late_grace_minutes ?? 5;
  return rows.map(r => {
    const stale = !!r.state && r.state !== 'offline' && !r.simulated && r.presence_source !== 'manual' && r.last_heartbeat_at && Date.now() - new Date(r.last_heartbeat_at).getTime() > 15 * 60000;
    const status = r.placement_status === 'on_leave' ? 'time_off' : liveStatus({ state: r.state, stale, schedule_days: r.schedule_days, schedule_start: r.schedule_start, schedule_end: r.schedule_end, timezone: r.timezone, worked_today: r.worked_today, absent_today: r.absent_today, time_off_today: r.time_off_today, grace });
    const today = dateInTz(new Date(), r.timezone);
    const scheduled = (r.schedule_days ?? []).includes(isoDow(today));
    const lateNow = status === 'late' ? Math.max(0, Math.floor((Date.now() - zonedToUtc(today, hhmm(r.schedule_start), r.timezone).getTime()) / 60000)) : null;
    return {
      id: r.worker_id, worker_id: r.worker_id, worker_name: r.worker_name, avatar_color: r.avatar_color, country: r.country, placement_id: r.presence_placement_id ?? r.placement_id, title: r.title, company_id: r.company_id, company_name: r.company_name, account_manager_name: r.account_manager_name,
      status, status_label: STATUS_LABEL[status], stale, session_started_at: status === 'working' || status === 'idle' || status === 'on_break' ? r.session_started_at : null, last_heartbeat_at: r.last_heartbeat_at,
      activity_pct: r.activity_pct, screen_share: r.screen_share, today_minutes: r.today_minutes, late_minutes: r.late_minutes ?? lateNow, timezone: r.timezone,
      shift: scheduled ? `${hhmm(r.schedule_start)}–${hhmm(r.schedule_end)}` : null, latest_shot: r.latest_shot ? shotOut(r.latest_shot) : null, client_can_view_shots: !!(r.client_can_view && r.portal_screenshots), screenshots_enabled: r.screenshots_enabled,
    };
  });
}

/** 10-minute timeline blocks for one worker/day (screenshots + activity + app labels). */
export async function dayTimeline(orgId: string, workerId: string, day: string, opts: { includeShots: boolean; placementIds?: string[] }) {
  const allPls = await q<any>(`SELECT p.id, p.title, p.timezone, co.name company_name FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.worker_id=$1 AND p.organization_id=$2 ORDER BY p.start_date DESC`, [workerId, orgId]);
  const pls = opts.placementIds ? allPls.filter(p => opts.placementIds!.includes(p.id)) : allPls;
  const ids = pls.map(p => p.id);
  const tz = pls[0]?.timezone ?? 'America/New_York';
  const from = zonedToUtc(day, '00:00', tz), to = new Date(from.getTime() + 24 * 3600 * 1000);
  const [entries, samples, shots, idle] = await Promise.all([
    q<any>(`SELECT e.id, e.started_at, e.ended_at, e.memo, e.source, e.break_seconds, e.discarded_idle_seconds, ${ENTRY_MIN()} minutes, co.name company_name, (SELECT json_agg(json_build_object('started_at', b.started_at, 'ended_at', b.ended_at)) FROM breaks b WHERE b.time_entry_id=e.id) breaks FROM time_entries e JOIN placements p ON p.id=e.placement_id JOIN companies co ON co.id=p.company_id WHERE e.worker_id=$1 AND e.work_date=$2 AND e.placement_id = ANY($3) ORDER BY e.started_at`, [workerId, day, ids]),
    q<any>(`SELECT bucket_start, bucket_seconds, key_count, mouse_count, active_seconds, idle_seconds, activity_pct, app_label FROM activity_samples WHERE worker_id=$1 AND bucket_start >= $2 AND bucket_start < $3 AND placement_id = ANY($4) ORDER BY bucket_start`, [workerId, from.toISOString(), to.toISOString(), ids]),
    opts.includeShots ? q<any>(`SELECT s.id, s.taken_at, s.file, s.kind, s.app_label, s.url_label, s.activity_pct, s.blurred, s.flagged, s.flag_note, fu.name flagged_by_name FROM screenshots s LEFT JOIN users fu ON fu.id=s.flagged_by WHERE s.worker_id=$1 AND s.deleted_at IS NULL AND s.taken_at >= $2 AND s.taken_at < $3 AND s.placement_id = ANY($4) ORDER BY s.taken_at`, [workerId, from.toISOString(), to.toISOString(), ids]) : Promise.resolve([]),
    q<any>(`SELECT started_at, ended_at, seconds, decision FROM idle_events WHERE worker_id=$1 AND started_at >= $2 AND started_at < $3 ORDER BY started_at`, [workerId, from.toISOString(), to.toISOString()]),
  ]);
  const deleted = await one<any>(`SELECT count(*)::int n FROM screenshots WHERE worker_id=$1 AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND taken_at >= $2 AND taken_at < $3`, [workerId, from.toISOString(), to.toISOString()]);
  const blockMs = 600000;
  const times = [...entries.map(e => new Date(e.started_at).getTime()), ...samples.map(s => new Date(s.bucket_start).getTime()), ...shots.map(s => new Date(s.taken_at).getTime())];
  const blocks: any[] = [];
  if (times.length) {
    const ends = [...entries.map(e => new Date(e.ended_at ?? Date.now()).getTime()), ...times];
    let b = Math.floor(Math.min(...times) / blockMs) * blockMs;
    const last = Math.max(...ends);
    for (; b < last && blocks.length < 200; b += blockMs) {
      const inB = (t: string) => { const x = new Date(t).getTime(); return x >= b && x < b + blockMs; };
      const ss = samples.filter(s => inB(s.bucket_start));
      const tot = ss.reduce((a, s) => a + s.bucket_seconds, 0);
      const act = ss.reduce((a, s) => a + s.active_seconds, 0);
      const sh = shots.filter(s => inB(s.taken_at));
      const tracked = entries.some(e => new Date(e.started_at).getTime() < b + blockMs && new Date(e.ended_at ?? Date.now()).getTime() > b);
      const onBreak = entries.some(e => (e.breaks ?? []).some((x: any) => new Date(x.started_at).getTime() <= b && new Date(x.ended_at ?? Date.now()).getTime() >= b + blockMs));
      const apps = [...ss.map(s => s.app_label), ...sh.map(s => s.app_label)].filter(Boolean);
      const app = apps.length ? apps.sort((a, c) => apps.filter(v => v === c).length - apps.filter(v => v === a).length)[0] : null;
      blocks.push({ start: new Date(b).toISOString(), end: new Date(b + blockMs).toISOString(), tracked, on_break: onBreak, activity_pct: tot ? Math.round((act / tot) * 100) : sh.length ? Math.round(sh.reduce((a, s) => a + (s.activity_pct ?? 0), 0) / sh.length) : null,
        keys: ss.reduce((a, s) => a + s.key_count, 0), mouse: ss.reduce((a, s) => a + s.mouse_count, 0), app_label: app, url_label: sh[0]?.url_label ?? null, shots: sh.map(shotOut) });
    }
  }
  const totSec = samples.reduce((a, s) => a + s.bucket_seconds, 0);
  return {
    day, timezone: tz, placements: pls, entries, idle, blocks, shots: shots.map(shotOut),
    summary: { tracked_minutes: entries.reduce((a, e) => a + e.minutes, 0), avg_activity: totSec ? Math.round(samples.reduce((a, s) => a + s.active_seconds, 0) * 100 / totSec) : null, screenshots: shots.length, flagged: shots.filter(s => s.flagged).length, worker_deleted: deleted.n, keys: samples.reduce((a, s) => a + s.key_count, 0), mouse: samples.reduce((a, s) => a + s.mouse_count, 0), idle_discarded_minutes: Math.round(idle.filter(i => i.decision === 'discard').reduce((a, i) => a + (i.seconds ?? 0), 0) / 60) },
  };
}

export default async function (app: FastifyInstance) {
  // ── Live Now ──
  app.get('/api/v1/time/live', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'view');
    const { company_id, status } = req.query as Record<string, string>;
    let rows = await liveRows(ctx.orgId, { companyId: company_id || null });
    const counts: Record<string, number> = { working: 0, idle: 0, on_break: 0, late: 0, absent: 0, offline: 0, time_off: 0 };
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const live = rows.filter(r => ['working', 'idle', 'on_break'].includes(r.status));
    const avg = live.filter(r => r.activity_pct !== null).map(r => r.activity_pct);
    if (!can(ctx, 'screenshots', 'view')) rows = rows.map(r => ({ ...r, latest_shot: null }));
    if (status) rows = rows.filter(r => status.split(',').includes(r.status));
    const order: Record<string, number> = { working: 0, idle: 1, on_break: 2, late: 3, absent: 4, time_off: 5, offline: 6 };
    rows.sort((a, b) => order[a.status] - order[b.status] || a.worker_name.localeCompare(b.worker_name));
    const declined = await one<any>(`SELECT count(*)::int n FROM worker_presence WHERE organization_id=$1 AND state <> 'offline' AND screen_share IN ('declined','unsupported')`, [ctx.orgId]);
    const companies = await q<any>(`SELECT DISTINCT co.id, co.name FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.organization_id=$1 AND p.status IN ('active','notice','on_leave') ORDER BY co.name`, [ctx.orgId]);
    return { rows, counts, total: rows.length, clocked_in: live.length, avg_activity: avg.length ? Math.round(avg.reduce((a, b) => a + b, 0) / avg.length) : null, screen_declined: declined.n, companies, as_of: new Date().toISOString() };
  });

  // ── Screenshots & Activity ──
  app.get('/api/v1/time/screenshots/day', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'view');
    const { worker_id, date } = req.query as Record<string, string>;
    if (!worker_id) throw badRequest('Choose a worker');
    await getOr404('workers', ctx, worker_id);
    const w = await one<any>(`SELECT w.id, ${WNAME} name, cd.avatar_color FROM workers w JOIN candidates cd ON cd.id=w.candidate_id WHERE w.id=$1`, [worker_id]);
    const tz = (await one<any>(`SELECT timezone FROM placements WHERE worker_id=$1 ORDER BY start_date DESC LIMIT 1`, [worker_id]))?.timezone ?? 'America/New_York';
    const day = date && dateRe.test(date) ? date : todayIn(tz);
    const t = await dayTimeline(ctx.orgId, worker_id, day, { includeShots: can(ctx, 'screenshots', 'view') });
    const declined = await q<any>(`SELECT kind, note, created_at FROM attendance_events WHERE worker_id=$1 AND work_date=$2 AND kind IN ('screen_declined','late','absent','early_leave')`, [worker_id, day]);
    return { worker: w, ...t, events: declined, can_flag: can(ctx, 'screenshots', 'edit') || can(ctx, 'time', 'edit') };
  });
  app.get('/api/v1/time/screenshots/workers', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'view');
    const { date, company_id } = req.query as Record<string, string>;
    const day = date && dateRe.test(date) ? date : await orgToday(ctx.orgId);
    const params: unknown[] = [ctx.orgId, day]; let extra = '';
    if (company_id) { params.push(company_id); extra = `AND p.company_id=$${params.length}`; }
    return q<any>(`SELECT w.id, ${WNAME} name, cd.avatar_color, co.name company_name, p.id placement_id,
        (SELECT count(*)::int FROM screenshots s WHERE s.worker_id=w.id AND s.deleted_at IS NULL AND (s.taken_at AT TIME ZONE p.timezone)::date=$2) shots,
        (SELECT COALESCE(sum(${ENTRY_MIN()}),0)::int FROM time_entries e WHERE e.worker_id=w.id AND e.work_date=$2) minutes,
        (SELECT round(sum(a.active_seconds)::numeric*100/NULLIF(sum(a.bucket_seconds),0))::int FROM activity_samples a WHERE a.worker_id=w.id AND (a.bucket_start AT TIME ZONE p.timezone)::date=$2) activity_pct
      FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=p.company_id
      WHERE p.organization_id=$1 AND (p.status IN ('active','notice','on_leave') OR EXISTS (SELECT 1 FROM time_entries e WHERE e.placement_id=p.id AND e.work_date=$2)) ${extra} ORDER BY 6 DESC, 2`, params);
  });
  app.get('/api/v1/time/screenshots', async (req) => {
    const ctx = staff(req); need(ctx, 'screenshots', 'view');
    const lp = listParams(req);
    const where = ['s.organization_id=$1', 's.deleted_at IS NULL']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.worker_id) { params.push(lp.filters.worker_id); where.push(`s.worker_id=$${params.length}`); }
    if (lp.filters.company_id) { params.push(lp.filters.company_id); where.push(`p.company_id=$${params.length}`); }
    if (lp.filters.date && dateRe.test(lp.filters.date)) { params.push(lp.filters.date); where.push(`(s.taken_at AT TIME ZONE p.timezone)::date=$${params.length}`); }
    if (lp.filters.flagged === 'true') where.push('s.flagged');
    if (lp.filters.kind) { params.push(lp.filters.kind); where.push(`s.kind=$${params.length}`); }
    const r = await paged({ select: `s.id, s.taken_at, s.file, s.kind, s.app_label, s.url_label, s.activity_pct, s.blurred, s.flagged, s.flag_note, s.worker_id, ${WNAME} worker_name, cd.avatar_color, co.name company_name`,
      from: 'screenshots s JOIN workers w ON w.id=s.worker_id JOIN candidates cd ON cd.id=w.candidate_id LEFT JOIN placements p ON p.id=s.placement_id LEFT JOIN companies co ON co.id=p.company_id',
      where, params, lp, searchCols: ['cd.first_name', 'cd.last_name', 's.app_label', 'co.name'], sortMap: { taken_at: 's.taken_at', activity_pct: 's.activity_pct' }, defaultSort: 's.taken_at DESC' });
    return { ...r, rows: r.rows.map(shotOut) };
  });
  app.get('/api/v1/time/screenshots/summary', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'view');
    const s = await one<any>(`SELECT count(*) FILTER (WHERE taken_at >= now() - interval '24 hours')::int last_24h, count(*) FILTER (WHERE taken_at >= now() - interval '48 hours' AND taken_at < now() - interval '24 hours')::int prev_24h,
      count(*) FILTER (WHERE flagged AND taken_at >= now() - interval '30 days')::int flagged_30d, count(*) FILTER (WHERE kind='real' AND taken_at >= now() - interval '7 days')::int real_7d,
      count(*) FILTER (WHERE deleted_by IS NOT NULL AND deleted_at >= now() - interval '30 days')::int worker_deleted_30d,
      round(avg(activity_pct) FILTER (WHERE taken_at >= now() - interval '24 hours'))::int avg_activity_24h FROM screenshots WHERE organization_id=$1`, [ctx.orgId]);
    const hourly = await q<any>(`SELECT to_char(h, 'HH24:00') label, COALESCE((SELECT round(avg(a.activity_pct)) FROM activity_samples a WHERE a.organization_id=$1 AND a.bucket_start >= h AND a.bucket_start < h + interval '1 hour'),0)::int value
      FROM generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') h ORDER BY h`, [ctx.orgId]);
    return { ...s, hourly };
  });
  app.post('/api/v1/time/screenshots/:id/flag', async (req) => {
    const ctx = staff(req); need(ctx, 'screenshots', 'view');
    if (!can(ctx, 'screenshots', 'edit') && !can(ctx, 'time', 'edit')) need(ctx, 'screenshots', 'edit');
    const { id } = req.params as { id: string };
    const s = await getOr404<any>('screenshots', ctx, id, 'AND deleted_at IS NULL');
    const b = z.object({ flagged: z.boolean(), note: z.string().max(500).optional().nullable() }).parse(req.body);
    const r = await one<any>(`UPDATE screenshots SET flagged=$2, flag_note=$3, flagged_by=$4, flagged_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1 RETURNING id, flagged, flag_note`, [id, b.flagged, b.flagged ? b.note ?? null : null, b.flagged ? ctx.userId : null]);
    if (s.placement_id) await activity(ctx, 'placement', s.placement_id, 'note', b.flagged ? 'Screenshot flagged' : 'Screenshot flag removed', b.note ?? null, { screenshot_id: id });
    if (b.flagged) await audit(ctx, 'screenshot.flagged', { type: 'screenshot', id }, null, { note: b.note });
    return r;
  });
  app.get('/api/v1/time/activity', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'view');
    const { worker_id, company_id, days } = req.query as Record<string, string>;
    const n = Math.min(90, Math.max(7, Number(days) || 14));
    const params: unknown[] = [ctx.orgId, n]; const extra: string[] = [];
    if (worker_id) { params.push(worker_id); extra.push(`a.worker_id=$${params.length}`); }
    if (company_id) { params.push(company_id); extra.push(`p.company_id=$${params.length}`); }
    return q<any>(`SELECT to_char(d, 'Mon DD') label, d::date::text AS day, COALESCE((SELECT round(sum(a.active_seconds)::numeric*100/NULLIF(sum(a.bucket_seconds),0)) FROM activity_samples a LEFT JOIN placements p ON p.id=a.placement_id WHERE a.organization_id=$1 AND a.bucket_start >= d AND a.bucket_start < d + interval '1 day' ${extra.length ? 'AND ' + extra.join(' AND ') : ''}),0)::int value
      FROM generate_series(date_trunc('day', now()) - make_interval(days => $2 - 1), date_trunc('day', now()), interval '1 day') d ORDER BY d`, params);
  });

  // ── Attendance ──
  app.get('/api/v1/time/attendance/summary', async (req) => {
    const ctx = staff(req); need(ctx, 'attendance', 'view');
    const { from, to, company_id, worker_id } = req.query as Record<string, string>;
    const ot = await orgToday(ctx.orgId);
    const f = from && dateRe.test(from) ? from : addDays(ot, -83), t = to && dateRe.test(to) ? to : ot;
    const params: unknown[] = [ctx.orgId, f, t]; const extra: string[] = [];
    if (company_id) { params.push(company_id); extra.push(`p.company_id=$${params.length}`); }
    if (worker_id) { params.push(worker_id); extra.push(`p.worker_id=$${params.length}`); }
    const X = extra.length ? 'AND ' + extra.join(' AND ') : '';
    const days = await q<any>(`WITH d AS (SELECT gs::date AS dd FROM generate_series($2::date, $3::date, interval '1 day') gs),
      sched AS (SELECT d.dd, p.id pid FROM d JOIN placements p ON p.organization_id=$1 AND p.start_date <= d.dd AND (p.end_date IS NULL OR p.end_date >= d.dd) AND p.status <> 'onboarding' AND EXTRACT(ISODOW FROM d.dd)::int = ANY(p.schedule_days) ${X})
      SELECT d.dd::text AS date, (SELECT count(*)::int FROM sched s WHERE s.dd=d.dd) scheduled,
        (SELECT count(DISTINCT e.placement_id)::int FROM time_entries e JOIN sched s ON s.pid=e.placement_id AND s.dd=e.work_date WHERE e.work_date=d.dd) worked,
        (SELECT count(*)::int FROM attendance_events a JOIN sched s ON s.pid=a.placement_id AND s.dd=a.work_date WHERE a.work_date=d.dd AND a.kind='late') late,
        (SELECT count(*)::int FROM attendance_events a JOIN sched s ON s.pid=a.placement_id AND s.dd=a.work_date WHERE a.work_date=d.dd AND a.kind='absent') absent,
        (SELECT count(*)::int FROM attendance_events a JOIN sched s ON s.pid=a.placement_id AND s.dd=a.work_date WHERE a.work_date=d.dd AND a.kind='early_leave') early_leave,
        (SELECT count(*)::int FROM attendance_events a JOIN sched s ON s.pid=a.placement_id AND s.dd=a.work_date WHERE a.work_date=d.dd AND a.kind='time_off') time_off
      FROM d ORDER BY d.dd`, params);
    const tot = days.reduce((a, d) => ({ scheduled: a.scheduled + d.scheduled, worked: a.worked + d.worked, late: a.late + d.late, absent: a.absent + d.absent, early_leave: a.early_leave + d.early_leave }), { scheduled: 0, worked: 0, late: 0, absent: 0, early_leave: 0 });
    const half = Math.floor(days.length / 2);
    const rate = (ds: any[]) => { const s = ds.reduce((a, d) => a + d.scheduled, 0); const w = ds.reduce((a, d) => a + d.worked - d.late, 0); return s ? Math.round((w / s) * 1000) / 10 : null; };
    const topLate = await q<any>(`SELECT p.worker_id, ${WNAME} worker_name, co.name company_name, count(*) FILTER (WHERE a.kind='late')::int late, count(*) FILTER (WHERE a.kind='absent')::int absent, COALESCE(round(avg(a.minutes) FILTER (WHERE a.kind='late')),0)::int avg_late
      FROM attendance_events a JOIN placements p ON p.id=a.placement_id JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=p.company_id
      WHERE a.organization_id=$1 AND a.work_date BETWEEN $2 AND $3 AND a.kind IN ('late','absent') ${X} GROUP BY 1,2,3 ORDER BY 4 DESC, 5 DESC LIMIT 8`, params);
    return { from: f, to: t, days, totals: { ...tot, on_time_pct: rate(days), prev_on_time_pct: rate(days.slice(0, half)), recent_on_time_pct: rate(days.slice(half)) }, top: topLate };
  });
  // Schedule vs actual for one day (per placement).
  app.get('/api/v1/time/attendance/day', async (req) => {
    const ctx = staff(req); need(ctx, 'attendance', 'view');
    const { date, company_id } = req.query as Record<string, string>;
    const day = date && dateRe.test(date) ? date : await orgToday(ctx.orgId);
    const params: unknown[] = [ctx.orgId, day]; let extra = '';
    if (company_id) { params.push(company_id); extra = `AND p.company_id=$${params.length}`; }
    const rows = await q<any>(`SELECT p.id, p.worker_id, ${WNAME} worker_name, cd.avatar_color, co.name company_name, p.title, p.timezone, p.schedule_start::text, p.schedule_end::text, p.schedule_days,
        (SELECT min(e.started_at) FROM time_entries e WHERE e.placement_id=p.id AND e.work_date=$2) first_in, (SELECT max(COALESCE(e.ended_at, now())) FROM time_entries e WHERE e.placement_id=p.id AND e.work_date=$2) last_out,
        (SELECT bool_or(e.ended_at IS NULL) FROM time_entries e WHERE e.placement_id=p.id AND e.work_date=$2) open,
        (SELECT COALESCE(sum(${ENTRY_MIN()}),0)::int FROM time_entries e WHERE e.placement_id=p.id AND e.work_date=$2) minutes,
        (SELECT json_agg(json_build_object('kind', a.kind, 'minutes', a.minutes, 'note', a.note)) FROM attendance_events a WHERE a.placement_id=p.id AND a.work_date=$2) events,
        EXISTS (SELECT 1 FROM time_off_requests r WHERE r.worker_id=p.worker_id AND r.status='approved' AND $2::date BETWEEN r.start_date AND r.end_date) time_off
      FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=p.company_id
      WHERE p.organization_id=$1 AND p.status <> 'onboarding' AND p.start_date <= $2 AND (p.end_date IS NULL OR p.end_date >= $2) ${extra} ORDER BY co.name, 3`, params);
    const out = rows.map(r => {
      const scheduled = r.schedule_days.includes(isoDow(day));
      const ev = (r.events ?? []) as any[];
      const status = r.time_off ? 'time_off' : !scheduled ? (r.minutes ? 'extra_day' : 'not_scheduled') : ev.some(e => e.kind === 'absent') ? 'absent' : ev.some(e => e.kind === 'late') ? 'late' : ev.some(e => e.kind === 'early_leave') ? 'early_leave' : r.first_in ? 'on_time' : 'not_started';
      return { ...r, id: r.id, scheduled, scheduled_start: scheduled ? hhmm(r.schedule_start) : null, scheduled_end: scheduled ? hhmm(r.schedule_end) : null, scheduled_minutes: scheduled ? (Number(hhmm(r.schedule_end).slice(0, 2)) * 60 + Number(hhmm(r.schedule_end).slice(3))) - (Number(hhmm(r.schedule_start).slice(0, 2)) * 60 + Number(hhmm(r.schedule_start).slice(3))) : 0, status, late_minutes: ev.find(e => e.kind === 'late')?.minutes ?? null };
    });
    return { date: day, rows: out };
  });
  app.get('/api/v1/time/attendance/events', async (req) => {
    const ctx = staff(req); need(ctx, 'attendance', 'view');
    const lp = listParams(req);
    const where = ['a.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.kind) { params.push(lp.filters.kind.split(',')); where.push(`a.kind = ANY($${params.length})`); }
    if (lp.filters.worker_id) { params.push(lp.filters.worker_id); where.push(`a.worker_id=$${params.length}`); }
    if (lp.filters.company_id) { params.push(lp.filters.company_id); where.push(`p.company_id=$${params.length}`); }
    if (lp.filters.from && dateRe.test(lp.filters.from)) { params.push(lp.filters.from); where.push(`a.work_date >= $${params.length}`); }
    if (lp.filters.to && dateRe.test(lp.filters.to)) { params.push(lp.filters.to); where.push(`a.work_date <= $${params.length}`); }
    return paged({ select: `a.id, a.work_date, a.kind, a.minutes, a.note, a.created_at, a.worker_id, a.placement_id, ${WNAME} worker_name, cd.avatar_color, co.name company_name`,
      from: 'attendance_events a JOIN workers w ON w.id=a.worker_id JOIN candidates cd ON cd.id=w.candidate_id LEFT JOIN placements p ON p.id=a.placement_id LEFT JOIN companies co ON co.id=p.company_id',
      where, params, lp, searchCols: ['cd.first_name', 'cd.last_name', 'co.name', 'a.note'], sortMap: { work_date: 'a.work_date', minutes: 'a.minutes', kind: 'a.kind' }, defaultSort: 'a.work_date DESC, a.created_at DESC' });
  });

  // ── Timesheets ──
  app.get('/api/v1/timesheets', async (req) => {
    const ctx = staff(req); need(ctx, 'timesheets', 'view');
    const lp = listParams(req);
    const where = ['t.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    const f = lp.filters;
    if (f.status) { params.push(f.status.split(',')); where.push(`t.status = ANY($${params.length})`); }
    for (const k of ['company_id', 'worker_id', 'placement_id'] as const) if (f[k]) { params.push(f[k]); where.push(`t.${k}=$${params.length}`); }
    if (f.week_start && dateRe.test(f.week_start)) { params.push(f.week_start); where.push(`t.week_start=$${params.length}`); }
    if (f.awaiting === 'agency') where.push(`t.status='submitted' AND co.timesheet_approval IN ('agency','both') AND t.agency_approved_at IS NULL`);
    if (f.awaiting === 'client') where.push(`t.status='submitted' AND co.timesheet_approval IN ('client','both') AND t.client_approved_at IS NULL`);
    if (f.account_manager_id) { params.push(f.account_manager_id); where.push(`p.account_manager_id=$${params.length}`); }
    if (f.from && dateRe.test(f.from)) { params.push(f.from); where.push(`t.week_start >= $${params.length}`); }
    return paged({ select: `t.id, t.week_start, t.status, t.total_minutes, t.submitted_at, t.approved_at, t.agency_approved_at, t.client_approved_at, t.rejected_reason, t.placement_id, t.worker_id, t.company_id, ${WNAME} worker_name, cd.avatar_color, co.name company_name, co.timesheet_approval, p.title, am.name account_manager_name,
        (SELECT count(*)::int FROM timesheet_adjustments a WHERE a.timesheet_id=t.id) adjustments`,
      from: 'timesheets t JOIN placements p ON p.id=t.placement_id JOIN workers w ON w.id=t.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=t.company_id LEFT JOIN users am ON am.id=p.account_manager_id',
      where, params, lp, searchCols: ['cd.first_name', 'cd.last_name', 'co.name', 'p.title'], sortMap: { week_start: 't.week_start', total_minutes: 't.total_minutes', worker_name: 'cd.first_name', company_name: 'co.name', status: 't.status', submitted_at: 't.submitted_at' }, defaultSort: 't.week_start DESC, cd.first_name' });
  });
  app.get('/api/v1/timesheets/summary', async (req) => {
    const ctx = staff(req); need(ctx, 'timesheets', 'view');
    const s = await one<any>(`SELECT count(*) FILTER (WHERE t.status='submitted')::int submitted, count(*) FILTER (WHERE t.status='open')::int open, count(*) FILTER (WHERE t.status='rejected')::int rejected,
      count(*) FILTER (WHERE t.status='submitted' AND co.timesheet_approval IN ('agency','both') AND t.agency_approved_at IS NULL)::int awaiting_agency,
      count(*) FILTER (WHERE t.status='submitted' AND co.timesheet_approval IN ('client','both') AND t.client_approved_at IS NULL)::int awaiting_client,
      COALESCE(sum(t.total_minutes) FILTER (WHERE t.status IN ('approved','locked') AND t.approved_at >= date_trunc('month', now())),0)::int approved_minutes_month,
      COALESCE(sum(t.total_minutes) FILTER (WHERE t.status IN ('approved','locked') AND t.approved_at >= date_trunc('month', now()) - interval '1 month' AND t.approved_at < date_trunc('month', now())),0)::int approved_minutes_last_month,
      count(*) FILTER (WHERE t.status IN ('approved','locked') AND t.approved_at >= date_trunc('month', now()))::int approved_month,
      COALESCE(sum(t.total_minutes) FILTER (WHERE t.status='submitted'),0)::int submitted_minutes,
      count(*) FILTER (WHERE t.status='open' AND t.week_start < date_trunc('week', CURRENT_DATE)::date AND t.total_minutes > 0)::int overdue_open
      FROM timesheets t JOIN companies co ON co.id=t.company_id WHERE t.organization_id=$1`, [ctx.orgId]);
    const trend = await q<any>(`SELECT to_char(wk, 'Mon DD') label, wk::date::text AS week, COALESCE((SELECT sum(t.total_minutes) FROM timesheets t WHERE t.organization_id=$1 AND t.week_start=wk::date AND t.status IN ('approved','locked')),0)::int value,
        COALESCE((SELECT sum(t.total_minutes) FROM timesheets t WHERE t.organization_id=$1 AND t.week_start=wk::date AND t.status NOT IN ('approved','locked')),0)::int pending
      FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') wk ORDER BY wk`, [ctx.orgId]);
    const oldest = await one<any>(`SELECT min(submitted_at) t FROM timesheets WHERE organization_id=$1 AND status='submitted'`, [ctx.orgId]);
    return { ...s, trend, oldest_submitted_at: oldest?.t ?? null };
  });
  app.get('/api/v1/timesheets/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'timesheets', 'view');
    const { id } = req.params as { id: string };
    await getOr404('timesheets', ctx, id);
    const t = await timesheetDetail(ctx.orgId, id);
    return { ...t, can: { approve: can(ctx, 'timesheets', 'approve'), edit: can(ctx, 'timesheets', 'edit') || can(ctx, 'timesheets', 'approve'), simulate: can(ctx, 'time', 'edit') } };
  });
  app.post('/api/v1/timesheets/:id/approve', async (req) => {
    const ctx = staff(req); need(ctx, 'timesheets', 'approve');
    const { id } = req.params as { id: string };
    await getOr404('timesheets', ctx, id);
    const b = z.object({ on_behalf_of_client: z.boolean().default(false), reason: z.string().max(500).optional() }).parse(req.body ?? {});
    if (b.on_behalf_of_client && !b.reason?.trim()) throw fieldErr({ reason: 'Explain why you are approving for the client' });
    return approveTimesheet(ctx, id, 'agency', { onBehalf: b.on_behalf_of_client, reason: b.reason });
  });
  app.post('/api/v1/timesheets/:id/reject', async (req) => {
    const ctx = staff(req); need(ctx, 'timesheets', 'approve');
    const { id } = req.params as { id: string };
    await getOr404('timesheets', ctx, id);
    const b = z.object({ reason: z.string().min(3, 'A reason is required').max(1000) }).parse(req.body);
    return rejectTimesheet(ctx, id, 'agency', b.reason);
  });
  app.post('/api/v1/timesheets/:id/submit', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'timesheets', 'edit') && !can(ctx, 'timesheets', 'approve')) need(ctx, 'timesheets', 'edit');
    const { id } = req.params as { id: string };
    await getOr404('timesheets', ctx, id);
    return submitTimesheet(ctx, id, `Submitted on behalf of the worker by ${ctx.user.name}`);
  });
  app.post('/api/v1/timesheets/:id/adjust', async (req) => {
    const ctx = staff(req); need(ctx, 'timesheets', 'approve');
    const { id } = req.params as { id: string };
    const t = await getOr404<any>('timesheets', ctx, id);
    const b = z.object({ work_date: z.string().regex(dateRe), minutes_delta: z.number().int().min(-1440).max(1440).refine(v => v !== 0, 'Adjustment cannot be zero'), reason: z.string().min(5, 'Explain the correction').max(1000) }).parse(req.body);
    if (!['approved', 'locked'].includes(t.status)) throw conflict('Adjustments are only for approved timesheets — edit time before approval instead');
    if (b.work_date < t.week_start || b.work_date > addDays(t.week_start, 6)) throw fieldErr({ work_date: 'Date must be inside this timesheet week' });
    const day = await one<any>(`SELECT COALESCE((SELECT minutes FROM timesheet_days WHERE timesheet_id=$1 AND work_date=$2),0) + COALESCE((SELECT sum(minutes_delta) FROM timesheet_adjustments WHERE timesheet_id=$1 AND work_date=$2),0) m`, [id, b.work_date]);
    if (Number(day.m) + b.minutes_delta < 0) throw fieldErr({ minutes_delta: `This day only has ${day.m} approved minutes` });
    const r = await one<any>(`INSERT INTO timesheet_adjustments (organization_id, timesheet_id, placement_id, work_date, minutes_delta, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [ctx.orgId, id, t.placement_id, b.work_date, b.minutes_delta, b.reason, ctx.userId]);
    await activity(ctx, 'timesheet', id, 'system', `Correction ${b.minutes_delta > 0 ? '+' : ''}${b.minutes_delta} min on ${humanDate(b.work_date)}`, b.reason);
    await audit(ctx, 'timesheet.adjusted', { type: 'timesheet', id }, null, { work_date: b.work_date, minutes_delta: b.minutes_delta }, b.reason);
    const p = await placementFull(ctx.orgId, t.placement_id);
    await emit(ctx.orgId, 'timesheet.adjusted', eventPayload(p, { timesheet_id: id, work_date: b.work_date, minutes_delta: b.minutes_delta }));
    await notify(ctx.orgId, [p.worker_user_id, p.account_manager_id].filter(u => u && u !== ctx.userId), { event: 'timesheet.adjusted', title: `Timesheet correction: week of ${humanDate(t.week_start)}`, body: `${b.minutes_delta > 0 ? '+' : ''}${b.minutes_delta} min on ${humanDate(b.work_date)} — ${b.reason}`, link: `/time/timesheets/${id}` });
    return r;
  });

  // ── Manual time requests ──
  app.get('/api/v1/time/manual-requests', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'view');
    const lp = listParams(req);
    const where = ['r.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.status) { params.push(lp.filters.status.split(',')); where.push(`r.status = ANY($${params.length})`); }
    if (lp.filters.worker_id) { params.push(lp.filters.worker_id); where.push(`r.worker_id=$${params.length}`); }
    if (lp.filters.company_id) { params.push(lp.filters.company_id); where.push(`p.company_id=$${params.length}`); }
    return paged({ select: `r.*, r.start_time::text start_time, r.end_time::text end_time, (EXTRACT(EPOCH FROM (r.end_time - r.start_time))/60)::int minutes, ${WNAME} worker_name, cd.avatar_color, co.name company_name, p.title, u.name decided_by_name`,
      from: 'manual_time_requests r JOIN placements p ON p.id=r.placement_id JOIN workers w ON w.id=r.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=p.company_id LEFT JOIN users u ON u.id=r.decided_by',
      where, params, lp, searchCols: ['cd.first_name', 'cd.last_name', 'co.name', 'r.reason'], sortMap: { work_date: 'r.work_date', created_at: 'r.created_at', status: 'r.status' }, defaultSort: `CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC` });
  });
  app.get('/api/v1/time/requests/summary', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'view');
    return one<any>(`SELECT (SELECT count(*)::int FROM manual_time_requests WHERE organization_id=$1 AND status='pending') manual_pending,
      (SELECT COALESCE(sum(EXTRACT(EPOCH FROM (end_time - start_time))/60),0)::int FROM manual_time_requests WHERE organization_id=$1 AND status='pending') manual_pending_minutes,
      (SELECT count(*)::int FROM manual_time_requests WHERE organization_id=$1 AND status='approved' AND decided_at >= now() - interval '30 days') manual_approved_30d,
      (SELECT count(*)::int FROM manual_time_requests WHERE organization_id=$1 AND status='rejected' AND decided_at >= now() - interval '30 days') manual_rejected_30d,
      (SELECT count(*)::int FROM time_off_requests WHERE organization_id=$1 AND status='pending') time_off_pending,
      (SELECT count(*)::int FROM time_off_requests WHERE organization_id=$1 AND status='approved' AND CURRENT_DATE BETWEEN start_date AND end_date) out_today,
      (SELECT count(*)::int FROM time_off_requests WHERE organization_id=$1 AND status='approved' AND start_date BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 30) upcoming_30d,
      (SELECT COALESCE(sum(end_date - start_date + 1),0)::int FROM time_off_requests WHERE organization_id=$1 AND status='approved' AND start_date >= date_trunc('year', now())) days_taken_ytd`, [ctx.orgId]);
  });
  app.post('/api/v1/time/manual-requests/:id/:decision', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'approve');
    const { id, decision } = req.params as { id: string; decision: string };
    if (!['approve', 'reject'].includes(decision)) throw notFound();
    const r = await getOr404<any>('manual_time_requests', ctx, id);
    if (r.status !== 'pending') throw conflict(`This request was already ${r.status}`);
    const b = z.object({ note: z.string().max(500).optional().nullable() }).parse(req.body ?? {});
    if (decision === 'reject' && !b.note?.trim()) throw fieldErr({ note: 'Tell the worker why' });
    const p = await placementFull(ctx.orgId, r.placement_id);
    let entryId: string | null = null, adjustment = false;
    if (decision === 'approve') {
      const s = zonedToUtc(r.work_date, hhmm(r.start_time), p.timezone), e = zonedToUtc(r.work_date, hhmm(r.end_time), p.timezone);
      const overlap = await one(`SELECT 1 FROM time_entries WHERE worker_id=$1 AND started_at < $3 AND COALESCE(ended_at, now()) > $2`, [r.worker_id, s.toISOString(), e.toISOString()]);
      if (overlap) throw conflict('This request overlaps time that is already tracked');
      const ent = await one<any>(`INSERT INTO time_entries (organization_id, placement_id, worker_id, work_date, started_at, ended_at, memo, source) VALUES ($1,$2,$3,$4,$5,$6,$7,'manual') RETURNING id`, [ctx.orgId, r.placement_id, r.worker_id, r.work_date, s.toISOString(), e.toISOString(), `Manual: ${r.reason}`.slice(0, 500)]);
      entryId = ent.id;
      const wk = weekStart(r.work_date);
      const ts = await rebuildTimesheet(ctx.orgId, r.placement_id, wk);
      if (ts && ['approved', 'locked'].includes(ts.status)) {
        const mins = Math.round((e.getTime() - s.getTime()) / 60000);
        await q(`INSERT INTO timesheet_adjustments (organization_id, timesheet_id, placement_id, work_date, minutes_delta, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ctx.orgId, ts.id, r.placement_id, r.work_date, mins, `Approved manual time request: ${r.reason}`.slice(0, 1000), ctx.userId]);
        adjustment = true;
      }
    }
    await q(`UPDATE manual_time_requests SET status=$2, decided_by=$3, decided_at=now(), time_entry_id=$4, decision_note=$5 WHERE id=$1`, [id, decision === 'approve' ? 'approved' : 'rejected', ctx.userId, entryId, b.note ?? null]);
    await activity(ctx, 'placement', r.placement_id, 'system', `Manual time ${decision === 'approve' ? 'approved' : 'rejected'}: ${humanDate(r.work_date)} ${hhmm(r.start_time)}–${hhmm(r.end_time)}`, b.note ?? r.reason);
    await audit(ctx, `manual_time.${decision === 'approve' ? 'approved' : 'rejected'}`, { type: 'placement', id: r.placement_id, label: p.worker_name }, null, { work_date: r.work_date, start: r.start_time, end: r.end_time, adjustment }, b.note ?? undefined);
    await notify(ctx.orgId, [p.worker_user_id], { event: 'manual_time.decided', title: `Manual time ${decision === 'approve' ? 'approved' : 'rejected'}`, body: `${humanDate(r.work_date)} ${hhmm(r.start_time)}–${hhmm(r.end_time)}${b.note ? ` — ${b.note}` : ''}`, link: '/portal/worker/timesheets' });
    return { ok: true, status: decision === 'approve' ? 'approved' : 'rejected', time_entry_id: entryId, adjustment };
  });

  // ── Time-off ──
  app.get('/api/v1/time/time-off', async (req) => {
    const ctx = staff(req); need(ctx, 'time_off', 'view');
    const lp = listParams(req);
    const where = ['r.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.status) { params.push(lp.filters.status.split(',')); where.push(`r.status = ANY($${params.length})`); }
    if (lp.filters.kind) { params.push(lp.filters.kind); where.push(`r.kind=$${params.length}`); }
    if (lp.filters.worker_id) { params.push(lp.filters.worker_id); where.push(`r.worker_id=$${params.length}`); }
    if (lp.filters.when === 'current') where.push(`CURRENT_DATE BETWEEN r.start_date AND r.end_date AND r.status='approved'`);
    if (lp.filters.when === 'upcoming') where.push(`r.start_date > CURRENT_DATE AND r.status='approved'`);
    return paged({ select: `r.*, (r.end_date - r.start_date + 1)::int days, ${WNAME} worker_name, cd.avatar_color, co.name company_name, u.name decided_by_name`,
      from: 'time_off_requests r JOIN workers w ON w.id=r.worker_id JOIN candidates cd ON cd.id=w.candidate_id LEFT JOIN placements p ON p.id=r.placement_id LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users u ON u.id=r.decided_by',
      where, params, lp, searchCols: ['cd.first_name', 'cd.last_name', 'co.name', 'r.note'], sortMap: { start_date: 'r.start_date', created_at: 'r.created_at', status: 'r.status' }, defaultSort: `CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.start_date DESC` });
  });
  app.get('/api/v1/time/time-off/calendar', async (req) => {
    const ctx = staff(req); need(ctx, 'time_off', 'view');
    const { month } = req.query as { month?: string };
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : (await orgToday(ctx.orgId)).slice(0, 7);
    const from = `${m}-01`, to = addDays(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString().slice(0, 10), -1);
    const rows = await q<any>(`SELECT r.id, r.kind, r.status, r.start_date::text start_date, r.end_date::text end_date, r.worker_id, ${WNAME} worker_name, cd.avatar_color FROM time_off_requests r JOIN workers w ON w.id=r.worker_id JOIN candidates cd ON cd.id=w.candidate_id
      WHERE r.organization_id=$1 AND r.status IN ('approved','pending') AND r.start_date <= $3 AND r.end_date >= $2 ORDER BY r.start_date`, [ctx.orgId, from, to]);
    return { month: m, from, to, rows };
  });
  app.post('/api/v1/time/time-off/:id/:decision', async (req) => {
    const ctx = staff(req); need(ctx, 'time_off', 'approve');
    const { id, decision } = req.params as { id: string; decision: string };
    if (!['approve', 'reject'].includes(decision)) throw notFound();
    const r = await getOr404<any>('time_off_requests', ctx, id);
    if (r.status !== 'pending') throw conflict(`This request was already ${r.status}`);
    const b = z.object({ note: z.string().max(500).optional().nullable() }).parse(req.body ?? {});
    if (decision === 'reject' && !b.note?.trim()) throw fieldErr({ note: 'Tell the worker why' });
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await q(`UPDATE time_off_requests SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`, [id, status, ctx.userId, b.note ?? null]);
    const p = r.placement_id ? await placementFull(ctx.orgId, r.placement_id) : null;
    if (status === 'approved' && p) {
      for (let d = r.start_date; d <= r.end_date; d = addDays(d, 1)) if (p.schedule_days.includes(isoDow(d))) await q(`INSERT INTO attendance_events (organization_id, worker_id, placement_id, work_date, kind, note) SELECT $1,$2,$3,$4,'time_off',$5 WHERE NOT EXISTS (SELECT 1 FROM attendance_events WHERE placement_id=$3 AND work_date=$4 AND kind='time_off')`, [ctx.orgId, r.worker_id, p.id, d, `Approved ${r.kind}`]);
      await activity(ctx, 'placement', p.id, 'system', `Time-off approved: ${r.kind} ${r.start_date} → ${r.end_date}`, b.note ?? r.note);
      await emit(ctx.orgId, 'time_off.approved', eventPayload(p, { start_date: r.start_date, end_date: r.end_date, kind: r.kind }));
    }
    const w = await one<any>(`SELECT user_id FROM workers WHERE id=$1`, [r.worker_id]);
    await notify(ctx.orgId, [w?.user_id], { event: 'time_off.decided', title: `Time-off ${status}: ${r.start_date} → ${r.end_date}`, body: b.note ?? null, link: '/portal/worker/time-off' });
    await audit(ctx, `time_off.${status}`, { type: 'worker', id: r.worker_id, label: p?.worker_name }, null, { start_date: r.start_date, end_date: r.end_date, kind: r.kind }, b.note ?? undefined);
    return { ok: true, status };
  });

  // ── Monitoring policies ──
  app.get('/api/v1/time/policies', async (req) => {
    const ctx = staff(req);
    return q(`SELECT mp.*, (SELECT count(*)::int FROM placements p WHERE p.monitoring_policy_id=mp.id AND p.status <> 'ended') placements FROM monitoring_policies mp WHERE mp.organization_id=$1 ORDER BY mp.is_default DESC, mp.name`, [ctx.orgId]);
  });
  const policyBody = z.object({ name: z.string().min(2).max(80), screenshots_enabled: z.boolean(), screenshot_interval_min: z.number().int().min(1).max(60), blur: z.boolean(), activity_tracking: z.boolean(), idle_minutes: z.number().int().min(1).max(60), retention_days: z.number().int().min(1).max(3650), worker_delete_window_min: z.number().int().min(0).max(1440), client_can_view: z.boolean(), is_default: z.boolean().default(false) });
  app.post('/api/v1/time/policies', async (req) => {
    const ctx = staff(req); need(ctx, 'settings', 'edit');
    const b = policyBody.parse(req.body);
    if (b.is_default) await q(`UPDATE monitoring_policies SET is_default=false WHERE organization_id=$1`, [ctx.orgId]);
    const r = await one(`INSERT INTO monitoring_policies (organization_id, name, screenshots_enabled, screenshot_interval_min, blur, activity_tracking, idle_minutes, retention_days, worker_delete_window_min, client_can_view, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.orgId, b.name, b.screenshots_enabled, b.screenshot_interval_min, b.blur, b.activity_tracking, b.idle_minutes, b.retention_days, b.worker_delete_window_min, b.client_can_view, b.is_default]);
    await audit(ctx, 'monitoring_policy.created', { type: 'monitoring_policy', id: (r as any).id, label: b.name }, null, b);
    return r;
  });
  app.patch('/api/v1/time/policies/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'settings', 'edit');
    const { id } = req.params as { id: string };
    const before = await getOr404<any>('monitoring_policies', ctx, id);
    const b = policyBody.partial().parse(req.body);
    if (b.is_default) await q(`UPDATE monitoring_policies SET is_default=false WHERE organization_id=$1`, [ctx.orgId]);
    const cols = Object.keys(b).filter(k => (b as any)[k] !== undefined);
    if (!cols.length) return before;
    const r = await one<any>(`UPDATE monitoring_policies SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, ctx.orgId, ...cols.map(k => (b as any)[k])]);
    // Material changes require workers to re-accept before their next clock-in.
    const material = ['screenshots_enabled', 'screenshot_interval_min', 'blur', 'activity_tracking', 'retention_days', 'client_can_view'].some(k => k in b && (b as any)[k] !== before[k]);
    if (material) await q(`UPDATE placements SET policy_accepted_at=NULL WHERE monitoring_policy_id=$1 AND organization_id=$2 AND status <> 'ended'`, [id, ctx.orgId]);
    await audit(ctx, 'monitoring_policy.updated', { type: 'monitoring_policy', id, label: r.name }, before, r);
    return { ...r, reacceptance_required: material };
  });

  // ── Background jobs ──
  // Attendance detector: late → absent per placement schedule (in placement timezone), early leave after shift.
  every('time.attendance', 120000, async () => {
    const pls = await q<any>(`SELECT p.*, ${WNAME} worker_name, co.name company_name FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=p.company_id WHERE p.status IN ('active','notice') AND p.start_date <= CURRENT_DATE + 1`);
    const settings = new Map<string, any>();
    for (const p of pls) {
      if (!settings.has(p.organization_id)) settings.set(p.organization_id, await getSetting(p.organization_id, 'time_tracking'));
      const st = settings.get(p.organization_id);
      const grace = st.late_grace_minutes ?? 5, absentAfter = st.absent_after_minutes ?? 120;
      const today = dateInTz(new Date(), p.timezone);
      if (today < p.start_date || !p.schedule_days.includes(isoDow(today))) continue;
      const start = zonedToUtc(today, hhmm(p.schedule_start), p.timezone).getTime(), end = zonedToUtc(today, hhmm(p.schedule_end), p.timezone).getTime();
      const mins = Math.floor((Date.now() - start) / 60000);
      if (mins <= grace) continue;
      const off = await one(`SELECT 1 FROM time_off_requests WHERE worker_id=$1 AND status='approved' AND $2::date BETWEEN start_date AND end_date`, [p.worker_id, today]);
      if (off) continue;
      const entries = await q<any>(`SELECT started_at, ended_at FROM time_entries WHERE placement_id=$1 AND work_date=$2 ORDER BY started_at`, [p.id, today]);
      const events = await q<any>(`SELECT id, kind FROM attendance_events WHERE placement_id=$1 AND work_date=$2`, [p.id, today]);
      const has = (k: string) => events.find(e => e.kind === k);
      if (!entries.length && Date.now() < end) {
        if (mins >= absentAfter && !has('absent')) {
          if (has('late')) await q(`DELETE FROM attendance_events WHERE id=$1`, [has('late').id]);
          await q(`INSERT INTO attendance_events (organization_id, worker_id, placement_id, work_date, kind, minutes, note) VALUES ($1,$2,$3,$4,'absent',$5,'No clock-in recorded')`, [p.organization_id, p.worker_id, p.id, today, mins]);
          await emit(p.organization_id, 'attendance.absent', eventPayload(p, { minutes: mins, work_date: today }));
          await notify(p.organization_id, [p.account_manager_id], { event: 'attendance.absent', title: `${p.worker_name} is absent`, body: `No clock-in ${Math.floor(mins / 60)}h after the ${hhmm(p.schedule_start)} shift start (${p.company_name}).`, link: `/time/attendance?date=${today}` });
        } else if (!has('late') && !has('absent')) {
          await q(`INSERT INTO attendance_events (organization_id, worker_id, placement_id, work_date, kind, minutes, note) VALUES ($1,$2,$3,$4,'late',$5,$6)`, [p.organization_id, p.worker_id, p.id, today, mins, `Not clocked in ${mins} min after shift start`]);
          await emit(p.organization_id, 'attendance.late', eventPayload(p, { minutes: mins, work_date: today }));
        }
      } else if (entries.length && Date.now() > end + 30 * 60000 && entries.every(e => e.ended_at) && !has('early_leave')) {
        const lastOut = new Date(entries[entries.length - 1].ended_at).getTime();
        const early = Math.floor((end - lastOut) / 60000);
        if (early >= 30) {
          await q(`INSERT INTO attendance_events (organization_id, worker_id, placement_id, work_date, kind, minutes, note) VALUES ($1,$2,$3,$4,'early_leave',$5,$6)`, [p.organization_id, p.worker_id, p.id, today, early, `Clocked out ${early} min before shift end`]);
          await emit(p.organization_id, 'attendance.early_leave', eventPayload(p, { minutes: early, work_date: today }));
        }
      }
    }
  });
  // Recurring lateness/absence pattern → notify the account manager (once per worker per week).
  every('time.attendance_patterns', 30 * 60000, async () => {
    const rows = await q<any>(`SELECT a.organization_id, p.id placement_id, p.worker_id, p.account_manager_id, p.recruiter_id, p.sales_id, p.title, p.company_id, ${WNAME} worker_name, co.name company_name,
        count(*) FILTER (WHERE a.kind='late')::int late, count(*) FILTER (WHERE a.kind='absent')::int absent
      FROM attendance_events a JOIN placements p ON p.id=a.placement_id JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=p.company_id
      WHERE a.work_date >= CURRENT_DATE - 14 AND p.status IN ('active','notice') GROUP BY 1,2,3,4,5,6,7,8,9,10 HAVING count(*) FILTER (WHERE a.kind='late') >= 3 OR count(*) FILTER (WHERE a.kind='absent') >= 2`);
    for (const r of rows) {
      const link = `/workforce/workers/${r.worker_id}`;
      const sent = await one(`SELECT 1 FROM notifications WHERE organization_id=$1 AND event='attendance.pattern' AND link=$2 AND created_at >= now() - interval '7 days'`, [r.organization_id, link]);
      if (sent) continue;
      const parts = [r.late ? `${r.late} late arrival${r.late === 1 ? '' : 's'}` : '', r.absent ? `${r.absent} absence${r.absent === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
      await notify(r.organization_id, [r.account_manager_id], { event: 'attendance.pattern', title: `Recurring attendance issue: ${r.worker_name}`, body: `${parts} in the last 14 days at ${r.company_name}. Consider logging an issue.`, link });
      await emit(r.organization_id, 'attendance.pattern', { worker_id: r.worker_id, worker_name: r.worker_name, placement_id: r.placement_id, company_id: r.company_id, company_name: r.company_name, account_manager_id: r.account_manager_id, late: r.late, absent: r.absent });
    }
  });
  // Screenshot retention: delete files older than the placement policy's retention_days.
  every('time.screenshot_retention', 60 * 60000, async () => {
    const old = await q<any>(`SELECT s.id, s.file FROM screenshots s LEFT JOIN placements p ON p.id=s.placement_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id
      WHERE s.deleted_at IS NULL AND s.taken_at < now() - make_interval(days => COALESCE(mp.retention_days, 90)) LIMIT 2000`);
    for (const s of old) if (!s.file.startsWith('mock/')) deleteFile(s.file);
    if (old.length) await q(`UPDATE screenshots SET deleted_at=now() WHERE id = ANY($1)`, [old.map(s => s.id)]);
    if (old.length) console.log(`[retention] removed ${old.length} expired screenshots`);
  });
  // Weekly timesheets are auto-built: ensure this week's row exists for every active placement and totals stay fresh.
  every('time.timesheet_rollup', 5 * 60000, async () => {
    const pls = await q<any>(`SELECT id, organization_id, timezone FROM placements WHERE status IN ('active','notice') AND start_date <= CURRENT_DATE`);
    for (const p of pls) await rebuildTimesheet(p.organization_id, p.id, weekStart(dateInTz(new Date(), p.timezone)));
  });
}
