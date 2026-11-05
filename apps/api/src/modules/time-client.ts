// Client Portal (WORKFORCE+TIME): Home, My Team (live status), Worker detail (schedule, timesheets,
// screenshots if the policy + company allow), Timesheet approval. Everything is scoped to ctx.companyId.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { weekStart, todayUtc } from '@veyro/shared';
import { q, one } from '../core/db';
import { auth, type Ctx } from '../core/context';
import { forbidden, notFound } from '../core/errors';
import { listParams, paged } from '../core/list';
import { WNAME, ENTRY_MIN, todayIn, hhmm } from './_wf/lib';
import { liveRows, dayTimeline } from './time-manager';
import { timesheetDetail, approveTimesheet, rejectTimesheet } from './_wf/timesheets';

function client(req: FastifyRequest): Ctx & { companyId: string } {
  const ctx = auth(req);
  if (ctx.role.kind !== 'client' || !ctx.companyId) throw notFound();
  return ctx as Ctx & { companyId: string };
}
const APPROVER_ROLES = ['client_owner', 'client_manager', 'client_supervisor'];
const uuidRe = /^[0-9a-f-]{36}$/i;

export default async function (app: FastifyInstance) {
  const P = '/api/v1/portal/client';
  const company = (ctx: Ctx & { companyId: string }) => one<any>(`SELECT id, name, timesheet_approval, portal_screenshots FROM companies WHERE id=$1 AND organization_id=$2`, [ctx.companyId, ctx.orgId]);
  const safeRow = (r: any) => ({ ...r, latest_shot: r.client_can_view_shots ? r.latest_shot : null, account_manager_name: undefined, country: r.country });

  app.get(`${P}/home`, async (req) => {
    const ctx = client(req);
    const co = await company(ctx);
    const team = (await liveRows(ctx.orgId, { companyId: ctx.companyId })).map(safeRow);
    const counts: Record<string, number> = {};
    for (const r of team) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const wk = weekStart(todayUtc());
    const hours = await one<any>(`SELECT COALESCE(sum(${ENTRY_MIN()}) FILTER (WHERE e.work_date >= $3::date),0)::int this_week, COALESCE(sum(${ENTRY_MIN()}) FILTER (WHERE e.work_date >= $3::date - 7 AND e.work_date < $3::date),0)::int last_week
      FROM time_entries e JOIN placements p ON p.id=e.placement_id WHERE p.company_id=$1 AND e.organization_id=$2 AND e.work_date >= $3::date - 7`, [ctx.companyId, ctx.orgId, wk]);
    const daily = await q<any>(`SELECT to_char(d, 'Dy') label, d::date::text AS day, COALESCE((SELECT sum(${ENTRY_MIN()}) FROM time_entries e JOIN placements p ON p.id=e.placement_id WHERE p.company_id=$1 AND e.work_date=d::date),0)::int value FROM generate_series($2::date, $2::date + 6, interval '1 day') d ORDER BY d`, [ctx.companyId, wk]);
    const ts = await one<any>(`SELECT count(*) FILTER (WHERE status='submitted' AND client_approved_at IS NULL)::int awaiting, COALESCE(sum(total_minutes) FILTER (WHERE status IN ('approved','locked') AND approved_at >= date_trunc('month', now())),0)::int approved_minutes_month FROM timesheets WHERE company_id=$1 AND organization_id=$2`, [ctx.companyId, ctx.orgId]);
    const am = await one<any>(`SELECT u.name, u.email, u.phone FROM companies c JOIN users u ON u.id=c.account_manager_id WHERE c.id=$1`, [ctx.companyId]);
    return { company: co, team, counts, hours, daily, timesheets: { ...ts, needs_client_approval: co.timesheet_approval !== 'agency' }, account_manager: am, can_approve: APPROVER_ROLES.includes(ctx.role.key) };
  });

  app.get(`${P}/team`, async (req) => {
    const ctx = client(req);
    const co = await company(ctx);
    const wk = weekStart(todayUtc());
    const rows = (await liveRows(ctx.orgId, { companyId: ctx.companyId })).map(safeRow);
    const week = await q<any>(`SELECT e.worker_id, COALESCE(sum(${ENTRY_MIN()}),0)::int m FROM time_entries e JOIN placements p ON p.id=e.placement_id WHERE p.company_id=$1 AND e.work_date >= $2::date GROUP BY 1`, [ctx.companyId, wk]);
    const past = await q<any>(`SELECT p.worker_id id, ${WNAME} worker_name, p.title, p.end_date, cd.avatar_color FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id WHERE p.company_id=$1 AND p.organization_id=$2 AND p.status='ended' ORDER BY p.end_date DESC LIMIT 20`, [ctx.companyId, ctx.orgId]);
    const onboarding = await q<any>(`SELECT p.worker_id id, ${WNAME} worker_name, p.title, p.start_date, cd.avatar_color FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id WHERE p.company_id=$1 AND p.organization_id=$2 AND p.status='onboarding' ORDER BY p.start_date`, [ctx.companyId, ctx.orgId]);
    return { company: co, rows: rows.map(r => ({ ...r, week_minutes: week.find(w => w.worker_id === r.worker_id)?.m ?? 0 })), onboarding, past };
  });

  app.get(`${P}/team/:workerId`, async (req) => {
    const ctx = client(req);
    const { workerId } = req.params as { workerId: string };
    if (!uuidRe.test(workerId)) throw notFound();
    const pls = await q<any>(`SELECT p.id, p.title, p.status, p.start_date, p.end_date, p.timezone, p.schedule_days, p.schedule_start::text, p.schedule_end::text, p.weekly_hours, mp.client_can_view, mp.screenshots_enabled, mp.screenshot_interval_min, mp.blur
      FROM placements p LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id WHERE p.worker_id=$1 AND p.company_id=$2 AND p.organization_id=$3 ORDER BY p.start_date DESC`, [workerId, ctx.companyId, ctx.orgId]);
    if (!pls.length) throw notFound();
    const co = await company(ctx);
    const w = await one<any>(`SELECT w.id, ${WNAME} name, cd.avatar_color, cd.headline, cd.country, cd.timezone, cd.skills FROM workers w JOIN candidates cd ON cd.id=w.candidate_id WHERE w.id=$1`, [workerId]);
    const live = (await liveRows(ctx.orgId, { companyId: ctx.companyId, workerId }))[0] ?? null;
    const canShots = !!co.portal_screenshots && pls.every(p => p.client_can_view) && pls.some(p => p.screenshots_enabled);
    const { date } = req.query as { date?: string };
    const tz = pls[0].timezone;
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayIn(tz);
    const timeline = await dayTimeline(ctx.orgId, workerId, day, { includeShots: canShots, placementIds: pls.map(p => p.id) });
    const timesheets = await q<any>(`SELECT id, week_start, status, total_minutes, submitted_at, approved_at, client_approved_at, rejected_reason FROM timesheets WHERE worker_id=$1 AND company_id=$2 ORDER BY week_start DESC LIMIT 12`, [workerId, ctx.companyId]);
    const weekly = await q<any>(`SELECT to_char(wk, 'Mon DD') label, COALESCE((SELECT sum(${ENTRY_MIN()}) FROM time_entries e WHERE e.worker_id=$1 AND e.placement_id = ANY($2) AND e.work_date >= wk::date AND e.work_date < wk::date + 7),0)::int value
      FROM generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') wk ORDER BY wk`, [workerId, pls.map(p => p.id)]);
    const timeOff = await q<any>(`SELECT kind, start_date, end_date, status FROM time_off_requests WHERE worker_id=$1 AND status='approved' AND end_date >= CURRENT_DATE ORDER BY start_date LIMIT 5`, [workerId]);
    return {
      worker: w, placements: pls.map(p => ({ ...p, schedule_start: hhmm(p.schedule_start), schedule_end: hhmm(p.schedule_end) })), live: live ? safeRow(live) : null,
      screenshots_allowed: canShots, screenshot_reason: canShots ? null : !co.portal_screenshots ? 'Your agency has not enabled screenshots in the client portal.' : 'The monitoring policy for this placement does not share screenshots with clients.',
      timeline: { ...timeline, shots: canShots ? timeline.shots : [], blocks: timeline.blocks.map((b: any) => ({ ...b, shots: canShots ? b.shots : [] })) }, timesheets, weekly, time_off: timeOff,
    };
  });

  app.get(`${P}/timesheets`, async (req) => {
    const ctx = client(req);
    const lp = listParams(req);
    const where = ['t.organization_id=$1', 't.company_id=$2']; const params: unknown[] = [ctx.orgId, ctx.companyId];
    if (lp.filters.status) { params.push(lp.filters.status.split(',')); where.push(`t.status = ANY($${params.length})`); }
    if (lp.filters.awaiting === 'true') where.push(`t.status='submitted' AND t.client_approved_at IS NULL`);
    if (lp.filters.worker_id) { params.push(lp.filters.worker_id); where.push(`t.worker_id=$${params.length}`); }
    return paged({ select: `t.id, t.week_start, t.status, t.total_minutes, t.submitted_at, t.approved_at, t.client_approved_at, t.agency_approved_at, t.rejected_reason, t.worker_id, ${WNAME} worker_name, cd.avatar_color, p.title`,
      from: 'timesheets t JOIN placements p ON p.id=t.placement_id JOIN workers w ON w.id=t.worker_id JOIN candidates cd ON cd.id=w.candidate_id',
      where, params, lp, searchCols: ['cd.first_name', 'cd.last_name', 'p.title'], sortMap: { week_start: 't.week_start', total_minutes: 't.total_minutes', worker_name: 'cd.first_name', status: 't.status' }, defaultSort: `CASE WHEN t.status='submitted' THEN 0 ELSE 1 END, t.week_start DESC` });
  });
  const myTimesheet = async (ctx: Ctx & { companyId: string }, id: string) => {
    if (!uuidRe.test(id)) throw notFound();
    const t = await one<any>(`SELECT id FROM timesheets WHERE id=$1 AND company_id=$2 AND organization_id=$3`, [id, ctx.companyId, ctx.orgId]);
    if (!t) throw notFound();
  };
  app.get(`${P}/timesheets/:id`, async (req) => {
    const ctx = client(req);
    const { id } = req.params as { id: string };
    await myTimesheet(ctx, id);
    const t: any = await timesheetDetail(ctx.orgId, id);
    return { ...t, account_manager_id: undefined, agency_approved_by: undefined, client_approved_by: undefined, can_approve: APPROVER_ROLES.includes(ctx.role.key) && t.status === 'submitted' && !t.client_approved_at && t.timesheet_approval !== 'agency' };
  });
  app.post(`${P}/timesheets/:id/approve`, async (req) => {
    const ctx = client(req);
    const { id } = req.params as { id: string };
    await myTimesheet(ctx, id);
    if (!APPROVER_ROLES.includes(ctx.role.key)) throw forbidden(`Your portal role (${ctx.role.name}) cannot approve timesheets`);
    return approveTimesheet(ctx, id, 'client');
  });
  app.post(`${P}/timesheets/:id/reject`, async (req) => {
    const ctx = client(req);
    const { id } = req.params as { id: string };
    await myTimesheet(ctx, id);
    if (!APPROVER_ROLES.includes(ctx.role.key)) throw forbidden(`Your portal role (${ctx.role.name}) cannot reject timesheets`);
    const b = z.object({ reason: z.string().min(3, 'Tell your agency what needs to change').max(1000) }).parse(req.body);
    return rejectTimesheet(ctx, id, 'client', b.reason);
  });
}
