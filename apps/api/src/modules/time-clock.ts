// TIME: Clock In console (supervisor view for "today"). Every active placement with its own-timezone shift,
// live clock status, session timer and on-behalf actions (clock in / start break / end break / clock out).
// On-behalf actions need time:edit + a reason, create real time_entries / breaks (source='manual',
// created_by/ended_by = acting staff user), update worker_presence + realtime 'presence', write a placement
// Activity + audit 'time.clocked_on_behalf', and notify the worker. Approved/locked weeks → 409.
// "My clock": staff users who are themselves a worker in this org can clock themselves.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { weekStart, isoDow, dateInTz, zonedToUtc } from '@veyro/shared';
import { q, one, tx } from '../core/db';
import { staff, need, can, getOr404, type Ctx } from '../core/context';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { emit } from '../core/events';
import { getSetting } from '../core/settings';
import { WNAME, ENTRY_MIN, ENTRY_SEC, placementFull, rebuildTimesheet, broadcastPresence, recordLateIfNeeded, hhmm, fmtClock, fieldErr } from './_wf/lib';

export const CLOCK_LABEL: Record<string, string> = {
  working: 'Working', on_break: 'On break', late: 'Late', absent: 'Missed shift', not_clocked_in: 'Not clocked in', clocked_out: 'Clocked out',
  elsewhere: 'On another placement', time_off: 'On time off', off_today: 'Off today',
};
const ORDER: Record<string, number> = { late: 0, absent: 1, working: 2, on_break: 3, not_clocked_in: 4, clocked_out: 5, elsewhere: 6, time_off: 7, off_today: 8 };
type Action = 'clock-in' | 'start-break' | 'end-break' | 'clock-out';
const ACTION_TEXT: Record<Action, { done: string; you: string }> = {
  'clock-in': { done: 'clocked in', you: 'clocked you in' }, 'start-break': { done: 'started a break for', you: 'started a break for you' },
  'end-break': { done: 'ended the break for', you: 'ended your break' }, 'clock-out': { done: 'clocked out', you: 'clocked you out' },
};

/** Workers in this org that belong to the signed-in staff user (membership.worker_id or workers.user_id). */
async function myWorkerIds(ctx: Ctx): Promise<string[]> {
  const r = await q<any>(`SELECT id FROM workers WHERE organization_id=$1 AND (user_id=$2 OR id=$3)`, [ctx.orgId, ctx.userId, ctx.workerId]);
  return r.map(x => x.id);
}

