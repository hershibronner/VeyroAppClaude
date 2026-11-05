// INSIGHTS: Report Builder (saved definitions, run, CSV export) + scheduled email delivery to the Dev Outbox.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, insertRow, updateRow } from '../core/db';
import { staff, can, scopeOf, canViewComp, getOr404, type Ctx } from '../core/context';
import { forbidden, notFound } from '../core/errors';
import { audit } from '../core/audit';
import { listParams, paged } from '../core/list';
import { every } from '../jobs/queue';
import { sendTemplate } from '../adapters/messaging';
import { WEB_URL } from '../core/settings';
import type { Scope } from '@veyro/shared';
import { catalogue, runReport, toCsvRows, toTextTable, normalizeDef, type Viewer, type ReportDef } from './_insights/reportEngine';

const viewerOf = (ctx: Ctx): Viewer => ({ orgId: ctx.orgId, userId: ctx.userId, can: (r, a) => can(ctx, r as any, a as any), scope: (r, a) => scopeOf(ctx, r as any, a as any), comp: canViewComp(ctx) });
/** Rebuilds a permission viewer for a stored user (scheduled reports run with their creator's current permissions). */
async function viewerForUser(orgId: string, userId: string | null): Promise<Viewer | null> {
  if (!userId) return null;
  const m = await one<any>(`SELECT m.role_id, r.kind FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='active'`, [orgId, userId]);
  if (!m || m.kind !== 'agency') return null;
  const perms: Record<string, Scope> = {};
  for (const p of await q<any>(`SELECT resource, action, scope FROM role_permissions WHERE role_id=$1`, [m.role_id])) perms[`${p.resource}:${p.action}`] = p.scope;
  const sc = (r: string, a: string) => perms[`${r}:${a}`] ?? 'none';
  return { orgId, userId, can: (r, a) => sc(r, a) !== 'none', scope: sc, comp: sc('rates', 'view_comp') !== 'none' };
}
const canView = (ctx: Ctx) => can(ctx, 'reports', 'view') || can(ctx, 'analytics', 'view');
const canWrite = (ctx: Ctx, a: 'create' | 'edit' | 'delete') => can(ctx, 'reports', a);

const filterZ = z.object({ field: z.string().max(60), op: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'last_days', 'between', 'empty', 'not_empty']), value: z.any().optional() });
const defZ = z.object({
  entity: z.string().max(40), fields: z.array(z.string().max(60)).max(30).default([]), filters: z.array(filterZ).max(20).default([]),
  group_by: z.string().max(70).nullish(), metric: z.string().max(70).nullish(), chart: z.enum(['table', 'bar', 'line']).default('table'), sort: z.string().max(60).nullish(), dir: z.enum(['asc', 'desc']).optional(),
});
const saveZ = defZ.extend({ name: z.string().min(1).max(120) });

const CADENCE_MS: Record<string, string> = { daily: '1 day', weekly: '7 days', monthly: '1 month' };

async function deliver(orgId: string, sr: any, rep: any, triggeredBy: Ctx | null) {
  const v = triggeredBy ? viewerOf(triggeredBy) : await viewerForUser(orgId, sr.created_by ?? rep.created_by);
  if (!v) { await q(`UPDATE scheduled_reports SET last_run_at=now(), last_status='failed: creator no longer has access', next_run_at=now() + $2::interval WHERE id=$1`, [sr.id, CADENCE_MS[sr.cadence] ?? '7 days']); return { sent: 0, error: 'Report owner no longer has access' }; }
  let table: string;
  try { table = toTextTable(await runReport(v, { entity: rep.entity, fields: rep.fields, filters: rep.filters, group_by: rep.group_by, metric: rep.metric, chart: rep.chart }, { limit: 200 })); }
  catch (e: any) { await q(`UPDATE scheduled_reports SET last_run_at=now(), last_status=$2, next_run_at=now() + $3::interval WHERE id=$1`, [sr.id, `failed: ${e?.message ?? e}`.slice(0, 200), CADENCE_MS[sr.cadence] ?? '7 days']); return { sent: 0, error: e?.message }; }
  const org = await one<any>(`SELECT name FROM organizations WHERE id=$1`, [orgId]);
  let sent = 0;
  for (const to of sr.recipients as string[]) {
    await sendTemplate(orgId, 'scheduled_report', to, { report: { name: rep.name, table: `${table}\n\nOpen in VeyroApp: ${WEB_URL}/analytics/reports?report=${rep.id}` }, org: { name: org?.name } });
    sent++;
  }
  await q(`UPDATE scheduled_reports SET last_run_at=now(), last_status=$2, next_run_at=GREATEST(next_run_at, now()) + $3::interval WHERE id=$1`, [sr.id, `sent to ${sent} recipient${sent === 1 ? '' : 's'}`, CADENCE_MS[sr.cadence] ?? '7 days']);
  return { sent };
}

