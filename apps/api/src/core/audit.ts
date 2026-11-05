import type { Ctx } from './context';
import { q, type Db, pool } from './db';

/** Append-only audit trail. */
export async function audit(ctx: Pick<Ctx, 'orgId' | 'userId' | 'user' | 'impersonatorId' | 'ip'> | null, action: string, entity: { type?: string; id?: string; label?: string } = {}, before?: unknown, after?: unknown, reason?: string, db: Db = pool) {
  await q(`INSERT INTO audit_events (organization_id, actor_id, actor_label, impersonator_id, action, entity_type, entity_id, entity_label, before, after, reason, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [ctx?.orgId || null, ctx?.userId ?? null, ctx?.user?.name ?? 'System', ctx?.impersonatorId ?? null, action, entity.type ?? null, entity.id ?? null, entity.label ?? null, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), reason ?? null, ctx?.ip ?? null], db);
}

/** Record timeline entry on any entity. */
export async function activity(ctx: Pick<Ctx, 'orgId' | 'userId'> | { orgId: string; userId: string | null }, entityType: string, entityId: string, kind: string, title: string, body?: string | null, meta: Record<string, unknown> = {}, db: Db = pool) {
  const r = await q<any>(`INSERT INTO activities (organization_id, entity_type, entity_id, kind, title, body, meta, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [ctx.orgId, entityType, entityId, kind, title, body ?? null, JSON.stringify(meta), ctx.userId], db);
  return r[0].id as string;
}