async function clockRows(ctx: Ctx, opts: { companyId?: string | null; workerIds?: string[] } = {}) {
  const params: unknown[] = [ctx.orgId]; const extra: string[] = [];
  if (opts.companyId) { params.push(opts.companyId); extra.push(`p.company_id=$${params.length}`); }
  if (opts.workerIds) { params.push(opts.workerIds); extra.push(`p.worker_id = ANY($${params.length})`); }
  const rows = await q<any>(`SELECT p.id placement_id, p.worker_id, p.title, p.status placement_status, p.timezone, p.schedule_days, p.schedule_start::text, p.schedule_end::text, p.company_id, co.name company_name,
      ${WNAME} worker_name, cd.avatar_color, w.user_id worker_user_id, am.name account_manager_name, (now() AT TIME ZONE p.timezone)::date::text local_date,
      wp.state presence_state, wp.activity_pct,
      (SELECT row_to_json(x) FROM (SELECT e.id, e.placement_id, e.started_at, e.work_date, e.source, e.created_by, cu.name created_by_name, ${ENTRY_SEC()} session_sec,
          (SELECT b.started_at FROM breaks b WHERE b.time_entry_id=e.id AND b.ended_at IS NULL LIMIT 1) break_started_at
        FROM time_entries e LEFT JOIN users cu ON cu.id=e.created_by WHERE e.worker_id=p.worker_id AND e.organization_id=p.organization_id AND e.ended_at IS NULL ORDER BY e.started_at DESC LIMIT 1) x) open_entry,
      (SELECT COALESCE(sum(${ENTRY_MIN()}),0)::int FROM time_entries e WHERE e.placement_id=p.id AND e.work_date=(now() AT TIME ZONE p.timezone)::date) today_minutes,
      (SELECT count(*)::int FROM time_entries e WHERE e.placement_id=p.id AND e.work_date=(now() AT TIME ZONE p.timezone)::date) today_sessions,
      (SELECT max(e.ended_at) FROM time_entries e WHERE e.placement_id=p.id AND e.work_date=(now() AT TIME ZONE p.timezone)::date) last_ended_at,
      (SELECT min(e.started_at) FROM time_entries e WHERE e.placement_id=p.id AND e.work_date=(now() AT TIME ZONE p.timezone)::date) first_started_at,
      (SELECT minutes FROM attendance_events a WHERE a.placement_id=p.id AND a.work_date=(now() AT TIME ZONE p.timezone)::date AND a.kind='late' LIMIT 1) late_recorded,
      EXISTS (SELECT 1 FROM time_off_requests r WHERE r.worker_id=p.worker_id AND r.status='approved' AND (now() AT TIME ZONE p.timezone)::date BETWEEN r.start_date AND r.end_date) time_off_today,
      (SELECT t.status FROM timesheets t WHERE t.placement_id=p.id AND t.week_start=date_trunc('week', (now() AT TIME ZONE p.timezone))::date) week_status
    FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=p.company_id LEFT JOIN users am ON am.id=p.account_manager_id
      LEFT JOIN worker_presence wp ON wp.worker_id=p.worker_id
    WHERE p.organization_id=$1 AND p.status IN ('active','notice','on_leave') ${extra.length ? 'AND ' + extra.join(' AND ') : ''}`, params);
  const grace = (await getSetting<any>(ctx.orgId, 'time_tracking')).late_grace_minutes ?? 5;
  const now = Date.now();
  return rows.map(r => {
    const tz = r.timezone || 'America/New_York';
    const today = r.local_date;
    const scheduled = (r.schedule_days ?? []).includes(isoDow(today));
    const start = zonedToUtc(today, hhmm(r.schedule_start), tz), end = zonedToUtc(today, hhmm(r.schedule_end), tz);
    const oe = r.open_entry;
    const mine = oe && oe.placement_id === r.placement_id;
    let status: string;
    if (mine) status = oe.break_started_at ? 'on_break' : 'working';
    else if (oe) status = 'elsewhere';
    else if (r.placement_status === 'on_leave' || r.time_off_today) status = 'time_off';
    else if (r.today_sessions > 0) status = 'clocked_out';
    else if (!scheduled) status = 'off_today';
    else if (now > start.getTime() + grace * 60000 && now < end.getTime()) status = 'late';
    else if (now >= end.getTime()) status = 'absent';
    else status = 'not_clocked_in';
    const locked = ['approved', 'locked'].includes(r.week_status);
    const openWeekLocked = locked; // open sessions always belong to this or last week; server re-checks per action
    const canAct = ['active', 'notice'].includes(r.placement_status);
    const late_minutes = status === 'late' ? Math.max(0, Math.floor((now - start.getTime()) / 60000)) : r.late_recorded ?? null;
    return {
      id: r.placement_id, placement_id: r.placement_id, worker_id: r.worker_id, worker_name: r.worker_name, avatar_color: r.avatar_color, title: r.title, company_id: r.company_id, company_name: r.company_name,
      account_manager_name: r.account_manager_name, placement_status: r.placement_status, timezone: tz, local_date: today, local_time: fmtClock(new Date(), tz),
      scheduled, shift_start: scheduled ? hhmm(r.schedule_start) : null, shift_end: scheduled ? hhmm(r.schedule_end) : null,
      shift_start_at: scheduled ? start.toISOString() : null, shift_end_at: scheduled ? end.toISOString() : null,
      status, status_label: CLOCK_LABEL[status], idle: mine && r.presence_state === 'idle', activity_pct: mine ? r.activity_pct : null,
      session_started_at: mine ? oe.started_at : null, session_sec: mine ? oe.session_sec : null, break_started_at: mine ? oe.break_started_at : null,
      session_source: mine ? oe.source : null, clocked_in_by_name: mine && oe.source === 'manual' ? oe.created_by_name ?? null : null,
      elsewhere_entry_placement_id: !mine && oe ? oe.placement_id : null,
      today_minutes: r.today_minutes, first_started_at: r.first_started_at, last_ended_at: r.last_ended_at, late_minutes,
      week_status: r.week_status ?? 'open', week_locked: locked,
      actions: {
        clock_in: canAct && !oe && status !== 'time_off' && !locked,
        start_break: canAct && status === 'working' && !openWeekLocked,
        end_break: status === 'on_break' && !openWeekLocked,
        clock_out: (status === 'working' || status === 'on_break') && !openWeekLocked,
      },
    };
  }).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.worker_name.localeCompare(b.worker_name));
}

