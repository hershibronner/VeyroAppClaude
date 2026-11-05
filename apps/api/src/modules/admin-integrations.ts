// Integrations page (simulated adapters), public API keys, outbound webhooks engine, and the audit log viewer.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { INTEGRATIONS } from '@veyro/db';
import { q, one, tx } from '../core/db';
import { staff, need, can, type Ctx } from '../core/context';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit } from '../core/audit';
import { notify, usersWithRoles, subscribers } from '../core/notify';
import { listParams, paged, toCsv } from '../core/list';
import { onEvent } from '../core/events';
import { enqueue, registerJob } from '../jobs/queue';
import { API_URL } from '../core/settings';
import { EVENT_CATALOG, isUuid, randomToken, sha256 } from './_admin/common';
import { fieldError } from './_admin/common';

const BACKOFF_SEC = [10, 30, 120, 600, 1800];
const MAX_ATTEMPTS = BACKOFF_SEC.length + 1;
const TEST_HINTS: Record<string, string> = {
  payments: 'Created and refunded a $1.00 test charge', payouts: 'Fetched balances (USD, PHP, MXN, ZAR)', accounting: 'Fetched the chart of accounts', email: 'Rendered a test email into the Dev Outbox',
  sms: 'Validated sender number', whatsapp: 'Validated WhatsApp business profile', calendar: 'Created and deleted a test meeting', esign: 'Generated a test envelope', ai: 'Ran a 1-line extraction', job_boards: 'Listed connected job boards',
  background_checks: 'Fetched package catalog', storage: 'Wrote and read a 1 KB test file',
};

// ───────────── Webhook delivery engine ─────────────
async function createDelivery(orgId: string, ep: any, event: string, data: Record<string, unknown>, eventId?: string) {
  const id = crypto.randomUUID();
  const org = await one<any>(`SELECT id, slug, name FROM organizations WHERE id=$1`, [orgId]);
  const body = { id: eventId ?? id, event, created_at: new Date().toISOString(), organization: { id: org?.id, slug: org?.slug, name: org?.name }, data };
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', ep.secret).update(raw).digest('hex');
  await q(`INSERT INTO webhook_deliveries (id, organization_id, endpoint_id, event, payload, signature, idempotency_key, status, next_attempt_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending', now())`, [id, orgId, ep.id, event, raw, signature, body.id]);
  await enqueue('webhook.deliver', { deliveryId: id }, { orgId, maxAttempts: 1 });
  return id;
}

registerJob('webhook.deliver', async ({ deliveryId }) => {
  const d = await one<any>(`SELECT d.*, e.url, e.active, e.secret FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, [deliveryId]);
  if (!d || d.status === 'delivered') return;
  const raw = JSON.stringify(d.payload);
  // Re-sign with the current secret (secret rotation) — the body is byte-identical to what the receiver parses.
  const signature = crypto.createHmac('sha256', d.secret).update(raw).digest('hex');
  const attempts = d.attempts + 1;
  let code: number | null = null; let text = ''; let ok = false;
  if (!d.active) { text = 'Endpoint disabled'; }
  else {
    try {
      const res = await fetch(d.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'VeyroApp-Webhooks/1.0', 'x-veyro-signature': signature, 'x-veyro-event': d.event, 'x-veyro-delivery': d.id, 'x-veyro-idempotency-key': d.idempotency_key }, body: raw, signal: AbortSignal.timeout(10_000) });
      code = res.status; text = (await res.text()).slice(0, 2000); ok = res.ok;
    } catch (e: any) { text = String(e?.cause?.code ?? e?.message ?? e).slice(0, 500); }
  }
  if (ok) {
    await q(`UPDATE webhook_deliveries SET status='delivered', attempts=$2, response_code=$3, response_body=$4, signature=$5, delivered_at=now(), next_attempt_at=NULL WHERE id=$1`, [d.id, attempts, code, text, signature]);
    return;
  }
  if (attempts < MAX_ATTEMPTS && d.active) {
    const wait = BACKOFF_SEC[attempts - 1];
    await q(`UPDATE webhook_deliveries SET status='retrying', attempts=$2, response_code=$3, response_body=$4, signature=$5, next_attempt_at=now() + make_interval(secs => $6) WHERE id=$1`, [d.id, attempts, code, text, signature, wait]);
    await enqueue('webhook.deliver', { deliveryId: d.id }, { orgId: d.organization_id, runAt: new Date(Date.now() + wait * 1000), maxAttempts: 1 });
  } else {
    await q(`UPDATE webhook_deliveries SET status='failed', attempts=$2, response_code=$3, response_body=$4, signature=$5, next_attempt_at=NULL WHERE id=$1`, [d.id, attempts, code, text, signature]);
    await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,'webhooks','error',$2,$3)`, [d.organization_id, `Webhook ${d.event} to ${d.url} failed after ${attempts} attempt(s)`, JSON.stringify({ delivery_id: d.id, response_code: code })]);
    const admins = [...await usersWithRoles(d.organization_id, ['owner', 'admin']), ...await subscribers(d.organization_id, 'integration.error')];
    await notify(d.organization_id, admins, { event: 'integration.error', title: 'Webhook delivery failed', body: `${d.event} → ${d.url} (${code ?? text})`, link: '/settings/api' });
  }
});

