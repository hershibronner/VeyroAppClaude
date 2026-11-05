// CRM — Activities: org-wide feed (calls, meetings, notes, messages, status changes, system events) with filters.
// Entries on records the viewer's role cannot see are excluded server-side.
import type { FastifyInstance } from 'fastify';
import { staff, need, can, type Ctx } from '../core/context';
import { one } from '../core/db';
import { listParams, paged } from '../core/list';
import { ENTITY_RESOURCE, relatedLabelSql, relatedStageSql, isUuid } from './_crm/util';

function visibleTypes(ctx: Ctx) {
  return Object.entries(ENTITY_RESOURCE).filter(([t, r]) => (t === 'company' ? can(ctx, 'clients', 'view') || can(ctx, 'leads', 'view') : can(ctx, r, 'view'))).map(([t]) => t);
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/activities', async (req) => {
    const ctx = staff(req); need(ctx, 'activities', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId, visibleTypes(ctx)];
    const where = ['a.organization_id=$1', 'a.entity_type = ANY($2)'];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
    // Companies: leads-only users see leads; clients-only users see clients.
    if (!can(ctx, 'clients', 'view')) where.push(`(a.entity_type <> 'company' OR EXISTS (SELECT 1 FROM companies c WHERE c.id=a.entity_id AND c.stage IN ('lead','qualified')))`);
    if (!can(ctx, 'leads', 'view')) where.push(`(a.entity_type <> 'company' OR EXISTS (SELECT 1 FROM companies c WHERE c.id=a.entity_id AND c.stage IN ('client','inactive')))`);
    const kinds = (f.kind ?? '').split(',').filter(k => ['call', 'email', 'meeting', 'note', 'message', 'status_change', 'system'].includes(k));
    if (kinds.length) add('a.kind = ANY(?)', kinds);
    if (f.entity_type) add('a.entity_type = ?', f.entity_type);
    if (isUuid(f.entity_id)) add('a.entity_id = ?', f.entity_id);
    if (isUuid(f.actor) || f.actor === 'me') add('a.actor_id = ?', f.actor === 'me' ? ctx.userId : f.actor);
    if (f.actor === 'system') where.push('a.actor_id IS NULL');
    if (f.crm === 'true') where.push(`a.entity_type IN ('company','contact','opportunity','task')`);
    if (f.mentions === 'me') add('EXISTS (SELECT 1 FROM mentions m WHERE m.activity_id=a.id AND m.user_id=?)', ctx.userId);
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.from ?? '')) add('a.created_at >= ?::date', f.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.to ?? '')) add(`a.created_at < ?::date + 1`, f.to);
    return paged({
      select: `a.id, a.entity_type, a.entity_id, a.kind, a.title, a.body, a.visibility, a.created_at, a.actor_id, u.name actor_name, u.avatar_color actor_color,
        ${relatedLabelSql('a.entity_type', 'a.entity_id')} entity_label, ${relatedStageSql('a.entity_type', 'a.entity_id')} entity_stage,
        (SELECT count(*) FROM mentions m WHERE m.activity_id=a.id)::int mention_count`,
      from: 'activities a LEFT JOIN users u ON u.id=a.actor_id', where, params, lp,
      searchCols: ['a.title', 'a.body', 'u.name'], sortMap: { created_at: 'a.created_at', kind: 'a.kind', actor_name: 'u.name' }, defaultSort: 'a.created_at DESC',
    });
  });

  app.get('/api/v1/activities/stats', async (req) => {
    const ctx = staff(req); need(ctx, 'activities', 'view');
    const r = await one<any>(`SELECT
      count(*) FILTER (WHERE kind='call' AND created_at >= now() - interval '7 days')::int calls_7d,
      count(*) FILTER (WHERE kind='email' AND created_at >= now() - interval '7 days')::int emails_7d,
      count(*) FILTER (WHERE kind='meeting' AND created_at >= now() - interval '7 days')::int meetings_7d,
      count(*) FILTER (WHERE kind='note' AND created_at >= now() - interval '7 days')::int notes_7d,
      count(*) FILTER (WHERE kind IN ('call','email','meeting') AND created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days')::int touches_prev_7d,
      count(*) FILTER (WHERE kind IN ('call','email','meeting') AND created_at >= now() - interval '7 days')::int touches_7d,
      to_char(current_date - 6, 'YYYY-MM-DD') from_7d
      FROM activities WHERE organization_id=$1 AND entity_type = ANY($2)`, [ctx.orgId, visibleTypes(ctx)]);
    return r;
  });
}
