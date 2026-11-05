// OPS: Inbox — message threads (internal + client / worker / candidate), read state, live notifications, portal messaging.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, one, tx } from '../core/db';
import { auth, staff, need, can, type Ctx } from '../core/context';
import { badRequest, notFound } from '../core/errors';
import { notify, usersWithRoles } from '../core/notify';
import { emit } from '../core/events';
import { listParams, paged } from '../core/list';
import { sendMessage } from '../adapters/messaging';
import { rateLimit } from '../core/ratelimit';

type Kind = 'internal' | 'client' | 'worker' | 'candidate';
const linkForKind = (kind: string, threadId: string) => (kind === 'agency' ? `/comms/inbox?thread=${threadId}` : `/portal/${kind}/messages?thread=${threadId}`);

/** Participants of a thread with their role kind in this org. */
async function participants(orgId: string, threadId: string) {
  return q<any>(`SELECT tp.user_id, tp.last_read_at, u.name, u.email, u.avatar_color, COALESCE(r.kind, 'agency') kind, r.name role_name, co.name company_name
    FROM thread_participants tp JOIN users u ON u.id=tp.user_id
    LEFT JOIN organization_memberships m ON m.user_id=tp.user_id AND m.organization_id=$1 LEFT JOIN roles r ON r.id=m.role_id LEFT JOIN companies co ON co.id=m.company_id
    WHERE tp.thread_id=$2 ORDER BY (COALESCE(r.kind,'agency')='agency') DESC, u.name`, [orgId, threadId]);
}

async function threadFor(ctx: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const t = await one<any>(`SELECT t.* FROM message_threads t JOIN thread_participants tp ON tp.thread_id=t.id AND tp.user_id=$3 WHERE t.id=$1 AND t.organization_id=$2`, [id, ctx.orgId, ctx.userId]);
  if (!t) throw notFound();
  return t;
}

async function threadDetail(ctx: Ctx, id: string) {
  const t = await threadFor(ctx, id);
  const parts = await participants(ctx.orgId, id);
  const msgs = await q<any>(`SELECT m.id, m.body, m.channel, m.created_at, m.author_id, u.name author_name, u.avatar_color author_color, COALESCE(r.kind,'agency') author_kind
    FROM messages m LEFT JOIN users u ON u.id=m.author_id LEFT JOIN organization_memberships om ON om.user_id=m.author_id AND om.organization_id=m.organization_id LEFT JOIN roles r ON r.id=om.role_id
    WHERE m.thread_id=$1 AND m.organization_id=$2 ORDER BY m.created_at ASC LIMIT 500`, [id, ctx.orgId]);
  await q(`UPDATE thread_participants SET last_read_at=now() WHERE thread_id=$1 AND user_id=$2`, [id, ctx.userId]);
  let related: { type: string; id: string; label: string | null } | null = null;
  if (t.related_type && t.related_id && ctx.role.kind === 'agency') {
    const lbl = await one<any>(`SELECT CASE $1::text WHEN 'company' THEN (SELECT name FROM companies WHERE id=$2) WHEN 'worker' THEN (SELECT concat_ws(' ',c.first_name,c.last_name) FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.id=$2) WHEN 'candidate' THEN (SELECT concat_ws(' ',first_name,last_name) FROM candidates WHERE id=$2) WHEN 'placement' THEN (SELECT title FROM placements WHERE id=$2) ELSE NULL END l`, [t.related_type, t.related_id]);
    related = { type: t.related_type, id: t.related_id, label: lbl?.l ?? null };
  }
  return { ...t, related, participants: parts.map(p => ({ id: p.user_id, name: p.name, kind: p.kind, role_name: p.role_name, company_name: p.company_name, avatar_color: p.avatar_color, last_read_at: p.last_read_at, ...(ctx.role.kind === 'agency' ? { email: p.email } : {}) })), messages: msgs, me: ctx.userId };
}

