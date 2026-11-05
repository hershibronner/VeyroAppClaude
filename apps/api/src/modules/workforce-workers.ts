// WORKFORCE: worker directory (All Workers + status filters), Worker 360, worker status, issues.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { weekStart, todayUtc } from '@veyro/shared';
import { q, one } from '../core/db';
import { staff, need, can, canViewComp, getOr404, redact } from '../core/context';
import { conflict } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { signedUrl } from '../core/storage';
import { WNAME, ENTRY_MIN, placementFull, eventPayload } from './_wf/lib';

export default async function (app: FastifyInstance) {
  const CUR = `(SELECT p.id FROM placements p WHERE p.worker_id=w.id ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'notice' THEN 1 WHEN 'on_leave' THEN 2 WHEN 'onboarding' THEN 3 ELSE 4 END, p.start_date DESC LIMIT 1)`;
  app.get('/api/v1/workers', async (req) => {
    const ctx = staff(req); need(ctx, 'workers', 'view');
    const lp = listParams(req);
    const where = ['w.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    const f = lp.filters;
    if (f.status) { params.push(f.status.split(',')); where.push(`w.status = ANY($${params.length})`); }
    if (f.company_id) { params.push(f.company_id); where.push(`EXISTS (SELECT 1 FROM placements p WHERE p.worker_id=w.id AND p.company_id=$${params.length} AND p.status <> 'ended')`); }
    if (f.country) { params.push(f.country); where.push(`cd.country=$${params.length}`); }
    if (f.portal === 'true') where.push('w.user_id IS NOT NULL'); else if (f.portal === 'false') where.push('w.user_id IS NULL');
    if (f.account_manager_id) { params.push(f.account_manager_id); where.push(`cp.account_manager_id=$${params.length}`); }
    if (f.live === 'true') where.push(`wp.state IN ('working','idle','on_break')`);
    return paged({
      select: `w.id, w.status, w.employee_code, w.created_at, w.user_id IS NOT NULL has_portal, ${WNAME} name, cd.email, cd.country, cd.city, cd.headline, cd.avatar_color, cd.id candidate_id,
        cp.id placement_id, cp.title placement_title, cp.status placement_status, cp.start_date, co.name company_name, am.name account_manager_name, COALESCE(wp.state,'offline') live_state,
        (SELECT count(*)::int FROM placements p WHERE p.worker_id=w.id) placements_count,
        (SELECT COALESCE(sum(${ENTRY_MIN()}),0)::int FROM time_entries e WHERE e.worker_id=w.id AND e.work_date >= date_trunc('week', CURRENT_DATE)::date) week_minutes`,
      from: `workers w JOIN candidates cd ON cd.id=w.candidate_id LEFT JOIN placements cp ON cp.id=${CUR} LEFT JOIN companies co ON co.id=cp.company_id LEFT JOIN users am ON am.id=cp.account_manager_id LEFT JOIN worker_presence wp ON wp.worker_id=w.id`,
      where, params, lp, searchCols: ['cd.first_name', 'cd.last_name', 'cd.email', 'co.name', 'w.employee_code', 'cp.title'],
      sortMap: { name: 'cd.first_name', status: 'w.status', company_name: 'co.name', start_date: 'cp.start_date', created_at: 'w.created_at', week_minutes: '(SELECT COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(e.ended_at, now()) - e.started_at))),0) FROM time_entries e WHERE e.worker_id=w.id AND e.work_date >= date_trunc(\'week\', CURRENT_DATE)::date)' },
      defaultSort: `CASE w.status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'on_leave' THEN 2 WHEN 'available' THEN 3 ELSE 4 END, cd.first_name`,
    });
  });

  app.get('/api/v1/workers/summary', async (req) => {
    const ctx = staff(req); need(ctx, 'workers', 'view');
    const s = await one<any>(`SELECT count(*)::int total, count(*) FILTER (WHERE status='active')::int active, count(*) FILTER (WHERE status='pending')::int pending, count(*) FILTER (WHERE status='available')::int available,
      count(*) FILTER (WHERE status='on_leave')::int on_leave, count(*) FILTER (WHERE status='inactive')::int inactive, count(*) FILTER (WHERE user_id IS NOT NULL)::int with_portal,
      count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int new_this_month, count(*) FILTER (WHERE created_at >= date_trunc('month', now()) - interval '1 month' AND created_at < date_trunc('month', now()))::int new_last_month
      FROM workers WHERE organization_id=$1`, [ctx.orgId]);
    const live = await one<any>(`SELECT count(*) FILTER (WHERE state IN ('working','idle','on_break'))::int live FROM worker_presence WHERE organization_id=$1`, [ctx.orgId]);
    const hours = await one<any>(`SELECT COALESCE(sum(${ENTRY_MIN()}) FILTER (WHERE e.work_date >= $2::date),0)::int this_week, COALESCE(sum(${ENTRY_MIN()}) FILTER (WHERE e.work_date >= $2::date - 7 AND e.work_date < $2::date AND e.work_date <= CURRENT_DATE - 7),0)::int last_week_same
      FROM time_entries e WHERE e.organization_id=$1 AND e.work_date >= $2::date - 7`, [ctx.orgId, weekStart(todayUtc())]);
    const byCountry = await q<any>(`SELECT COALESCE(cd.country,'—') label, count(*)::int value FROM workers w JOIN candidates cd ON cd.id=w.candidate_id WHERE w.organization_id=$1 AND w.status IN ('active','on_leave','pending') GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [ctx.orgId]);
    const hoursTrend = await q<any>(`SELECT to_char(wk, 'Mon DD') label, wk::date::text AS week, COALESCE((SELECT sum(${ENTRY_MIN()}) FROM time_entries e WHERE e.organization_id=$1 AND e.work_date >= wk::date AND e.work_date < wk::date + 7),0)::int value
      FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') wk ORDER BY wk`, [ctx.orgId]);
    return { ...s, ...live, hours, byCountry, hoursTrend };
  });

  // ── Worker 360 ──
  app.get('/api/v1/workers/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'workers', 'view');
    const { id } = req.params as { id: string };
    await getOr404('workers', ctx, id);
    const w = await one<any>(`SELECT w.*, cd.first_name, cd.last_name, ${WNAME} name, cd.email, cd.phone, cd.country, cd.city, cd.timezone, cd.headline, cd.years_experience, cd.skills, cd.software, cd.languages, cd.avatar_color, cd.rate_min_cents, cd.rate_target_cents, cd.rate_currency, cd.rate_unit, cd.source, cd.created_at candidate_created_at
      FROM workers w JOIN candidates cd ON cd.id=w.candidate_id WHERE w.id=$1`, [id]);
    const viewComp = canViewComp(ctx);
    const [placements, applications, submissions, interviews, offers, onboarding, docs, presence, shots, timesheets, issues, timeOff, attendance, pay, invite] = await Promise.all([
      q<any>(`SELECT p.id, p.title, p.status, p.start_date, p.end_date, p.end_reason, p.timezone, p.schedule_days, p.schedule_start, p.schedule_end, p.weekly_hours, p.replaces_placement_id, co.name company_name, co.id company_id, am.name account_manager_name, mp.name policy_name,
          (SELECT r.pay_rate_cents FROM placement_rates r WHERE r.placement_id=p.id ORDER BY (r.effective_from <= CURRENT_DATE) DESC, r.effective_from DESC LIMIT 1) pay_rate_cents,
          (SELECT r.bill_rate_cents FROM placement_rates r WHERE r.placement_id=p.id ORDER BY (r.effective_from <= CURRENT_DATE) DESC, r.effective_from DESC LIMIT 1) bill_rate_cents,
          (SELECT r.currency FROM placement_rates r WHERE r.placement_id=p.id ORDER BY r.effective_from DESC LIMIT 1) currency
        FROM placements p JOIN companies co ON co.id=p.company_id LEFT JOIN users am ON am.id=p.account_manager_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id WHERE p.worker_id=$1 ORDER BY CASE p.status WHEN 'ended' THEN 1 ELSE 0 END, p.start_date DESC`, [id]),
      q<any>(`SELECT a.id, a.status, a.source, a.created_at, po.title position_title, u.name recruiter_name FROM applications a LEFT JOIN positions po ON po.id=a.position_id LEFT JOIN users u ON u.id=a.recruiter_id WHERE a.candidate_id=$1 ORDER BY a.created_at DESC`, [w.candidate_id]),
      q<any>(`SELECT s.id, s.status, s.created_at, po.title position_title, co.name company_name FROM candidate_submissions s JOIN positions po ON po.id=s.position_id LEFT JOIN companies co ON co.id=po.company_id WHERE s.candidate_id=$1 ORDER BY s.created_at DESC`, [w.candidate_id]),
      q<any>(`SELECT i.id, i.kind, i.status, i.outcome, i.scheduled_at, po.title position_title FROM interviews i LEFT JOIN positions po ON po.id=i.position_id WHERE i.candidate_id=$1 ORDER BY i.scheduled_at DESC`, [w.candidate_id]),
      q<any>(`SELECT o.id, o.status, o.start_date, o.signed_at, o.pay_rate_cents, o.bill_rate_cents, o.currency, po.title position_title FROM offers o LEFT JOIN positions po ON po.id=o.position_id WHERE o.candidate_id=$1 ORDER BY o.created_at DESC`, [w.candidate_id]),
      q<any>(`SELECT i.id, i.title, i.source, i.required, i.owner, i.done_at, du.name done_by_name, p.id placement_id, co.name company_name FROM placement_onboarding_items i JOIN placements p ON p.id=i.placement_id JOIN companies co ON co.id=p.company_id LEFT JOIN users du ON du.id=i.done_by
        WHERE p.worker_id=$1 AND i.removed_at IS NULL AND p.status IN ('onboarding','active','notice','on_leave') ORDER BY p.start_date DESC, i.sort`, [id]),
      can(ctx, 'documents', 'view') ? q<any>(`SELECT id, name, category, file, issue_date, expires_at, verification, signature_status, visibility, created_at FROM documents WHERE organization_id=$1 AND entity_type='worker' AND entity_id=$2 AND archived_at IS NULL ORDER BY created_at DESC`, [ctx.orgId, id]) : Promise.resolve(null),
      one<any>(`SELECT wp.state, wp.session_started_at, wp.last_heartbeat_at, wp.activity_pct, wp.screen_share, wp.placement_id, co.name company_name FROM worker_presence wp LEFT JOIN placements p ON p.id=wp.placement_id LEFT JOIN companies co ON co.id=p.company_id WHERE wp.worker_id=$1`, [id]),
      can(ctx, 'screenshots', 'view') ? q<any>(`SELECT id, taken_at, file, app_label, activity_pct, flagged, blurred, kind FROM screenshots WHERE worker_id=$1 AND deleted_at IS NULL ORDER BY taken_at DESC LIMIT 12`, [id]) : Promise.resolve(null),
      q<any>(`SELECT t.id, t.week_start, t.status, t.total_minutes, co.name company_name FROM timesheets t JOIN companies co ON co.id=t.company_id WHERE t.worker_id=$1 ORDER BY t.week_start DESC LIMIT 10`, [id]),
      q<any>(`SELECT i.*, u.name created_by_name FROM issues i LEFT JOIN users u ON u.id=i.created_by WHERE i.worker_id=$1 ORDER BY i.created_at DESC`, [id]),
      q<any>(`SELECT id, kind, start_date, end_date, status, note FROM time_off_requests WHERE worker_id=$1 AND end_date >= CURRENT_DATE - 60 ORDER BY start_date DESC`, [id]),
      one<any>(`SELECT count(*) FILTER (WHERE kind='late')::int late, count(*) FILTER (WHERE kind='absent')::int absent, count(*) FILTER (WHERE kind='early_leave')::int early_leave, count(*) FILTER (WHERE kind='screen_declined')::int screen_declined FROM attendance_events WHERE worker_id=$1 AND work_date >= CURRENT_DATE - 30`, [id]),
      viewComp && can(ctx, 'payroll', 'view') ? q<any>(`SELECT pi.id, pr.period_start, pr.period_end, pr.pay_date, pr.status run_status, pi.gross_cents, pi.net_cents, pi.currency, pi.regular_minutes, pi.ot_minutes, pi.payslip_number FROM payroll_items pi JOIN payroll_runs pr ON pr.id=pi.run_id WHERE pi.worker_id=$1 ORDER BY pr.period_end DESC LIMIT 12`, [id]) : Promise.resolve(null),
      one<any>(`SELECT status, created_at, expires_at FROM invitations WHERE worker_id=$1 ORDER BY created_at DESC LIMIT 1`, [id]),
    ]);
    const week = await one<any>(`SELECT COALESCE(sum(${ENTRY_MIN()}),0)::int m FROM time_entries e WHERE e.worker_id=$1 AND e.work_date >= $2::date`, [id, weekStart(todayUtc())]);
    const act30 = await one<any>(`SELECT round(avg(activity_pct))::int pct FROM activity_samples WHERE worker_id=$1 AND bucket_start >= now() - interval '30 days'`, [id]);
    return {
      ...redact(ctx, w), placements: placements.map(p => redact(ctx, p)),
      recruiting: { applications, submissions, interviews, offers: offers.map(o => redact(ctx, o)) },
      onboarding, documents: docs ? docs.map(d => ({ ...d, url: signedUrl(d.file), file: undefined })) : null,
      presence, screenshots: shots ? shots.map(s => ({ ...s, url: signedUrl(s.file, 3600), file: undefined })) : null,
      timesheets, issues, time_off: timeOff, attendance_30d: attendance, pay_history: pay, invite,
      stats: { week_minutes: week.m, activity_30d: act30?.pct ?? null },
      can: { edit: can(ctx, 'workers', 'edit'), view_comp: viewComp, placements_create: can(ctx, 'placements', 'create'), issues_create: can(ctx, 'issues', 'create') },
    };
  });

  app.post('/api/v1/workers/:id/status', async (req) => {
    const ctx = staff(req); need(ctx, 'workers', 'edit');
    const { id } = req.params as { id: string };
    const w = await getOr404<any>('workers', ctx, id);
    const b = z.object({ status: z.enum(['inactive', 'available']), reason: z.string().min(3, 'Give a short reason').max(500) }).parse(req.body);
    const open = await one<any>(`SELECT count(*)::int n FROM placements WHERE worker_id=$1 AND status IN ('active','notice','on_leave','onboarding')`, [id]);
    if (open.n > 0) throw conflict(`This worker has ${open.n} open placement(s) — offboard them before changing the worker status`);
    if (w.status === b.status) throw conflict(`Worker is already ${b.status}`);
    await q(`UPDATE workers SET status=$3, updated_at=now() WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId, b.status]);
    await activity(ctx, 'worker', id, 'status_change', `Worker marked ${b.status}`, b.reason, { from: w.status, to: b.status });
    await audit(ctx, 'worker.status_changed', { type: 'worker', id }, { status: w.status }, { status: b.status }, b.reason);
    return { ok: true, status: b.status };
  });

  // ── Issues ──
  app.get('/api/v1/issues', async (req) => {
    const ctx = staff(req); need(ctx, 'issues', 'view');
    const lp = listParams(req);
    const where = ['i.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    for (const k of ['status', 'kind', 'severity'] as const) if (lp.filters[k]) { params.push(lp.filters[k].split(',')); where.push(`i.${k} = ANY($${params.length})`); }
    for (const k of ['worker_id', 'placement_id'] as const) if (lp.filters[k]) { params.push(lp.filters[k]); where.push(`i.${k}=$${params.length}`); }
    if (lp.filters.company_id) { params.push(lp.filters.company_id); where.push(`p.company_id=$${params.length}`); }
    if (lp.filters.open === 'true') where.push(`i.status IN ('open','investigating')`);
    return paged({ select: `i.*, ${WNAME} worker_name, cd.avatar_color, co.name company_name, p.title placement_title, u.name created_by_name, ru.name resolved_by_name`,
      from: `issues i LEFT JOIN workers w ON w.id=i.worker_id LEFT JOIN candidates cd ON cd.id=w.candidate_id LEFT JOIN placements p ON p.id=i.placement_id LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users u ON u.id=i.created_by LEFT JOIN users ru ON ru.id=i.resolved_by`,
      where, params, lp, searchCols: ['i.title', 'i.description', 'cd.first_name', 'cd.last_name', 'co.name'],
      sortMap: { created_at: 'i.created_at', severity: `CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`, status: 'i.status', worker_name: 'cd.first_name' }, defaultSort: 'i.created_at DESC' });
  });
  app.get('/api/v1/issues/summary', async (req) => {
    const ctx = staff(req); need(ctx, 'issues', 'view');
    const s = await one<any>(`SELECT count(*) FILTER (WHERE status IN ('open','investigating'))::int open, count(*) FILTER (WHERE status IN ('open','investigating') AND severity IN ('high','critical'))::int high,
      count(*) FILTER (WHERE status='replacement')::int replacement, count(*) FILTER (WHERE status='resolved' AND resolved_at >= now() - interval '30 days')::int resolved_30d,
      count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int new_30d, count(*) FILTER (WHERE created_at >= now() - interval '60 days' AND created_at < now() - interval '30 days')::int new_prev_30d,
      round(avg(EXTRACT(EPOCH FROM resolved_at - created_at)/86400) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 1)::float avg_days_to_resolve FROM issues WHERE organization_id=$1`, [ctx.orgId]);
    const byKind = await q<any>(`SELECT kind label, count(*)::int value FROM issues WHERE organization_id=$1 AND created_at >= now() - interval '180 days' GROUP BY 1 ORDER BY 2 DESC`, [ctx.orgId]);
    return { ...s, byKind };
  });
  app.post('/api/v1/issues', async (req) => {
    const ctx = staff(req); need(ctx, 'issues', 'create');
    const b = z.object({ placement_id: z.string().uuid(), kind: z.enum(['performance', 'attendance', 'client_complaint', 'conduct', 'other']), severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'), title: z.string().min(3, 'Give the issue a title').max(200), description: z.string().max(4000).optional().nullable() }).parse(req.body);
    const p = await placementFull(ctx.orgId, b.placement_id);
    if (!p) throw conflict('Placement not found');
    const r = await one<any>(`INSERT INTO issues (organization_id, placement_id, worker_id, kind, severity, title, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [ctx.orgId, p.id, p.worker_id, b.kind, b.severity, b.title, b.description ?? null, ctx.userId]);
    await activity(ctx, 'placement', p.id, 'note', `Issue logged: ${b.title}`, `${b.kind.replace('_', ' ')} · ${b.severity}${b.description ? ` — ${b.description}` : ''}`, { issue_id: r.id });
    await activity(ctx, 'worker', p.worker_id, 'note', `Issue logged: ${b.title}`, null, { issue_id: r.id });
    await notify(ctx.orgId, [p.account_manager_id].filter(u => u !== ctx.userId), { event: 'issue.created', title: `Issue: ${b.title}`, body: `${p.worker_name} @ ${p.company_name} · ${b.severity}`, link: `/workforce/issues?placement_id=${p.id}` });
    await emit(ctx.orgId, 'issue.created', eventPayload(p, { issue_id: r.id, kind: b.kind, severity: b.severity, title: b.title }));
    return r;
  });
  app.patch('/api/v1/issues/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'issues', 'edit');
    const { id } = req.params as { id: string };
    const it = await getOr404<any>('issues', ctx, id);
    const b = z.object({ status: z.enum(['open', 'investigating', 'resolved']).optional(), severity: z.enum(['low', 'medium', 'high', 'critical']).optional(), resolution: z.string().max(2000).optional().nullable() }).parse(req.body);
    if (b.status === 'resolved' && !b.resolution?.trim() && !it.resolution) throw conflict('Add a resolution note when resolving an issue');
    const r = await one<any>(`UPDATE issues SET status=COALESCE($3,status), severity=COALESCE($4,severity), resolution=COALESCE($5,resolution), resolved_at=CASE WHEN $3='resolved' THEN now() WHEN $3 IS NOT NULL THEN NULL ELSE resolved_at END, resolved_by=CASE WHEN $3='resolved' THEN $6::uuid WHEN $3 IS NOT NULL THEN NULL ELSE resolved_by END WHERE id=$1 AND organization_id=$2 RETURNING *`,
      [id, ctx.orgId, b.status ?? null, b.severity ?? null, b.resolution ?? null, ctx.userId]);
    if (it.placement_id && b.status && b.status !== it.status) await activity(ctx, 'placement', it.placement_id, 'status_change', `Issue ${b.status}: ${it.title}`, b.resolution ?? null, { issue_id: id });
    return r;
  });
}
