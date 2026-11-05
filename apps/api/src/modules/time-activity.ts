// TIME: Apps & Activity — which apps / URLs the team spends tracked time in (per client / worker / date range),
// activity % trend, productive vs idle split. Uses keyboard/mouse COUNTS and app/URL labels only — never content.
// App time = activity_samples.active_seconds grouped by app_label. URL time = screenshots.url_label weighted by
// the estimated active seconds each capture represents (policy interval × capture activity %).
import type { FastifyInstance } from 'fastify';
import { addDays } from '@veyro/shared';
import { q, one } from '../core/db';
import { staff, need, getOr404, type Ctx } from '../core/context';
import { badRequest } from '../core/errors';
import { WNAME, ENTRY_MIN } from './_wf/lib';
import { orgToday } from './time-manager';

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

interface Scope { from: string; to: string; companyId: string | null; workerId: string | null }

async function readScope(ctx: Ctx, qs: Record<string, string>): Promise<Scope> {
  const today = await orgToday(ctx.orgId);
  const to = qs.to && dateRe.test(qs.to) ? qs.to : today;
  const from = qs.from && dateRe.test(qs.from) ? qs.from : addDays(to, -13);
  if (from > to) throw badRequest('Start date must be before end date');
  if (daysBetween(from, to) > 366) throw badRequest('Choose a range of at most one year');
  if (qs.company_id) await getOr404('companies', ctx, qs.company_id);
  if (qs.worker_id) await getOr404('workers', ctx, qs.worker_id);
  return { from, to, companyId: qs.company_id || null, workerId: qs.worker_id || null };
}

/** WHERE fragment over activity_samples a / placements p for a scope (dates are placement-local work dates). */
function sampleWhere(ctx: Ctx, s: Scope, from = s.from, to = s.to) {
  const params: unknown[] = [ctx.orgId, from, to];
  const where = [`a.organization_id=$1`, `a.bucket_start >= ($2::date - 1)::timestamptz`, `a.bucket_start < ($3::date + 2)::timestamptz`, `(a.bucket_start AT TIME ZONE p.timezone)::date BETWEEN $2::date AND $3::date`];
  if (s.companyId) { params.push(s.companyId); where.push(`p.company_id=$${params.length}`); }
  if (s.workerId) { params.push(s.workerId); where.push(`a.worker_id=$${params.length}`); }
  return { params, sql: where.join(' AND ') };
}
function shotWhere(ctx: Ctx, s: Scope) {
  const params: unknown[] = [ctx.orgId, s.from, s.to];
  const where = [`s.organization_id=$1`, `s.deleted_at IS NULL`, `s.taken_at >= ($2::date - 1)::timestamptz`, `s.taken_at < ($3::date + 2)::timestamptz`, `(s.taken_at AT TIME ZONE p.timezone)::date BETWEEN $2::date AND $3::date`];
  if (s.companyId) { params.push(s.companyId); where.push(`p.company_id=$${params.length}`); }
  if (s.workerId) { params.push(s.workerId); where.push(`s.worker_id=$${params.length}`); }
  return { params, sql: where.join(' AND ') };
}
const SHOT_WEIGHT = `(COALESCE(mp.screenshot_interval_min, 10) * 60 * COALESCE(s.activity_pct, 0) / 100.0)`;
const APP = `COALESCE(NULLIF(a.app_label, ''), 'Unlabelled')`;
const min = (sec: number | null | undefined) => Math.round((Number(sec) || 0) / 60);

