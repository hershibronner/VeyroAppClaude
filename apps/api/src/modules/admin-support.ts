// Help Center → Support tickets (agency side). Tickets are visible to VeyroApp staff in the Platform Control Center.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../core/db';
import { staff, can, type Ctx } from '../core/context';
import { conflict, notFound } from '../core/errors';
import { listParams, paged } from '../core/list';
import { audit } from '../core/audit';
import { isUuid, notifyPlatform } from './_admin/common';

/** Owners/admins see every ticket of the agency; other staff see the ones they opened. */
const seesAll = (ctx: Ctx) => can(ctx, 'settings', 'view') || ['owner', 'admin'].includes(ctx.role.key);

async function ticketOr404(ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const t = await one<any>(`SELECT t.*, u.name created_by_name, a.name assigned_to_name FROM support_tickets t LEFT JOIN users u ON u.id=t.created_by LEFT JOIN users a ON a.id=t.assigned_to WHERE t.id=$1 AND t.organization_id=$2`, [id, ctx.orgId]);
  if (!t || (!seesAll(ctx) && t.created_by !== ctx.userId)) throw notFound();
  return t;
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/support/tickets', async (req) => {
    const ctx = staff(req);
    const lp = listParams(req);
    const where = ['t.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (!seesAll(ctx) || lp.filters.mine === 'true') { params.push(ctx.userId); where.push(`t.created_by=$${params.length}`); }
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`t.status=$${params.length}`); }
    if (lp.filters.category) { params.push(lp.filters.category); where.push(`t.category=$${params.length}`); }
    return paged({ select: `t.id, t.subject, t.status, t.priority, t.category, t.created_at, t.updated_at, u.name created_by_name, (SELECT count(*)::int FROM support_ticket_replies r WHERE r.ticket_id=t.id) replies,
        (SELECT r.is_staff FROM support_ticket_replies r WHERE r.ticket_id=t.id ORDER BY r.created_at DESC LIMIT 1) last_reply_staff`,
      from: 'support_tickets t LEFT JOIN users u ON u.id=t.created_by', where, params, lp, searchCols: ['t.subject', 't.body'],
      sortMap: { created_at: 't.created_at', updated_at: 't.updated_at', status: 't.status', priority: "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END" }, defaultSort: 't.updated_at DESC' });
  });
  app.get('/api/v1/support/summary', async (req) => {
    const ctx = staff(req);
    const mine = !seesAll(ctx);
    return one(`SELECT count(*) FILTER (WHERE status='open')::int open, count(*) FILTER (WHERE status='pending')::int pending, count(*) FILTER (WHERE status='resolved')::int resolved, count(*)::int total,
      (avg(EXTRACT(EPOCH FROM ((SELECT min(r.created_at) FROM support_ticket_replies r WHERE r.ticket_id=t.id AND r.is_staff) - t.created_at)))/3600)::numeric(10,1) avg_first_response_hours
      FROM support_tickets t WHERE t.organization_id=$1 ${mine ? 'AND t.created_by=$2' : ''}`, mine ? [ctx.orgId, ctx.userId] : [ctx.orgId]);
  });
  app.get('/api/v1/support/tickets/:id', async (req) => {
    const ctx = staff(req);
    const t = await ticketOr404(ctx, (req.params as any).id);
    const replies = await q<any>(`SELECT r.id, r.body, r.is_staff, r.created_at, CASE WHEN r.is_staff THEN 'VeyroApp Support' ELSE u.name END author_name, u.name author_real FROM support_ticket_replies r LEFT JOIN users u ON u.id=r.author_id WHERE r.ticket_id=$1 ORDER BY r.created_at`, [t.id]);
    return { ...t, replies: replies.map(r => ({ ...r, author_real: r.is_staff ? undefined : r.author_real })), assigned_to_name: t.assigned_to ? 'VeyroApp Support' : null };
  });
  app.post('/api/v1/support/tickets', async (req) => {
    const ctx = staff(req);
    const b = z.object({ subject: z.string().min(4).max(160), body: z.string().min(10, 'Describe the problem (10+ characters)').max(5000), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'), category: z.enum(['general', 'billing', 'bug', 'how_to', 'feature_request', 'data_import', 'security']).default('general') }).parse(req.body);
    const t = await one<any>(`INSERT INTO support_tickets (organization_id, subject, body, status, priority, category, created_by) VALUES ($1,$2,$3,'open',$4,$5,$6) RETURNING *`, [ctx.orgId, b.subject, b.body, b.priority, b.category, ctx.userId]);
    await notifyPlatform(`New ${b.priority === 'normal' ? '' : b.priority + ' '}ticket from ${ctx.org.name}`, b.subject, `/platform/tickets?ticket=${t.id}`, 'support');
    await audit(ctx, 'support.ticket_created', { type: 'support_ticket', id: t.id, label: b.subject }, null, { priority: b.priority, category: b.category });
    return t;
  });
  app.post('/api/v1/support/tickets/:id/replies', async (req) => {
    const ctx = staff(req);
    const t = await ticketOr404(ctx, (req.params as any).id);
    const b = z.object({ body: z.string().min(1).max(5000) }).parse(req.body);
    const r = await one<any>(`INSERT INTO support_ticket_replies (ticket_id, author_id, body, is_staff) VALUES ($1,$2,$3,false) RETURNING *`, [t.id, ctx.userId, b.body]);
    await q(`UPDATE support_tickets SET status=CASE WHEN status IN ('pending','resolved') THEN 'open' ELSE status END, updated_at=now() WHERE id=$1`, [t.id]);
    await notifyPlatform(`Reply from ${ctx.org.name}: ${t.subject}`, b.body.slice(0, 160), `/platform/tickets?ticket=${t.id}`, 'support');
    return r;
  });
  app.post('/api/v1/support/tickets/:id/:action', async (req) => {
    const ctx = staff(req);
    const { action } = req.params as any;
    if (!['resolve', 'reopen'].includes(action)) throw notFound();
    const t = await ticketOr404(ctx, (req.params as any).id);
    const to = action === 'resolve' ? 'resolved' : 'open';
    if (t.status === to) throw conflict(`This ticket is already ${to}`);
    await q(`UPDATE support_tickets SET status=$2, updated_at=now() WHERE id=$1`, [t.id, to]);
    await audit(ctx, `support.ticket_${action === 'resolve' ? 'resolved' : 'reopened'}`, { type: 'support_ticket', id: t.id, label: t.subject }, { status: t.status }, { status: to });
    return { ok: true, status: to };
  });
}