const bodySchema = z.object({ reason: z.string().trim().max(500).optional().nullable(), at: z.string().max(40).optional().nullable(), memo: z.string().trim().max(500).optional().nullable() });

/** Resolves an optional backdated timestamp: not in the future, at most 12 hours ago. */
function resolveAt(at: string | null | undefined): Date {
  if (!at) return new Date();
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) throw badRequest('Invalid time');
  if (d.getTime() > Date.now() + 60000) throw badRequest('Time cannot be in the future');
  if (d.getTime() < Date.now() - 12 * 3600 * 1000) throw badRequest('Time can be at most 12 hours ago — use a manual time request for older work');
  return d.getTime() > Date.now() ? new Date() : d;
}

async function weekLocked(placementId: string, workDate: string, db: any) {
  const t = await one<any>(`SELECT status FROM timesheets WHERE placement_id=$1 AND week_start=$2`, [placementId, weekStart(workDate)], db);
  if (t && ['approved', 'locked'].includes(t.status)) throw conflict(`This week's timesheet is already ${t.status} — clock actions are not allowed. Use a timesheet adjustment instead.`);
}

async function perform(ctx: Ctx, placementId: string, action: Action, b: z.infer<typeof bodySchema>, mode: 'on_behalf' | 'self') {
  const p = await placementFull(ctx.orgId, placementId);
  if (!p) throw notFound();
  const reason = (b.reason ?? '').trim();
  if (mode === 'on_behalf' && reason.length < 3) throw fieldErr({ reason: 'Give a reason (at least 3 characters)' });
  const at = resolveAt(b.at);
  const tz = p.timezone || 'America/New_York';

  const res = await tx(async c => {
    await c.query(`SELECT id FROM workers WHERE id=$1 FOR UPDATE`, [p.worker_id]);
    const open = await one<any>(`SELECT e.*, (SELECT row_to_json(x) FROM (SELECT id, started_at FROM breaks WHERE time_entry_id=e.id AND ended_at IS NULL LIMIT 1) x) open_break
      FROM time_entries e WHERE e.worker_id=$1 AND e.organization_id=$2 AND e.ended_at IS NULL ORDER BY e.started_at DESC LIMIT 1`, [p.worker_id, ctx.orgId], c);
    const before = { state: open ? (open.open_break ? 'on_break' : 'working') : 'offline', entry_id: open?.id ?? null };
    if (action === 'clock-in') {
      if (!['active', 'notice'].includes(p.status)) throw conflict(p.status === 'on_leave' ? `${p.worker_name} is on leave — clock-in is not allowed` : `This placement is ${String(p.status).replace('_', ' ')}`);
      if (open) {
        const other = open.placement_id !== p.id ? await one<any>(`SELECT co.name FROM placements pl JOIN companies co ON co.id=pl.company_id WHERE pl.id=$1`, [open.placement_id], c) : null;
        throw conflict(other ? `${p.worker_name} is already clocked in on another placement (${other.name}) — clock them out there first` : `${p.worker_name} is already clocked in`);
      }
      const wd = dateInTz(at, tz);
      const off = await one(`SELECT 1 FROM time_off_requests WHERE worker_id=$1 AND status='approved' AND $2::date BETWEEN start_date AND end_date`, [p.worker_id, wd], c);
      if (off) throw conflict(`${p.worker_name} has approved time off on this day`);
      await weekLocked(p.id, wd, c);
      const prevEnd = await one<any>(`SELECT max(ended_at) t FROM time_entries WHERE worker_id=$1 AND ended_at > $2`, [p.worker_id, at.toISOString()], c);
      if (prevEnd?.t) throw conflict('That start time overlaps an earlier session — pick a later time');
      const e = await one<any>(`INSERT INTO time_entries (organization_id, placement_id, worker_id, work_date, started_at, memo, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7) RETURNING *`,
        [ctx.orgId, p.id, p.worker_id, wd, at.toISOString(), b.memo || null, ctx.userId], c);
      await c.query(`INSERT INTO worker_presence (worker_id, organization_id, placement_id, time_entry_id, state, session_started_at, last_heartbeat_at, simulated, activity_pct, updated_at) VALUES ($1,$2,$3,$4,'working',$5,now(),false,NULL,now())
        ON CONFLICT (worker_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, placement_id=EXCLUDED.placement_id, time_entry_id=EXCLUDED.time_entry_id, state='working', session_started_at=EXCLUDED.session_started_at, last_heartbeat_at=now(), simulated=false, activity_pct=NULL, updated_at=now()`,
        [p.worker_id, ctx.orgId, p.id, e.id, at.toISOString()]);
      return { before, after: { state: 'working', entry_id: e.id, at: at.toISOString() }, entry: e, workDate: wd };
    }
    if (!open) throw conflict(`${p.worker_name} is not clocked in`);
    if (open.placement_id !== p.id) throw conflict(`${p.worker_name} is clocked in on another placement`);
    await weekLocked(p.id, open.work_date, c);
    const t = at < new Date(open.started_at) ? new Date(open.started_at) : at;
    if (action === 'start-break') {
      if (open.open_break) throw conflict(`${p.worker_name} is already on a break`);
      await c.query(`INSERT INTO breaks (organization_id, time_entry_id, started_at, created_by) VALUES ($1,$2,$3,$4)`, [ctx.orgId, open.id, t.toISOString(), ctx.userId]);
      await c.query(`UPDATE worker_presence SET state='on_break', last_heartbeat_at=now(), updated_at=now() WHERE worker_id=$1`, [p.worker_id]);
      return { before, after: { state: 'on_break', entry_id: open.id, at: t.toISOString() }, entry: open, workDate: open.work_date };
    }
    const closeBreak = async (end: Date) => {
      const bs = Math.max(0, Math.floor((end.getTime() - new Date(open.open_break.started_at).getTime()) / 1000));
      await c.query(`UPDATE breaks SET ended_at=$2, ended_by=$3 WHERE id=$1`, [open.open_break.id, new Date(Math.max(end.getTime(), new Date(open.open_break.started_at).getTime())).toISOString(), ctx.userId]);
      await c.query(`UPDATE time_entries SET break_seconds=break_seconds+$2 WHERE id=$1`, [open.id, bs]);
      return bs;
    };
    if (action === 'end-break') {
      if (!open.open_break) throw conflict(`${p.worker_name} is not on a break`);
      const bs = await closeBreak(t);
      await c.query(`UPDATE worker_presence SET state='working', last_heartbeat_at=now(), updated_at=now() WHERE worker_id=$1`, [p.worker_id]);
      return { before, after: { state: 'working', entry_id: open.id, at: t.toISOString(), break_seconds: bs }, entry: open, workDate: open.work_date };
    }
    // clock-out
    if (open.open_break) await closeBreak(t);
    const e = await one<any>(`UPDATE time_entries SET ended_at=$2, ended_by=$3, memo=COALESCE($4, memo) WHERE id=$1 RETURNING *, ${ENTRY_MIN('time_entries')} minutes`, [open.id, t.toISOString(), ctx.userId, b.memo || null], c);
    await c.query(`UPDATE worker_presence SET state='offline', time_entry_id=NULL, session_started_at=NULL, simulated=false, updated_at=now() WHERE worker_id=$1`, [p.worker_id]);
    return { before, after: { state: 'offline', entry_id: open.id, at: t.toISOString(), minutes: e.minutes }, entry: e, workDate: open.work_date };
  });

  if (action === 'clock-in') {
    const grace = (await getSetting<any>(ctx.orgId, 'time_tracking')).late_grace_minutes ?? 5;
    await recordLateIfNeeded(ctx.orgId, p, at, grace, emit).catch(() => null);
  }
  await rebuildTimesheet(ctx.orgId, p.id, weekStart(res.workDate));
  await broadcastPresence(ctx.orgId, p.worker_id);
  const when = fmtClock(new Date(res.after.at), tz);
  const tzShort = tz.split('/').pop()?.replace('_', ' ');
  const backdated = Math.abs(Date.now() - new Date(res.after.at).getTime()) > 120000;
  const verb = ACTION_TEXT[action];
  const title = mode === 'self' ? `${p.worker_name} ${action === 'clock-in' ? 'clocked in' : action === 'clock-out' ? 'clocked out' : action === 'start-break' ? 'started a break' : 'ended a break'} from the staff console`
    : action === 'clock-in' || action === 'clock-out' ? `${ctx.user.name} ${verb.done} ${p.worker_name} on their behalf` : `${ctx.user.name} ${verb.done} ${p.worker_name}`;
  const body = `${backdated ? `Effective ${when} (${tzShort})` : `At ${when} (${tzShort})`}${'minutes' in res.after ? ` · session ${Math.floor(Number(res.after.minutes) / 60)}h ${String(Number(res.after.minutes) % 60).padStart(2, '0')}m` : ''}${reason ? ` — Reason: ${reason}` : ''}`;
  await activity(ctx, 'placement', p.id, 'system', title, body, { action, mode, time_entry_id: res.after.entry_id, at: res.after.at, reason: reason || null, source: 'manual' });
  if (mode === 'on_behalf') {
    await audit(ctx, 'time.clocked_on_behalf', { type: 'placement', id: p.id, label: `${p.worker_name} — ${p.company_name}` }, res.before, { ...res.after, action }, reason);
    if (p.worker_user_id && p.worker_user_id !== ctx.userId) {
      await notify(ctx.orgId, [p.worker_user_id], { event: 'time.clocked_on_behalf', title: `${ctx.user.name} ${verb.you}`, body: `${p.title} at ${p.company_name} · ${when} (${tzShort}) — ${reason}`, link: '/portal/worker/tracker' });
    }
  }
  return { ok: true, action, ...res.after };
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/time/clock/today', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'view');
    const { company_id, status } = req.query as Record<string, string>;
    if (company_id) await getOr404('companies', ctx, company_id);
    const all = await clockRows(ctx, { companyId: company_id || null });
    const counts: Record<string, number> = Object.fromEntries(Object.keys(CLOCK_LABEL).map(k => [k, 0]));
    for (const r of all) counts[r.status]++;
    const rows = status ? all.filter(r => status.split(',').includes(r.status)) : all;
    const companies = await q<any>(`SELECT DISTINCT co.id, co.name FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.organization_id=$1 AND p.status IN ('active','notice','on_leave') ORDER BY co.name`, [ctx.orgId]);
    const scheduled = all.filter(r => r.scheduled && r.status !== 'time_off').length;
    const clockedToday = all.filter(r => r.scheduled && (r.today_minutes > 0 || ['working', 'on_break', 'clocked_out'].includes(r.status))).length;
    return {
      rows, total: rows.length, counts, companies, as_of: new Date().toISOString(), can_edit: can(ctx, 'time', 'edit'),
      summary: { placements: all.length, scheduled_today: scheduled, clocked_in_now: counts.working + counts.on_break, clocked_today: clockedToday, late: counts.late, missed: counts.absent, not_clocked_in: counts.not_clocked_in + counts.late + counts.absent, minutes_today: all.reduce((a, r) => a + r.today_minutes, 0), on_behalf_today: (await one<any>(`SELECT count(*)::int n FROM audit_events WHERE organization_id=$1 AND action='time.clocked_on_behalf' AND created_at >= now() - interval '24 hours'`, [ctx.orgId]))?.n ?? 0 },
    };
  });

  app.post('/api/v1/time/clock/:placementId/:action', async (req) => {
    const ctx = staff(req);
    const { placementId, action } = req.params as { placementId: string; action: string };
    if (!['clock-in', 'start-break', 'end-break', 'clock-out'].includes(action)) throw notFound();
    need(ctx, 'time', 'edit');
    const pl = await getOr404<any>('placements', ctx, placementId);
    const b = bodySchema.parse(req.body ?? {});
    const r = await perform(ctx, placementId, action as Action, b, 'on_behalf');
    const row = (await clockRows(ctx, { workerIds: [pl.worker_id] })).find(x => x.placement_id === placementId);
    return { ...r, row: row ?? null };
  });

  // ── My clock (staff member who is also a worker in this org) ──
  app.get('/api/v1/time/clock/me', async (req) => {
    const ctx = staff(req);
    const ids = await myWorkerIds(ctx);
    if (!ids.length) return { is_worker: false, rows: [] };
    const rows = await clockRows(ctx, { workerIds: ids });
    const portal = await one(`SELECT 1 FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=$1 AND m.status='active' AND r.kind='worker' AND m.worker_id = ANY($2)`, [ctx.userId, ids]);
    return { is_worker: true, rows, tracker_link: portal ? '/portal/worker/tracker' : null };
  });
  app.post('/api/v1/time/clock/me/:placementId/:action', async (req) => {
    const ctx = staff(req);
    const { placementId, action } = req.params as { placementId: string; action: string };
    if (!['clock-in', 'start-break', 'end-break', 'clock-out'].includes(action)) throw notFound();
    const pl = await getOr404<any>('placements', ctx, placementId);
    const ids = await myWorkerIds(ctx);
    if (!ids.includes(pl.worker_id)) throw notFound();
    const b = bodySchema.parse(req.body ?? {});
    const r = await perform(ctx, placementId, action as Action, b, 'self');
    const row = (await clockRows(ctx, { workerIds: [pl.worker_id] })).find(x => x.placement_id === placementId);
    return { ...r, row: row ?? null };
  });
}
