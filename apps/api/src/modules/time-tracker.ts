// TIME: Worker Portal — web Time Tracker (clock in/out, breaks, memo, heartbeats with activity counts,
// idle keep/discard, screenshots, screen-share declined, offline sync, demo simulation) and the worker's
// Today / Schedule / Timesheets / Time-off / Onboarding / Performance / Manual time pages.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { weekStart, addDays, isoDow, dateInTz, zonedToUtc } from '@veyro/shared';
import { q, one } from '../core/db';
import { auth, type Ctx } from '../core/context';
import { badRequest, conflict, notFound, HttpError } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { emit } from '../core/events';
import { publishOrg } from '../core/realtime';
import { saveFile, signedUrl, deleteFile } from '../core/storage';
import { getSetting } from '../core/settings';
import { ENTRY_MIN, ENTRY_SEC, placementFull, rebuildTimesheet, broadcastPresence, createMockShot, todayIn, hhmm, eventPayload, recordLateIfNeeded, simulateWorkday, scheduledDays, fieldErr } from './_wf/lib';
import { simulateWeek, clientApprovers } from './workforce-placements';

function worker(req: FastifyRequest): Ctx & { workerId: string } {
  const ctx = auth(req);
  if (ctx.role.kind !== 'worker' || !ctx.workerId) throw notFound();
  return ctx as Ctx & { workerId: string };
}
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const time = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM');

async function myPlacement(ctx: Ctx & { workerId: string }, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const p = await placementFull(ctx.orgId, id);
  if (!p || p.worker_id !== ctx.workerId) throw notFound();
  return p;
}
async function openEntry(ctx: Ctx & { workerId: string }) {
  return one<any>(`SELECT e.*, (SELECT row_to_json(b) FROM (SELECT id, started_at FROM breaks WHERE time_entry_id=e.id AND ended_at IS NULL LIMIT 1) b) open_break FROM time_entries e WHERE e.worker_id=$1 AND e.organization_id=$2 AND e.ended_at IS NULL ORDER BY e.started_at DESC LIMIT 1`, [ctx.workerId, ctx.orgId]);
}
function clampAt(at: string | undefined | null): Date {
  if (!at) return new Date();
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) throw badRequest('Invalid timestamp');
  if (d.getTime() > Date.now() + 60000) return new Date();
  if (d.getTime() < Date.now() - 36 * 3600 * 1000) throw conflict('Queued event is older than 36 hours — submit a manual time request instead');
  return d;
}

