// CRM — Opportunities: pipeline board + table, stage machine, Won → activate client + optional Position.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, tx } from '../core/db';
import { staff, need, assertTransition, type Ctx } from '../core/context';
import { conflict, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged, type ListParams } from '../core/list';
import { emit } from '../core/events';
import { allowedNext, humanize } from '@veyro/shared';
import { OPP_STAGES, LEAD_SOURCES, optStr, optDate, optUuid, optInt, optCents, assertMember, assertScope, isUuid, fieldError, monthBuckets, pctDelta } from './_crm/util';

const PROB: Record<string, number> = { new: 10, discovery: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 };
const oppFields = {
  name: z.string().trim().min(2, 'Name is required').max(200), company_id: optUuid, contact_id: optUuid, owner_id: optUuid,
  est_workers: optInt(0, 10000), value_cents: optCents, expected_close: optDate, probability: optInt(0, 100),
  source: z.preprocess(v => (v === '' ? null : v), z.enum(LEAD_SOURCES).nullable().optional()), campaign: optStr(120),
};

async function oppOr404(ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const o = await one<any>(`SELECT * FROM opportunities WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]);
  if (!o) throw notFound();
  return o;
}
async function checkLinks(ctx: Ctx, companyId?: string | null, contactId?: string | null) {
  if (companyId && !(await one(`SELECT 1 FROM companies WHERE id=$1 AND organization_id=$2`, [companyId, ctx.orgId]))) fieldError('company_id', 'Company not found');
  if (contactId) {
    const ct = await one<any>(`SELECT company_id FROM contacts WHERE id=$1 AND organization_id=$2`, [contactId, ctx.orgId]);
    if (!ct) fieldError('contact_id', 'Contact not found');
  }
}

const SELECT = `o.id, o.name, o.stage, o.owner_id, u.name owner_name, u.avatar_color owner_color, o.est_workers, o.value_cents, o.currency, o.expected_close, o.probability, o.source, o.campaign,
  o.company_id, co.name company_name, co.stage company_stage, o.contact_id, NULLIF(concat_ws(' ', ct.first_name, ct.last_name), '') contact_name, o.lost_reason, o.closed_at, o.created_at, o.updated_at,
  round(o.value_cents * o.probability / 100.0)::bigint weighted_cents`;
const FROM = `opportunities o LEFT JOIN users u ON u.id=o.owner_id LEFT JOIN companies co ON co.id=o.company_id LEFT JOIN contacts ct ON ct.id=o.contact_id`;
function oppWhere(ctx: Ctx, lp: ListParams) {
  const f = lp.filters; const params: unknown[] = [ctx.orgId];
  const where = ['o.organization_id=$1', 'o.archived_at IS NULL'];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
  const stages = (f.stage ?? '').split(',').filter(s => (OPP_STAGES as readonly string[]).includes(s));
  if (stages.length) add('o.stage = ANY(?)', stages);
  if (f.open === 'true') where.push(`o.stage NOT IN ('won','lost')`);
  if (f.owner) add('o.owner_id = ?', f.owner === 'me' ? ctx.userId : isUuid(f.owner) ? f.owner : null);
  if (isUuid(f.company_id)) add('o.company_id = ?', f.company_id);
  if (f.source) add('o.source = ?', f.source);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.closed_from ?? '')) add('o.closed_at >= ?::date', f.closed_from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.close_to ?? '')) add('o.expected_close <= ?::date', f.close_to);
  if (f.overdue === 'true') where.push(`o.expected_close < current_date AND o.stage NOT IN ('won','lost')`);
  return { where, params };
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/opportunities', async (req) => {
    const ctx = staff(req); need(ctx, 'opportunities', 'view');
    const lp = listParams(req);
    const { where, params } = oppWhere(ctx, lp);
    return paged({ select: SELECT, from: FROM, where, params, lp, searchCols: ['o.name', 'co.name', "concat_ws(' ', ct.first_name, ct.last_name)", 'o.campaign'],
      sortMap: { name: 'o.name', value_cents: 'o.value_cents', expected_close: 'o.expected_close', probability: 'o.probability', created_at: 'o.created_at', stage: 'o.stage', company_name: 'co.name', owner_name: 'u.name', weighted_cents: 'weighted_cents' },
      defaultSort: 'o.expected_close ASC NULLS LAST, o.created_at DESC' });
  });

  app.get('/api/v1/opportunities/board', async (req) => {
    const ctx = staff(req); need(ctx, 'opportunities', 'view');
    const lp = listParams(req);
    const { where, params } = oppWhere(ctx, lp);
    where.push(`(o.stage NOT IN ('won','lost') OR o.closed_at > now() - interval '90 days')`);
    if (lp.search) { params.push(`%${lp.search}%`); where.push(`(o.name ILIKE $${params.length} OR co.name ILIKE $${params.length})`); }
    const rows = await q<any>(`SELECT ${SELECT} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY o.value_cents DESC LIMIT 1000`, params);
    return { columns: OPP_STAGES.map(s => { const items = rows.filter(r => r.stage === s); return { stage: s, label: humanize(s), count: items.length, value_cents: items.reduce((a, r) => a + Number(r.value_cents), 0), items, allowed_from: OPP_STAGES.filter(f => allowedNext('opportunity', f).includes(s)) }; }) };
  });

  app.get('/api/v1/opportunities/stats', async (req) => {
    const ctx = staff(req); need(ctx, 'opportunities', 'view');
    const months = Math.min(24, Math.max(3, Number((req.query as any).months) || 6));
    const r = await one<any>(`SELECT
      count(*) FILTER (WHERE stage NOT IN ('won','lost'))::int open_count,
      COALESCE(sum(value_cents) FILTER (WHERE stage NOT IN ('won','lost')),0)::bigint pipeline_cents,
      COALESCE(round(sum(value_cents * probability / 100.0) FILTER (WHERE stage NOT IN ('won','lost'))),0)::bigint weighted_cents,
      count(*) FILTER (WHERE stage='won' AND closed_at >= date_trunc('month', now()))::int won_this_month,
      count(*) FILTER (WHERE stage='won' AND closed_at >= date_trunc('month', now()) - interval '1 month' AND closed_at < date_trunc('month', now()))::int won_last_month,
      COALESCE(sum(value_cents) FILTER (WHERE stage='won' AND closed_at >= date_trunc('month', now())),0)::bigint won_value_this_month,
      count(*) FILTER (WHERE stage='won')::int won_total, count(*) FILTER (WHERE stage='lost')::int lost_total,
      count(*) FILTER (WHERE expected_close < current_date AND stage NOT IN ('won','lost'))::int overdue_close,
      count(*) FILTER (WHERE expected_close BETWEEN current_date AND current_date + 30 AND stage NOT IN ('won','lost'))::int closing_30d
      FROM opportunities WHERE organization_id=$1 AND archived_at IS NULL`, [ctx.orgId]);
    const buckets = monthBuckets(months);
    const won = await q<any>(`SELECT to_char(closed_at, 'YYYY-MM') m, sum(value_cents)::bigint v, count(*)::int n FROM opportunities WHERE organization_id=$1 AND stage='won' AND closed_at >= $2::date AND archived_at IS NULL GROUP BY 1`, [ctx.orgId, buckets[0].key + '-01']);
    const decided = Number(r.won_total) + Number(r.lost_total);
    return { ...r, pipeline_cents: Number(r.pipeline_cents), weighted_cents: Number(r.weighted_cents), won_value_this_month: Number(r.won_value_this_month),
      won_delta: pctDelta(r.won_this_month, r.won_last_month), win_rate: decided ? Math.round((Number(r.won_total) / decided) * 1000) / 10 : null,
      won_trend: buckets.map(b => ({ label: b.label, value: Number(won.find(w => w.m === b.key)?.v ?? 0), count: won.find(w => w.m === b.key)?.n ?? 0 })),
      month_start: (await one<any>(`SELECT to_char(date_trunc('month', now()), 'YYYY-MM-DD') d`))!.d };
  });

  app.get('/api/v1/opportunities/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'opportunities', 'view');
    const o = await oppOr404(ctx, (req.params as any).id);
    const row = await one<any>(`SELECT ${SELECT}, co.account_manager_id, ct.email contact_email, ct.phone contact_phone, ct.title contact_title, cu.name created_by_name FROM ${FROM} LEFT JOIN users cu ON cu.id=o.created_by WHERE o.id=$1`, [o.id]);
    const positions = await q<any>(`SELECT id, title, status, openings, filled FROM positions WHERE organization_id=$1 AND opportunity_id=$2 ORDER BY created_at`, [ctx.orgId, o.id]);
    return { ...row, positions, allowed_next: allowedNext('opportunity', o.stage) };
  });

  app.post('/api/v1/opportunities', async (req) => {
    const ctx = staff(req); need(ctx, 'opportunities', 'create');
    const b = z.object({ ...oppFields, stage: z.enum(['new', 'discovery', 'proposal', 'negotiation']).default('new') }).parse(req.body);
    await assertMember(ctx, b.owner_id, 'owner_id'); await checkLinks(ctx, b.company_id, b.contact_id);
    const co = b.company_id ? await one<any>(`SELECT source, campaign, currency FROM companies WHERE id=$1`, [b.company_id]) : null;
    const o = await one<any>(`INSERT INTO opportunities (organization_id, company_id, contact_id, name, stage, owner_id, est_workers, value_cents, currency, expected_close, probability, source, campaign, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [ctx.orgId, b.company_id ?? null, b.contact_id ?? null, b.name, b.stage, b.owner_id ?? ctx.userId, b.est_workers ?? null, b.value_cents ?? 0, co?.currency ?? 'USD', b.expected_close ?? null, b.probability ?? PROB[b.stage], b.source ?? co?.source ?? null, b.campaign ?? co?.campaign ?? null, ctx.userId]);
    await activity(ctx, 'opportunity', o.id, 'system', 'Opportunity created');
    if (o.company_id) await activity(ctx, 'company', o.company_id, 'system', `Opportunity created: ${o.name}`, null, { opportunity_id: o.id });
    if (o.owner_id !== ctx.userId) await notify(ctx.orgId, [o.owner_id], { event: 'opportunity.assigned', title: `Opportunity assigned: ${o.name}`, link: `/crm/opportunities/${o.id}` });
    return o;
  });

  app.patch('/api/v1/opportunities/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'opportunities', 'edit');
    const o = await oppOr404(ctx, (req.params as any).id);
    const b = z.object(oppFields).partial().strict().parse(req.body);
    if ('name' in b && !b.name) fieldError('name', 'Name is required');
    await assertMember(ctx, b.owner_id, 'owner_id'); await checkLinks(ctx, b.company_id, b.contact_id);
    const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
    if (patch.value_cents === null) patch.value_cents = 0;
    if (patch.probability === null) delete patch.probability;
    const changed = Object.keys(patch).filter(k => String(o[k] ?? '') !== String(patch[k] ?? ''));
    if (!changed.length) return o;
    const row = await one<any>(`UPDATE opportunities SET ${Object.keys(patch).map((k, i) => `${k}=$${i + 3}`).join(',')}, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [o.id, ctx.orgId, ...Object.values(patch)]);
    await activity(ctx, 'opportunity', o.id, 'system', `Updated ${changed.map(k => k.replace(/_cents$/, '').replace(/_id$/, '').replace(/_/g, ' ')).join(', ')}`, null, { changed });
    return row;
  });

  // ── Stage change (board drag & drop). Won → optionally activate client + create Position. ──
  app.post('/api/v1/opportunities/:id/stage', async (req) => {
    const ctx = staff(req); need(ctx, 'opportunities', 'edit');
    const b = z.object({
      stage: z.enum(OPP_STAGES), lost_reason: optStr(1000), activate_client: z.boolean().default(true),
      position: z.object({ title: z.string().trim().min(2, 'Position title is required').max(200), openings: z.preprocess(v => (v === '' || v == null ? 1 : Number(v)), z.number().int().min(1).max(500)) }).nullable().optional(),
    }).parse(req.body);
    const o = await oppOr404(ctx, (req.params as any).id);
    assertTransition('opportunity', o.stage, b.stage);
    if (b.stage === 'lost' && !b.lost_reason) fieldError('lost_reason', 'A reason is required when marking an opportunity lost');
    if (b.position) need(ctx, 'positions', 'create');
    if (b.stage === 'won' && b.activate_client && o.company_id) need(ctx, 'clients', 'edit');
    if (b.position && !o.company_id) fieldError('position', 'Link a company to this opportunity before creating a position');
    const res = await tx(async db => {
      const closed = b.stage === 'won' || b.stage === 'lost';
      const row = (await db.query(`UPDATE opportunities SET stage=$3, probability=$4, closed_at=$5, lost_reason=$6, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`,
        [o.id, ctx.orgId, b.stage, PROB[b.stage] ?? o.probability, closed ? new Date() : null, b.stage === 'lost' ? b.lost_reason : null])).rows[0];
      await activity(ctx, 'opportunity', o.id, 'status_change', `Stage: ${humanize(o.stage)} → ${humanize(b.stage)}`, b.lost_reason ?? null, { from: o.stage, to: b.stage, field: 'stage' }, db);
      let activated = false; let positionId: string | null = null; let company: any = null;
      if (o.company_id) company = (await db.query(`SELECT * FROM companies WHERE id=$1 AND organization_id=$2`, [o.company_id, ctx.orgId])).rows[0];
      if (b.stage === 'won' && b.activate_client && company && company.stage !== 'client') {
        assertTransition('company', company.stage, 'client');
        const wasLead = company.stage === 'lead' || company.stage === 'qualified';
        await db.query(`UPDATE companies SET stage='client', lead_status=CASE WHEN $3 THEN 'converted' ELSE lead_status END, converted_at=COALESCE(converted_at, now()), updated_at=now() WHERE id=$1 AND organization_id=$2`, [company.id, ctx.orgId, wasLead]);
        await activity(ctx, 'company', company.id, 'status_change', wasLead ? 'Converted to client (opportunity won)' : 'Client re-activated (opportunity won)', o.name, { from: company.stage, to: 'client', field: 'stage', opportunity_id: o.id }, db);
        activated = true;
      }
      if (b.stage === 'won' && b.position && company) {
        positionId = (await db.query(`INSERT INTO positions (organization_id, company_id, opportunity_id, title, openings, status, created_by) VALUES ($1,$2,$3,$4,$5,'draft',$6) RETURNING id`, [ctx.orgId, company.id, o.id, b.position.title, b.position.openings, ctx.userId])).rows[0].id;
        await activity(ctx, 'position', positionId!, 'system', `Position drafted from won opportunity ${o.name}`, null, { opportunity_id: o.id }, db);
        await activity(ctx, 'opportunity', o.id, 'system', `Position drafted: ${b.position.title}`, null, { position_id: positionId }, db);
      }
      if (company) await activity(ctx, 'company', company.id, 'system', `Opportunity ${o.name} moved to ${humanize(b.stage)}`, null, { opportunity_id: o.id }, db);
      if (closed) await audit(ctx, `opportunity.${b.stage}`, { type: 'opportunity', id: o.id, label: o.name }, { stage: o.stage }, { stage: b.stage, position_id: positionId, client_activated: activated }, b.lost_reason ?? undefined, db);
      return { row, activated, positionId, company };
    });
    if (b.stage === 'won') {
      await emit(ctx.orgId, 'opportunity.won', { opportunity_id: o.id, opportunity_name: o.name, company_id: o.company_id, company_name: res.company?.name ?? null, value_cents: Number(o.value_cents), owner_id: o.owner_id, account_manager_id: res.company?.account_manager_id ?? null, position_id: res.positionId });
      if (res.activated && res.company && (res.company.stage === 'lead' || res.company.stage === 'qualified')) await emit(ctx.orgId, 'lead.converted', { company_id: res.company.id, company_name: res.company.name, owner_id: res.company.owner_id, account_manager_id: res.company.account_manager_id, opportunity_id: o.id, position_id: res.positionId, converted_by: ctx.userId, source: res.company.source });
      await notify(ctx.orgId, [o.owner_id, res.company?.account_manager_id].filter(u => u && u !== ctx.userId), { event: 'opportunity.won', title: `Won: ${o.name}`, body: res.company ? `${res.company.name}${res.activated ? ' is now an active client' : ''}` : null, link: `/crm/opportunities/${o.id}` });
    }
    return { ...res.row, client_activated: res.activated, position_id: res.positionId };
  });

  app.delete('/api/v1/opportunities/:id', async (req) => {
    const ctx = staff(req);
    const o = await oppOr404(ctx, (req.params as any).id);
    assertScope(ctx, 'opportunities', 'delete', o);
    if (o.stage === 'won') throw conflict('Won opportunities are kept for reporting and cannot be archived');
    await q(`UPDATE opportunities SET archived_at=now(), updated_at=now() WHERE id=$1 AND organization_id=$2`, [o.id, ctx.orgId]);
    await activity(ctx, 'opportunity', o.id, 'system', 'Opportunity archived');
    await audit(ctx, 'opportunity.archived', { type: 'opportunity', id: o.id, label: o.name });
    return { ok: true };
  });
}
