// Platform helpdesk (VeyroApp staff): ticket inbox views, SLA, internal notes, assignment, bulk actions, saved replies.
// Agencies open and reply to tickets from their Help Center (admin-support.ts); internal notes never reach them.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../core/db';
import { notFound } from '../core/errors';
import { audit } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { platform, auditAs, isUuid } from './_admin/common';
import { mrrFor } from './_admin/saas';

/** First-response targets by priority (hours). */
export const SLA_HOURS: Record<string, number> = { urgent: 1, high: 4, normal: 8, low: 24 };
export const slaInterval = (col = 't.priority') => `(CASE ${col} WHEN 'urgent' THEN interval '1 hour' WHEN 'high' THEN interval '4 hours' WHEN 'normal' THEN interval '8 hours' ELSE interval '24 hours' END)`;
const DUE = `COALESCE(t.sla_due_at, t.created_at + ${slaInterval()})`;
/** met | breached (answered late) | overdue (no answer, past due) | due_soon (<1h left) | on_track | none (resolved without reply) */
const SLA_STATE = `CASE
  WHEN t.first_response_at IS NOT NULL THEN CASE WHEN t.first_response_at <= ${DUE} THEN 'met' ELSE 'breached' END
  WHEN t.status = 'resolved' THEN 'none'
  WHEN now() > ${DUE} THEN 'overdue'
  WHEN now() > ${DUE} - interval '1 hour' THEN 'due_soon'
  ELSE 'on_track' END`;
const UNREAD = `(t.last_reply_by = 'agency' AND t.status <> 'resolved' AND (t.staff_read_at IS NULL OR t.staff_read_at < t.last_activity_at))`;
const PRIORITY_RANK = "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";

/** Inbox views → SQL condition ($1 = current admin's user id). */
const VIEWS: Record<string, string> = {
  unassigned: `t.status <> 'resolved' AND t.assigned_to IS NULL`,
  mine: `t.status <> 'resolved' AND t.assigned_to = $1`,
  open: `t.status = 'open'`,
  waiting: `t.status = 'pending'`,
  urgent: `t.status <> 'resolved' AND t.priority IN ('urgent','high')`,
  overdue: `t.status <> 'resolved' AND t.first_response_at IS NULL AND now() > ${DUE}`,
  resolved: `t.status = 'resolved'`,
  all: `TRUE`,
};

const CATEGORIES = ['general', 'billing', 'bug', 'how_to', 'feature_request', 'data_import', 'security'] as const;
const label = (s: string) => s === 'pending' ? 'Waiting on agency' : s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

async function ticketOr404(id: string) {
  if (!isUuid(id)) throw notFound();
  const t = await one<any>(`SELECT * FROM support_tickets WHERE id=$1`, [id]);
  if (!t) throw notFound();
  return t;
}
async function event(ticketId: string, authorId: string, body: string, meta: Record<string, unknown> = {}) {
  await q(`INSERT INTO support_ticket_replies (ticket_id, author_id, body, is_staff, kind, meta) VALUES ($1,$2,$3,true,'event',$4)`, [ticketId, authorId, body, JSON.stringify(meta)]);
}