// ── Core tracker actions (also used by offline sync with explicit timestamps) ──
async function clockIn(ctx: Ctx & { workerId: string }, b: { placement_id: string; memo?: string | null; client_event_id?: string | null; at?: string | null }) {
  const p = await myPlacement(ctx, b.placement_id);
  if (!['active', 'notice'].includes(p.status)) throw conflict(p.status === 'onboarding' ? 'This placement is not active yet — finish onboarding first' : `This placement is ${p.status.replace('_', ' ')}; you cannot clock in`);
  if (!p.policy_accepted_at) throw conflict('Please review and accept the monitoring policy before your first clock-in', { needs_policy: true });
  if (b.client_event_id) { const dup = await one<any>(`SELECT * FROM time_entries WHERE worker_id=$1 AND client_event_id=$2`, [ctx.workerId, b.client_event_id]); if (dup) return dup; }
  const cur = await openEntry(ctx);
  if (cur) throw conflict('You are already clocked in', { entry_id: cur.id });
  const at = clampAt(b.at);
  const wd = dateInTz(at, p.timezone);
  const wts = await one<any>(`SELECT status FROM timesheets WHERE placement_id=$1 AND week_start=$2`, [p.id, weekStart(wd)]);
  if (wts && ['approved', 'locked'].includes(wts.status)) throw conflict(`This week's timesheet is already ${wts.status} — request manual time for any extra work`);
  const e = await one<any>(`INSERT INTO time_entries (organization_id, placement_id, worker_id, work_date, started_at, memo, source, client_event_id) VALUES ($1,$2,$3,$4,$5,$6,'tracker',$7) RETURNING *`, [ctx.orgId, p.id, ctx.workerId, wd, at.toISOString(), b.memo ?? null, b.client_event_id ?? null]);
  await q(`INSERT INTO worker_presence (worker_id, organization_id, placement_id, time_entry_id, state, session_started_at, last_heartbeat_at, simulated, updated_at) VALUES ($1,$2,$3,$4,'working',$5,now(),false,now())
    ON CONFLICT (worker_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, placement_id=EXCLUDED.placement_id, time_entry_id=EXCLUDED.time_entry_id, state='working', session_started_at=EXCLUDED.session_started_at, last_heartbeat_at=now(), simulated=false, activity_pct=NULL, updated_at=now()`, [ctx.workerId, ctx.orgId, p.id, e.id, at.toISOString()]);
  const grace = (await getSetting<any>(ctx.orgId, 'time_tracking')).late_grace_minutes ?? 5;
  await recordLateIfNeeded(ctx.orgId, p, at, grace, emit);
  await rebuildTimesheet(ctx.orgId, p.id, weekStart(wd));
  await broadcastPresence(ctx.orgId, ctx.workerId);
  return e;
}
async function clockOut(ctx: Ctx & { workerId: string }, b: { memo?: string | null; at?: string | null }) {
  const e = await openEntry(ctx);
  if (!e) throw conflict('You are not clocked in');
  const at = clampAt(b.at);
  const end = at < new Date(e.started_at) ? new Date(e.started_at) : at;
  if (e.open_break) {
    const secs = Math.max(0, Math.floor((end.getTime() - new Date(e.open_break.started_at).getTime()) / 1000));
    await q(`UPDATE breaks SET ended_at=$2 WHERE id=$1`, [e.open_break.id, end.toISOString()]);
    await q(`UPDATE time_entries SET break_seconds=break_seconds+$2 WHERE id=$1`, [e.id, secs]);
  }
  const r = await one<any>(`UPDATE time_entries SET ended_at=$2, memo=COALESCE($3, memo) WHERE id=$1 RETURNING *, ${ENTRY_MIN('time_entries')} minutes`, [e.id, end.toISOString(), b.memo ?? null]);
  await q(`UPDATE worker_presence SET state='offline', time_entry_id=NULL, session_started_at=NULL, updated_at=now() WHERE worker_id=$1`, [ctx.workerId]);
  await rebuildTimesheet(ctx.orgId, e.placement_id, weekStart(e.work_date));
  await broadcastPresence(ctx.orgId, ctx.workerId);
  return r;
}
async function startBreak(ctx: Ctx & { workerId: string }, at?: string | null) {
  const e = await openEntry(ctx);
  if (!e) throw conflict('You are not clocked in');
  if (e.open_break) throw conflict('You are already on a break');
  const t = clampAt(at);
  await q(`INSERT INTO breaks (organization_id, time_entry_id, started_at) VALUES ($1,$2,$3)`, [ctx.orgId, e.id, t.toISOString()]);
  await q(`UPDATE worker_presence SET state='on_break', last_heartbeat_at=now(), updated_at=now() WHERE worker_id=$1`, [ctx.workerId]);
  await broadcastPresence(ctx.orgId, ctx.workerId);
  return { ok: true };
}
async function resume(ctx: Ctx & { workerId: string }, at?: string | null) {
  const e = await openEntry(ctx);
  if (!e) throw conflict('You are not clocked in');
  if (!e.open_break) throw conflict('You are not on a break');
  const t = clampAt(at);
  const secs = Math.max(0, Math.floor((t.getTime() - new Date(e.open_break.started_at).getTime()) / 1000));
  await q(`UPDATE breaks SET ended_at=$2 WHERE id=$1`, [e.open_break.id, t.toISOString()]);
  await q(`UPDATE time_entries SET break_seconds=break_seconds+$2 WHERE id=$1`, [e.id, secs]);
  await q(`UPDATE worker_presence SET state='working', last_heartbeat_at=now(), updated_at=now() WHERE worker_id=$1`, [ctx.workerId]);
  await broadcastPresence(ctx.orgId, ctx.workerId);
  return { ok: true, break_seconds: secs };
}
const hbBody = z.object({ key_count: z.number().int().min(0).max(100000), mouse_count: z.number().int().min(0).max(100000), active_seconds: z.number().int().min(0).max(3600), idle_seconds: z.number().int().min(0).max(3600), bucket_start: z.string().optional(), idle: z.boolean().default(false), app_label: z.string().max(80).optional().nullable() });
async function heartbeat(ctx: Ctx & { workerId: string }, b: z.infer<typeof hbBody>) {
  const e = await openEntry(ctx);
  if (!e) return { ok: false, clocked_in: false };
  const p = await placementFull(ctx.orgId, e.placement_id);
  const secs = Math.max(1, b.active_seconds + b.idle_seconds);
  const pct = Math.round(Math.min(100, (b.active_seconds / secs) * 100));
  if (p.activity_tracking !== false && !e.open_break) {
    const bucket = b.bucket_start ? clampAt(b.bucket_start) : new Date(Date.now() - secs * 1000);
    await q(`INSERT INTO activity_samples (organization_id, worker_id, placement_id, time_entry_id, bucket_start, bucket_seconds, key_count, mouse_count, active_seconds, idle_seconds, activity_pct, app_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.orgId, ctx.workerId, e.placement_id, e.id, bucket.toISOString(), secs, b.key_count, b.mouse_count, b.active_seconds, b.idle_seconds, pct, b.app_label ?? 'VeyroApp Tracker']);
  }
  const recent = await one<any>(`SELECT round(sum(active_seconds)::numeric * 100 / NULLIF(sum(bucket_seconds),0))::int pct FROM activity_samples WHERE time_entry_id=$1 AND bucket_start >= now() - interval '10 minutes'`, [e.id]);
  const state = e.open_break ? 'on_break' : b.idle ? 'idle' : 'working';
  await q(`UPDATE worker_presence SET last_heartbeat_at=now(), activity_pct=$2, state=$3, updated_at=now() WHERE worker_id=$1`, [ctx.workerId, recent?.pct ?? pct, state]);
  await broadcastPresence(ctx.orgId, ctx.workerId);
  return { ok: true, clocked_in: true, activity_pct: recent?.pct ?? pct };
}
const idleBody = z.object({ started_at: z.string(), ended_at: z.string(), decision: z.enum(['keep', 'discard']) });
async function idleDecision(ctx: Ctx & { workerId: string }, b: z.infer<typeof idleBody>) {
  const e = await openEntry(ctx) ?? await one<any>(`SELECT * FROM time_entries WHERE worker_id=$1 ORDER BY started_at DESC LIMIT 1`, [ctx.workerId]);
  if (!e) throw conflict('No session to apply idle time to');
  const s = clampAt(b.started_at), en = clampAt(b.ended_at);
  const secs = Math.max(0, Math.floor((en.getTime() - s.getTime()) / 1000));
  if (secs > 8 * 3600) throw badRequest('Idle period is too long');
  await q(`INSERT INTO idle_events (organization_id, worker_id, time_entry_id, started_at, ended_at, seconds, decision) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ctx.orgId, ctx.workerId, e.id, s.toISOString(), en.toISOString(), secs, b.decision]);
  await q(`UPDATE time_entries SET idle_seconds=idle_seconds+$2, discarded_idle_seconds=discarded_idle_seconds+$3 WHERE id=$1`, [e.id, secs, b.decision === 'discard' ? secs : 0]);
  await q(`UPDATE worker_presence SET state=CASE WHEN state='idle' THEN 'working' ELSE state END, last_heartbeat_at=now(), updated_at=now() WHERE worker_id=$1`, [ctx.workerId]);
  await rebuildTimesheet(ctx.orgId, e.placement_id, weekStart(e.work_date));
  await broadcastPresence(ctx.orgId, ctx.workerId);
  return { ok: true, seconds: secs, decision: b.decision };
}

