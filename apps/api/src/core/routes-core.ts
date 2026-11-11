import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { one, q } from './db';
import { auth, staff, getOr404 } from './context';
import { notFound, forbidden, HttpError } from './errors';
import { IS_PROD } from './env';
import { addConn } from './realtime';
import { verifySignature, resolveSafe, MIME } from './storage';
import { activity } from './audit';
import { notify } from './notify';
import { listParams, paged } from './list';
import QRCode from 'qrcode';
import { audit } from './audit';
import { can as canDo } from './context';

export default async function coreRoutes(app: FastifyInstance) {
  app.get('/api/v1/health', { config: { public: true } }, async () => {
    const db = await one<any>(`SELECT now() t`);
    const jobs = await one<any>(`SELECT count(*) FILTER (WHERE status='queued')::int queued, count(*) FILTER (WHERE status='failed')::int failed FROM jobs`);
    return { ok: true, db: !!db, time: db?.t, jobs };
  });

  // ── Realtime (SSE) ──
  app.get('/api/v1/stream', async (req, reply) => {
    const ctx = auth(req);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ orgId: ctx.orgId })}\n\n`);
    const remove = addConn({ userId: ctx.userId, orgId: ctx.orgId, reply });
    req.raw.on('close', () => remove());
    return reply.hijack();
  });

  // ── Notifications ──
  app.get('/api/v1/notifications', async (req) => {
    const ctx = auth(req);
    const { unread } = req.query as { unread?: string };
    const rows = await q(`SELECT * FROM notifications WHERE user_id=$1 AND organization_id=$2 ${unread ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 50`, [ctx.userId, ctx.orgId]);
    const c = await one<any>(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND organization_id=$2 AND read_at IS NULL`, [ctx.userId, ctx.orgId]);
    return { rows, unread: c.n };
  });
  app.post('/api/v1/notifications/:id/read', async (req) => {
    const ctx = auth(req);
    await q(`UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND organization_id=$3`, [(req.params as any).id, ctx.userId, ctx.orgId]);
    return { ok: true };
  });
  app.post('/api/v1/notifications/read-all', async (req) => {
    const ctx = auth(req);
    await q(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND organization_id=$2 AND read_at IS NULL`, [ctx.userId, ctx.orgId]);
    return { ok: true };
  });

  // ── Timeline (activities) for any record + notes with @mentions ──
  const ENTITY_TABLE: Record<string, string> = { company: 'companies', contact: 'contacts', opportunity: 'opportunities', position: 'positions', candidate: 'candidates', placement: 'placements', worker: 'workers', invoice: 'invoices', task: 'tasks', payroll_run: 'payroll_runs', offer: 'offers', interview: 'interviews', submission: 'candidate_submissions', timesheet: 'timesheets', document: 'documents' };
  app.get('/api/v1/timeline/:type/:id', async (req) => {
    const ctx = staff(req);
    const { type, id } = req.params as { type: string; id: string };
    if (!ENTITY_TABLE[type]) throw notFound();
    await getOr404(ENTITY_TABLE[type], ctx, id);
    return q(`SELECT a.*, u.name actor_name, u.avatar_color actor_color FROM activities a LEFT JOIN users u ON u.id=a.actor_id WHERE a.organization_id=$1 AND a.entity_type=$2 AND a.entity_id=$3 ORDER BY a.created_at DESC LIMIT 200`, [ctx.orgId, type, id]);
  });
  app.post('/api/v1/timeline/:type/:id', async (req) => {
    const ctx = staff(req);
    const { type, id } = req.params as { type: string; id: string };
    if (!ENTITY_TABLE[type]) throw notFound();
    await getOr404(ENTITY_TABLE[type], ctx, id);
    const b = z.object({ kind: z.enum(['note', 'call', 'email', 'meeting', 'message']).default('note'), title: z.string().max(200).optional(), body: z.string().min(1).max(5000), mentions: z.array(z.string().uuid()).default([]) }).parse(req.body);
    const titles: Record<string, string> = { note: 'Note', call: 'Logged a call', email: 'Logged an email', meeting: 'Logged a meeting', message: 'Message' };
    const aid = await activity(ctx, type, id, b.kind, b.title || titles[b.kind], b.body, { mentions: b.mentions });
    // @mentions → only members of this org
    const valid = await q<any>(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND user_id = ANY($2) AND status='active'`, [ctx.orgId, b.mentions]);
    for (const m of valid) await q(`INSERT INTO mentions (organization_id, activity_id, user_id) VALUES ($1,$2,$3)`, [ctx.orgId, aid, m.user_id]);
    const linkBase: Record<string, string> = { company: '/crm/companies', contact: '/crm/contacts', opportunity: '/crm/opportunities', position: '/recruiting/positions', candidate: '/recruiting/candidates', placement: '/workforce/placements', worker: '/workforce/workers', invoice: '/finance/invoices', task: '/crm/tasks' };
    await notify(ctx.orgId, valid.map(v => v.user_id).filter(u => u !== ctx.userId), { event: 'mention', title: `${ctx.user.name} mentioned you`, body: b.body.slice(0, 160), link: linkBase[type] ? `${linkBase[type]}/${id}` : null });
    // lead scoring nudges for engagement
    if (type === 'company' && ['call', 'meeting', 'email'].includes(b.kind)) {
      const delta = b.kind === 'meeting' ? 10 : 5;
      await q(`INSERT INTO lead_score_events (organization_id, company_id, delta, reason) VALUES ($1,$2,$3,$4)`, [ctx.orgId, id, delta, `${titles[b.kind]}`]);
      await q(`UPDATE companies SET lead_score=LEAST(100, lead_score+$3), lead_status=CASE WHEN lead_status='new' THEN 'contacted' ELSE lead_status END, updated_at=now() WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId, delta]);
    }
    return one(`SELECT a.*, u.name actor_name FROM activities a LEFT JOIN users u ON u.id=a.actor_id WHERE a.id=$1`, [aid]);
  });

  // Sidebar badges: new leads, timesheets awaiting approval, unread inbox threads (each permission-gated).
  app.get('/api/v1/nav-counts', async (req) => {
    const ctx = staff(req);
    const out: Record<string, number> = {};
    if (canDo(ctx, 'leads', 'view')) out.leads = (await one<any>(`SELECT count(*)::int n FROM companies WHERE organization_id=$1 AND stage IN ('lead','qualified') AND lead_status='new' AND archived_at IS NULL`, [ctx.orgId])).n;
    if (canDo(ctx, 'timesheets', 'view')) out.timesheets = (await one<any>(`SELECT count(*)::int n FROM timesheets WHERE organization_id=$1 AND status='submitted'`, [ctx.orgId])).n;
    if (canDo(ctx, 'messages', 'view')) out.inbox = (await one<any>(`SELECT count(*)::int n FROM thread_participants tp JOIN message_threads t ON t.id=tp.thread_id WHERE t.organization_id=$1 AND tp.user_id=$2 AND (tp.last_read_at IS NULL OR tp.last_read_at < t.last_message_at)`, [ctx.orgId, ctx.userId])).n;
    return out;
  });

  // Members of the current org (for assignee pickers, @mentions)
  app.get('/api/v1/members', async (req) => {
    const ctx = staff(req);
    return q(`SELECT u.id, u.name, u.email, u.avatar_color, r.key role_key, r.name role_name, m.recruiting_scope, m.team FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.kind='agency' ORDER BY u.name`, [ctx.orgId]);
  });

  // QR codes generated locally (sourcing links, pay links).
  app.get('/api/v1/qr', { config: { public: true } }, async (req, reply) => {
    const { text } = req.query as { text?: string };
    if (!text || text.length > 2000) throw notFound();
    const png = await QRCode.toBuffer(text, { width: 320, margin: 1, color: { dark: '#0A0E16', light: '#FFFFFF' } });
    reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=86400');
    return reply.send(png);
  });

  // Every list export is audited (sensitive exports included).
  app.post('/api/v1/exports/log', async (req) => {
    const ctx = staff(req);
    const b = z.object({ resource: z.string().max(60), count: z.number().int().min(0), filters: z.record(z.any()).default({}) }).parse(req.body);
    const res = b.resource as any;
    if (!canDo(ctx, res, 'export') && !canDo(ctx, 'exports', 'create') && !canDo(ctx, res, 'view')) throw forbidden();
    await audit(ctx, 'export.csv', { type: b.resource, label: `${b.count} rows` }, null, { filters: b.filters, count: b.count });
    return { ok: true };
  });

  // ── Signed file serving ──
  app.get('/files/*', { config: { public: true } }, async (req, reply) => {
    const rel = decodeURIComponent((req.params as any)['*'] as string);
    const { exp, sig, dl } = req.query as Record<string, string>;
    if (!verifySignature(rel, exp, sig)) throw forbidden('This link has expired. Refresh the page to get a new one.');
    let abs: string;
    try { abs = resolveSafe(rel); } catch { throw notFound(); }
    if (!fs.existsSync(abs)) throw notFound();
    const ext = path.extname(abs).slice(1).toLowerCase();
    reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
    reply.header('Cache-Control', 'private, max-age=600');
    if (dl) reply.header('Content-Disposition', `attachment; filename="${dl.replace(/"/g, '')}"`);
    return reply.send(fs.createReadStream(abs));
  });

  // ── Dev Outbox (local demo only) ──
  // In production it holds password-reset links, so it is limited to signed-in staff and their own workspace.
  app.get('/api/v1/dev/outbox', { config: { public: !IS_PROD } }, async (req) => {
    const lp = listParams(req);
    const where: string[] = []; const params: unknown[] = [];
    if (IS_PROD) { if (!req.ctx || req.ctx.role.kind !== 'agency') throw new HttpError(403, 'Not available'); params.push(req.ctx.orgId); where.push(`o.organization_id=$${params.length}`); }
    if (lp.filters.channel) { params.push(lp.filters.channel); where.push(`channel=$${params.length}`); }
    if (lp.filters.to) { params.push(`%${lp.filters.to}%`); where.push(`to_address ILIKE $${params.length}`); }
    return paged({ select: 'o.*, org.name org_name', from: 'outbox_messages o LEFT JOIN organizations org ON org.id=o.organization_id', where, params, lp: { ...lp, pageSize: Math.min(lp.pageSize, 100) }, searchCols: ['o.subject', 'o.body_text', 'o.to_address'], sortMap: { created_at: 'o.created_at' }, defaultSort: 'o.created_at DESC' });
  });

  // ── Local webhook receiver (for demoing outbound webhooks) ──
  app.post('/api/v1/dev/webhook-receiver/:slug', { config: { public: true } }, async (req) => {
    if (IS_PROD) throw new HttpError(404, 'Not found');
    const { slug } = req.params as { slug: string };
    const sig = String(req.headers['x-veyro-signature'] ?? '');
    const ep = await one<any>(`SELECT e.secret FROM webhook_endpoints e JOIN organizations o ON o.id=e.organization_id WHERE o.slug=$1 AND e.url LIKE '%' || $1 LIMIT 1`, [slug]);
    const raw = JSON.stringify(req.body ?? {});
    const valid = ep ? sig === crypto.createHmac('sha256', ep.secret).update(raw).digest('hex') : false;
    await q(`INSERT INTO webhook_receiver_log (path, headers, body, signature_valid) VALUES ($1,$2,$3,$4)`, [`/${slug}`, JSON.stringify({ 'x-veyro-event': req.headers['x-veyro-event'], 'x-veyro-signature': sig, 'x-veyro-delivery': req.headers['x-veyro-delivery'] }), raw, valid]);
    return { received: true, signatureValid: valid };
  });
  app.get('/api/v1/dev/webhook-receiver', { config: { public: true } }, async () => IS_PROD ? Promise.reject(new HttpError(404, 'Not found')) : q(`SELECT * FROM webhook_receiver_log ORDER BY received_at DESC LIMIT 100`));
}