const PatchBody = z.object({
  status: z.enum(['open', 'pending', 'resolved']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  category: z.enum(CATEGORIES).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(12).optional(),
});

/** Applies a patch, writing an event line for each visible change. Returns the human-readable changes. */
async function applyPatch(ctx: any, t: any, b: z.infer<typeof PatchBody>) {
  const changes: string[] = [];
  if (b.status && b.status !== t.status) changes.push(`changed status to ${label(b.status)}`);
  if (b.priority && b.priority !== t.priority) changes.push(`set priority to ${label(b.priority)}`);
  if (b.category && b.category !== t.category) changes.push(`set category to ${label(b.category)}`);
  if (b.assigned_to !== undefined && b.assigned_to !== t.assigned_to) {
    if (!b.assigned_to) changes.push('unassigned the ticket');
    else if (b.assigned_to === ctx.userId) changes.push('assigned the ticket to themselves');
    else { const u = await one<any>(`SELECT u.name FROM platform_admins p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND p.status='active'`, [b.assigned_to]); if (!u) throw notFound(); changes.push(`assigned the ticket to ${u.name}`); }
  }
  if (b.tags) { const add = b.tags.filter(x => !t.tags.includes(x)), rm = t.tags.filter((x: string) => !b.tags!.includes(x)); if (add.length) changes.push(`added tag${add.length > 1 ? 's' : ''} ${add.join(', ')}`); if (rm.length) changes.push(`removed tag${rm.length > 1 ? 's' : ''} ${rm.join(', ')}`); }
  const priorityChanged = b.priority && b.priority !== t.priority && !t.first_response_at;
  await q(`UPDATE support_tickets SET status=COALESCE($2,status), priority=COALESCE($3,priority), category=COALESCE($4,category), tags=COALESCE($5,tags),
      assigned_to=CASE WHEN $6::boolean THEN $7::uuid ELSE assigned_to END,
      resolved_at=CASE WHEN $2='resolved' AND status<>'resolved' THEN now() WHEN $2 IS NOT NULL AND $2<>'resolved' THEN NULL ELSE resolved_at END,
      sla_due_at=CASE WHEN $8::boolean THEN created_at + ${slaInterval('$3')} ELSE sla_due_at END,
      updated_at=now() WHERE id=$1`,
    [t.id, b.status ?? null, b.priority ?? null, b.category ?? null, b.tags ?? null, b.assigned_to !== undefined, b.assigned_to ?? null, !!priorityChanged]);
  for (const c of changes) await event(t.id, ctx.userId, c);
  if (b.status === 'resolved' && t.status !== 'resolved' && t.organization_id && t.created_by) await notify(t.organization_id, [t.created_by], { event: 'support.resolved', title: `Ticket resolved: ${t.subject}`, link: `/help/tickets?ticket=${t.id}` });
  if (changes.length) await audit(auditAs(ctx, t.organization_id), 'platform.ticket_updated', { type: 'support_ticket', id: t.id, label: t.subject }, { status: t.status, priority: t.priority, assigned_to: t.assigned_to }, b);
  return changes;
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/platform/tickets/views', async (req) => {
    const ctx = platform(req);
    const cols = Object.entries(VIEWS).map(([k, w]) => `count(*) FILTER (WHERE ${w})::int "${k}"`).join(', ');
    const counts = await one<any>(`SELECT ${cols}, count(*) FILTER (WHERE ${UNREAD})::int unread FROM support_tickets t`, [ctx.userId]);
    const stats = await one<any>(`SELECT
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (t.first_response_at - t.created_at)))) / 60)::int median_first_response_min,
        (100.0 * count(*) FILTER (WHERE t.first_response_at <= ${DUE}) / NULLIF(count(*) FILTER (WHERE t.first_response_at IS NOT NULL), 0))::int sla_met_pct,
        count(*) FILTER (WHERE t.resolved_at > now() - interval '7 days')::int resolved_7d
      FROM support_tickets t WHERE t.created_at > now() - interval '30 days'`);
    return { counts, stats };
  });

  app.get('/api/v1/platform/tickets', async (req) => {
    const ctx = platform(req);
    const lp = listParams(req);
    const view = VIEWS[lp.filters.view ?? ''] ? lp.filters.view : 'all';
    const where = [VIEWS[view], '$1::uuid IS NOT NULL']; const params: unknown[] = [ctx.userId];
    if (lp.filters.priority) { params.push(lp.filters.priority); where.push(`t.priority=$${params.length}`); }
    if (lp.filters.category) { params.push(lp.filters.category); where.push(`t.category=$${params.length}`); }
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`t.status=$${params.length}`); }
    if (lp.filters.tag) { params.push(lp.filters.tag); where.push(`$${params.length} = ANY(t.tags)`); }
    if (lp.filters.organization_id && isUuid(lp.filters.organization_id)) { params.push(lp.filters.organization_id); where.push(`t.organization_id=$${params.length}`); }
    if (lp.search && /^#?\d+$/.test(lp.search.trim())) { params.push(Number(lp.search.trim().replace('#', ''))); where.push(`t.number=$${params.length}`); lp.search = ''; }
    return paged({
      select: `t.id, t.number, t.subject, t.status, t.priority, t.category, t.tags, t.created_at, t.updated_at, t.last_activity_at, t.last_reply_by, t.assigned_to, t.organization_id,
        o.name org_name, u.name created_by_name, a.name assigned_to_name, a.avatar_color assigned_to_color, ${DUE} sla_due_at, ${SLA_STATE} sla_state, ${UNREAD} unread,
        (SELECT count(*)::int FROM support_ticket_replies r WHERE r.ticket_id=t.id AND r.kind='reply') replies,
        lp.preview, COALESCE(lp.preview_by, 'agency') preview_by`,
      from: `support_tickets t LEFT JOIN organizations o ON o.id=t.organization_id LEFT JOIN users u ON u.id=t.created_by LEFT JOIN users a ON a.id=t.assigned_to
        LEFT JOIN LATERAL (SELECT left(COALESCE(m.body, t.body), 160) preview, CASE WHEN m.kind='note' THEN 'note' WHEN m.is_staff THEN 'staff' ELSE 'agency' END preview_by, m.author_id preview_author
          FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT r.body, r.kind, r.is_staff, r.author_id FROM support_ticket_replies r WHERE r.ticket_id=t.id AND r.kind IN ('reply','note') ORDER BY r.created_at DESC LIMIT 1) m ON true) lp ON true`,
      where, params, lp, searchCols: ['t.subject', 't.body', 'o.name', 'u.name'],
      sortMap: { last_activity_at: 't.last_activity_at', created_at: 't.created_at', priority: PRIORITY_RANK, sla: DUE },
      defaultSort: view === 'resolved' || view === 'all' ? 't.last_activity_at DESC' : `${UNREAD} DESC, ${PRIORITY_RANK}, ${DUE}`,
    });
  });

  app.get('/api/v1/platform/tickets/:id', async (req) => {
    const ctx = platform(req);
    const t0 = await ticketOr404((req.params as any).id);
    const t = await one<any>(`SELECT t.*, o.name org_name, o.slug org_slug, u.name created_by_name, u.email created_by_email, u.avatar_color created_by_color, a.name assigned_to_name,
        ${DUE} sla_due_at, ${SLA_STATE} sla_state
      FROM support_tickets t LEFT JOIN organizations o ON o.id=t.organization_id LEFT JOIN users u ON u.id=t.created_by LEFT JOIN users a ON a.id=t.assigned_to WHERE t.id=$1`, [t0.id]);
    const thread = await q<any>(`SELECT r.id, r.body, r.is_staff, r.kind, r.meta, r.created_at, u.name author_name, u.avatar_color author_color FROM support_ticket_replies r LEFT JOIN users u ON u.id=r.author_id WHERE r.ticket_id=$1 ORDER BY r.created_at`, [t.id]);
    const admins = await q<any>(`SELECT u.id, u.name, u.avatar_color FROM platform_admins p JOIN users u ON u.id=p.user_id WHERE p.status='active' AND (p.expires_at IS NULL OR p.expires_at > now()) ORDER BY u.name`);
    let agency: any = null;
    if (t.organization_id) {
      agency = await one<any>(`SELECT o.id, o.name, o.slug, o.created_at, s.status sub_status, s.plan_key, p.name plan_name, s.comped, s.trial_ends_at,
          (SELECT count(*)::int FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=o.id AND m.status='active' AND r.kind='agency') staff,
          (SELECT count(*)::int FROM support_tickets x WHERE x.organization_id=o.id AND x.status <> 'resolved') open_tickets,
          (SELECT count(*)::int FROM support_tickets x WHERE x.organization_id=o.id) total_tickets
        FROM organizations o LEFT JOIN subscriptions s ON s.organization_id=o.id LEFT JOIN plans p ON p.key=s.plan_key WHERE o.id=$1`, [t.organization_id]).catch(() => null);
      if (agency) { const m = await mrrFor(t.organization_id).catch(() => null); agency.mrr_cents = m?.net ?? null; agency.seats = m?.seats ?? null; }
    }
    const related = await q<any>(`SELECT id, number, subject, status, created_at FROM support_tickets WHERE id <> $1 AND (created_by=$2 OR organization_id=$3) ORDER BY created_at DESC LIMIT 5`, [t.id, t.created_by, t.organization_id]);
    await q(`UPDATE support_tickets SET staff_read_at=now() WHERE id=$1`, [t.id]);
    void ctx;
    return { ...t, thread, admins, agency, related };
  });

  app.post('/api/v1/platform/tickets/:id/replies', async (req) => {
    const ctx = platform(req);
    const t = await ticketOr404((req.params as any).id);
    const b = z.object({ body: z.string().trim().min(1).max(8000), kind: z.enum(['reply', 'note']).default('reply'), status: z.enum(['open', 'pending', 'resolved']).optional() }).parse(req.body);
    const r = await one<any>(`INSERT INTO support_ticket_replies (ticket_id, author_id, body, is_staff, kind) VALUES ($1,$2,$3,true,$4) RETURNING *`, [t.id, ctx.userId, b.body, b.kind]);
    if (b.kind === 'reply') {
      await q(`UPDATE support_tickets SET first_response_at=COALESCE(first_response_at, now()), last_reply_by='staff', last_activity_at=now(), staff_read_at=now(),
          assigned_to=COALESCE(assigned_to,$2), updated_at=now() WHERE id=$1`, [t.id, ctx.userId]);
      if (!t.assigned_to) await event(t.id, ctx.userId, 'assigned the ticket to themselves');
      if (t.organization_id && t.created_by) await notify(t.organization_id, [t.created_by], { event: 'support.reply', title: `VeyroApp Support replied: ${t.subject}`, body: b.body.slice(0, 160), link: `/help/tickets?ticket=${t.id}` });
    } else {
      await q(`UPDATE support_tickets SET staff_read_at=now(), updated_at=now() WHERE id=$1`, [t.id]);
    }
    // A reply defaults to "waiting on agency"; a note leaves the status alone unless one is chosen.
    const status = b.status ?? (b.kind === 'reply' && t.status === 'open' ? 'pending' : undefined);
    if (status && status !== t.status) await applyPatch(ctx, { ...t, assigned_to: t.assigned_to ?? ctx.userId }, { status });
    return r;
  });

  app.patch('/api/v1/platform/tickets/:id', async (req) => {
    const ctx = platform(req);
    const t = await ticketOr404((req.params as any).id);
    const changes = await applyPatch(ctx, t, PatchBody.parse(req.body));
    return { ok: true, changes };
  });

  app.post('/api/v1/platform/tickets/bulk', async (req) => {
    const ctx = platform(req);
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(200), patch: PatchBody }).parse(req.body);
    const rows = await q<any>(`SELECT * FROM support_tickets WHERE id = ANY($1)`, [b.ids]);
    let changed = 0;
    for (const t of rows) if ((await applyPatch(ctx, t, b.patch)).length) changed++;
    return { ok: true, changed };
  });

  app.get('/api/v1/platform/tickets-tags', async (req) => {
    platform(req);
    return (await q<any>(`SELECT tag, count(*)::int n FROM support_tickets, unnest(tags) tag GROUP BY tag ORDER BY n DESC, tag LIMIT 50`)).map(r => r.tag);
  });

  // ── Saved replies ──
  app.get('/api/v1/platform/support/macros', async (req) => {
    platform(req);
    return q(`SELECT m.id, m.title, m.body, m.created_at, u.name created_by_name FROM support_macros m LEFT JOIN users u ON u.id=m.created_by ORDER BY m.title`);
  });
  app.post('/api/v1/platform/support/macros', async (req) => {
    const ctx = platform(req);
    const b = z.object({ title: z.string().trim().min(2).max(80), body: z.string().trim().min(2).max(8000) }).parse(req.body);
    return one(`INSERT INTO support_macros (title, body, created_by) VALUES ($1,$2,$3) RETURNING *`, [b.title, b.body, ctx.userId]);
  });
  app.put('/api/v1/platform/support/macros/:id', async (req) => {
    platform(req);
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const b = z.object({ title: z.string().trim().min(2).max(80), body: z.string().trim().min(2).max(8000) }).parse(req.body);
    const r = await one(`UPDATE support_macros SET title=$2, body=$3 WHERE id=$1 RETURNING *`, [id, b.title, b.body]);
    if (!r) throw notFound();
    return r;
  });
  app.delete('/api/v1/platform/support/macros/:id', async (req) => {
    platform(req);
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    await q(`DELETE FROM support_macros WHERE id=$1`, [id]);
    return { ok: true };
  });
}