async function trackerState(ctx: Ctx & { workerId: string }) {
  const placements = await q<any>(`SELECT p.id, p.title, p.status, p.timezone, p.schedule_days, p.schedule_start, p.schedule_end, p.weekly_hours, p.policy_accepted_at, co.name company_name,
      mp.id policy_id, mp.name policy_name, mp.screenshots_enabled, mp.screenshot_interval_min, mp.blur, mp.activity_tracking, mp.idle_minutes, mp.retention_days, mp.worker_delete_window_min, mp.client_can_view
    FROM placements p JOIN companies co ON co.id=p.company_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id WHERE p.worker_id=$1 AND p.organization_id=$2 AND p.status IN ('active','notice','onboarding','on_leave') ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'notice' THEN 1 ELSE 2 END, p.start_date`, [ctx.workerId, ctx.orgId]);
  const e = await openEntry(ctx);
  const tz = (e ? placements.find(p => p.id === e.placement_id)?.timezone : placements[0]?.timezone) ?? 'America/New_York';
  const today = todayIn(tz), wk = weekStart(today);
  const tot = await one<any>(`SELECT COALESCE(sum(${ENTRY_SEC()}) FILTER (WHERE e.work_date=$2),0)::int today_sec, COALESCE(sum(${ENTRY_SEC()}) FILTER (WHERE e.work_date >= $3::date AND e.work_date <= $3::date + 6),0)::int week_sec FROM time_entries e WHERE e.worker_id=$1 AND e.work_date >= $3::date - 1`, [ctx.workerId, today, wk]);
  const session = e ? await one<any>(`SELECT ${ENTRY_SEC()} s FROM time_entries e WHERE e.id=$1`, [e.id]) : null;
  const todays = await q<any>(`SELECT e.id, e.started_at, e.ended_at, e.memo, e.source, e.break_seconds, e.discarded_idle_seconds, ${ENTRY_MIN()} minutes, co.name company_name FROM time_entries e JOIN placements p ON p.id=e.placement_id JOIN companies co ON co.id=p.company_id WHERE e.worker_id=$1 AND e.work_date=$2 ORDER BY e.started_at`, [ctx.workerId, today]);
  const presence = await one<any>(`SELECT state, screen_share, activity_pct, last_heartbeat_at FROM worker_presence WHERE worker_id=$1`, [ctx.workerId]);
  const shots = await one<any>(`SELECT count(*)::int n, max(taken_at) last FROM screenshots WHERE worker_id=$1 AND deleted_at IS NULL AND taken_at >= $2`, [ctx.workerId, zonedToUtc(today, '00:00', tz).toISOString()]);
  const ts = placements.length ? await q<any>(`SELECT placement_id, id, status, total_minutes FROM timesheets WHERE worker_id=$1 AND week_start=$2`, [ctx.workerId, wk]) : [];
  return {
    demo: true, now: new Date().toISOString(), today, week_start: wk, placements, current: e ? { ...e, session_sec: session?.s ?? 0 } : null,
    totals: { session_sec: session?.s ?? 0, today_sec: tot.today_sec, week_sec: tot.week_sec }, entries_today: todays, presence, screenshots_today: shots, timesheets_this_week: ts,
  };
}

