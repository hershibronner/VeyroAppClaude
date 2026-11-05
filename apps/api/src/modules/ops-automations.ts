// OPS: Automation builder API, run log, approvals, test runs — and the engine wiring (event listener + scheduler).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, insertRow, updateRow } from '../core/db';
import { staff, need, getOr404 } from '../core/context';
import { badRequest, conflict } from '../core/errors';
import { audit } from '../core/audit';
import { listParams, paged } from '../core/list';
import { emit, onEvent } from '../core/events';
import { every } from '../jobs/queue';
import {
  EVENT_TRIGGERS, SCHEDULE_TRIGGERS, ACTION_TYPES, RECIPIENTS, STATUS_TARGETS, enrich, evalConditions, planActions, executeActions,
  processTrigger, runSchedule, samplePayload, scheduleMs, hashKey, type Automation,
} from './_insights/automationEngine';

// ── Engine wiring ──
// Event-triggered automations: every domain event is matched against enabled automations listening for it.
onEvent('automations', async (orgId, event, payload) => {
  const autos = await q<Automation>(`SELECT * FROM automations WHERE organization_id=$1 AND enabled AND trigger_kind='event' AND trigger_event=$2`, [orgId, event]);
  for (const a of autos) {
    try {
      const dk = typeof payload.dedupe_key === 'string' ? payload.dedupe_key : `${event}:${hashKey(JSON.stringify(payload))}`;
      await processTrigger(a, payload, { dedupeKey: dk, recordSkips: true });
    } catch (e: any) { console.error(`[automation ${a.name}]`, e?.message ?? e); }
  }
});
// Schedule-triggered automations: evaluated when due (hourly / daily / every_5m).
let schedRunning = false;
every('automations.schedule', 30_000, async () => {
  if (schedRunning) return;
  schedRunning = true;
  try {
    const autos = await q<Automation & { last_run_at: Date | null }>(`SELECT * FROM automations WHERE enabled AND trigger_kind='schedule' ORDER BY last_run_at NULLS FIRST`);
    for (const a of autos) {
      if (a.last_run_at && Date.now() - new Date(a.last_run_at).getTime() < scheduleMs(a.schedule)) continue;
      try { await runSchedule(a); } catch (e: any) { console.error(`[automation ${a.name}]`, e?.message ?? e); }
    }
  } finally { schedRunning = false; }
});