async function listThreads(req: FastifyRequest, ctx: Ctx) {
  const lp = listParams(req);
  const where = ['t.organization_id=$1', 'EXISTS (SELECT 1 FROM thread_participants tp WHERE tp.thread_id=t.id AND tp.user_id=$2)'];
  const params: unknown[] = [ctx.orgId, ctx.userId];
  if (lp.filters.kind) { params.push(lp.filters.kind); where.push(`t.kind=$${params.length}`); }
  if (lp.filters.unread === 'true' || lp.filters.unread === '1') where.push(`EXISTS (SELECT 1 FROM messages mm JOIN thread_participants me ON me.thread_id=mm.thread_id AND me.user_id=$2 WHERE mm.thread_id=t.id AND mm.author_id IS DISTINCT FROM $2 AND mm.created_at > COALESCE(me.last_read_at, 'epoch'))`);
  if (lp.search) { params.push(`%${lp.search}%`); where.push(`(t.subject ILIKE $${params.length} OR EXISTS (SELECT 1 FROM messages sm WHERE sm.thread_id=t.id AND sm.body ILIKE $${params.length}))`); }
  return paged({
    select: `t.id, t.subject, t.kind, t.related_type, t.related_id, t.last_message_at, t.created_at,
      (SELECT json_build_object('body', left(m.body, 160), 'author', u.name, 'at', m.created_at) FROM messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.thread_id=t.id ORDER BY m.created_at DESC LIMIT 1) last_message,
      (SELECT count(*) FROM messages m JOIN thread_participants me ON me.thread_id=m.thread_id AND me.user_id=$2 WHERE m.thread_id=t.id AND m.author_id IS DISTINCT FROM $2 AND m.created_at > COALESCE(me.last_read_at, 'epoch'))::int unread,
      (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'color', u.avatar_color) ORDER BY u.name) FROM thread_participants p JOIN users u ON u.id=p.user_id WHERE p.thread_id=t.id AND p.user_id <> $2) others`,
    from: 'message_threads t', where, params, lp: { ...lp, search: '' }, sortMap: { last_message_at: 't.last_message_at', subject: 't.subject' }, defaultSort: 't.last_message_at DESC',
  });
}

/** Posts a message; notifies other participants live (SSE) and optionally delivers externally via the Dev Outbox. */
async function postMessage(ctx: Ctx, threadId: string, body: string, channel: 'in_app' | 'email' | 'sms' | 'whatsapp' = 'in_app') {
  const t = await threadFor(ctx, threadId);
  const m = await one<any>(`INSERT INTO messages (organization_id, thread_id, author_id, body, channel) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [ctx.orgId, threadId, ctx.userId, body, channel]);
  await q(`UPDATE message_threads SET last_message_at=now() WHERE id=$1`, [threadId]);
  await q(`UPDATE thread_participants SET last_read_at=now() WHERE thread_id=$1 AND user_id=$2`, [threadId, ctx.userId]);
  const parts = (await participants(ctx.orgId, threadId)).filter(p => p.user_id !== ctx.userId);
  const byKind = new Map<string, string[]>();
  for (const p of parts) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p.user_id]);
  for (const [kind, ids] of byKind) await notify(ctx.orgId, ids, { event: 'message', title: `${ctx.user.name}: ${t.subject}`, body: body.slice(0, 160), link: linkForKind(kind, threadId) });
  // External delivery (simulated email / SMS / WhatsApp) to the thread's external party.
  if (channel !== 'in_app' && ctx.role.kind === 'agency') {
    const dest = await externalAddress(ctx.orgId, t, channel);
    if (!dest) throw badRequest(`No ${channel === 'email' ? 'email address' : 'phone number'} on file for this ${t.kind}`);
    await sendMessage({ orgId: ctx.orgId, channel, to: dest, subject: channel === 'email' ? t.subject : undefined, text: body, related: t.related_type && t.related_id ? { type: t.related_type, id: t.related_id } : undefined });
  }
  if (ctx.role.kind !== 'agency') await emit(ctx.orgId, 'message.received', { thread_id: threadId, thread_kind: t.kind, author_id: ctx.userId, author_name: ctx.user.name, company_id: ctx.companyId, worker_id: ctx.workerId, candidate_id: ctx.candidateId });
  return { ...m, author_name: ctx.user.name, author_kind: ctx.role.kind };
}

async function externalAddress(orgId: string, t: any, channel: string): Promise<string | null> {
  const phone = channel !== 'email';
  if (t.related_type === 'worker') {
    const r = await one<any>(`SELECT c.email, c.phone FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.id=$1 AND w.organization_id=$2`, [t.related_id, orgId]);
    return (phone ? r?.phone : r?.email) ?? null;
  }
  if (t.related_type === 'candidate') {
    const r = await one<any>(`SELECT email, phone FROM candidates WHERE id=$1 AND organization_id=$2`, [t.related_id, orgId]);
    return (phone ? r?.phone : r?.email) ?? null;
  }
  if (t.related_type === 'company') {
    const r = await one<any>(`SELECT email, phone FROM contacts WHERE company_id=$1 AND organization_id=$2 AND archived_at IS NULL ORDER BY is_primary DESC, created_at LIMIT 1`, [t.related_id, orgId]);
    return (phone ? r?.phone : r?.email) ?? null;
  }
  return null;
}

/** Portal users for an external party (client portal users of a company, the worker's / candidate's user). */
async function externalUsers(orgId: string, kind: Kind, id: string): Promise<string[]> {
  if (kind === 'client') return (await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.company_id=$2 AND m.status='active' AND r.kind='client'`, [orgId, id])).map(r => r.user_id);
  if (kind === 'worker') return (await q<any>(`SELECT user_id FROM workers WHERE id=$1 AND organization_id=$2 AND user_id IS NOT NULL UNION SELECT m.user_id FROM organization_memberships m WHERE m.organization_id=$1 AND m.worker_id=$2 AND m.status='active'`, [id, orgId])).map(r => r.user_id);
  if (kind === 'candidate') return (await q<any>(`SELECT user_id FROM candidates WHERE id=$1 AND organization_id=$2 AND user_id IS NOT NULL UNION SELECT m.user_id FROM organization_memberships m WHERE m.organization_id=$1 AND m.candidate_id=$2 AND m.status='active'`, [id, orgId])).map(r => r.user_id);
  return [];
}