onEvent('webhooks', async (orgId, event, payload) => {
  if (!orgId) return;
  const eps = await q<any>(`SELECT * FROM webhook_endpoints WHERE organization_id=$1 AND active AND ($2 = ANY(events) OR '*' = ANY(events))`, [orgId, event]);
  for (const ep of eps) await createDelivery(orgId, ep, event, payload);
});

async function integrationOr404(ctx: Ctx, key: string) {
  const r = await one<any>(`SELECT * FROM integrations WHERE organization_id=$1 AND key=$2`, [ctx.orgId, key]);
  if (!r) throw notFound();
  return r;
}
async function logIntegration(orgId: string, key: string, level: 'info' | 'warn' | 'error', message: string, meta: Record<string, unknown> = {}) {
  await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,$2,$3,$4,$5)`, [orgId, key, level, message, JSON.stringify(meta)]);
}

export default async function (app: FastifyInstance) {
  // ───────────── Integrations ─────────────
  app.get('/api/v1/integrations', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'view');
    // Ensure every adapter exists for this workspace (agencies created before a new adapter shipped).
    for (const i of INTEGRATIONS) await q(`INSERT INTO integrations (organization_id, key, category, provider, scopes, status, last_sync_at) VALUES ($1,$2,$3,$4,$5,'connected', now()) ON CONFLICT DO NOTHING`, [ctx.orgId, i.key, i.category, i.provider, i.scopes]);
    const rows = await q<any>(`SELECT i.*, (SELECT count(*)::int FROM integration_logs l WHERE l.organization_id=i.organization_id AND l.integration_key=i.key AND l.level='error' AND l.created_at > now() - interval '7 days') errors_7d,
      (SELECT count(*)::int FROM integration_logs l WHERE l.organization_id=i.organization_id AND l.integration_key=i.key AND l.created_at > now() - interval '7 days') events_7d
      FROM integrations i WHERE i.organization_id=$1 ORDER BY i.category, i.provider`, [ctx.orgId]);
    return { rows: rows.map(r => ({ ...r, config: undefined })), editable: can(ctx, 'integrations', 'edit') };
  });
  app.get('/api/v1/integrations/:key/logs', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'view');
    const { key } = req.params as any;
    await integrationOr404(ctx, key);
    const lp = listParams(req);
    const where = ['organization_id=$1', 'integration_key=$2']; const params: unknown[] = [ctx.orgId, key];
    if (lp.filters.level) { params.push(lp.filters.level); where.push(`level=$${params.length}`); }
    return paged({ select: '*', from: 'integration_logs', where, params, lp, searchCols: ['message'], sortMap: { created_at: 'created_at' }, defaultSort: 'created_at DESC' });
  });
  const integrationAction = (action: 'connect' | 'reconnect' | 'disconnect' | 'test' | 'sync' | 'simulate_error') => async (req: any) => {
    const ctx = staff(req); need(ctx, 'integrations', 'edit');
    const it = await integrationOr404(ctx, req.params.key);
    const before = { status: it.status, last_error: it.last_error };
    let status = it.status; let lastError = it.last_error; let message = ''; let level: 'info' | 'warn' | 'error' = 'info'; let ok = true;
    if (action === 'connect' || action === 'reconnect') { status = 'connected'; lastError = null; message = `${action === 'connect' ? 'Connected' : 'Reconnected'} to ${it.provider} (simulated OAuth, scopes: ${it.scopes.join(', ')})`; }
    else if (action === 'disconnect') { status = 'disconnected'; message = `Disconnected from ${it.provider}`; level = 'warn'; }
    else if (action === 'simulate_error') { status = 'error'; lastError = 'Simulated provider error: 503 Service Unavailable'; message = lastError; level = 'error'; }
    else if (action === 'test' || action === 'sync') {
      if (it.status !== 'connected') { ok = false; level = 'error'; message = `${action === 'test' ? 'Connection test' : 'Sync'} failed: ${it.status === 'disconnected' ? 'integration is disconnected — reconnect first' : it.last_error ?? 'provider error'}`; }
      else message = action === 'test' ? `Connection test passed — ${TEST_HINTS[it.key] ?? 'provider responded'} in ${80 + (crypto.randomInt(0, 220))} ms` : `Sync completed — ${crypto.randomInt(0, 12)} record(s) updated`;
    }
    await q(`UPDATE integrations SET status=$3, last_error=$4, last_sync_at=CASE WHEN $5::boolean THEN now() ELSE last_sync_at END, updated_at=now() WHERE organization_id=$1 AND key=$2`, [ctx.orgId, it.key, status, lastError, ok && ['connect', 'reconnect', 'sync', 'test'].includes(action)]);
    await logIntegration(ctx.orgId, it.key, level, message, { by: ctx.user.name, action });
    if (['connect', 'reconnect', 'disconnect', 'simulate_error'].includes(action)) await audit(ctx, `integration.${action}`, { type: 'integration', id: it.key, label: it.provider }, before, { status, last_error: lastError });
    if (status === 'error' && before.status !== 'error') {
      const ids = [...await usersWithRoles(ctx.orgId, ['owner', 'admin']), ...await subscribers(ctx.orgId, 'integration.error')].filter(u => u !== ctx.userId);
      await notify(ctx.orgId, ids, { event: 'integration.error', title: `${it.category} integration error`, body: `${it.provider}: ${lastError}`, link: '/settings/integrations' });
    }
    return { ok, status, message };
  };
  for (const a of ['connect', 'reconnect', 'disconnect', 'test', 'sync'] as const) app.post(`/api/v1/integrations/:key/${a}`, integrationAction(a));
  app.post('/api/v1/integrations/:key/simulate-error', integrationAction('simulate_error'));

  // ───────────── API keys ─────────────
  app.get('/api/v1/api-keys', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'view');
    return q(`SELECT k.id, k.name, k.prefix, k.scopes, k.last_used_at, k.created_at, k.revoked_at, u.name created_by_name FROM api_keys k LEFT JOIN users u ON u.id=k.created_by WHERE k.organization_id=$1 ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`, [ctx.orgId]);
  });
  app.post('/api/v1/api-keys', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'create');
    const b = z.object({ name: z.string().min(2).max(60), scopes: z.array(z.enum(['read', 'write'])).min(1).default(['read']) }).parse(req.body);
    const key = `vk_${randomToken(30)}`;
    const scopes = [...new Set(['read', ...b.scopes])];
    const r = await one<any>(`INSERT INTO api_keys (organization_id, name, prefix, key_hash, scopes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, prefix, scopes, created_at`, [ctx.orgId, b.name, key.slice(0, 10), sha256(key), scopes, ctx.userId]);
    await audit(ctx, 'api_key.created', { type: 'api_key', id: r.id, label: `${b.name} (${r.prefix}…)` }, null, { scopes });
    return { ...r, key, note: 'Copy this key now — it will not be shown again.' };
  });
  app.post('/api/v1/api-keys/:id/revoke', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'edit');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const k = await one<any>(`SELECT * FROM api_keys WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!k) throw notFound();
    if (k.revoked_at) throw conflict('This key is already revoked');
    await q(`UPDATE api_keys SET revoked_at=now() WHERE id=$1`, [id]);
    await q(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND active_organization_id=$2 AND user_agent='api-key' AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM api_keys k2 WHERE k2.created_by=$1 AND k2.organization_id=$2 AND k2.revoked_at IS NULL)`, [k.created_by, ctx.orgId]);
    await audit(ctx, 'api_key.revoked', { type: 'api_key', id, label: `${k.name} (${k.prefix}…)` }, { revoked: false }, { revoked: true });
    return { ok: true };
  });

  // ───────────── Webhooks ─────────────
  app.get('/api/v1/webhooks/events', async (req) => { staff(req); return [{ key: '*', label: 'All events', group: 'All' }, ...EVENT_CATALOG, { key: 'webhook.test', label: 'Test event', group: 'Admin' }]; });
  app.get('/api/v1/webhooks', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'view');
    const rows = await q<any>(`SELECT e.id, e.url, e.events, e.active, e.description, e.created_at, left(e.secret, 9) secret_prefix,
      (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id=e.id AND d.created_at > now() - interval '7 days') deliveries_7d,
      (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id=e.id AND d.status='failed' AND d.created_at > now() - interval '7 days') failed_7d,
      (SELECT max(d.created_at) FROM webhook_deliveries d WHERE d.endpoint_id=e.id) last_delivery_at
      FROM webhook_endpoints e WHERE e.organization_id=$1 ORDER BY e.created_at`, [ctx.orgId]);
    return { rows, receiver_url: `${API_URL}/api/v1/dev/webhook-receiver/${ctx.org.slug}`, editable: can(ctx, 'integrations', 'edit') };
  });
  const whBody = z.object({ url: z.string().url('Enter a full URL (https://…)').max(500), events: z.array(z.string().max(60)).min(1, 'Pick at least one event'), description: z.string().max(200).nullable().optional(), active: z.boolean().optional() });
  const validEvents = new Set(['*', 'webhook.test', ...EVENT_CATALOG.map(e => e.key)]);
  app.post('/api/v1/webhooks', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'create');
    const b = whBody.parse(req.body);
    const bad = b.events.filter(e => !validEvents.has(e)); if (bad.length) throw fieldError({ events: `Unknown event(s): ${bad.join(', ')}` });
    const secret = `whsec_${randomToken(18)}`;
    const r = await one<any>(`INSERT INTO webhook_endpoints (organization_id, url, secret, events, active, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, url, events, active, description, created_at`, [ctx.orgId, b.url, secret, b.events, b.active ?? true, b.description ?? null]);
    await audit(ctx, 'webhook.created', { type: 'webhook_endpoint', id: r.id, label: b.url }, null, { events: b.events });
    return { ...r, secret, note: 'Copy the signing secret now — it will not be shown again.' };
  });
  async function endpointOr404(ctx: Ctx, id: string) { if (!isUuid(id)) throw notFound(); const e = await one<any>(`SELECT * FROM webhook_endpoints WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!e) throw notFound(); return e; }
  app.patch('/api/v1/webhooks/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'edit');
    const e = await endpointOr404(ctx, (req.params as any).id);
    const b = whBody.partial().parse(req.body);
    if (b.events) { const bad = b.events.filter(x => !validEvents.has(x)); if (bad.length) throw fieldError({ events: `Unknown event(s): ${bad.join(', ')}` }); }
    await q(`UPDATE webhook_endpoints SET url=COALESCE($3,url), events=COALESCE($4,events), active=COALESCE($5,active), description=CASE WHEN $6::boolean THEN $7 ELSE description END WHERE id=$1 AND organization_id=$2`, [e.id, ctx.orgId, b.url ?? null, b.events ?? null, b.active ?? null, b.description !== undefined, b.description ?? null]);
    await audit(ctx, 'webhook.updated', { type: 'webhook_endpoint', id: e.id, label: b.url ?? e.url }, { url: e.url, events: e.events, active: e.active }, b);
    return { ok: true };
  });
  app.delete('/api/v1/webhooks/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'delete');
    const e = await endpointOr404(ctx, (req.params as any).id);
    await q(`DELETE FROM webhook_endpoints WHERE id=$1 AND organization_id=$2`, [e.id, ctx.orgId]);
    await audit(ctx, 'webhook.deleted', { type: 'webhook_endpoint', id: e.id, label: e.url }, { events: e.events }, null);
    return { ok: true };
  });
  app.post('/api/v1/webhooks/:id/rotate-secret', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'edit');
    const e = await endpointOr404(ctx, (req.params as any).id);
    const secret = `whsec_${randomToken(18)}`;
    await q(`UPDATE webhook_endpoints SET secret=$3 WHERE id=$1 AND organization_id=$2`, [e.id, ctx.orgId, secret]);
    await audit(ctx, 'webhook.secret_rotated', { type: 'webhook_endpoint', id: e.id, label: e.url });
    return { secret, note: 'Copy the new signing secret now — it will not be shown again.' };
  });
  app.post('/api/v1/webhooks/:id/test', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'edit');
    const e = await endpointOr404(ctx, (req.params as any).id);
    const id = await createDelivery(ctx.orgId, e, 'webhook.test', { message: 'This is a test event from VeyroApp', sent_by: ctx.user.name, endpoint_id: e.id });
    return { delivery_id: id };
  });
  app.get('/api/v1/webhooks/deliveries', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'view');
    const lp = listParams(req);
    const where = ['d.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`d.status=$${params.length}`); }
    if (lp.filters.event) { params.push(lp.filters.event); where.push(`d.event=$${params.length}`); }
    if (lp.filters.endpoint_id && isUuid(lp.filters.endpoint_id)) { params.push(lp.filters.endpoint_id); where.push(`d.endpoint_id=$${params.length}`); }
    return paged({ select: 'd.id, d.event, d.status, d.attempts, d.response_code, d.created_at, d.delivered_at, d.next_attempt_at, d.idempotency_key, e.url endpoint_url', from: 'webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id', where, params, lp,
      searchCols: ['d.event', 'e.url'], sortMap: { created_at: 'd.created_at', event: 'd.event', status: 'd.status', attempts: 'd.attempts' }, defaultSort: 'd.created_at DESC' });
  });
  app.get('/api/v1/webhooks/deliveries/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'view');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const d = await one<any>(`SELECT d.*, e.url endpoint_url FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1 AND d.organization_id=$2`, [id, ctx.orgId]);
    if (!d) throw notFound();
    return { ...d, headers: { 'content-type': 'application/json', 'x-veyro-event': d.event, 'x-veyro-delivery': d.id, 'x-veyro-signature': d.signature, 'x-veyro-idempotency-key': d.idempotency_key } };
  });
  app.post('/api/v1/webhooks/deliveries/:id/replay', async (req) => {
    const ctx = staff(req); need(ctx, 'integrations', 'edit');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const d = await one<any>(`SELECT d.*, e.secret, e.active FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1 AND d.organization_id=$2`, [id, ctx.orgId]);
    if (!d) throw notFound();
    if (!d.active) throw conflict('Enable the endpoint before replaying');
    const nid = crypto.randomUUID();
    const raw = JSON.stringify(d.payload);
    await q(`INSERT INTO webhook_deliveries (id, organization_id, endpoint_id, event, payload, signature, idempotency_key, status, next_attempt_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending', now())`, [nid, ctx.orgId, d.endpoint_id, d.event, raw, crypto.createHmac('sha256', d.secret).update(raw).digest('hex'), d.idempotency_key]);
    await enqueue('webhook.deliver', { deliveryId: nid }, { orgId: ctx.orgId, maxAttempts: 1 });
    await audit(ctx, 'webhook.replayed', { type: 'webhook_delivery', id: d.id, label: d.event }, null, { new_delivery: nid });
    return { delivery_id: nid };
  });

  // ───────────── Audit log ─────────────
  function auditWhere(ctx: Ctx, f: Record<string, string>) {
    const where = ['a.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (f.actor && isUuid(f.actor)) { params.push(f.actor); where.push(`a.actor_id=$${params.length}`); }
    if (f.action) { params.push(f.action.endsWith('.') ? `${f.action}%` : f.action.includes('%') ? f.action : `${f.action}%`); where.push(`a.action LIKE $${params.length}`); }
    if (f.entity) { params.push(f.entity); where.push(`a.entity_type=$${params.length}`); }
    if (f.from) { params.push(f.from); where.push(`a.created_at >= $${params.length}::date`); }
    if (f.to) { params.push(f.to); where.push(`a.created_at < ($${params.length}::date + 1)`); }
    if (f.impersonated === 'true') where.push('a.impersonator_id IS NOT NULL');
    if (f.search) { params.push(`%${f.search}%`); where.push(`(a.action ILIKE $${params.length} OR a.entity_label ILIKE $${params.length} OR a.actor_label ILIKE $${params.length} OR a.reason ILIKE $${params.length})`); }
    return { where, params };
  }
  app.get('/api/v1/audit', async (req) => {
    const ctx = staff(req); need(ctx, 'audit', 'view');
    const lp = listParams(req);
    const { where, params } = auditWhere(ctx, lp.filters);
    const res = await paged<any>({ select: `a.id::text id, a.created_at, a.actor_id, a.actor_label, a.action, a.entity_type, a.entity_id, a.entity_label, a.reason, a.ip, (a.before IS NOT NULL OR a.after IS NOT NULL) has_diff, iu.name impersonator_name`,
      from: 'audit_events a LEFT JOIN users iu ON iu.id=a.impersonator_id', where, params, lp, searchCols: ['a.action', 'a.entity_label', 'a.actor_label', 'a.reason', 'a.entity_type'],
      sortMap: { created_at: 'a.created_at', action: 'a.action', actor_label: 'a.actor_label' }, defaultSort: 'a.created_at DESC' });
    return res;
  });
  app.get('/api/v1/audit/facets', async (req) => {
    const ctx = staff(req); need(ctx, 'audit', 'view');
    const actions = await q<any>(`SELECT split_part(action,'.',1) prefix, count(*)::int n FROM audit_events WHERE organization_id=$1 GROUP BY 1 ORDER BY 2 DESC`, [ctx.orgId]);
    const entities = await q<any>(`SELECT entity_type, count(*)::int n FROM audit_events WHERE organization_id=$1 AND entity_type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [ctx.orgId]);
    const actors = await q<any>(`SELECT a.actor_id id, max(a.actor_label) name, count(*)::int n FROM audit_events a WHERE a.organization_id=$1 AND a.actor_id IS NOT NULL GROUP BY a.actor_id ORDER BY 3 DESC LIMIT 100`, [ctx.orgId]);
    const stats = await one<any>(`SELECT count(*)::int total, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int last_24h, count(*) FILTER (WHERE impersonator_id IS NOT NULL)::int impersonated,
      count(*) FILTER (WHERE action LIKE 'export%' OR action LIKE 'audit.exported%')::int exports, count(*) FILTER (WHERE action LIKE 'role.%' OR action LIKE 'member.%')::int access_changes FROM audit_events WHERE organization_id=$1`, [ctx.orgId]);
    return { actions, entities, actors, stats, can_export: can(ctx, 'audit', 'export') };
  });
  app.get('/api/v1/audit/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'audit', 'view');
    const { id } = req.params as any; if (!/^\d+$/.test(id)) throw notFound();
    const a = await one<any>(`SELECT a.*, a.id::text id, iu.name impersonator_name, u.email actor_email FROM audit_events a LEFT JOIN users iu ON iu.id=a.impersonator_id LEFT JOIN users u ON u.id=a.actor_id WHERE a.id=$1 AND a.organization_id=$2`, [id, ctx.orgId]);
    if (!a) throw notFound();
    const keys = [...new Set([...Object.keys(a.before && typeof a.before === 'object' ? a.before : {}), ...Object.keys(a.after && typeof a.after === 'object' ? a.after : {})])];
    const diff = keys.map(k => ({ key: k, before: a.before?.[k] ?? null, after: a.after?.[k] ?? null, changed: JSON.stringify(a.before?.[k] ?? null) !== JSON.stringify(a.after?.[k] ?? null) }));
    return { ...a, diff };
  });
  app.get('/api/v1/audit/export.csv', async (req, reply) => {
    const ctx = staff(req); need(ctx, 'audit', 'export');
    const f = (req.query ?? {}) as Record<string, string>;
    const { where, params } = auditWhere(ctx, f);
    const rows = await q<any>(`SELECT a.id, a.created_at, a.actor_label actor, iu.name impersonator, a.action, a.entity_type, a.entity_id, a.entity_label, a.reason, a.ip, a.before, a.after FROM audit_events a LEFT JOIN users iu ON iu.id=a.impersonator_id WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT 20000`, params);
    await audit(ctx, 'audit.exported', { type: 'audit_log', label: `${rows.length} rows` }, null, { filters: f, count: rows.length });
    const owners = (await usersWithRoles(ctx.orgId, ['owner', 'admin'])).filter(u => u !== ctx.userId);
    await notify(ctx.orgId, owners, { event: 'export.created', title: `${ctx.user.name} exported the audit log`, body: `${rows.length} rows`, link: '/settings/audit?action=audit.' });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    return toCsv(rows.map(r => ({ ...r, created_at: new Date(r.created_at).toISOString() })));
  });
  void tx;
}
