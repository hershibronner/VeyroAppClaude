import type { FastifyRequest } from 'fastify';
import { canTransition, allowedNext, humanize, type MachineName, type Resource, type Action, type Scope, stripComp } from '@veyro/shared';
import { one, q } from './db';
import { conflict, forbidden, notFound, unauthorized } from './errors';

export interface Ctx {
  sessionId: string;
  csrf: string;
  userId: string;
  user: { id: string; name: string; email: string; avatar_color: string | null };
  orgId: string;
  org: { id: string; name: string; slug: string };
  membershipId: string;
  role: { id: string; key: string; name: string; kind: 'agency' | 'client' | 'worker' | 'candidate' };
  recruitingScope: 'all' | 'team' | 'assigned';
  team: string | null;
  perms: Record<string, Scope>; // "resource:action" -> scope
  companyId: string | null; // client users
  workerId: string | null; // worker users
  candidateId: string | null; // candidate users
  isPlatformAdmin: boolean;
  impersonatorId: string | null;
  ip: string;
}

declare module 'fastify' {
  interface FastifyRequest { ctx: Ctx | null; sessionUserId?: string | null }
}

export const SESSION_COOKIE = 'vsid';

/** Resolves session → user → active membership → role → permissions. Never trusts client-sent org/role ids. */
export async function resolveCtx(req: FastifyRequest): Promise<Ctx | null> {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  const s = await one<any>(`SELECT s.*, u.name, u.email, u.avatar_color FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND s.mfa_pending = false`, [sid]);
  if (!s) return null;
  req.sessionUserId = s.user_id;
  const isPlatformAdmin = !!(await one(`SELECT 1 FROM platform_admins WHERE user_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > now())`, [s.user_id]));
  let m = s.active_organization_id ? await one<any>(`SELECT m.*, r.key role_key, r.name role_name, r.kind role_kind, o.name org_name, o.slug org_slug FROM organization_memberships m JOIN roles r ON r.id=m.role_id JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='active' AND o.status <> 'deleted'`, [s.user_id, s.active_organization_id]) : null;
  if (!m) {
    m = await one<any>(`SELECT m.*, r.key role_key, r.name role_name, r.kind role_kind, o.name org_name, o.slug org_slug FROM organization_memberships m JOIN roles r ON r.id=m.role_id JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.status='active' ORDER BY (r.kind='agency') DESC, m.created_at LIMIT 1`, [s.user_id]);
    if (m) await q(`UPDATE sessions SET active_organization_id=$2 WHERE id=$1`, [sid, m.organization_id]);
  }
  q(`UPDATE sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now() - interval '1 minute'`, [sid]).catch(() => {});
  const base = { sessionId: sid, csrf: s.csrf_token, userId: s.user_id, user: { id: s.user_id, name: s.name, email: s.email, avatar_color: s.avatar_color }, isPlatformAdmin, impersonatorId: s.impersonator_user_id, ip: req.ip };
  if (!m) {
    // Platform admins may have no tenant membership.
    return { ...base, orgId: '', org: { id: '', name: '', slug: '' }, membershipId: '', role: { id: '', key: 'none', name: 'No workspace', kind: 'agency' }, recruitingScope: 'all', team: null, perms: {}, companyId: null, workerId: null, candidateId: null };
  }
  const perms: Record<string, Scope> = {};
  for (const p of await q<any>(`SELECT resource, action, scope FROM role_permissions WHERE role_id=$1`, [m.role_id])) perms[`${p.resource}:${p.action}`] = p.scope;
  return {
    ...base, orgId: m.organization_id, org: { id: m.organization_id, name: m.org_name, slug: m.org_slug }, membershipId: m.id,
    role: { id: m.role_id, key: m.role_key, name: m.role_name, kind: m.role_kind }, recruitingScope: m.recruiting_scope, team: m.team, perms,
    companyId: m.company_id, workerId: m.worker_id, candidateId: m.candidate_id,
  };
}

/** Requires a signed-in user with an active workspace. */
export function auth(req: FastifyRequest): Ctx {
  if (!req.ctx) throw unauthorized();
  if (!req.ctx.orgId) throw forbidden('No active workspace');
  return req.ctx;
}
/** Requires an internal agency user (blocks client/worker/candidate from internal APIs). */
export function staff(req: FastifyRequest): Ctx {
  const ctx = auth(req);
  if (ctx.role.kind !== 'agency') throw notFound();
  return ctx;
}
export function scopeOf(ctx: Ctx, resource: Resource, action: Action): Scope {
  if (ctx.role.kind !== 'agency') return 'none';
  return ctx.perms[`${resource}:${action}`] ?? 'none';
}
export function can(ctx: Ctx, resource: Resource, action: Action): boolean { return scopeOf(ctx, resource, action) !== 'none'; }
/** Requires the permission; returns the scope. Throws 403 (or 404 for views, to avoid leaking existence). */
export function need(ctx: Ctx, resource: Resource, action: Action): Scope {
  const s = scopeOf(ctx, resource, action);
  if (s === 'none') throw action === 'view' ? notFound() : forbidden(`Your role (${ctx.role.name}) cannot ${action.replace('_', ' ')} ${resource.replace('_', ' ')}`);
  return s;
}
export function canViewComp(ctx: Ctx, resource: Resource = 'rates'): boolean { return can(ctx, resource, 'view_comp') || can(ctx, 'rates', 'view_comp'); }
export function redact<T extends Record<string, unknown>>(ctx: Ctx, row: T, resource: Resource = 'rates'): T { return stripComp(row, canViewComp(ctx, resource)); }

/** Validates a state transition or throws HTTP 409 with the allowed next states. */
export function assertTransition(machine: MachineName, from: string, to: string) {
  if (!canTransition(machine, from, to)) throw conflict(`Cannot move ${machine.replace('_', ' ')} from ${humanize(from)} to ${humanize(to)}`, { allowed: allowedNext(machine, from) });
}

/** Loads a tenant-scoped row or 404s. */
export async function getOr404<T = any>(table: string, ctx: Ctx, id: string, extraWhere = ''): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const row = await one<T>(`SELECT * FROM ${table} WHERE id=$1 AND organization_id=$2 ${extraWhere}`, [id, ctx.orgId]);
  if (!row) throw notFound();
  return row;
}
