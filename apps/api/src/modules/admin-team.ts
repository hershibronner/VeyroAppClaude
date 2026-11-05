// Settings → Team (members, invitations) and Roles & Permissions (editable resource × action → scope matrix).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RESOURCES, ACTIONS } from '@veyro/shared';
import { q, one, tx } from '../core/db';
import { staff, need, can, type Ctx } from '../core/context';
import { badRequest, conflict, forbidden, notFound } from '../core/errors';
import { audit } from '../core/audit';
import { notify, usersWithRoles } from '../core/notify';
import { listParams, paged } from '../core/list';
import { sendTemplate } from '../adapters/messaging';
import { WEB_URL } from '../core/settings';
import { randomToken, isUuid } from './_admin/common';
import { fieldError } from './_admin/common';

const SCOPES = ['all', 'team', 'assigned', 'own', 'none'] as const;
const INVITE_DAYS = 7;

async function activeOwnerCount(orgId: string, db = undefined as any) {
  return (await one<any>(`SELECT count(*)::int n FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.key='owner'`, [orgId], db)).n as number;
}
async function memberOr404(ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const m = await one<any>(`SELECT m.*, u.name, u.email, r.key role_key, r.name role_name, r.kind role_kind FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.id=$1 AND m.organization_id=$2`, [id, ctx.orgId]);
  if (!m || m.role_kind !== 'agency') throw notFound();
  return m;
}
/** Owner protection: only an Owner can grant/alter the Owner role, and the last Owner can never be removed or demoted. */
async function assertOwnerSafe(ctx: Ctx, m: any, change: { newRoleKey?: string; removing?: boolean }) {
  const losingOwner = m.role_key === 'owner' && m.status === 'active' && (change.removing || (change.newRoleKey && change.newRoleKey !== 'owner'));
  if (losingOwner && (await activeOwnerCount(ctx.orgId)) <= 1) throw conflict('This is the last Owner of the agency. Make someone else an Owner first.');
  const touchesOwner = m.role_key === 'owner' || change.newRoleKey === 'owner';
  if (touchesOwner && ctx.role.key !== 'owner') throw forbidden('Only an Owner can change Owner access');
}