export default async function (app: FastifyInstance) {
  const P = '/api/v1/portal/worker';
  app.get(`${P}/tracker/state`, async (req) => trackerState(worker(req)));
  app.post(`${P}/tracker/accept-policy`, async (req) => {
    const ctx = worker(req);
    const b = z.object({ placement_id: z.string() }).parse(req.body);
    const p = await myPlacement(ctx, b.placement_id);
    if (p.policy_accepted_at) return { ok: true, accepted_at: p.policy_accepted_at };
    const r = await one<any>(`UPDATE placements SET policy_accepted_at=now(), updated_at=now() WHERE id=$1 RETURNING policy_accepted_at`, [p.id]);
    await activity(ctx, 'placement', p.id, 'system', `${p.worker_name} accepted the monitoring policy`, `${p.policy_name}: screenshots ${p.screenshots_enabled ? `every ${p.screenshot_interval_min} min${p.blur ? ' (blurred)' : ''}` : 'off'}, activity tracking ${p.activity_tracking ? 'on' : 'off'}, retention ${p.retention_days} days.`);
    await audit(ctx, 'monitoring_policy.accepted', { type: 'placement', id: p.id, label: p.policy_name }, null, { policy_id: p.monitoring_policy_id });
    return { ok: true, accepted_at: r.policy_accepted_at };
  });
  app.post(`${P}/tracker/clock-in`, async (req) => {
    const ctx = worker(req);
    const b = z.object({ placement_id: z.string(), memo: z.string().max(500).optional().nullable(), client_event_id: z.string().max(80).optional().nullable() }).parse(req.body);
    await clockIn(ctx, b);
    return trackerState(ctx);
  });
  app.post(`${P}/tracker/clock-out`, async (req) => { const ctx = worker(req); const b = z.object({ memo: z.string().max(500).optional().nullable() }).parse(req.body ?? {}); await clockOut(ctx, b); return trackerState(ctx); });
  app.post(`${P}/tracker/break`, async (req) => { const ctx = worker(req); await startBreak(ctx); return trackerState(ctx); });
  app.post(`${P}/tracker/resume`, async (req) => { const ctx = worker(req); await resume(ctx); return trackerState(ctx); });
  app.post(`${P}/tracker/memo`, async (req) => {
    const ctx = worker(req);
    const b = z.object({ memo: z.string().max(500) }).parse(req.body);
    const e = await openEntry(ctx);
    if (!e) throw conflict('You are not clocked in');
    await q(`UPDATE time_entries SET memo=$2 WHERE id=$1`, [e.id, b.memo || null]);
    return { ok: true };
  });
  app.post(`${P}/tracker/heartbeat`, async (req) => heartbeat(worker(req), hbBody.parse(req.body)));
  app.post(`${P}/tracker/idle`, async (req) => idleDecision(worker(req), idleBody.parse(req.body)));

  app.post(`${P}/tracker/screen-share`, async (req) => {
    const ctx = worker(req);
    const b = z.object({ status: z.enum(['granted', 'declined', 'unsupported', 'stopped']) }).parse(req.body);
    const e = await openEntry(ctx);
    const status = b.status === 'stopped' ? 'declined' : b.status;
    await q(`UPDATE worker_presence SET screen_share=$2, updated_at=now() WHERE worker_id=$1`, [ctx.workerId, status]);
    if (e && status !== 'granted') {
      const p = await placementFull(ctx.orgId, e.placement_id);
      const exists = await one(`SELECT 1 FROM attendance_events WHERE placement_id=$1 AND work_date=$2 AND kind='screen_declined'`, [p.id, e.work_date]);
      if (!exists) {
        await q(`INSERT INTO attendance_events (organization_id, worker_id, placement_id, work_date, kind, note) VALUES ($1,$2,$3,$4,'screen_declined',$5)`, [ctx.orgId, ctx.workerId, p.id, e.work_date, b.status === 'unsupported' ? 'Browser does not support screen capture — demo screenshots generated' : b.status === 'stopped' ? 'Worker stopped screen sharing — demo screenshots generated' : 'Worker declined screen sharing — demo screenshots generated']);
        await activity(ctx, 'placement', p.id, 'system', `Screen sharing ${b.status === 'unsupported' ? 'unsupported' : b.status === 'stopped' ? 'stopped' : 'declined'} by ${p.worker_name}`, 'Demo mode: mock desktop screenshots are generated instead.');
        await notify(ctx.orgId, [p.account_manager_id], { event: 'screen.declined', title: `${p.worker_name} ${b.status === 'unsupported' ? 'cannot share' : 'declined sharing'} their screen`, body: `${p.company_name} — demo screenshots will be generated.`, link: `/time/screenshots?worker_id=${p.worker_id}` });
      }
      if (p.screenshots_enabled) await createMockShot({ orgId: ctx.orgId, workerId: ctx.workerId, placementId: p.id, entryId: e.id, at: new Date(), tz: p.timezone, blur: !!p.blur, activityPct: (await one<any>(`SELECT activity_pct FROM worker_presence WHERE worker_id=$1`, [ctx.workerId]))?.activity_pct ?? 70 });
    }
    await broadcastPresence(ctx.orgId, ctx.workerId);
    return { ok: true, screen_share: status };
  });

  // Real screenshot upload (frame from getDisplayMedia, downsized/blurred client-side).
  app.post(`${P}/tracker/screenshot`, async (req) => {
    const ctx = worker(req);
    const e = await openEntry(ctx);
    if (!e) throw conflict('You are not clocked in');
    const p = await placementFull(ctx.orgId, e.placement_id);
    if (!p.screenshots_enabled) throw conflict('Screenshots are disabled by your monitoring policy');
    let buf: Buffer | null = null; let mime = ''; const fields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') { mime = part.mimetype; buf = await part.toBuffer(); }
      else fields[part.fieldname] = String(part.value);
    }
    if (!buf) throw badRequest('No image received');
    if (buf.length > 4 * 1024 * 1024) throw badRequest('Screenshot is too large (max 4 MB)');
    const isPng = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpg) throw badRequest('Screenshots must be JPEG or PNG');
    const file = saveFile(`screenshots/${ctx.orgId}`, isPng ? 'shot.png' : 'shot.jpg', buf);
    const takenAt = fields.taken_at ? clampAt(fields.taken_at) : new Date();
    const pct = fields.activity_pct ? Math.max(0, Math.min(100, parseInt(fields.activity_pct, 10) || 0)) : (await one<any>(`SELECT activity_pct FROM worker_presence WHERE worker_id=$1`, [ctx.workerId]))?.activity_pct ?? null;
    const row = await one<any>(`INSERT INTO screenshots (organization_id, worker_id, placement_id, time_entry_id, taken_at, file, kind, app_label, url_label, activity_pct, blurred) VALUES ($1,$2,$3,$4,$5,$6,'real',$7,$8,$9,$10) RETURNING id, taken_at`,
      [ctx.orgId, ctx.workerId, p.id, e.id, takenAt.toISOString(), file, (fields.app_label || 'Shared screen').slice(0, 80), (fields.url_label || null), pct, fields.blurred === 'true' || !!p.blur]);
    await q(`UPDATE worker_presence SET screen_share='granted', last_heartbeat_at=now(), updated_at=now() WHERE worker_id=$1`, [ctx.workerId]);
    publishOrg(ctx.orgId, 'screenshot', { id: row.id, worker_id: ctx.workerId, placement_id: p.id, taken_at: row.taken_at, activity_pct: pct, url: signedUrl(file, 3600), kind: 'real' });
    await broadcastPresence(ctx.orgId, ctx.workerId);
    void mime;
    return { id: row.id, taken_at: row.taken_at, url: signedUrl(file, 3600) };
  });

  // Worker's own screenshots + self-delete within the policy window.
  app.get(`${P}/screenshots`, async (req) => {
    const ctx = worker(req);
    const { date: d } = req.query as { date?: string };
    const day = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
    const rows = await q<any>(`SELECT s.id, s.taken_at, s.file, s.kind, s.app_label, s.activity_pct, s.blurred, s.flagged, COALESCE(mp.worker_delete_window_min, 10) window_min, co.name company_name
      FROM screenshots s JOIN placements p ON p.id=s.placement_id JOIN companies co ON co.id=p.company_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id
      WHERE s.worker_id=$1 AND s.organization_id=$2 AND s.deleted_at IS NULL ${day ? `AND (s.taken_at AT TIME ZONE p.timezone)::date = $3` : ''} ORDER BY s.taken_at DESC LIMIT 200`, day ? [ctx.workerId, ctx.orgId, day] : [ctx.workerId, ctx.orgId]);
    const deleted = await one<any>(`SELECT count(*)::int n FROM screenshots WHERE worker_id=$1 AND deleted_by=$2`, [ctx.workerId, ctx.userId]);
    return { rows: rows.map(r => { const until = new Date(new Date(r.taken_at).getTime() + r.window_min * 60000); return { ...r, url: signedUrl(r.file, 3600), file: undefined, delete_until: until, can_delete: until > new Date() }; }), deleted_by_me: deleted.n };
  });
  app.delete(`${P}/screenshots/:id`, async (req) => {
    const ctx = worker(req);
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const s = await one<any>(`SELECT s.*, COALESCE(mp.worker_delete_window_min, 10) window_min FROM screenshots s LEFT JOIN placements p ON p.id=s.placement_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id WHERE s.id=$1 AND s.organization_id=$2 AND s.worker_id=$3 AND s.deleted_at IS NULL`, [id, ctx.orgId, ctx.workerId]);
    if (!s) throw notFound();
    if (new Date(s.taken_at).getTime() + s.window_min * 60000 < Date.now()) throw conflict(`Screenshots can only be deleted within ${s.window_min} minutes of capture`);
    await q(`UPDATE screenshots SET deleted_at=now(), deleted_by=$2 WHERE id=$1`, [id, ctx.userId]);
    if (!s.file.startsWith('mock/')) deleteFile(s.file);
    await audit(ctx, 'screenshot.deleted_by_worker', { type: 'screenshot', id, label: new Date(s.taken_at).toISOString() }, { taken_at: s.taken_at, app_label: s.app_label }, null, 'Worker self-delete within policy window');
    if (s.placement_id) await activity(ctx, 'placement', s.placement_id, 'system', `Worker deleted a screenshot taken ${new Date(s.taken_at).toISOString().slice(11, 16)} UTC`, 'Deleted within the policy window (logged).');
    return { ok: true };
  });

  // Offline queue sync: events are processed in time order, each exactly once.
  app.post(`${P}/tracker/sync`, async (req) => {
    const ctx = worker(req);
    const b = z.object({ events: z.array(z.object({ client_event_id: z.string().min(4).max(80), type: z.enum(['clock_in', 'clock_out', 'break', 'resume', 'heartbeat', 'idle', 'memo']), at: z.string(), data: z.record(z.any()).default({}) })).max(500) }).parse(req.body);
    const results: { client_event_id: string; ok: boolean; duplicate?: boolean; error?: string }[] = [];
    for (const ev of [...b.events].sort((a, c) => a.at.localeCompare(c.at))) {
      const done = await one(`SELECT 1 FROM tracker_sync_events WHERE worker_id=$1 AND client_event_id=$2`, [ctx.workerId, ev.client_event_id]);
      if (done) { results.push({ client_event_id: ev.client_event_id, ok: true, duplicate: true }); continue; }
      let ok = true, error: string | undefined;
      try {
        if (ev.type === 'clock_in') await clockIn(ctx, { placement_id: String(ev.data.placement_id ?? ''), memo: ev.data.memo ?? null, client_event_id: ev.client_event_id, at: ev.at });
        else if (ev.type === 'clock_out') await clockOut(ctx, { memo: ev.data.memo ?? null, at: ev.at });
        else if (ev.type === 'break') await startBreak(ctx, ev.at);
        else if (ev.type === 'resume') await resume(ctx, ev.at);
        else if (ev.type === 'heartbeat') await heartbeat(ctx, hbBody.parse({ ...ev.data, bucket_start: ev.data.bucket_start ?? ev.at }));
        else if (ev.type === 'idle') await idleDecision(ctx, idleBody.parse(ev.data));
        else if (ev.type === 'memo') { const e = await openEntry(ctx); if (e) await q(`UPDATE time_entries SET memo=$2 WHERE id=$1`, [e.id, String(ev.data.memo ?? '').slice(0, 500) || null]); }
      } catch (e: any) { ok = false; error = e instanceof HttpError ? e.message : 'Could not apply event'; }
      await q(`INSERT INTO tracker_sync_events (organization_id, worker_id, client_event_id, kind, occurred_at, result) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [ctx.orgId, ctx.workerId, ev.client_event_id, ev.type, new Date(ev.at).toISOString(), JSON.stringify({ ok, error })]);
      results.push({ client_event_id: ev.client_event_id, ok, error });
    }
    return { results, state: await trackerState(ctx) };
  });

  // ── Demo: simulate a workday / rest of week ──
  app.post(`${P}/tracker/simulate-day`, async (req) => {
    const ctx = worker(req);
    const b = z.object({ placement_id: z.string() }).parse(req.body);
    const p = await myPlacement(ctx, b.placement_id);
    if (!['active', 'notice'].includes(p.status)) throw conflict('This placement is not active');
    if (!p.policy_accepted_at) throw conflict('Please accept the monitoring policy first', { needs_policy: true });
    const today = todayIn(p.timezone), wk = weekStart(today);
    const ts = await one<any>(`SELECT status FROM timesheets WHERE placement_id=$1 AND week_start=$2`, [p.id, wk]);
    if (ts && ['submitted', 'approved', 'locked'].includes(ts.status)) throw conflict(`This week's timesheet is already ${ts.status}`);
    const worked = new Set((await q<any>(`SELECT DISTINCT work_date::text d FROM time_entries WHERE placement_id=$1 AND work_date BETWEEN $2::date AND $2::date + 6`, [p.id, wk])).map(r => r.d));
    const day = scheduledDays(p, wk).find(d => !worked.has(d) && d >= p.start_date);
    if (!day) throw conflict('Every scheduled day this week already has time — submit your timesheet from Timesheets');
    const r = await simulateWorkday(ctx.orgId, p, day);
    await rebuildTimesheet(ctx.orgId, p.id, wk);
    await activity(ctx, 'placement', p.id, 'system', `Demo: simulated workday ${day}`, `${(r.minutes / 60).toFixed(1)}h with ${r.shots} screenshots and activity samples.`);
    return { date: day, minutes: r.minutes, shots: r.shots, state: await trackerState(ctx) };
  });
  app.post(`${P}/tracker/simulate-week`, async (req) => {
    const ctx = worker(req);
    const b = z.object({ placement_id: z.string(), submit: z.boolean().default(true) }).parse(req.body);
    const p = await myPlacement(ctx, b.placement_id);
    if (!['active', 'notice'].includes(p.status)) throw conflict('This placement is not active');
    if (!p.policy_accepted_at) throw conflict('Please accept the monitoring policy first', { needs_policy: true });
    if (b.submit && await openEntry(ctx)) throw conflict('Clock out first — a timesheet cannot be submitted while you are clocked in');
    const r = await simulateWeek(ctx, p, weekStart(todayIn(p.timezone)), b.submit, 'worker');
    return { ...r, state: await trackerState(ctx) };
  });

  // ── Today ──
  app.get(`${P}/today`, async (req) => {
    const ctx = worker(req);
    const st = await trackerState(ctx);
    const p = st.placements[0];
    const onboarding = await one<any>(`SELECT count(*) FILTER (WHERE i.owner='worker' AND i.done_at IS NULL)::int mine_open, count(*) FILTER (WHERE i.done_at IS NULL AND i.required)::int required_open FROM placement_onboarding_items i JOIN placements p ON p.id=i.placement_id WHERE p.worker_id=$1 AND i.removed_at IS NULL AND p.status IN ('onboarding','active')`, [ctx.workerId]);
    const toSubmit = await q<any>(`SELECT t.id, t.week_start, t.total_minutes, t.status, co.name company_name FROM timesheets t JOIN companies co ON co.id=t.company_id WHERE t.worker_id=$1 AND t.status IN ('open','rejected') AND t.week_start < $2 AND t.total_minutes > 0 ORDER BY t.week_start`, [ctx.workerId, st.week_start]);
    const pending = await one<any>(`SELECT (SELECT count(*)::int FROM time_off_requests WHERE worker_id=$1 AND status='pending') time_off, (SELECT count(*)::int FROM manual_time_requests WHERE worker_id=$1 AND status='pending') manual`, [ctx.workerId]);
    const upcoming = await q<any>(`SELECT id, kind, start_date, end_date, status FROM time_off_requests WHERE worker_id=$1 AND end_date >= $2 AND status IN ('approved','pending') ORDER BY start_date LIMIT 3`, [ctx.workerId, st.today]);
    const shift = p && (p.schedule_days ?? []).includes(isoDow(st.today)) ? { start: hhmm(p.schedule_start), end: hhmm(p.schedule_end), timezone: p.timezone, company_name: p.company_name } : null;
    const lastWeek = await one<any>(`SELECT COALESCE(sum(${ENTRY_MIN()}),0)::int m FROM time_entries e WHERE e.worker_id=$1 AND e.work_date >= $2::date - 7 AND e.work_date < $2::date`, [ctx.workerId, st.week_start]);
    return { ...st, shift, onboarding, timesheets_to_submit: toSubmit, pending, upcoming_time_off: upcoming, last_week_minutes: lastWeek.m };
  });

  // ── Schedule ──
  app.get(`${P}/schedule`, async (req) => {
    const ctx = worker(req);
    const qq = req.query as { from?: string; to?: string };
    const from = qq.from && /^\d{4}-\d{2}-\d{2}$/.test(qq.from) ? qq.from : weekStart(dateInTz(new Date(), 'UTC'));
    let to = qq.to && /^\d{4}-\d{2}-\d{2}$/.test(qq.to) ? qq.to : addDays(from, 27);
    if (to < from) to = from; if (addDays(from, 92) < to) to = addDays(from, 92);
    const pls = await q<any>(`SELECT p.id, p.title, p.status, p.start_date, p.end_date, p.schedule_days, p.schedule_start, p.schedule_end, p.timezone, co.name company_name FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.worker_id=$1 AND p.status <> 'ended' OR (p.worker_id=$1 AND p.end_date >= $2)`, [ctx.workerId, from]);
    const off = await q<any>(`SELECT id, kind, start_date, end_date, status, note FROM time_off_requests WHERE worker_id=$1 AND status IN ('approved','pending') AND end_date >= $2 AND start_date <= $3`, [ctx.workerId, from, to]);
    const worked = await q<any>(`SELECT e.work_date::text d, sum(${ENTRY_MIN()})::int m FROM time_entries e WHERE e.worker_id=$1 AND e.work_date BETWEEN $2 AND $3 GROUP BY 1`, [ctx.workerId, from, to]);
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const shifts = pls.filter(p => p.schedule_days.includes(isoDow(d)) && d >= p.start_date && (!p.end_date || d <= p.end_date)).map(p => ({ placement_id: p.id, title: p.title, company_name: p.company_name, start: hhmm(p.schedule_start), end: hhmm(p.schedule_end), timezone: p.timezone }));
      const t = off.find(o => o.start_date <= d && o.end_date >= d);
      days.push({ date: d, dow: isoDow(d), shifts, time_off: t ? { kind: t.kind, status: t.status } : null, worked_minutes: worked.find(w => w.d === d)?.m ?? 0 });
    }
    return { from, to, days, placements: pls, time_off: off };
  });

  // ── Timesheets ──
  app.get(`${P}/timesheets`, async (req) => {
    const ctx = worker(req);
    for (const p of await q<any>(`SELECT id, timezone FROM placements WHERE worker_id=$1 AND status IN ('active','notice')`, [ctx.workerId])) await rebuildTimesheet(ctx.orgId, p.id, weekStart(todayIn(p.timezone)));
    return { rows: await q<any>(`SELECT t.id, t.week_start, t.status, t.total_minutes, t.submitted_at, t.approved_at, t.rejected_reason, co.name company_name, p.title FROM timesheets t JOIN companies co ON co.id=t.company_id JOIN placements p ON p.id=t.placement_id WHERE t.worker_id=$1 AND t.organization_id=$2 ORDER BY t.week_start DESC LIMIT 60`, [ctx.workerId, ctx.orgId]) };
  });
  app.get(`${P}/timesheets/:id`, async (req) => {
    const ctx = worker(req);
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const t = await one<any>(`SELECT t.*, co.name company_name, p.title, p.timezone FROM timesheets t JOIN companies co ON co.id=t.company_id JOIN placements p ON p.id=t.placement_id WHERE t.id=$1 AND t.worker_id=$2 AND t.organization_id=$3`, [id, ctx.workerId, ctx.orgId]);
    if (!t) throw notFound();
    const entries = await q<any>(`SELECT e.id, e.work_date, e.started_at, e.ended_at, e.memo, e.source, e.break_seconds, e.discarded_idle_seconds, ${ENTRY_MIN()} minutes FROM time_entries e WHERE e.placement_id=$1 AND e.work_date BETWEEN $2::date AND $2::date + 6 ORDER BY e.started_at`, [t.placement_id, t.week_start]);
    const history = await q<any>(`SELECT a.party, a.decision, a.reason, a.created_at, u.name actor_name FROM timesheet_approvals a LEFT JOIN users u ON u.id=a.actor_id WHERE a.timesheet_id=$1 ORDER BY a.created_at`, [id]);
    const adjustments = await q<any>(`SELECT work_date, minutes_delta, reason, created_at FROM timesheet_adjustments WHERE timesheet_id=$1 ORDER BY created_at`, [id]);
    return { ...t, entries, history, adjustments };
  });
  app.post(`${P}/timesheets/:id/submit`, async (req) => {
    const ctx = worker(req);
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const t0 = await one<any>(`SELECT * FROM timesheets WHERE id=$1 AND worker_id=$2 AND organization_id=$3`, [id, ctx.workerId, ctx.orgId]);
    if (!t0) throw notFound();
    if (!['open', 'rejected'].includes(t0.status)) throw conflict(`Cannot submit a timesheet that is ${t0.status}`);
    const open = await one(`SELECT 1 FROM time_entries WHERE placement_id=$1 AND ended_at IS NULL AND work_date BETWEEN $2::date AND $2::date + 6`, [t0.placement_id, t0.week_start]);
    if (open) throw conflict('Clock out before submitting this week');
    const t = await rebuildTimesheet(ctx.orgId, t0.placement_id, t0.week_start);
    if (!t.total_minutes) throw conflict('There is no time on this timesheet yet');
    await q(`UPDATE timesheets SET status='submitted', submitted_at=now(), rejected_reason=NULL, updated_at=now() WHERE id=$1`, [id]);
    await q(`INSERT INTO timesheet_approvals (organization_id, timesheet_id, actor_id, party, decision, reason) VALUES ($1,$2,$3,'agency','submitted','Submitted by worker')`, [ctx.orgId, id, ctx.userId]);
    const p = await placementFull(ctx.orgId, t0.placement_id);
    await activity(ctx, 'timesheet', id, 'status_change', `Timesheet submitted by ${p.worker_name} (${(t.total_minutes / 60).toFixed(1)}h)`, null, { from: t0.status, to: 'submitted' });
    await emit(ctx.orgId, 'timesheet.submitted', eventPayload(p, { timesheet_id: id, week_start: t0.week_start, total_minutes: t.total_minutes }));
    const approvers = p.timesheet_approval === 'agency' ? [] : await clientApprovers(ctx.orgId, p.company_id);
    await notify(ctx.orgId, [p.account_manager_id], { event: 'timesheet.submitted', title: `Timesheet submitted: ${p.worker_name}`, body: `Week of ${t0.week_start} · ${(t.total_minutes / 60).toFixed(1)}h${p.timesheet_approval === 'agency' ? '' : ' · awaiting client approval'}`, link: `/time/timesheets/${id}` });
    if (approvers.length) await notify(ctx.orgId, approvers, { event: 'timesheet.submitted', title: `Timesheet to approve: ${p.worker_name}`, body: `Week of ${t0.week_start} · ${(t.total_minutes / 60).toFixed(1)}h`, link: `/portal/client/timesheets` });
    publishOrg(ctx.orgId, 'timesheet', { id, status: 'submitted' });
    return { ok: true, status: 'submitted' };
  });

  // ── Time-off ──
  app.get(`${P}/time-off`, async (req) => {
    const ctx = worker(req);
    return { rows: await q<any>(`SELECT r.*, u.name decided_by_name, co.name company_name FROM time_off_requests r LEFT JOIN users u ON u.id=r.decided_by LEFT JOIN placements p ON p.id=r.placement_id LEFT JOIN companies co ON co.id=p.company_id WHERE r.worker_id=$1 AND r.organization_id=$2 ORDER BY r.start_date DESC`, [ctx.workerId, ctx.orgId]) };
  });
  app.post(`${P}/time-off`, async (req) => {
    const ctx = worker(req);
    const b = z.object({ placement_id: z.string().optional().nullable(), kind: z.enum(['vacation', 'sick', 'personal', 'unpaid', 'holiday']), start_date: date, end_date: date, note: z.string().max(1000).optional().nullable() }).parse(req.body);
    if (b.end_date < b.start_date) throw fieldErr({ end_date: 'End date must be on or after the start date' });
    const p = b.placement_id ? await myPlacement(ctx, b.placement_id) : await one<any>(`SELECT p.*, co.name company_name FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.worker_id=$1 AND p.status IN ('active','notice','onboarding','on_leave') ORDER BY p.start_date DESC LIMIT 1`, [ctx.workerId]);
    const overlap = await one(`SELECT 1 FROM time_off_requests WHERE worker_id=$1 AND status IN ('pending','approved') AND start_date <= $3 AND end_date >= $2`, [ctx.workerId, b.start_date, b.end_date]);
    if (overlap) throw conflict('You already have a time-off request covering some of these dates');
    const r = await one<any>(`INSERT INTO time_off_requests (organization_id, worker_id, placement_id, kind, start_date, end_date, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [ctx.orgId, ctx.workerId, p?.id ?? null, b.kind, b.start_date, b.end_date, b.note ?? null]);
    if (p) await notify(ctx.orgId, [p.account_manager_id], { event: 'time_off.requested', title: `Time-off request: ${ctx.user.name}`, body: `${b.kind} · ${b.start_date} → ${b.end_date}`, link: `/time/time-off?status=pending` });
    return r;
  });
  app.post(`${P}/time-off/:id/cancel`, async (req) => {
    const ctx = worker(req);
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const r = await one<any>(`SELECT * FROM time_off_requests WHERE id=$1 AND worker_id=$2`, [id, ctx.workerId]);
    if (!r) throw notFound();
    if (r.status !== 'pending') throw conflict('Only pending requests can be cancelled');
    await q(`UPDATE time_off_requests SET status='cancelled', decided_at=now() WHERE id=$1`, [id]);
    return { ok: true };
  });

  // ── Manual time requests ──
  app.get(`${P}/manual-requests`, async (req) => {
    const ctx = worker(req);
    return { rows: await q<any>(`SELECT r.*, u.name decided_by_name, co.name company_name FROM manual_time_requests r LEFT JOIN users u ON u.id=r.decided_by JOIN placements p ON p.id=r.placement_id JOIN companies co ON co.id=p.company_id WHERE r.worker_id=$1 AND r.organization_id=$2 ORDER BY r.created_at DESC`, [ctx.workerId, ctx.orgId]) };
  });
  app.post(`${P}/manual-requests`, async (req) => {
    const ctx = worker(req);
    const b = z.object({ placement_id: z.string(), work_date: date, start_time: time, end_time: time, reason: z.string().min(5, 'Explain why the time was not tracked').max(1000) }).parse(req.body);
    const p = await myPlacement(ctx, b.placement_id);
    if (!['active', 'notice'].includes(p.status)) throw conflict('This placement is not active');
    if (b.end_time <= b.start_time) throw fieldErr({ end_time: 'End time must be after the start time' });
    const today = todayIn(p.timezone);
    if (b.work_date > today) throw fieldErr({ work_date: 'Manual time can only be requested for today or past days' });
    if (b.work_date < addDays(today, -45)) throw fieldErr({ work_date: 'Requests older than 45 days are not accepted' });
    if (b.work_date < p.start_date) throw fieldErr({ work_date: 'Date is before your placement started' });
    const s = zonedToUtc(b.work_date, b.start_time, p.timezone), e = zonedToUtc(b.work_date, b.end_time, p.timezone);
    const overlap = await one(`SELECT 1 FROM time_entries WHERE worker_id=$1 AND started_at < $3 AND COALESCE(ended_at, now()) > $2`, [ctx.workerId, s.toISOString(), e.toISOString()]);
    if (overlap) throw conflict('That time overlaps time you already tracked');
    const r = await one<any>(`INSERT INTO manual_time_requests (organization_id, worker_id, placement_id, work_date, start_time, end_time, reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [ctx.orgId, ctx.workerId, p.id, b.work_date, b.start_time, b.end_time, b.reason]);
    await notify(ctx.orgId, [p.account_manager_id], { event: 'manual_time.requested', title: `Manual time request: ${p.worker_name}`, body: `${b.work_date} ${b.start_time}–${b.end_time} · ${b.reason}`, link: `/time/manual?status=pending` });
    return r;
  });

  // ── Onboarding (their part) ──
  app.get(`${P}/onboarding`, async (req) => {
    const ctx = worker(req);
    const rows = await q<any>(`SELECT i.id, i.title, i.source, i.required, i.owner, i.done_at, i.note, du.name done_by_name, p.id placement_id, p.title placement_title, p.status placement_status, co.name company_name
      FROM placement_onboarding_items i JOIN placements p ON p.id=i.placement_id JOIN companies co ON co.id=p.company_id LEFT JOIN users du ON du.id=i.done_by
      WHERE p.worker_id=$1 AND p.organization_id=$2 AND i.removed_at IS NULL AND p.status IN ('onboarding','active','notice','on_leave') ORDER BY p.start_date DESC, CASE i.owner WHEN 'worker' THEN 0 ELSE 1 END, i.sort`, [ctx.workerId, ctx.orgId]);
    return { rows };
  });
  app.post(`${P}/onboarding/:itemId`, async (req) => {
    const ctx = worker(req);
    const { itemId } = req.params as { itemId: string };
    const b = z.object({ done: z.boolean() }).parse(req.body);
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) throw notFound();
    const it = await one<any>(`SELECT i.*, p.status placement_status FROM placement_onboarding_items i JOIN placements p ON p.id=i.placement_id WHERE i.id=$1 AND p.worker_id=$2 AND i.removed_at IS NULL`, [itemId, ctx.workerId]);
    if (!it) throw notFound();
    if (it.owner !== 'worker') throw conflict('This item is completed by your agency');
    if (it.placement_status === 'ended') throw conflict('This placement has ended');
    await q(`UPDATE placement_onboarding_items SET done_at=$2, done_by=$3 WHERE id=$1`, [itemId, b.done ? new Date().toISOString() : null, b.done ? ctx.userId : null]);
    await activity(ctx, 'placement', it.placement_id, 'system', `${ctx.user.name} ${b.done ? 'completed' : 'reopened'}: ${it.title}`, 'From the Worker Portal');
    return { ok: true };
  });

  // ── Performance ──
  app.get(`${P}/performance`, async (req) => {
    const ctx = worker(req);
    const weekly = await q<any>(`SELECT to_char(wk, 'Mon DD') label, wk::date::text AS week, COALESCE((SELECT sum(${ENTRY_MIN()}) FROM time_entries e WHERE e.worker_id=$1 AND e.work_date >= wk::date AND e.work_date < wk::date + 7),0)::int value
      FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') wk ORDER BY wk`, [ctx.workerId]);
    const activityDaily = await q<any>(`SELECT to_char(d, 'Mon DD') label, d::date::text AS day, COALESCE((SELECT round(sum(active_seconds)::numeric * 100 / NULLIF(sum(bucket_seconds),0)) FROM activity_samples a WHERE a.worker_id=$1 AND a.bucket_start >= d AND a.bucket_start < d + interval '1 day'),0)::int value
      FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d ORDER BY d`, [ctx.workerId]);
    const days = await one<any>(`SELECT count(DISTINCT work_date)::int worked FROM time_entries WHERE worker_id=$1 AND work_date >= CURRENT_DATE - 90`, [ctx.workerId]);
    const att = await one<any>(`SELECT count(*) FILTER (WHERE kind='late')::int late, count(*) FILTER (WHERE kind='absent')::int absent, count(*) FILTER (WHERE kind='early_leave')::int early_leave, COALESCE(round(avg(minutes) FILTER (WHERE kind='late')),0)::int avg_late_min FROM attendance_events WHERE worker_id=$1 AND work_date >= CURRENT_DATE - 90`, [ctx.workerId]);
    const appr = await one<any>(`SELECT COALESCE(sum(d.minutes),0)::int approved_minutes FROM timesheet_days d JOIN timesheets t ON t.id=d.timesheet_id WHERE t.worker_id=$1 AND d.work_date >= CURRENT_DATE - 90`, [ctx.workerId]);
    const apps = await q<any>(`SELECT COALESCE(app_label,'Other') label, sum(active_seconds)::int value FROM activity_samples WHERE worker_id=$1 AND bucket_start >= now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, [ctx.workerId]);
    const scheduled = days.worked + att.absent;
    const onTime = scheduled ? Math.round(((days.worked - att.late) / scheduled) * 1000) / 10 : null;
    const actVals = activityDaily.filter(d => d.value > 0);
    return { weekly, activity_daily: activityDaily, apps, attendance: { ...att, days_worked: days.worked, on_time_pct: onTime }, approved_minutes_90d: appr.approved_minutes, avg_activity_30d: actVals.length ? Math.round(actVals.reduce((a, b) => a + b.value, 0) / actVals.length) : null };
  });
}