const condZ = z.object({ field: z.string().min(1).max(80), op: z.enum(['=', '!=', '>', '>=', '<', '<=', 'contains', 'in', 'exists']), value: z.any().optional() });
const actionZ = z.object({ type: z.enum(ACTION_TYPES) }).passthrough().superRefine((a: any, c) => {
  const need_ = (k: string, msg: string) => { if (a[k] === undefined || a[k] === null || a[k] === '') c.addIssue({ code: 'custom', message: msg, path: [k] }); };
  if (a.type === 'notify') { need_('to', 'Choose who to notify'); need_('title', 'Notification title is required'); }
  if (a.type === 'create_task') { need_('assignee', 'Choose an assignee'); need_('title', 'Task title is required'); }
  if (a.type === 'send_template') { need_('template', 'Choose a template'); need_('to', 'Choose a recipient'); }
  if (a.type === 'change_status') { need_('entity', 'Choose a record type'); need_('status', 'Choose a status'); if (a.entity && !STATUS_TARGETS[a.entity]) c.addIssue({ code: 'custom', message: 'Unsupported record type', path: ['entity'] }); }
  if (a.type === 'assign') { need_('entity', 'Choose a record type'); need_('to', 'Choose who to assign'); }
  if (a.type === 'webhook') { need_('url', 'Webhook URL is required'); if (a.url && !/^https?:\/\//i.test(a.url)) c.addIssue({ code: 'custom', message: 'URL must start with http:// or https://', path: ['url'] }); }
});
const autoZ = z.object({
  name: z.string().min(2).max(120), description: z.string().max(500).nullish(),
  trigger_kind: z.enum(['event', 'schedule']), trigger_event: z.string().min(1).max(60), schedule: z.enum(['every_5m', 'hourly', 'daily']).nullish(),
  conditions: z.array(condZ).max(10).default([]), actions: z.array(actionZ).min(1, 'Add at least one action').max(10), requires_approval: z.boolean().default(false), enabled: z.boolean().default(true),
});
function validTrigger(kind: string, ev: string) {
  const list = kind === 'event' ? EVENT_TRIGGERS : SCHEDULE_TRIGGERS;
  if (!list.some(t => t.key === ev)) throw badRequest('Please check the highlighted fields', undefined);
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/automations/catalog', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'view');
    const templates = await q(`SELECT key, name, channel FROM templates WHERE organization_id=$1 AND archived_at IS NULL AND key IS NOT NULL ORDER BY name`, [ctx.orgId]);
    const roles = await q(`SELECT key, name FROM roles WHERE organization_id=$1 AND kind='agency' ORDER BY name`, [ctx.orgId]);
    return { events: EVENT_TRIGGERS, schedules: SCHEDULE_TRIGGERS, actions: ACTION_TYPES, recipients: [...new Set([...RECIPIENTS, ...roles.map((r: any) => `role:${r.key}`)])], roles, templates, statusTargets: STATUS_TARGETS };
  });

  app.get('/api/v1/automations', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'view');
    const lp = listParams(req);
    const where = ['a.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.enabled) { params.push(lp.filters.enabled === 'true'); where.push(`a.enabled=$${params.length}`); }
    if (lp.filters.trigger_kind) { params.push(lp.filters.trigger_kind); where.push(`a.trigger_kind=$${params.length}`); }
    return paged({ select: `a.*, u.name created_by_name,
      (SELECT count(*) FROM automation_runs r WHERE r.automation_id=a.id AND r.created_at > now() - interval '30 days' AND r.status NOT IN ('test','skipped'))::int runs_30d,
      (SELECT count(*) FROM automation_runs r WHERE r.automation_id=a.id AND r.status='failed' AND r.created_at > now() - interval '30 days')::int failed_30d,
      (SELECT count(*) FROM automation_runs r WHERE r.automation_id=a.id AND r.status='pending_approval')::int pending,
      LEAST(now(), (SELECT max(created_at) FROM automation_runs r WHERE r.automation_id=a.id AND r.status NOT IN ('test','skipped'))) last_fired_at`,
      from: 'automations a LEFT JOIN users u ON u.id=a.created_by', where, params, lp, searchCols: ['a.name', 'a.description', 'a.trigger_event'],
      sortMap: { name: 'a.name', created_at: 'a.created_at', last_run_at: 'a.last_run_at' }, defaultSort: 'a.created_at ASC' });
  });

  app.get('/api/v1/automations/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'view');
    const a = await getOr404<any>('automations', ctx, (req.params as any).id);
    const stats = await one<any>(`SELECT count(*) FILTER (WHERE status IN ('succeeded','approved'))::int succeeded, count(*) FILTER (WHERE status='failed')::int failed, count(*) FILTER (WHERE status='pending_approval')::int pending FROM automation_runs WHERE automation_id=$1`, [a.id]);
    return { ...a, stats };
  });

  app.post('/api/v1/automations', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'create');
    const b = autoZ.parse(req.body);
    validTrigger(b.trigger_kind, b.trigger_event);
    const a = await insertRow('automations', { organization_id: ctx.orgId, name: b.name, description: b.description ?? null, trigger_kind: b.trigger_kind, trigger_event: b.trigger_event, schedule: b.trigger_kind === 'schedule' ? b.schedule ?? 'hourly' : null, conditions: JSON.stringify(b.conditions), actions: JSON.stringify(b.actions), requires_approval: b.requires_approval, enabled: b.enabled, created_by: ctx.userId });
    await audit(ctx, 'automation.created', { type: 'automation', id: a.id, label: a.name }, null, b);
    return a;
  });

  app.patch('/api/v1/automations/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'edit');
    const a = await getOr404<any>('automations', ctx, (req.params as any).id);
    const b = autoZ.partial().parse(req.body);
    if (b.trigger_kind || b.trigger_event) validTrigger(b.trigger_kind ?? a.trigger_kind, b.trigger_event ?? a.trigger_event);
    const kind = b.trigger_kind ?? a.trigger_kind;
    const r = await updateRow('automations', ctx.orgId, a.id, { name: b.name, description: b.description, trigger_kind: b.trigger_kind, trigger_event: b.trigger_event, schedule: kind === 'schedule' ? (b.schedule ?? a.schedule ?? 'hourly') : null, conditions: b.conditions ? JSON.stringify(b.conditions) : undefined, actions: b.actions ? JSON.stringify(b.actions) : undefined, requires_approval: b.requires_approval, enabled: b.enabled });
    await audit(ctx, b.enabled !== undefined && Object.keys(b).length === 1 ? (b.enabled ? 'automation.enabled' : 'automation.disabled') : 'automation.updated', { type: 'automation', id: a.id, label: a.name }, { enabled: a.enabled, conditions: a.conditions, actions: a.actions }, b);
    return r;
  });

  app.delete('/api/v1/automations/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'delete');
    const a = await getOr404<any>('automations', ctx, (req.params as any).id);
    await q(`DELETE FROM automations WHERE id=$1 AND organization_id=$2`, [a.id, ctx.orgId]);
    await audit(ctx, 'automation.deleted', { type: 'automation', id: a.id, label: a.name }, a);
    return { ok: true };
  });

  // Dry run: evaluates conditions and shows exactly what would happen, using a real recent record (or a supplied payload). Nothing is executed.
  app.post('/api/v1/automations/test', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'view');
    const b = z.object({ automation_id: z.string().uuid().optional(), definition: autoZ.partial().optional(), payload: z.record(z.any()).optional() }).parse(req.body);
    const saved = b.automation_id ? await getOr404<any>('automations', ctx, b.automation_id) : null;
    const def = { ...(saved ?? {}), ...(b.definition ?? {}) } as any;
    if (!def.trigger_event) throw badRequest('Choose a trigger first');
    const payload = b.payload ?? await samplePayload(ctx.orgId, def.trigger_event);
    const v = await enrich(ctx.orgId, payload);
    const cond = evalConditions(def.conditions ?? [], v);
    const plan = await planActions(ctx.orgId, def.actions ?? [], v);
    const result = { conditions: cond.details, wouldRun: cond.ok, requiresApproval: !!def.requires_approval, planned: plan, sample: Object.keys(payload).length ? payload : null };
    if (saved) await q(`INSERT INTO automation_runs (organization_id, automation_id, status, trigger_payload, result, approved_by) VALUES ($1,$2,'test',$3,$4,$5)`, [ctx.orgId, saved.id, JSON.stringify(payload), JSON.stringify(result), ctx.userId]);
    return { ...result, variables: v };
  });

  // Run now: schedule automations scan immediately; event automations execute once against the latest real record.
  app.post('/api/v1/automations/:id/run', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'edit');
    const a = await getOr404<Automation>('automations', ctx, (req.params as any).id);
    if (!a.enabled) throw conflict('Enable this automation before running it');
    await audit(ctx, 'automation.run_now', { type: 'automation', id: a.id, label: a.name });
    if (a.trigger_kind === 'schedule') {
      const r = await runSchedule(a, 50, ctx.userId);
      return { kind: 'schedule', scanned: r.scanned, executed: r.executed, runs: r.runs.map(x => ({ id: x.id, status: x.status })) };
    }
    const payload = await samplePayload(ctx.orgId, a.trigger_event ?? '');
    const run = await processTrigger(a, payload, { dedupeKey: `manual:${Date.now()}`, recordSkips: true, manualBy: ctx.userId });
    return { kind: 'event', executed: run && run.status !== 'skipped' ? 1 : 0, runs: run ? [{ id: run.id, status: run.status }] : [] };
  });

  // Fires the trigger event through the real event bus (all listeners: automations, webhooks) with a sample payload.
  app.post('/api/v1/automations/:id/fire', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'edit');
    const a = await getOr404<Automation>('automations', ctx, (req.params as any).id);
    if (a.trigger_kind !== 'event' || !a.trigger_event) throw conflict('Only event-triggered automations can fire a sample event');
    const payload = { ...(await samplePayload(ctx.orgId, a.trigger_event)), simulated: true, dedupe_key: `sample:${Date.now()}` };
    const v = await enrich(ctx.orgId, payload);
    await emit(ctx.orgId, a.trigger_event, { ...payload, worker_name: v.worker?.name, company_name: v.company?.name, account_manager_id: v.account_manager_id });
    await audit(ctx, 'automation.sample_event', { type: 'automation', id: a.id, label: a.name }, null, { event: a.trigger_event });
    return { ok: true, event: a.trigger_event, payload };
  });

  // ── Run log ──
  app.get('/api/v1/automations/runs/list', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'view');
    const lp = listParams(req);
    const where = ['r.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`r.status=$${params.length}`); }
    if (lp.filters.automation_id) { params.push(lp.filters.automation_id); where.push(`r.automation_id::text=$${params.length}`); }
    if (lp.filters.run) { params.push(lp.filters.run); where.push(`r.id::text=$${params.length}`); }
    if (lp.filters.from) { params.push(lp.filters.from); where.push(`r.created_at >= $${params.length}::date`); }
    return paged({ select: `r.*, a.name automation_name, a.trigger_event, a.trigger_kind, u.name approved_by_name`, from: 'automation_runs r JOIN automations a ON a.id=r.automation_id LEFT JOIN users u ON u.id=r.approved_by', where, params, lp,
      searchCols: ['a.name', 'r.result::text'], sortMap: { created_at: 'r.created_at', status: 'r.status', automation_name: 'a.name' }, defaultSort: 'r.created_at DESC' });
  });
  app.get('/api/v1/automations/runs/summary', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'view');
    return one(`SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days' AND status IN ('succeeded','approved'))::int succeeded_7d, count(*) FILTER (WHERE created_at > now() - interval '7 days' AND status='failed')::int failed_7d, count(*) FILTER (WHERE status='pending_approval')::int pending, count(*) FILTER (WHERE created_at > now() - interval '7 days' AND status='skipped')::int skipped_7d FROM automation_runs WHERE organization_id=$1`, [ctx.orgId]);
  });

  async function decide(req: any, approve: boolean) {
    const ctx = staff(req);
    need(ctx, 'automation', 'approve');
    const run = await getOr404<any>('automation_runs', ctx, req.params.id);
    if (run.status !== 'pending_approval') throw conflict(`This run is already ${run.status.replace('_', ' ')}`);
    const b = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    const auto = await getOr404<Automation>('automations', ctx, run.automation_id);
    // Lock the row so two approvers cannot execute it twice.
    const locked = await one<any>(`UPDATE automation_runs SET status=$2, approved_by=$3 WHERE id=$1 AND status='pending_approval' RETURNING *`, [run.id, approve ? 'running' : 'rejected', ctx.userId]);
    if (!locked) throw conflict('This run was already decided');
    if (!approve) {
      await q(`UPDATE automation_runs SET result = result || $2::jsonb WHERE id=$1`, [run.id, JSON.stringify({ rejected_reason: b.reason ?? null, decided_at: new Date().toISOString() })]);
      await audit(ctx, 'automation.run_rejected', { type: 'automation', id: auto.id, label: auto.name }, null, { run_id: run.id }, b.reason);
      return one(`SELECT * FROM automation_runs WHERE id=$1`, [run.id]);
    }
    const v = await enrich(ctx.orgId, run.trigger_payload ?? {});
    const results = await executeActions(ctx.orgId, auto, auto.actions, v);
    const ok = results.every(r => r.ok);
    await audit(ctx, 'automation.run_approved', { type: 'automation', id: auto.id, label: auto.name }, null, { run_id: run.id, results }, b.reason);
    return one(`UPDATE automation_runs SET status=$2, result = result || $3::jsonb WHERE id=$1 RETURNING *`, [run.id, ok ? 'approved' : 'failed', JSON.stringify({ actions: results, decided_at: new Date().toISOString(), ...(ok ? {} : { error: results.filter(r => !r.ok).map(r => r.detail).join('; ') }) })]);
  }
  app.post('/api/v1/automations/runs/:id/approve', async (req) => decide(req, true));
  app.post('/api/v1/automations/runs/:id/reject', async (req) => decide(req, false));

  // Retry a failed run (re-executes the actions with the stored trigger payload).
  app.post('/api/v1/automations/runs/:id/retry', async (req) => {
    const ctx = staff(req);
    need(ctx, 'automation', 'edit');
    const run = await getOr404<any>('automation_runs', ctx, (req.params as any).id);
    if (run.status !== 'failed') throw conflict('Only failed runs can be retried');
    const auto = await getOr404<Automation>('automations', ctx, run.automation_id);
    const v = await enrich(ctx.orgId, run.trigger_payload ?? {});
    const results = await executeActions(ctx.orgId, auto, auto.actions, v);
    const ok = results.every(r => r.ok);
    await audit(ctx, 'automation.run_retried', { type: 'automation', id: auto.id, label: auto.name }, null, { run_id: run.id, ok });
    return one(`UPDATE automation_runs SET status=$2, result = result || $3::jsonb, approved_by=$4 WHERE id=$1 RETURNING *`, [run.id, ok ? 'succeeded' : 'failed', JSON.stringify({ actions: results, retried_at: new Date().toISOString(), error: ok ? null : results.filter(r => !r.ok).map(r => r.detail).join('; ') }), ctx.userId]);
  });

}