// Scheduler: deliver due scheduled reports (checked every minute).
every('reports.scheduled', 60_000, async () => {
  const due = await q<any>(`SELECT s.*, row_to_json(r) rep FROM scheduled_reports s JOIN report_definitions r ON r.id=s.report_id WHERE s.active AND s.next_run_at <= now() ORDER BY s.next_run_at LIMIT 20`);
  for (const s of due) {
    try { await deliver(s.organization_id, s, s.rep, null); } catch (e: any) { console.error('[scheduled report]', e?.message ?? e); }
  }
});

export default async function (app: FastifyInstance) {
  app.get('/api/v1/reports/entities', async (req) => {
    const ctx = staff(req);
    if (!canView(ctx)) throw notFound();
    return { entities: catalogue(viewerOf(ctx)), canSave: canWrite(ctx, 'create') };
  });

  app.get('/api/v1/reports', async (req) => {
    const ctx = staff(req);
    if (!canView(ctx)) throw notFound();
    const lp = listParams(req);
    const where = ['r.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.entity) { params.push(lp.filters.entity); where.push(`r.entity=$${params.length}`); }
    const allowed = catalogue(viewerOf(ctx)).map(e => e.key);
    params.push(allowed); where.push(`r.entity = ANY($${params.length})`);
    return paged({ select: `r.*, u.name created_by_name, (SELECT count(*) FROM scheduled_reports s WHERE s.report_id=r.id AND s.active)::int schedules`, from: 'report_definitions r LEFT JOIN users u ON u.id=r.created_by', where, params, lp, searchCols: ['r.name'], sortMap: { name: 'r.name', updated_at: 'r.updated_at', entity: 'r.entity' }, defaultSort: 'r.updated_at DESC' });
  });

  app.post('/api/v1/reports/run', async (req) => {
    const ctx = staff(req);
    if (!canView(ctx)) throw notFound();
    const b = defZ.extend({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(500).default(100) }).parse(req.body);
    return runReport(viewerOf(ctx), b as ReportDef, { limit: b.pageSize, offset: (b.page - 1) * b.pageSize });
  });

  // CSV export (ad-hoc definition) — audited.
  app.post('/api/v1/reports/export', async (req, reply) => {
    const ctx = staff(req);
    if (!canView(ctx)) throw notFound();
    const b = defZ.extend({ name: z.string().max(120).optional() }).parse(req.body);
    const res = await runReport(viewerOf(ctx), b as ReportDef, { limit: 5000 });
    await audit(ctx, 'report.exported', { type: 'report', label: b.name ?? `${b.entity} report` }, null, { entity: b.entity, rows: res.rows.length, filters: b.filters });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${(b.name ?? b.entity).replace(/[^\w-]+/g, '-').toLowerCase()}.csv"`);
    return toCsvRows(res);
  });

  app.post('/api/v1/reports', async (req) => {
    const ctx = staff(req);
    if (!canWrite(ctx, 'create')) throw forbidden(`Your role (${ctx.role.name}) cannot save reports`);
    const b = saveZ.parse(req.body);
    await runReport(viewerOf(ctx), b as ReportDef, { limit: 1 }); // validates entity, fields and permissions
    const r = await insertRow('report_definitions', { organization_id: ctx.orgId, name: b.name, entity: b.entity, fields: b.fields, filters: JSON.stringify(b.filters), group_by: b.group_by ?? null, metric: b.metric ?? null, chart: b.chart, created_by: ctx.userId });
    await audit(ctx, 'report.created', { type: 'report', id: r.id, label: r.name });
    return r;
  });

  app.get('/api/v1/reports/:id', async (req) => {
    const ctx = staff(req);
    if (!canView(ctx)) throw notFound();
    const r = await getOr404<any>('report_definitions', ctx, (req.params as any).id);
    if (!catalogue(viewerOf(ctx)).some(e => e.key === r.entity)) throw notFound();
    const schedules = await q(`SELECT s.*, u.name created_by_name FROM scheduled_reports s LEFT JOIN users u ON u.id=s.created_by WHERE s.report_id=$1 AND s.organization_id=$2 ORDER BY s.created_at`, [r.id, ctx.orgId]);
    return { ...r, ...normalizeDef(r), schedules };
  });

  app.patch('/api/v1/reports/:id', async (req) => {
    const ctx = staff(req);
    if (!canWrite(ctx, 'edit')) throw forbidden(`Your role (${ctx.role.name}) cannot edit reports`);
    const r = await getOr404<any>('report_definitions', ctx, (req.params as any).id);
    const b = saveZ.partial().parse(req.body);
    const merged = { ...normalizeDef(r), ...b } as ReportDef;
    await runReport(viewerOf(ctx), merged, { limit: 1 });
    return updateRow('report_definitions', ctx.orgId, r.id, { name: b.name, entity: b.entity, fields: b.fields, filters: b.filters ? JSON.stringify(b.filters) : undefined, group_by: b.group_by === undefined ? undefined : b.group_by ?? null, metric: b.metric === undefined ? undefined : b.metric ?? null, chart: b.chart });
  });

  app.delete('/api/v1/reports/:id', async (req) => {
    const ctx = staff(req);
    if (!canWrite(ctx, 'delete') && !canWrite(ctx, 'edit')) throw forbidden(`Your role (${ctx.role.name}) cannot delete reports`);
    const r = await getOr404<any>('report_definitions', ctx, (req.params as any).id);
    await q(`DELETE FROM report_definitions WHERE id=$1 AND organization_id=$2`, [r.id, ctx.orgId]);
    await audit(ctx, 'report.deleted', { type: 'report', id: r.id, label: r.name }, r);
    return { ok: true };
  });

  app.get('/api/v1/reports/:id/run', async (req) => {
    const ctx = staff(req);
    if (!canView(ctx)) throw notFound();
    const r = await getOr404<any>('report_definitions', ctx, (req.params as any).id);
    const qy = req.query as any;
    const pageSize = Math.min(500, Number(qy.pageSize) || 100), page = Math.max(1, Number(qy.page) || 1);
    return { report: { id: r.id, name: r.name, chart: r.chart }, ...(await runReport(viewerOf(ctx), r, { limit: pageSize, offset: (page - 1) * pageSize })) };
  });

  app.get('/api/v1/reports/:id/export.csv', async (req, reply) => {
    const ctx = staff(req);
    if (!canView(ctx)) throw notFound();
    const r = await getOr404<any>('report_definitions', ctx, (req.params as any).id);
    const res = await runReport(viewerOf(ctx), r, { limit: 5000 });
    await audit(ctx, 'report.exported', { type: 'report', id: r.id, label: r.name }, null, { rows: res.rows.length });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${r.name.replace(/[^\w-]+/g, '-').toLowerCase()}.csv"`);
    return toCsvRows(res);
  });

  // ── Schedules ──
  const schedZ = z.object({ cadence: z.enum(['daily', 'weekly', 'monthly']), recipients: z.array(z.string().email()).min(1).max(20), active: z.boolean().default(true), first_run_at: z.string().datetime().optional() });
  app.post('/api/v1/reports/:id/schedules', async (req) => {
    const ctx = staff(req);
    if (!canWrite(ctx, 'edit') && !canWrite(ctx, 'create')) throw forbidden(`Your role (${ctx.role.name}) cannot schedule reports`);
    const r = await getOr404<any>('report_definitions', ctx, (req.params as any).id);
    const b = schedZ.parse(req.body);
    const s = await insertRow('scheduled_reports', { organization_id: ctx.orgId, report_id: r.id, cadence: b.cadence, recipients: b.recipients, active: b.active, next_run_at: b.first_run_at ?? new Date(Date.now() + 60_000).toISOString(), created_by: ctx.userId });
    await audit(ctx, 'report.scheduled', { type: 'report', id: r.id, label: r.name }, null, { cadence: b.cadence, recipients: b.recipients });
    return s;
  });
  app.patch('/api/v1/reports/schedules/:sid', async (req) => {
    const ctx = staff(req);
    if (!canWrite(ctx, 'edit') && !canWrite(ctx, 'create')) throw forbidden();
    const s = await getOr404<any>('scheduled_reports', ctx, (req.params as any).sid);
    const b = schedZ.partial().parse(req.body);
    return updateRow('scheduled_reports', ctx.orgId, s.id, { cadence: b.cadence, recipients: b.recipients, active: b.active, next_run_at: b.first_run_at });
  });
  app.delete('/api/v1/reports/schedules/:sid', async (req) => {
    const ctx = staff(req);
    if (!canWrite(ctx, 'edit') && !canWrite(ctx, 'create')) throw forbidden();
    const s = await getOr404<any>('scheduled_reports', ctx, (req.params as any).sid);
    await q(`DELETE FROM scheduled_reports WHERE id=$1 AND organization_id=$2`, [s.id, ctx.orgId]);
    return { ok: true };
  });
  app.post('/api/v1/reports/schedules/:sid/send-now', async (req) => {
    const ctx = staff(req);
    if (!canView(ctx)) throw notFound();
    const s = await getOr404<any>('scheduled_reports', ctx, (req.params as any).sid);
    const rep = await getOr404<any>('report_definitions', ctx, s.report_id);
    return deliver(ctx.orgId, s, rep, ctx);
  });
}