export default async function (app: FastifyInstance) {
  // ── Agency inbox ──
  app.get('/api/v1/threads', async (req) => {
    const ctx = staff(req);
    need(ctx, 'messages', 'view');
    const r = await listThreads(req, ctx);
    const counts = await one<any>(`SELECT count(*) FILTER (WHERE t.kind='internal')::int internal, count(*) FILTER (WHERE t.kind='client')::int client, count(*) FILTER (WHERE t.kind='worker')::int worker, count(*) FILTER (WHERE t.kind='candidate')::int candidate FROM message_threads t JOIN thread_participants tp ON tp.thread_id=t.id AND tp.user_id=$2 WHERE t.organization_id=$1`, [ctx.orgId, ctx.userId]);
    return { ...r, counts };
  });
  app.get('/api/v1/messages/unread', async (req) => {
    const ctx = auth(req);
    const r = await one<any>(`SELECT count(DISTINCT m.thread_id)::int threads, count(*)::int messages FROM messages m JOIN thread_participants me ON me.thread_id=m.thread_id AND me.user_id=$2 WHERE m.organization_id=$1 AND m.author_id IS DISTINCT FROM $2 AND m.created_at > COALESCE(me.last_read_at, 'epoch')`, [ctx.orgId, ctx.userId]);
    return r;
  });

  // People / parties that can be added to a conversation.
  app.get('/api/v1/threads/recipients', async (req) => {
    const ctx = staff(req);
    need(ctx, 'messages', 'view');
    const { kind = 'client', search = '' } = req.query as { kind?: string; search?: string };
    const s = `%${search}%`;
    if (kind === 'client') {
      if (!can(ctx, 'clients', 'view')) return [];
      return q(`SELECT co.id, co.name, (SELECT concat_ws(' ', first_name, last_name) FROM contacts ct WHERE ct.company_id=co.id AND ct.archived_at IS NULL ORDER BY is_primary DESC LIMIT 1) sub,
        (SELECT count(*) FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=co.organization_id AND m.company_id=co.id AND m.status='active' AND r.kind='client')::int portal_users
        FROM companies co WHERE co.organization_id=$1 AND co.stage='client' AND co.archived_at IS NULL AND co.name ILIKE $2 ORDER BY co.name LIMIT 50`, [ctx.orgId, s]);
    }
    if (kind === 'worker') {
      if (!can(ctx, 'workers', 'view')) return [];
      return q(`SELECT w.id, concat_ws(' ', c.first_name, c.last_name) name, (SELECT co.name FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.worker_id=w.id ORDER BY (p.status='active') DESC, p.start_date DESC LIMIT 1) sub, (w.user_id IS NOT NULL)::int portal_users
        FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.organization_id=$1 AND concat_ws(' ', c.first_name, c.last_name) ILIKE $2 ORDER BY (w.status='active') DESC, c.first_name LIMIT 50`, [ctx.orgId, s]);
    }
    if (kind === 'candidate') {
      if (!can(ctx, 'candidates', 'view')) return [];
      return q(`SELECT c.id, concat_ws(' ', c.first_name, c.last_name) name, c.headline sub, (c.user_id IS NOT NULL)::int portal_users FROM candidates c WHERE c.organization_id=$1 AND c.archived_at IS NULL AND concat_ws(' ', c.first_name, c.last_name, c.email) ILIKE $2 ORDER BY c.created_at DESC LIMIT 50`, [ctx.orgId, s]);
    }
    return [];
  });

  app.post('/api/v1/threads', async (req) => {
    const ctx = staff(req);
    need(ctx, 'messages', 'create');
    const b = z.object({
      subject: z.string().min(1).max(200), kind: z.enum(['internal', 'client', 'worker', 'candidate']), body: z.string().min(1).max(10000),
      participant_ids: z.array(z.string().uuid()).max(50).default([]), party_id: z.string().uuid().optional(),
      channel: z.enum(['in_app', 'email', 'sms', 'whatsapp']).default('in_app'),
    }).parse(req.body);
    const staffIds = b.participant_ids.length ? (await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.kind='agency' AND m.user_id = ANY($2)`, [ctx.orgId, b.participant_ids])).map(r => r.user_id) : [];
    let external: string[] = [];
    let related: { type: string; id: string } | null = null;
    if (b.kind === 'internal') { if (!staffIds.filter(x => x !== ctx.userId).length) throw badRequest('Add at least one teammate to the conversation'); }
    else {
      if (!b.party_id) throw badRequest(`Choose a ${b.kind}`);
      const table = b.kind === 'client' ? 'companies' : b.kind === 'worker' ? 'workers' : 'candidates';
      const ok = await one(`SELECT 1 FROM ${table} WHERE id=$1 AND organization_id=$2`, [b.party_id, ctx.orgId]);
      if (!ok) throw notFound();
      if (b.kind === 'client' && !can(ctx, 'clients', 'view')) throw notFound();
      if (b.kind === 'worker' && !can(ctx, 'workers', 'view')) throw notFound();
      if (b.kind === 'candidate' && !can(ctx, 'candidates', 'view')) throw notFound();
      external = await externalUsers(ctx.orgId, b.kind, b.party_id);
      related = { type: b.kind === 'client' ? 'company' : b.kind, id: b.party_id };
      if (!external.length && b.channel === 'in_app') b.channel = 'email'; // no portal access yet → deliver by email so the message reaches them
    }
    const t = await tx(async c => {
      const th = (await c.query(`INSERT INTO message_threads (organization_id, subject, kind, related_type, related_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ctx.orgId, b.subject, b.kind, related?.type ?? null, related?.id ?? null, ctx.userId])).rows[0];
      for (const u of new Set([ctx.userId, ...staffIds, ...external])) await c.query(`INSERT INTO thread_participants (thread_id, user_id, last_read_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [th.id, u, u === ctx.userId ? new Date() : null]);
      return th;
    });
    await postMessage(ctx, t.id, b.body, b.channel);
    return { ...t, delivered_via: b.channel, portal_recipients: external.length };
  });

  app.get('/api/v1/threads/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'messages', 'view');
    return threadDetail(ctx, (req.params as any).id);
  });
  app.post('/api/v1/threads/:id/messages', async (req) => {
    const ctx = staff(req);
    need(ctx, 'messages', 'create');
    const b = z.object({ body: z.string().min(1).max(10000), channel: z.enum(['in_app', 'email', 'sms', 'whatsapp']).default('in_app') }).parse(req.body);
    return postMessage(ctx, (req.params as any).id, b.body, b.channel);
  });
  app.post('/api/v1/threads/:id/participants', async (req) => {
    const ctx = staff(req);
    need(ctx, 'messages', 'edit');
    const t = await threadFor(ctx, (req.params as any).id);
    const b = z.object({ user_ids: z.array(z.string().uuid()).min(1).max(20) }).parse(req.body);
    const ok = (await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.kind='agency' AND m.user_id = ANY($2)`, [ctx.orgId, b.user_ids])).map(r => r.user_id);
    for (const u of ok) await q(`INSERT INTO thread_participants (thread_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.id, u]);
    await notify(ctx.orgId, ok, { event: 'message', title: `${ctx.user.name} added you to "${t.subject}"`, link: `/comms/inbox?thread=${t.id}` });
    return { added: ok.length };
  });
  app.post('/api/v1/threads/:id/leave', async (req) => {
    const ctx = staff(req);
    const t = await threadFor(ctx, (req.params as any).id);
    await q(`DELETE FROM thread_participants WHERE thread_id=$1 AND user_id=$2`, [t.id, ctx.userId]);
    return { ok: true };
  });
  app.post('/api/v1/threads/:id/read', async (req) => {
    const ctx = auth(req);
    const t = await threadFor(ctx, (req.params as any).id);
    await q(`UPDATE thread_participants SET last_read_at=now() WHERE thread_id=$1 AND user_id=$2`, [t.id, ctx.userId]);
    return { ok: true };
  });
  app.post('/api/v1/threads/:id/unread', async (req) => {
    const ctx = staff(req);
    const t = await threadFor(ctx, (req.params as any).id);
    await q(`UPDATE thread_participants SET last_read_at=(SELECT max(created_at) - interval '1 second' FROM messages WHERE thread_id=$1) WHERE thread_id=$1 AND user_id=$2`, [t.id, ctx.userId]);
    return { ok: true };
  });

  // ── Portal messaging (client + worker) ──
  for (const kind of ['client', 'worker'] as const) {
    const portal = (req: FastifyRequest) => {
      const ctx = auth(req);
      if (ctx.role.kind !== kind) throw notFound();
      if (kind === 'client' && !ctx.companyId) throw notFound();
      if (kind === 'worker' && !ctx.workerId) throw notFound();
      return ctx;
    };
    app.get(`/api/v1/portal/${kind}/messages`, async (req) => { const ctx = portal(req); return listThreads(req, ctx); });
    app.get(`/api/v1/portal/${kind}/messages/:id`, async (req) => { const ctx = portal(req); return threadDetail(ctx, (req.params as any).id); });
    app.post(`/api/v1/portal/${kind}/messages/:id`, async (req) => {
      const ctx = portal(req);
      await rateLimit(`portal-msg:${ctx.userId}`, 60, 300);
      const b = z.object({ body: z.string().min(1).max(5000) }).parse(req.body);
      return postMessage(ctx, (req.params as any).id, b.body, 'in_app');
    });
    // New conversation with the agency: routed to the account manager(s), falling back to owners/admins.
    app.post(`/api/v1/portal/${kind}/messages`, async (req) => {
      const ctx = portal(req);
      await rateLimit(`portal-thread:${ctx.userId}`, 20, 3600);
      const b = z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(5000) }).parse(req.body);
      let staffIds: string[];
      if (kind === 'client') staffIds = (await q<any>(`SELECT account_manager_id u FROM companies WHERE id=$1 AND organization_id=$2 AND account_manager_id IS NOT NULL UNION SELECT DISTINCT account_manager_id FROM placements WHERE company_id=$1 AND organization_id=$2 AND status IN ('active','onboarding','on_leave','notice') AND account_manager_id IS NOT NULL`, [ctx.companyId, ctx.orgId])).map(r => r.u);
      else staffIds = (await q<any>(`SELECT DISTINCT account_manager_id u FROM placements WHERE worker_id=$1 AND organization_id=$2 AND account_manager_id IS NOT NULL ORDER BY 1`, [ctx.workerId, ctx.orgId])).map(r => r.u);
      if (!staffIds.length) staffIds = await usersWithRoles(ctx.orgId, ['owner', 'admin']);
      const coUsers = kind === 'client' ? await externalUsers(ctx.orgId, 'client', ctx.companyId!) : [];
      const t = await tx(async c => {
        const th = (await c.query(`INSERT INTO message_threads (organization_id, subject, kind, related_type, related_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ctx.orgId, b.subject, kind, kind === 'client' ? 'company' : 'worker', kind === 'client' ? ctx.companyId : ctx.workerId, ctx.userId])).rows[0];
        for (const u of new Set([ctx.userId, ...staffIds, ...coUsers])) await c.query(`INSERT INTO thread_participants (thread_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [th.id, u]);
        return th;
      });
      await postMessage(ctx, t.id, b.body, 'in_app');
      return t;
    });
  }
}