export default async function (app: FastifyInstance) {
  // ── Members ──
  app.get('/api/v1/team', async (req) => {
    const ctx = staff(req); need(ctx, 'team', 'view');
    const lp = listParams(req);
    const where = ['m.organization_id=$1', "r.kind='agency'", "m.status <> 'removed'"]; const params: unknown[] = [ctx.orgId];
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`m.status=$${params.length}`); }
    if (lp.filters.role) { params.push(lp.filters.role); where.push(`r.key=$${params.length}`); }
    if (lp.filters.team) { params.push(lp.filters.team); where.push(`m.team=$${params.length}`); }
    if (lp.filters.scope) { params.push(lp.filters.scope); where.push(`m.recruiting_scope=$${params.length}`); }
    return paged({ select: `m.id, m.user_id, m.status, m.recruiting_scope, m.team, m.created_at, m.updated_at, u.name, u.email, u.avatar_color, u.last_login_at, u.mfa_enabled, r.id role_id, r.key role_key, r.name role_name, (m.user_id = '${ctx.userId}') is_me`,
      from: 'organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id', where, params, lp, searchCols: ['u.name', 'u.email', 'm.team'],
      sortMap: { name: 'u.name', role_name: 'r.name', status: 'm.status', last_login_at: 'u.last_login_at', created_at: 'm.created_at', team: 'm.team' }, defaultSort: 'u.name ASC' });
  });
  app.get('/api/v1/team/summary', async (req) => {
    const ctx = staff(req); need(ctx, 'team', 'view');
    const s = await one<any>(`SELECT count(*) FILTER (WHERE m.status='active')::int active, count(*) FILTER (WHERE m.status='suspended')::int suspended,
      count(*) FILTER (WHERE m.status='active' AND r.key='owner')::int owners, count(*) FILTER (WHERE m.status='active' AND u.mfa_enabled)::int mfa,
      count(*) FILTER (WHERE m.status='active' AND u.last_login_at > now() - interval '7 days')::int active_7d
      FROM organization_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND r.kind='agency'`, [ctx.orgId]);
    const inv = await one<any>(`SELECT count(*) FILTER (WHERE status='pending' AND expires_at > now())::int pending, count(*) FILTER (WHERE status='pending' AND expires_at <= now())::int expired FROM invitations i JOIN roles r ON r.id=i.role_id WHERE i.organization_id=$1 AND r.kind='agency'`, [ctx.orgId]);
    const teams = (await q<any>(`SELECT DISTINCT team FROM organization_memberships WHERE organization_id=$1 AND team IS NOT NULL ORDER BY team`, [ctx.orgId])).map(t => t.team);
    return { ...s, ...inv, teams };
  });

  app.patch('/api/v1/team/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'team', 'edit');
    const m = await memberOr404(ctx, (req.params as any).id);
    const b = z.object({ role_id: z.string().uuid().optional(), recruiting_scope: z.enum(['all', 'team', 'assigned']).optional(), team: z.string().max(60).nullable().optional() }).parse(req.body);
    let newRole: any = null;
    if (b.role_id && b.role_id !== m.role_id) {
      newRole = await one<any>(`SELECT * FROM roles WHERE id=$1 AND organization_id=$2 AND kind='agency'`, [b.role_id, ctx.orgId]);
      if (!newRole) throw badRequest('Choose a valid staff role', { fields: { role_id: 'Unknown role' } });
      if (m.user_id === ctx.userId && m.role_key === 'owner' && newRole.key !== 'owner' && (await activeOwnerCount(ctx.orgId)) <= 1) throw conflict('You are the last Owner — you cannot demote yourself.');
      await assertOwnerSafe(ctx, m, { newRoleKey: newRole.key });
    }
    const before = { role: m.role_name, recruiting_scope: m.recruiting_scope, team: m.team };
    await q(`UPDATE organization_memberships SET role_id=COALESCE($3, role_id), recruiting_scope=COALESCE($4, recruiting_scope), team=CASE WHEN $5::boolean THEN $6 ELSE team END, updated_at=now() WHERE id=$1 AND organization_id=$2`,
      [m.id, ctx.orgId, newRole?.id ?? null, b.recruiting_scope ?? null, b.team !== undefined, b.team ?? null]);
    const after = { role: newRole?.name ?? m.role_name, recruiting_scope: b.recruiting_scope ?? m.recruiting_scope, team: b.team !== undefined ? b.team : m.team };
    await audit(ctx, newRole ? 'member.role_changed' : 'member.updated', { type: 'user', id: m.user_id, label: m.name }, before, after);
    if (JSON.stringify(before) !== JSON.stringify(after) && m.user_id !== ctx.userId) {
      await notify(ctx.orgId, [m.user_id], { event: 'role.changed', title: newRole ? `Your role is now ${newRole.name}` : 'Your access was updated', body: `${ctx.user.name} updated your access in ${ctx.org.name}: ${after.role}, recruiting scope ${after.recruiting_scope}${after.team ? `, team ${after.team}` : ''}. It takes effect immediately.`, link: '/' });
    }
    return { ok: true, ...after };
  });

  const setStatus = (status: 'active' | 'suspended' | 'removed') => async (req: any) => {
    const ctx = staff(req); need(ctx, 'team', status === 'removed' ? 'delete' : 'edit');
    const m = await memberOr404(ctx, req.params.id);
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    if (m.user_id === ctx.userId && status !== 'active') throw conflict('You cannot suspend or remove yourself');
    if (status !== 'active') await assertOwnerSafe(ctx, m, { removing: true });
    if (m.status === status) return { ok: true };
    await tx(async (c) => {
      await c.query(`UPDATE organization_memberships SET status=$3, updated_at=now() WHERE id=$1 AND organization_id=$2`, [m.id, ctx.orgId, status]);
      if (status !== 'active') {
        // Sessions focused on this workspace re-resolve on the next request; API keys created by them stop working.
        await c.query(`UPDATE api_keys SET revoked_at=now() WHERE organization_id=$1 AND created_by=$2 AND revoked_at IS NULL`, [ctx.orgId, m.user_id]);
        await c.query(`UPDATE sessions SET active_organization_id=NULL WHERE user_id=$1 AND active_organization_id=$2 AND revoked_at IS NULL`, [m.user_id, ctx.orgId]);
      }
      await audit(ctx, `member.${status === 'active' ? 'reactivated' : status}`, { type: 'user', id: m.user_id, label: m.name }, { status: m.status }, { status }, reason, c);
    });
    if (status === 'active') await notify(ctx.orgId, [m.user_id], { event: 'role.changed', title: `Your access to ${ctx.org.name} was restored`, link: '/' });
    return { ok: true, status };
  };
  app.post('/api/v1/team/:id/suspend', setStatus('suspended'));
  app.post('/api/v1/team/:id/reactivate', setStatus('active'));
  app.post('/api/v1/team/:id/remove', setStatus('removed'));

  // ── Invitations (staff) ──
  app.get('/api/v1/invitations', async (req) => {
    const ctx = staff(req); need(ctx, 'team', 'view');
    const lp = listParams(req);
    const where = ['i.organization_id=$1', "r.kind='agency'"]; const params: unknown[] = [ctx.orgId];
    const st = lp.filters.status;
    if (st === 'pending') where.push(`i.status='pending' AND i.expires_at > now()`);
    else if (st === 'expired') where.push(`i.status='pending' AND i.expires_at <= now()`);
    else if (st) { params.push(st); where.push(`i.status=$${params.length}`); }
    else where.push(`i.status IN ('pending','revoked','expired')`);
    return paged({ select: `i.id, i.email, i.name, i.recruiting_scope, i.team, i.created_at, i.expires_at, i.last_sent_at, i.resent_count, r.name role_name, r.key role_key, u.name invited_by_name, CASE WHEN i.status='pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END status`,
      from: 'invitations i JOIN roles r ON r.id=i.role_id LEFT JOIN users u ON u.id=i.invited_by', where, params, lp, searchCols: ['i.email', 'i.name'], sortMap: { email: 'i.email', created_at: 'i.created_at', expires_at: 'i.expires_at' }, defaultSort: 'i.created_at DESC' });
  });

  async function sendInvite(ctx: Ctx, inv: any, roleName: string) {
    await sendTemplate(ctx.orgId, 'invite_staff', inv.email, { invitee: { name: inv.name ?? inv.email }, inviter: { name: ctx.user.name }, org: { name: ctx.org.name }, role: { name: roleName }, link: `${WEB_URL}/invite/${inv.token}` });
  }
  app.post('/api/v1/invitations', async (req) => {
    const ctx = staff(req); need(ctx, 'team', 'create');
    const b = z.object({ email: z.string().email(), name: z.string().min(1).max(80).optional(), role_id: z.string().uuid(), recruiting_scope: z.enum(['all', 'team', 'assigned']).default('all'), team: z.string().max(60).nullable().optional() }).parse(req.body);
    const role = await one<any>(`SELECT * FROM roles WHERE id=$1 AND organization_id=$2 AND kind='agency'`, [b.role_id, ctx.orgId]);
    if (!role) throw fieldError({ role_id: 'Choose a staff role' });
    if (role.key === 'owner' && ctx.role.key !== 'owner') throw forbidden('Only an Owner can invite another Owner');
    const existing = await one<any>(`SELECT m.status FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND lower(u.email)=lower($2)`, [ctx.orgId, b.email]);
    if (existing && existing.status === 'active') throw conflict(`${b.email} is already a member of ${ctx.org.name}`);
    const pending = await one<any>(`SELECT id FROM invitations WHERE organization_id=$1 AND lower(email)=lower($2) AND status='pending' AND expires_at > now()`, [ctx.orgId, b.email]);
    if (pending) throw conflict('An invitation for this email is already pending — resend it instead');
    const inv = await one<any>(`INSERT INTO invitations (organization_id, email, name, role_id, token, invited_by, expires_at, recruiting_scope, team, last_sent_at) VALUES ($1,lower($2),$3,$4,$5,$6, now() + make_interval(days => $7),$8,$9, now()) RETURNING *`,
      [ctx.orgId, b.email, b.name ?? null, role.id, randomToken(), ctx.userId, INVITE_DAYS, b.recruiting_scope, b.team ?? null]);
    await sendInvite(ctx, inv, role.name);
    await audit(ctx, 'invitation.created', { type: 'invitation', id: inv.id, label: inv.email }, null, { role: role.name, recruiting_scope: b.recruiting_scope, team: b.team ?? null, expires_at: inv.expires_at });
    return { id: inv.id, email: inv.email, expires_at: inv.expires_at };
  });
  app.post('/api/v1/invitations/:id/resend', async (req) => {
    const ctx = staff(req); need(ctx, 'team', 'create');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const inv = await one<any>(`SELECT i.*, r.name role_name FROM invitations i JOIN roles r ON r.id=i.role_id WHERE i.id=$1 AND i.organization_id=$2 AND r.kind='agency'`, [id, ctx.orgId]);
    if (!inv) throw notFound();
    if (!['pending', 'expired'].includes(inv.status)) throw conflict(`This invitation was ${inv.status}`);
    const token = randomToken();
    await q(`UPDATE invitations SET token=$2, status='pending', expires_at=now() + make_interval(days => $3), resent_count=resent_count+1, last_sent_at=now() WHERE id=$1`, [inv.id, token, INVITE_DAYS]);
    await sendInvite(ctx, { ...inv, token }, inv.role_name);
    await audit(ctx, 'invitation.resent', { type: 'invitation', id: inv.id, label: inv.email }, { expires_at: inv.expires_at }, { new_link: true });
    return { ok: true };
  });
  app.post('/api/v1/invitations/:id/revoke', async (req) => {
    const ctx = staff(req); need(ctx, 'team', 'delete');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const inv = await one<any>(`SELECT i.* FROM invitations i JOIN roles r ON r.id=i.role_id WHERE i.id=$1 AND i.organization_id=$2 AND r.kind='agency'`, [id, ctx.orgId]);
    if (!inv) throw notFound();
    if (inv.status !== 'pending') throw conflict(`This invitation was already ${inv.status}`);
    await q(`UPDATE invitations SET status='revoked', revoked_at=now() WHERE id=$1`, [inv.id]);
    await audit(ctx, 'invitation.revoked', { type: 'invitation', id: inv.id, label: inv.email }, { status: 'pending' }, { status: 'revoked' });
    return { ok: true };
  });

  // ── Roles & permission matrix ──
  app.get('/api/v1/roles', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'roles', 'view') && !can(ctx, 'team', 'view')) throw notFound();
    const rows = await q<any>(`SELECT r.id, r.key, r.name, r.kind, r.is_system, r.description, (SELECT count(*)::int FROM organization_memberships m WHERE m.role_id=r.id AND m.status='active') members,
      (SELECT count(*)::int FROM role_permissions p WHERE p.role_id=r.id) grants FROM roles r WHERE r.organization_id=$1 ORDER BY r.kind, r.is_system DESC, r.created_at`, [ctx.orgId]);
    const { kind } = req.query as any;
    return kind ? rows.filter(r => r.kind === kind) : rows;
  });
  app.get('/api/v1/roles/matrix', async (req) => {
    const ctx = staff(req); need(ctx, 'roles', 'view');
    const roles = await q<any>(`SELECT r.id, r.key, r.name, r.is_system, r.description, (SELECT count(*)::int FROM organization_memberships m WHERE m.role_id=r.id AND m.status='active') members FROM roles r WHERE r.organization_id=$1 AND r.kind='agency' ORDER BY r.is_system DESC, r.created_at`, [ctx.orgId]);
    const perms = await q<any>(`SELECT p.role_id, p.resource, p.action, p.scope FROM role_permissions p JOIN roles r ON r.id=p.role_id WHERE r.organization_id=$1`, [ctx.orgId]);
    const matrix: Record<string, Record<string, Record<string, string>>> = {};
    for (const r of roles) matrix[r.id] = {};
    for (const p of perms) if (matrix[p.role_id]) (matrix[p.role_id][p.resource] ??= {})[p.action] = p.scope;
    return { roles, matrix, resources: RESOURCES, actions: ACTIONS, scopes: SCOPES, editable: can(ctx, 'roles', 'edit') };
  });
  app.put('/api/v1/roles/:id/permissions', async (req) => {
    const ctx = staff(req); need(ctx, 'roles', 'edit');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const role = await one<any>(`SELECT * FROM roles WHERE id=$1 AND organization_id=$2 AND kind='agency'`, [id, ctx.orgId]);
    if (!role) throw notFound();
    if (role.key === 'owner') throw conflict('The Owner role always has full access and cannot be edited');
    if (role.id === ctx.role.id) throw conflict('You cannot edit the permissions of your own role — ask another admin');
    const b = z.object({ changes: z.array(z.object({ resource: z.enum(RESOURCES), action: z.enum(ACTIONS), scope: z.enum(SCOPES) })).min(1).max(400) }).parse(req.body);
    const before = await q<any>(`SELECT resource, action, scope FROM role_permissions WHERE role_id=$1`, [role.id]);
    const bmap = Object.fromEntries(before.map(p => [`${p.resource}:${p.action}`, p.scope]));
    const diff: { resource: string; action: string; from: string; to: string }[] = [];
    await tx(async (c) => {
      for (const ch of b.changes) {
        const from = bmap[`${ch.resource}:${ch.action}`] ?? 'none';
        if (from === ch.scope) continue;
        if (ch.scope === 'none') await c.query(`DELETE FROM role_permissions WHERE role_id=$1 AND resource=$2 AND action=$3`, [role.id, ch.resource, ch.action]);
        else await c.query(`INSERT INTO role_permissions (role_id, resource, action, scope) VALUES ($1,$2,$3,$4) ON CONFLICT (role_id, resource, action) DO UPDATE SET scope=EXCLUDED.scope`, [role.id, ch.resource, ch.action, ch.scope]);
        diff.push({ resource: ch.resource, action: ch.action, from, to: ch.scope });
      }
      if (diff.length) await audit(ctx, 'role.permissions_changed', { type: 'role', id: role.id, label: role.name }, Object.fromEntries(diff.map(d => [`${d.resource}:${d.action}`, d.from])), Object.fromEntries(diff.map(d => [`${d.resource}:${d.action}`, d.to])), undefined, c);
    });
    if (diff.length) {
      const affected = (await q<any>(`SELECT user_id FROM organization_memberships WHERE role_id=$1 AND status='active'`, [role.id])).map(r => r.user_id).filter(u => u !== ctx.userId);
      await notify(ctx.orgId, affected, { event: 'role.changed', title: `Permissions for ${role.name} changed`, body: `${ctx.user.name} changed ${diff.length} permission${diff.length === 1 ? '' : 's'} for your role. Changes apply immediately.`, link: '/' });
    }
    return { ok: true, changed: diff.length, diff };
  });
  app.post('/api/v1/roles', async (req) => {
    const ctx = staff(req); need(ctx, 'roles', 'create');
    const b = z.object({ name: z.string().min(2).max(60), description: z.string().max(300).optional(), clone_from: z.string().uuid().optional() }).parse(req.body);
    const key = 'custom_' + b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) + '_' + randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '');
    const src = b.clone_from ? await one<any>(`SELECT * FROM roles WHERE id=$1 AND organization_id=$2 AND kind='agency'`, [b.clone_from, ctx.orgId]) : null;
    if (b.clone_from && !src) throw badRequest('Role to clone not found');
    const role = await tx(async (c) => {
      const r = (await c.query(`INSERT INTO roles (organization_id, key, name, kind, is_system, description) VALUES ($1,$2,$3,'agency',false,$4) RETURNING *`, [ctx.orgId, key, b.name, b.description ?? (src ? `Based on ${src.name}` : null)])).rows[0];
      if (src) await c.query(`INSERT INTO role_permissions (role_id, resource, action, scope) SELECT $1, resource, action, scope FROM role_permissions WHERE role_id=$2`, [r.id, src.id]);
      else await c.query(`INSERT INTO role_permissions (role_id, resource, action, scope) VALUES ($1,'tasks','view','own'),($1,'activities','view','all')`, [r.id]);
      await audit(ctx, src ? 'role.cloned' : 'role.created', { type: 'role', id: r.id, label: r.name }, null, { name: r.name, cloned_from: src?.name ?? null }, undefined, c);
      return r;
    });
    return role;
  });
  app.patch('/api/v1/roles/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'roles', 'edit');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const role = await one<any>(`SELECT * FROM roles WHERE id=$1 AND organization_id=$2 AND kind='agency'`, [id, ctx.orgId]);
    if (!role) throw notFound();
    if (role.is_system) throw conflict('System roles cannot be renamed — clone it to make a custom role');
    const b = z.object({ name: z.string().min(2).max(60).optional(), description: z.string().max(300).nullable().optional() }).parse(req.body);
    const r = await one<any>(`UPDATE roles SET name=COALESCE($3,name), description=CASE WHEN $4::boolean THEN $5 ELSE description END WHERE id=$1 AND organization_id=$2 RETURNING *`, [role.id, ctx.orgId, b.name ?? null, b.description !== undefined, b.description ?? null]);
    await audit(ctx, 'role.updated', { type: 'role', id: role.id, label: r.name }, { name: role.name, description: role.description }, { name: r.name, description: r.description });
    return r;
  });
  app.delete('/api/v1/roles/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'roles', 'delete');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const role = await one<any>(`SELECT * FROM roles WHERE id=$1 AND organization_id=$2 AND kind='agency'`, [id, ctx.orgId]);
    if (!role) throw notFound();
    if (role.is_system) throw conflict('System roles cannot be deleted');
    const used = await one<any>(`SELECT (SELECT count(*)::int FROM organization_memberships WHERE role_id=$1 AND status <> 'removed') m, (SELECT count(*)::int FROM invitations WHERE role_id=$1 AND status='pending') i`, [role.id]);
    if (used.m || used.i) throw conflict(`Move the ${used.m} member(s)${used.i ? ` and ${used.i} pending invitation(s)` : ''} to another role before deleting ${role.name}`);
    const perms = await q<any>(`SELECT resource, action, scope FROM role_permissions WHERE role_id=$1`, [role.id]);
    await tx(async (c) => {
      await c.query(`DELETE FROM organization_memberships WHERE role_id=$1 AND status='removed'`, [role.id]);
      await c.query(`UPDATE invitations SET role_id=(SELECT id FROM roles WHERE organization_id=$2 AND key='viewer') WHERE role_id=$1`, [role.id, ctx.orgId]);
      await c.query(`DELETE FROM roles WHERE id=$1 AND organization_id=$2`, [role.id, ctx.orgId]);
      await audit(ctx, 'role.deleted', { type: 'role', id: role.id, label: role.name }, { name: role.name, permissions: perms.length }, null, undefined, c);
    });
    return { ok: true };
  });

  // Who can do what (owners/admins notified of permanent deletes etc. use this)
  app.get('/api/v1/team/admins', async (req) => {
    const ctx = staff(req);
    const ids = await usersWithRoles(ctx.orgId, ['owner', 'admin']);
    return q(`SELECT id, name, email FROM users WHERE id = ANY($1) ORDER BY name`, [ids]);
  });
}