export default async function (app: FastifyInstance) {
  app.get('/api/v1/time/activity/overview', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'view');
    const s = await readScope(ctx, req.query as Record<string, string>);
    const w = sampleWhere(ctx, s);
    const FROM = `activity_samples a JOIN placements p ON p.id=a.placement_id`;
    const len = daysBetween(s.from, s.to) + 1;
    const pw = sampleWhere(ctx, s, addDays(s.from, -len), addDays(s.from, -1));

    const ep: unknown[] = [ctx.orgId, s.from, s.to]; const ex: string[] = [];
    if (s.companyId) { ep.push(s.companyId); ex.push(`p.company_id=$${ep.length}`); }
    if (s.workerId) { ep.push(s.workerId); ex.push(`e.worker_id=$${ep.length}`); }
    const sw = shotWhere(ctx, s);

    const [tot, prev, trend, apps, workers, entries, urls] = await Promise.all([
      one<any>(`SELECT COALESCE(sum(a.active_seconds),0)::bigint active, COALESCE(sum(a.idle_seconds),0)::bigint idle, COALESCE(sum(a.bucket_seconds),0)::bigint total,
          COALESCE(sum(a.key_count),0)::bigint keys, COALESCE(sum(a.mouse_count),0)::bigint mouse, count(DISTINCT a.worker_id)::int workers FROM ${FROM} WHERE ${w.sql}`, w.params),
      one<any>(`SELECT round(sum(a.active_seconds)::numeric*100/NULLIF(sum(a.bucket_seconds),0))::int pct FROM ${FROM} WHERE ${pw.sql}`, pw.params),
      q<any>(`WITH d AS (SELECT gs::date dd FROM generate_series($2::date, $3::date, interval '1 day') gs),
          x AS (SELECT (a.bucket_start AT TIME ZONE p.timezone)::date dd, sum(a.active_seconds) act, sum(a.idle_seconds) idl, sum(a.bucket_seconds) tot FROM ${FROM} WHERE ${w.sql} GROUP BY 1)
        SELECT d.dd::text AS day, to_char(d.dd, 'Mon DD') label, CASE WHEN x.tot > 0 THEN round(x.act::numeric*100/x.tot)::int ELSE 0 END value,
          COALESCE(round(x.act/60.0),0)::int active_minutes, COALESCE(round(x.idl/60.0),0)::int idle_minutes, (x.tot IS NOT NULL) has_data FROM d LEFT JOIN x ON x.dd=d.dd ORDER BY d.dd`, w.params),
      q<any>(`SELECT ${APP} label, sum(a.active_seconds)::bigint active, sum(a.bucket_seconds)::bigint total, sum(a.idle_seconds)::bigint idle, count(DISTINCT a.worker_id)::int workers
        FROM ${FROM} WHERE ${w.sql} GROUP BY 1 ORDER BY 2 DESC`, w.params),
      q<any>(`WITH x AS (SELECT a.worker_id, ${APP} app, sum(a.active_seconds) act, sum(a.idle_seconds) idl, sum(a.bucket_seconds) tot, sum(a.key_count) keys, sum(a.mouse_count) mouse,
            max((a.bucket_start AT TIME ZONE p.timezone)::date) last_day FROM ${FROM} WHERE ${w.sql} GROUP BY 1, 2)
        SELECT x.worker_id, ${WNAME} name, cd.avatar_color, sum(x.act)::bigint active, sum(x.idl)::bigint idle, sum(x.tot)::bigint total, sum(x.keys)::bigint keys, sum(x.mouse)::bigint mouse, max(x.last_day)::text last_day,
            (array_agg(x.app ORDER BY x.act DESC))[1] top_app,
            (SELECT string_agg(DISTINCT co.name, ', ') FROM placements pp JOIN companies co ON co.id=pp.company_id WHERE pp.worker_id=x.worker_id AND pp.organization_id=$1) company_names
          FROM x JOIN workers wk ON wk.id=x.worker_id JOIN candidates cd ON cd.id=wk.candidate_id GROUP BY x.worker_id, cd.first_name, cd.last_name, cd.avatar_color ORDER BY 4 DESC`, w.params),
      one<any>(`SELECT COALESCE(sum(${ENTRY_MIN()}),0)::int minutes, COALESCE(sum(e.break_seconds),0)::bigint breaks, COALESCE(sum(e.discarded_idle_seconds),0)::bigint discarded, count(*)::int sessions
        FROM time_entries e JOIN placements p ON p.id=e.placement_id WHERE e.organization_id=$1 AND e.work_date BETWEEN $2 AND $3 ${ex.length ? 'AND ' + ex.join(' AND ') : ''}`, ep),
      q<any>(`SELECT COALESCE(NULLIF(s.url_label,''), '(no URL)') label, COALESCE(NULLIF(s.app_label,''), 'Unlabelled') app_label, count(*)::int shots, round(sum(${SHOT_WEIGHT}))::bigint weight, count(DISTINCT s.worker_id)::int workers
        FROM screenshots s JOIN placements p ON p.id=s.placement_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id WHERE ${sw.sql} GROUP BY 1, 2 ORDER BY 4 DESC, 3 DESC LIMIT 25`, sw.params),
    ]);
    const active = Number(tot.active), total = Number(tot.total), idle = Number(tot.idle);
    const avg = total ? Math.round((active * 100) / total) : null;
    const appRows = apps.map(r => ({ label: r.label, active_minutes: min(r.active), idle_minutes: min(r.idle), total_minutes: min(r.total), share_pct: active ? Math.round((Number(r.active) * 1000) / active) / 10 : 0, activity_pct: Number(r.total) ? Math.round((Number(r.active) * 100) / Number(r.total)) : null, workers: r.workers }));
    const urlTotal = urls.reduce((a, u) => a + Number(u.weight), 0);
    const [companies, workerOpts] = await Promise.all([
      q<any>(`SELECT DISTINCT co.id, co.name FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.organization_id=$1 AND p.status <> 'cancelled' ORDER BY co.name`, [ctx.orgId]),
      q<any>(`SELECT DISTINCT w.id, ${WNAME} name FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id WHERE p.organization_id=$1 ${s.companyId ? 'AND p.company_id=$2' : ''} ORDER BY 2`, s.companyId ? [ctx.orgId, s.companyId] : [ctx.orgId]),
    ]);
    return {
      range: { from: s.from, to: s.to, days: len },
      filters: { companies, workers: workerOpts },
      kpis: {
        avg_activity: avg, prev_avg_activity: prev?.pct ?? null, active_minutes: min(active), idle_minutes: min(idle), monitored_minutes: min(total),
        tracked_minutes: entries.minutes, sessions: entries.sessions, keys: Number(tot.keys), mouse: Number(tot.mouse), workers: tot.workers,
        top_app: appRows[0] ? { label: appRows[0].label, minutes: appRows[0].active_minutes, share_pct: appRows[0].share_pct } : null,
      },
      split: { active_minutes: min(active), idle_minutes: min(idle), break_minutes: min(entries.breaks), discarded_idle_minutes: min(entries.discarded) },
      trend: trend.map(t => ({ day: t.day, label: t.label, value: t.value, active_minutes: t.active_minutes, idle_minutes: t.idle_minutes, has_data: t.has_data })),
      apps: appRows,
      urls: urls.map(u => ({ label: u.label, app_label: u.app_label, shots: u.shots, est_minutes: min(u.weight), share_pct: urlTotal ? Math.round((Number(u.weight) * 1000) / urlTotal) / 10 : 0, workers: u.workers })),
      workers: workers.map(r => ({ worker_id: r.worker_id, name: r.name, avatar_color: r.avatar_color, company_names: r.company_names ?? null, active_minutes: min(r.active), idle_minutes: min(r.idle), activity_pct: Number(r.total) ? Math.round((Number(r.active) * 100) / Number(r.total)) : null, keys: Number(r.keys), mouse: Number(r.mouse), top_app: r.top_app, last_day: r.last_day })),
    };
  });

  // Drill-down: who uses one app (and which URLs inside it) in the scope.
  app.get('/api/v1/time/activity/app', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'view');
    const qs = req.query as Record<string, string>;
    const label = (qs.app ?? '').trim();
    if (!label) throw badRequest('Choose an app');
    if (label.length > 200) throw badRequest('App label is too long');
    const s = await readScope(ctx, qs);
    const w = sampleWhere(ctx, s);
    w.params.push(label); const li = w.params.length;
    const sw = shotWhere(ctx, s);
    sw.params.push(label); const si = sw.params.length;
    const [workers, urls] = await Promise.all([
      q<any>(`WITH x AS (SELECT a.worker_id, sum(a.active_seconds) FILTER (WHERE ${APP}=$${li}) app_act, sum(a.bucket_seconds) FILTER (WHERE ${APP}=$${li}) app_tot, sum(a.active_seconds) all_act,
            max((a.bucket_start AT TIME ZONE p.timezone)::date) FILTER (WHERE ${APP}=$${li}) last_day, sum(a.key_count) FILTER (WHERE ${APP}=$${li}) keys, sum(a.mouse_count) FILTER (WHERE ${APP}=$${li}) mouse
            FROM activity_samples a JOIN placements p ON p.id=a.placement_id WHERE ${w.sql} GROUP BY 1)
        SELECT x.*, ${WNAME} name, cd.avatar_color, (SELECT string_agg(DISTINCT co.name, ', ') FROM placements pp JOIN companies co ON co.id=pp.company_id WHERE pp.worker_id=x.worker_id AND pp.organization_id=$1) company_names
          FROM x JOIN workers wk ON wk.id=x.worker_id JOIN candidates cd ON cd.id=wk.candidate_id WHERE x.app_act IS NOT NULL ORDER BY x.app_act DESC`, w.params),
      q<any>(`SELECT COALESCE(NULLIF(s.url_label,''), '(no URL)') label, count(*)::int shots, round(sum(${SHOT_WEIGHT}))::bigint weight
        FROM screenshots s JOIN placements p ON p.id=s.placement_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id WHERE ${sw.sql} AND COALESCE(NULLIF(s.app_label,''), 'Unlabelled')=$${si} GROUP BY 1 ORDER BY 3 DESC LIMIT 15`, sw.params),
    ]);
    const total = workers.reduce((a, r) => a + Number(r.app_act), 0);
    return {
      app: label, range: { from: s.from, to: s.to }, active_minutes: min(total),
      workers: workers.map(r => ({ worker_id: r.worker_id, name: r.name, avatar_color: r.avatar_color, company_names: r.company_names ?? null, active_minutes: min(r.app_act),
        share_of_worker_pct: Number(r.all_act) ? Math.round((Number(r.app_act) * 100) / Number(r.all_act)) : 0, activity_pct: Number(r.app_tot) ? Math.round((Number(r.app_act) * 100) / Number(r.app_tot)) : null, keys: Number(r.keys ?? 0), mouse: Number(r.mouse ?? 0), last_day: r.last_day ? String(r.last_day).slice(0, 10) : null })),
      urls: urls.map(u => ({ label: u.label, shots: u.shots, est_minutes: min(u.weight) })),
    };
  });
}
