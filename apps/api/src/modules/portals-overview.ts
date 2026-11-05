import type { FastifyInstance } from 'fastify';
import { q, one } from '../core/db';
import { staff, can } from '../core/context';
import { getSetting, WEB_URL } from '../core/settings';

const KINDS = ['client', 'worker', 'candidate'] as const;

/** Portals overview (sidebar → Other → Portals): adoption and access for each external portal. */
export default async function (app: FastifyInstance) {
  app.get('/api/v1/portals/overview', async (req) => {
    const ctx = staff(req);
    const settings = await getSetting<Record<string, boolean>>(ctx.orgId, 'portals');
    const users = await q<any>(`SELECT r.kind, count(*) FILTER (WHERE m.status='active')::int active, max(u.last_login_at) last_login,
        count(*) FILTER (WHERE m.status='active' AND u.last_login_at > now() - interval '30 days')::int active_30d
      FROM organization_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id
      WHERE m.organization_id=$1 AND r.kind = ANY($2) GROUP BY r.kind`, [ctx.orgId, KINDS]);
    const invites = await q<any>(`SELECT r.kind, count(*)::int pending FROM invitations i JOIN roles r ON r.id=i.role_id
      WHERE i.organization_id=$1 AND i.status='pending' AND i.expires_at > now() AND r.kind = ANY($2) GROUP BY r.kind`, [ctx.orgId, KINDS]);
    const eligible = {
      client: (await one<any>(`SELECT count(*)::int n FROM companies WHERE organization_id=$1 AND stage='client'`, [ctx.orgId])).n,
      worker: (await one<any>(`SELECT count(*)::int n FROM workers WHERE organization_id=$1 AND status IN ('active','pending','on_leave')`, [ctx.orgId])).n,
      candidate: (await one<any>(`SELECT count(*)::int n FROM candidates WHERE organization_id=$1 AND archived_at IS NULL AND status NOT IN ('hired','blacklisted')`, [ctx.orgId])).n,
    };
    const recent = await q<any>(`SELECT u.name, u.last_login_at, r.kind, r.name role_name, c.name company_name
      FROM organization_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id LEFT JOIN companies c ON c.id=m.company_id
      WHERE m.organization_id=$1 AND r.kind = ANY($2) AND m.status='active' AND u.last_login_at IS NOT NULL ORDER BY u.last_login_at DESC LIMIT 8`, [ctx.orgId, KINDS]);
    const apps30 = (await one<any>(`SELECT count(*)::int n FROM applications WHERE organization_id=$1 AND created_at > now() - interval '30 days'`, [ctx.orgId])).n;
    const links = (await one<any>(`SELECT count(*)::int n FROM sourcing_links WHERE organization_id=$1 AND active`, [ctx.orgId])).n;
    const by = (rows: any[], k: string) => rows.find(r => r.kind === k) ?? {};
    return {
      canManage: can(ctx, 'settings', 'edit'),
      apply: { url: `${WEB_URL}/apply/${ctx.org.slug}`, applications30d: apps30, activeLinks: links },
      portals: KINDS.map(k => ({
        kind: k,
        enabled: settings?.[`${k}_enabled`] !== false,
        activeUsers: by(users, k).active ?? 0,
        active30d: by(users, k).active_30d ?? 0,
        lastLogin: by(users, k).last_login ?? null,
        pendingInvites: by(invites, k).pending ?? 0,
        eligible: eligible[k],
      })),
      recent,
    };
  });
}
