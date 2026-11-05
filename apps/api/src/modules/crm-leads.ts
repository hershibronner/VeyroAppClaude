// CRM — Leads: list/board/stats/source analytics, create/edit, status changes (Kanban), qualify, disqualify,
// outreach email (Dev Outbox), convert to client (same company record), archive.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, tx, type Db } from '../core/db';
import { staff, need, can, assertTransition, type Ctx } from '../core/context';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged, type ListParams } from '../core/list';
import { emit } from '../core/events';
import { sendMessage, sendTemplate } from '../adapters/messaging';
import { render } from '../core/templates';
import { allowedNext, humanize } from '@veyro/shared';
import {
  LEAD_SOURCES, LEAD_STATUSES, optStr, optEmail, optDate, optUuid, optInt, optCents, assertMember, companyOr404, assertScope, domainOf, normalizeWebsite,
  insertContact, pctDelta, fieldError, isUuid,
} from './_crm/util';

const contactInput = z.object({ first_name: z.string().trim().min(1, 'First name is required').max(100), last_name: optStr(100), title: optStr(120), email: optEmail, phone: optStr(40) });

export const leadFields = {
  name: z.string().trim().min(2, 'Company name is required').max(200),
  website: optStr(300), industry: optStr(100), size: optStr(40), country: optStr(80), phone: optStr(40), email: optEmail, address: optStr(300),
  source: z.preprocess(v => (v === '' ? null : v), z.enum(LEAD_SOURCES).nullable().optional()),
  campaign: optStr(120), owner_id: optUuid, account_manager_id: optUuid,
  lead_score: optInt(0, 100), est_workers: optInt(0, 10000), est_monthly_value_cents: optCents,
  notes: optStr(5000), next_follow_up: optDate,
};
const leadCreate = z.object({ ...leadFields, contact: contactInput.optional().nullable() });

const LEAD_SELECT = `c.id, c.name, c.website, c.domain, c.industry, c.size, c.country, c.source, c.campaign, c.owner_id, ou.name owner_name, ou.avatar_color owner_color,
  c.lead_score, c.lead_status, c.stage, c.est_workers, c.est_monthly_value_cents, c.currency, c.next_follow_up, c.created_at, c.converted_at, c.disqualify_reason,
  pc.id contact_id, NULLIF(concat_ws(' ', pc.first_name, pc.last_name), '') contact_name, pc.title contact_title, pc.email contact_email, pc.phone contact_phone,
  la.last_activity_at`;
const LEAD_FROM = `companies c LEFT JOIN users ou ON ou.id=c.owner_id
  LEFT JOIN LATERAL (SELECT id, first_name, last_name, title, email, phone FROM contacts WHERE company_id=c.id AND archived_at IS NULL ORDER BY is_primary DESC, created_at LIMIT 1) pc ON true
  LEFT JOIN LATERAL (SELECT max(created_at) last_activity_at FROM activities WHERE organization_id=c.organization_id AND entity_type='company' AND entity_id=c.id) la ON true`;

/** WHERE clauses shared by list + board (filters: status, source, owner, score, created/converted range, follow_up). */
function leadWhere(ctx: Ctx, lp: ListParams, opts: { forBoard?: boolean } = {}) {
  const f = lp.filters; const params: unknown[] = [ctx.orgId];
  const where = ['c.organization_id = $1', 'c.archived_at IS NULL'];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
  const statuses = (f.status ?? '').split(',').filter(s => (LEAD_STATUSES as readonly string[]).includes(s));
  if (!opts.forBoard && statuses.length) {
    add('c.lead_status = ANY(?)', statuses);
    if (!statuses.includes('converted')) where.push(`c.stage IN ('lead','qualified')`);
    else where.push(`(c.stage IN ('lead','qualified') OR c.lead_status='converted')`);
  } else if (!opts.forBoard) {
    where.push(`c.stage IN ('lead','qualified')`, `COALESCE(c.lead_status,'new') <> 'converted'`);
  } else {
    where.push(`(c.stage IN ('lead','qualified') OR (c.lead_status='converted' AND c.converted_at > now() - interval '90 days'))`);
  }
  if (f.source) add('c.source = ?', f.source);
  if (f.owner) add('c.owner_id = ?', f.owner === 'me' ? ctx.userId : isUuid(f.owner) ? f.owner : '00000000-0000-0000-0000-000000000000');
  if (f.unowned === 'true') where.push('c.owner_id IS NULL');
  if (f.score === 'hot') where.push('c.lead_score >= 70'); else if (f.score === 'warm') where.push('c.lead_score BETWEEN 40 AND 69'); else if (f.score === 'cold') where.push('c.lead_score < 40');
  if (f.score_min && !Number.isNaN(Number(f.score_min))) add('c.lead_score >= ?', Number(f.score_min));
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.created_from ?? '')) add('c.created_at >= ?::date', f.created_from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.created_to ?? '')) add(`c.created_at < ?::date + 1`, f.created_to);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.converted_from ?? '')) add('c.converted_at >= ?::date', f.converted_from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.converted_to ?? '')) add('c.converted_at < ?::date + 1', f.converted_to);
  if (f.follow_up === 'overdue') where.push(`c.next_follow_up < current_date AND COALESCE(c.lead_status,'new') NOT IN ('converted','unqualified')`);
  else if (f.follow_up === 'today') where.push('c.next_follow_up = current_date');
  else if (f.follow_up === 'week') where.push(`c.next_follow_up BETWEEN current_date AND current_date + 7`);
  else if (f.follow_up === 'none') where.push('c.next_follow_up IS NULL');
  if (f.stale === 'true') where.push(`c.lead_status='new' AND c.created_at < now() - interval '3 days'`);
  if (f.industry) add('c.industry = ?', f.industry);
  return { where, params };
}

/** Moves a lead between statuses following the lead_status machine, keeping company.stage in sync. */
export async function changeLeadStatus(ctx: Ctx, c: any, to: string, reason: string | null, db: Db) {
  const from = c.lead_status ?? 'new';
  if (from === to) return c;
  assertTransition('lead_status', from, to);
  let stage = c.stage;
  const wantStage = to === 'qualified' ? 'qualified' : to === 'converted' ? 'client' : 'lead';
  if (stage !== wantStage && (stage === 'lead' || stage === 'qualified')) { assertTransition('company', stage, wantStage); stage = wantStage; }
  const r = (await db.query(`UPDATE companies SET lead_status=$3, stage=$4, disqualify_reason=$5, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`,
    [c.id, ctx.orgId, to, stage, to === 'unqualified' ? reason : null])).rows[0];
  await activity(ctx, 'company', c.id, 'status_change', `Lead status: ${humanize(from)} → ${humanize(to)}`, reason, { from, to, field: 'lead_status' }, db);
  if (to === 'qualified') {
    await db.query(`INSERT INTO lead_score_events (organization_id, company_id, delta, reason) VALUES ($1,$2,15,'Qualified')`, [ctx.orgId, c.id]);
    await db.query(`UPDATE companies SET lead_score=LEAST(100, lead_score+15) WHERE id=$1`, [c.id]);
    r.lead_score = Math.min(100, r.lead_score + 15);
  }
  return r;
}

export default async function (app: FastifyInstance) {
  // ── List ──
  app.get('/api/v1/leads', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'view');
    const lp = listParams(req);
    const { where, params } = leadWhere(ctx, lp);
    return paged({ select: LEAD_SELECT, from: LEAD_FROM, where, params, lp, searchCols: ['c.name', 'c.domain', 'c.industry', "concat_ws(' ', pc.first_name, pc.last_name)", 'pc.email', 'c.campaign'],
      sortMap: { name: 'c.name', lead_score: 'c.lead_score', score: 'c.lead_score', created_at: 'c.created_at', next_follow_up: 'c.next_follow_up', est_monthly_value_cents: 'c.est_monthly_value_cents', lead_status: 'c.lead_status', source: 'c.source', owner_name: 'ou.name', last_activity_at: 'la.last_activity_at' },
      defaultSort: 'c.created_at DESC' });
  });

  // ── Kanban board: columns by lead status (same filters as the list) ──
  app.get('/api/v1/leads/board', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'view');
    const lp = listParams(req);
    const { where, params } = leadWhere(ctx, lp, { forBoard: true });
    if (lp.search) { params.push(`%${lp.search}%`); where.push(`(c.name ILIKE $${params.length} OR c.domain ILIKE $${params.length} OR concat_ws(' ', pc.first_name, pc.last_name) ILIKE $${params.length})`); }
    const rows = await q<any>(`SELECT ${LEAD_SELECT} FROM ${LEAD_FROM} WHERE ${where.join(' AND ')} ORDER BY c.lead_score DESC, c.created_at DESC LIMIT 1000`, params);
    return {
      columns: LEAD_STATUSES.map(s => {
        const items = rows.filter(r => (r.lead_status ?? 'new') === s);
        return { status: s, label: humanize(s), count: items.length, value_cents: items.reduce((a, r) => a + Number(r.est_monthly_value_cents ?? 0), 0), items: items.slice(0, 100), allowed_from: LEAD_STATUSES.filter(f => allowedNext('lead_status', f).includes(s)) };
      }),
    };
  });

  // ── KPI row + banner facts ──
  app.get('/api/v1/leads/stats', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'view');
    const r = await one<any>(`SELECT
      count(*) FILTER (WHERE stage IN ('lead','qualified') AND COALESCE(lead_status,'new') <> 'converted') open_now,
      count(*) FILTER (WHERE lead_status IS NOT NULL AND created_at < date_trunc('month', now()) AND (converted_at IS NULL OR converted_at >= date_trunc('month', now())) AND stage IN ('lead','qualified','client')) open_at_month_start,
      count(*) FILTER (WHERE lead_status IS NOT NULL AND created_at >= date_trunc('month', now())) new_this_month,
      count(*) FILTER (WHERE lead_status IS NOT NULL AND created_at >= date_trunc('month', now()) - interval '1 month' AND created_at < date_trunc('month', now())) new_last_month,
      count(*) FILTER (WHERE lead_status='qualified' AND stage IN ('lead','qualified')) qualified_now,
      count(*) FILTER (WHERE converted_at >= date_trunc('month', now())) converted_this_month,
      count(*) FILTER (WHERE converted_at >= date_trunc('month', now()) - interval '1 month' AND converted_at < date_trunc('month', now())) converted_last_month,
      count(*) FILTER (WHERE stage IN ('lead','qualified') AND next_follow_up < current_date AND COALESCE(lead_status,'new') NOT IN ('converted','unqualified')) follow_up_overdue,
      count(*) FILTER (WHERE stage IN ('lead','qualified') AND next_follow_up = current_date) follow_up_today,
      count(*) FILTER (WHERE stage IN ('lead','qualified') AND lead_status='new' AND created_at < now() - interval '3 days') stale_new,
      COALESCE(sum(est_monthly_value_cents) FILTER (WHERE stage IN ('lead','qualified') AND lead_status IN ('new','contacted','qualified')),0)::bigint pipeline_value_cents
      FROM companies WHERE organization_id=$1 AND archived_at IS NULL`, [ctx.orgId]);
    const qual = await one<any>(`SELECT count(DISTINCT entity_id) FILTER (WHERE created_at >= date_trunc('month', now())) this_month, count(DISTINCT entity_id) FILTER (WHERE created_at >= date_trunc('month', now()) - interval '1 month' AND created_at < date_trunc('month', now())) last_month
      FROM activities WHERE organization_id=$1 AND entity_type='company' AND kind='status_change' AND meta->>'to'='qualified'`, [ctx.orgId]);
    const n = (k: string) => Number(r[k] ?? 0);
    return {
      open: n('open_now'), open_delta: pctDelta(n('open_now'), n('open_at_month_start')),
      new_this_month: n('new_this_month'), new_delta: pctDelta(n('new_this_month'), n('new_last_month')),
      qualified: n('qualified_now'), qualified_this_month: Number(qual?.this_month ?? 0), qualified_last_month: Number(qual?.last_month ?? 0),
      converted_this_month: n('converted_this_month'), converted_last_month: n('converted_last_month'), converted_delta: pctDelta(n('converted_this_month'), n('converted_last_month')),
      follow_up_overdue: n('follow_up_overdue'), follow_up_today: n('follow_up_today'), stale_new: n('stale_new'), pipeline_value_cents: Number(r.pipeline_value_cents),
      month_start: (await one<any>(`SELECT to_char(date_trunc('month', now()), 'YYYY-MM-DD') d`))!.d,
    };
  });

  // ── Lead source analytics: leads → qualified → converted → placements → revenue (from invoices) ──
  app.get('/api/v1/leads/source-analytics', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'view');
    const months = Math.min(60, Math.max(0, Number((req.query as any).months) || 0)); // 0 = all time
    const params: unknown[] = [ctx.orgId];
    let range = '';
    if (months) { params.push(months); range = `AND c.created_at >= date_trunc('month', now()) - make_interval(months => $2 - 1)`; }
    const rows = await q<any>(`SELECT COALESCE(c.source, 'Unknown') source, count(*)::int leads,
        count(*) FILTER (WHERE c.lead_status IN ('qualified','converted') OR c.stage IN ('qualified','client','inactive'))::int qualified,
        count(*) FILTER (WHERE c.lead_status='converted' OR c.converted_at IS NOT NULL OR c.stage IN ('client','inactive'))::int converted,
        COALESCE(sum(pl.n),0)::int placements, COALESCE(sum(inv.rev),0)::bigint revenue_cents
      FROM companies c
      LEFT JOIN LATERAL (SELECT count(*) n FROM placements p WHERE p.company_id=c.id) pl ON true
      LEFT JOIN LATERAL (SELECT sum(total_cents) rev FROM invoices i WHERE i.company_id=c.id AND i.status NOT IN ('draft','void','written_off')) inv ON true
      WHERE c.organization_id=$1 AND c.archived_at IS NULL ${range}
      GROUP BY 1 ORDER BY revenue_cents DESC, leads DESC`, params);
    const showRevenue = can(ctx, 'invoices', 'view') || can(ctx, 'analytics', 'view');
    const out = rows.map(r => ({ ...r, revenue_cents: showRevenue ? Number(r.revenue_cents) : null, conversion_pct: r.leads ? Math.round((r.converted / r.leads) * 1000) / 10 : 0 }));
    const totals = out.reduce((a, r) => ({ leads: a.leads + r.leads, qualified: a.qualified + r.qualified, converted: a.converted + r.converted, placements: a.placements + r.placements, revenue_cents: showRevenue ? (a.revenue_cents ?? 0) + Number(r.revenue_cents) : null }), { leads: 0, qualified: 0, converted: 0, placements: 0, revenue_cents: showRevenue ? 0 : null as number | null });
    return { rows: out, totals, months, revenue_visible: showRevenue };
  });

  // ── Detail ──
  app.get('/api/v1/leads/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'view');
    const c = await companyOr404(ctx, (req.params as any).id);
    const [owner, contacts, scoreEvents, openTasks, opps, creator] = await Promise.all([
      one<any>(`SELECT id, name, email, avatar_color FROM users WHERE id=$1`, [c.owner_id]),
      q<any>(`SELECT ct.*, COALESCE((SELECT json_agg(json_build_object('id', m.id, 'kind', m.kind, 'value', m.value, 'label', m.label, 'is_primary', m.is_primary) ORDER BY m.is_primary DESC, m.created_at) FROM contact_methods m WHERE m.contact_id=ct.id), '[]') methods
        FROM contacts ct WHERE ct.organization_id=$1 AND ct.company_id=$2 AND ct.archived_at IS NULL ORDER BY ct.is_primary DESC, ct.created_at`, [ctx.orgId, c.id]),
      q<any>(`SELECT delta, reason, created_at FROM lead_score_events WHERE organization_id=$1 AND company_id=$2 ORDER BY created_at DESC LIMIT 10`, [ctx.orgId, c.id]),
      one<any>(`SELECT count(*)::int n FROM tasks WHERE organization_id=$1 AND related_type='company' AND related_id=$2 AND status IN ('open','in_progress') AND archived_at IS NULL`, [ctx.orgId, c.id]),
      q<any>(`SELECT o.id, o.name, o.stage, o.value_cents, o.currency, o.expected_close, u.name owner_name FROM opportunities o LEFT JOIN users u ON u.id=o.owner_id WHERE o.organization_id=$1 AND o.company_id=$2 AND o.archived_at IS NULL ORDER BY o.created_at DESC`, [ctx.orgId, c.id]),
      one<any>(`SELECT name FROM users WHERE id=$1`, [c.created_by]),
    ]);
    const primary = contacts[0] ?? null;
    const status = c.lead_status ?? 'new';
    return {
      ...c, owner_name: owner?.name ?? null, owner_color: owner?.avatar_color ?? null, created_by_name: creator?.name ?? null,
      contacts, primary_contact: primary, score_events: scoreEvents, open_tasks: openTasks?.n ?? 0, opportunities: opps,
      allowed_next: allowedNext('lead_status', status), can_convert: ['new', 'contacted', 'qualified'].includes(status) && (c.stage === 'lead' || c.stage === 'qualified'),
    };
  });

  // ── Create ──
  app.post('/api/v1/leads', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'create');
    const b = leadCreate.parse(req.body);
    await assertMember(ctx, b.owner_id, 'owner_id');
    const row = await tx(async (db) => {
      const c = (await db.query(`INSERT INTO companies (organization_id, name, website, domain, industry, size, country, phone, email, address, stage, lead_status, source, campaign, owner_id, lead_score, est_workers, est_monthly_value_cents, notes, next_follow_up, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'lead','new',$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [ctx.orgId, b.name, normalizeWebsite(b.website), domainOf(b.website) ?? (b.email ? b.email.split('@')[1]?.toLowerCase() : null), b.industry ?? null, b.size ?? null, b.country ?? null, b.phone ?? null, b.email ?? null, b.address ?? null,
          b.source ?? null, b.campaign ?? null, b.owner_id ?? ctx.userId, b.lead_score ?? 10, b.est_workers ?? null, b.est_monthly_value_cents ?? null, b.notes ?? null, b.next_follow_up ?? null, ctx.userId])).rows[0];
      if (b.contact?.first_name) await insertContact(ctx, { ...b.contact, company_id: c.id, is_primary: true }, db);
      await activity(ctx, 'company', c.id, 'system', 'Lead created', b.source ? `Source: ${b.source}${b.campaign ? ` · ${b.campaign}` : ''}` : null, {}, db);
      return c;
    });
    if (row.owner_id && row.owner_id !== ctx.userId) await notify(ctx.orgId, [row.owner_id], { event: 'lead.assigned', title: `New lead assigned: ${row.name}`, body: `${ctx.user.name} assigned you this lead.`, link: `/crm/leads/${row.id}` });
    return row;
  });

  // ── Edit ──
  app.patch('/api/v1/leads/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'edit');
    const c = await companyOr404(ctx, (req.params as any).id);
    return updateCompany(ctx, c, req.body);
  });

  // ── Status change (Kanban drag & drop) ──
  app.post('/api/v1/leads/:id/status', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'edit');
    const b = z.object({ status: z.enum(LEAD_STATUSES), reason: optStr(1000) }).parse(req.body);
    const c = await companyOr404(ctx, (req.params as any).id);
    if (b.status === 'converted') throw conflict('Use Convert to turn a lead into a client — it lets you keep contacts and create an opportunity or position.', { allowed: allowedNext('lead_status', c.lead_status ?? 'new') });
    if (b.status === 'unqualified' && !b.reason) fieldError('reason', 'A reason is required to disqualify a lead');
    return tx(db => changeLeadStatus(ctx, c, b.status, b.reason ?? null, db));
  });
  app.post('/api/v1/leads/:id/qualify', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'edit');
    const c = await companyOr404(ctx, (req.params as any).id);
    const b = z.object({ note: optStr(1000) }).parse(req.body ?? {});
    return tx(db => changeLeadStatus(ctx, c, 'qualified', b.note ?? null, db));
  });
  app.post('/api/v1/leads/:id/disqualify', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'edit');
    const b = z.object({ reason: z.string({ required_error: 'A reason is required' }).trim().min(3, 'A reason is required to disqualify a lead').max(1000) }).parse(req.body ?? {});
    const c = await companyOr404(ctx, (req.params as any).id);
    const r = await tx(db => changeLeadStatus(ctx, c, 'unqualified', b.reason, db));
    await audit(ctx, 'lead.disqualified', { type: 'company', id: c.id, label: c.name }, { lead_status: c.lead_status }, { lead_status: 'unqualified' }, b.reason);
    return r;
  });

  // ── Outreach email from template → Dev Outbox ──
  async function outreachContext(ctx: Ctx, c: any, contactId?: string | null) {
    const contact = contactId
      ? await one<any>(`SELECT * FROM contacts WHERE id=$1 AND organization_id=$2 AND company_id=$3`, [contactId, ctx.orgId, c.id])
      : await one<any>(`SELECT * FROM contacts WHERE organization_id=$1 AND company_id=$2 AND archived_at IS NULL AND email IS NOT NULL ORDER BY is_primary DESC, created_at LIMIT 1`, [ctx.orgId, c.id]);
    if (contactId && !contact) fieldError('contact_id', 'Contact not found on this lead');
    const vars = { contact: { firstName: contact?.first_name ?? 'there', name: [contact?.first_name, contact?.last_name].filter(Boolean).join(' ') }, company: { name: c.name }, sender: { name: ctx.user.name, email: ctx.user.email }, org: { name: ctx.org.name } };
    return { contact, vars };
  }
  app.get('/api/v1/leads/:id/email-preview', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'view');
    const c = await companyOr404(ctx, (req.params as any).id);
    const { contact_id, template } = req.query as any;
    const { contact, vars } = await outreachContext(ctx, c, isUuid(contact_id) ? contact_id : null);
    const key = typeof template === 'string' && /^[a-z_]{2,60}$/.test(template) ? template : 'lead_outreach';
    const t = await one<any>(`SELECT v.subject, v.body FROM templates t JOIN template_versions v ON v.template_id=t.id AND v.version=t.current_version WHERE t.organization_id=$1 AND t.key=$2 AND t.archived_at IS NULL`, [ctx.orgId, key]);
    const fb = (await import('@veyro/db')).EMAIL_TEMPLATES.find(e => e.key === key);
    if (!t && !fb) throw notFound('Template not found');
    return { template_key: key, to: contact?.email ?? null, contact_id: contact?.id ?? null, subject: render(t?.subject ?? fb!.subject, vars), body: render(t?.body ?? fb!.body, vars) };
  });
  app.post('/api/v1/leads/:id/send-email', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'edit');
    const b = z.object({ contact_id: optUuid, to: optEmail, subject: optStr(300), body: optStr(10000), template_key: z.string().regex(/^[a-z_]{2,60}$/).default('lead_outreach') }).parse(req.body ?? {});
    const c = await companyOr404(ctx, (req.params as any).id);
    const { contact, vars } = await outreachContext(ctx, c, b.contact_id ?? null);
    const to = b.to ?? contact?.email;
    if (!to) fieldError('to', 'This lead has no contact email — add one or type an address');
    const msg = b.subject && b.body
      ? await sendMessage({ orgId: ctx.orgId, channel: 'email', to: to!, subject: b.subject, text: b.body, related: { type: 'company', id: c.id }, templateKey: b.template_key })
      : await sendTemplate(ctx.orgId, b.template_key, to!, vars, { related: { type: 'company', id: c.id } });
    await tx(async db => {
      await db.query(`INSERT INTO lead_score_events (organization_id, company_id, delta, reason) VALUES ($1,$2,5,'Outreach email sent')`, [ctx.orgId, c.id]);
      await db.query(`UPDATE companies SET lead_score=LEAST(100, lead_score+5), updated_at=now() WHERE id=$1`, [c.id]);
      if ((c.lead_status ?? 'new') === 'new') await changeLeadStatus(ctx, c, 'contacted', 'Outreach email sent', db);
    });
    return { ok: true, outbox_id: msg.id, to };
  });

  // ── Convert: same company record → client; keep/create contacts; optional Opportunity and/or Position ──
  const convertBody = z.object({
    keep_contact_ids: z.array(z.string().uuid()).optional(),
    primary_contact_id: optUuid,
    new_contacts: z.array(contactInput.extend({ is_primary: z.boolean().optional() })).max(20).default([]),
    account_manager_id: optUuid,
    owner_id: optUuid,
    opportunity: z.object({ name: z.string().trim().min(2, 'Opportunity name is required').max(200), value_cents: optCents, est_workers: optInt(0, 10000), expected_close: optDate, stage: z.enum(['new', 'discovery', 'proposal', 'negotiation']).default('new'), probability: optInt(0, 100) }).nullable().optional(),
    position: z.object({ title: z.string().trim().min(2, 'Position title is required').max(200), openings: z.preprocess(v => (v === '' || v == null ? 1 : Number(v)), z.number().int().min(1).max(500)) }).nullable().optional(),
    note: optStr(2000),
  });
  app.post('/api/v1/leads/:id/convert', async (req) => {
    const ctx = staff(req); need(ctx, 'leads', 'edit'); need(ctx, 'clients', 'create');
    const b = convertBody.parse(req.body ?? {});
    if (b.opportunity) need(ctx, 'opportunities', 'create');
    if (b.position) need(ctx, 'positions', 'create');
    await assertMember(ctx, b.account_manager_id, 'account_manager_id');
    await assertMember(ctx, b.owner_id, 'owner_id');
    const c0 = await companyOr404(ctx, (req.params as any).id);
    if (c0.lead_status === 'converted' || c0.stage === 'client') throw conflict(`${c0.name} is already a client`);
    if (c0.lead_status === 'unqualified') throw conflict('This lead is disqualified — reopen it before converting', { allowed: allowedNext('lead_status', 'unqualified') });
    const result = await tx(async (db) => {
      let c = c0;
      // Walk the state machine: new/contacted → qualified → converted (each step writes an Activity).
      if ((c.lead_status ?? 'new') !== 'qualified') c = await changeLeadStatus(ctx, c, 'qualified', 'Qualified during conversion', db);
      assertTransition('lead_status', 'qualified', 'converted');
      assertTransition('company', c.stage, 'client');
      // Contacts: keep (default all), detach the rest (they stay as standalone contacts), create new ones.
      const existing = (await db.query(`SELECT id FROM contacts WHERE organization_id=$1 AND company_id=$2 AND archived_at IS NULL`, [ctx.orgId, c.id])).rows.map(r => r.id as string);
      const keep = b.keep_contact_ids ?? existing;
      const detach = existing.filter(id => !keep.includes(id));
      if (detach.length) {
        await db.query(`UPDATE contacts SET company_id=NULL, is_primary=false, updated_at=now() WHERE id = ANY($1) AND organization_id=$2`, [detach, ctx.orgId]);
        await db.query(`DELETE FROM company_contacts WHERE company_id=$1 AND contact_id = ANY($2)`, [c.id, detach]);
        for (const id of detach) await activity(ctx, 'contact', id, 'system', `Detached from ${c.name} during lead conversion`, null, {}, db);
      }
      const created: string[] = [];
      for (const nc of b.new_contacts) created.push((await insertContact(ctx, { ...nc, company_id: c.id, is_primary: !!nc.is_primary }, db)).id);
      const primaryId = b.primary_contact_id && [...keep, ...created].includes(b.primary_contact_id) ? b.primary_contact_id : null;
      if (primaryId) await db.query(`UPDATE contacts SET is_primary=(id=$2) WHERE company_id=$1 AND organization_id=$3`, [c.id, primaryId, ctx.orgId]);
      const primary = (await db.query(`SELECT id FROM contacts WHERE company_id=$1 AND archived_at IS NULL ORDER BY is_primary DESC, created_at LIMIT 1`, [c.id])).rows[0];
      const upd = (await db.query(`UPDATE companies SET stage='client', lead_status='converted', converted_at=now(), account_manager_id=COALESCE($3, account_manager_id), owner_id=COALESCE($4, owner_id), updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`,
        [c.id, ctx.orgId, b.account_manager_id ?? null, b.owner_id ?? null])).rows[0];
      let opportunityId: string | null = null; let positionId: string | null = null;
      if (b.opportunity) {
        const o = (await db.query(`INSERT INTO opportunities (organization_id, company_id, contact_id, name, stage, owner_id, est_workers, value_cents, currency, expected_close, probability, source, campaign, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [ctx.orgId, c.id, primary?.id ?? null, b.opportunity.name, b.opportunity.stage, upd.owner_id ?? ctx.userId, b.opportunity.est_workers ?? c.est_workers ?? null, b.opportunity.value_cents ?? c.est_monthly_value_cents ?? 0, c.currency, b.opportunity.expected_close ?? null,
            b.opportunity.probability ?? ({ new: 10, discovery: 25, proposal: 50, negotiation: 75 } as const)[b.opportunity.stage], c.source, c.campaign, ctx.userId])).rows[0];
        opportunityId = o.id;
        await activity(ctx, 'opportunity', o.id, 'system', `Opportunity created from lead conversion of ${c.name}`, null, { company_id: c.id }, db);
      }
      if (b.position) {
        const p = (await db.query(`INSERT INTO positions (organization_id, company_id, opportunity_id, title, openings, status, created_by) VALUES ($1,$2,$3,$4,$5,'draft',$6) RETURNING id`, [ctx.orgId, c.id, opportunityId, b.position.title, b.position.openings, ctx.userId])).rows[0];
        positionId = p.id;
        await activity(ctx, 'position', p.id, 'system', `Position drafted during conversion of ${c.name}`, null, { company_id: c.id }, db);
      }
      await activity(ctx, 'company', c.id, 'status_change', `Converted to client`, b.note ?? ([opportunityId && 'Opportunity created', positionId && 'Position drafted', created.length && `${created.length} contact(s) added`, detach.length && `${detach.length} contact(s) detached`].filter(Boolean).join(' · ') || null),
        { from: 'qualified', to: 'converted', field: 'lead_status', opportunity_id: opportunityId, position_id: positionId }, db);
      await audit(ctx, 'lead.converted', { type: 'company', id: c.id, label: c.name }, { stage: c0.stage, lead_status: c0.lead_status }, { stage: 'client', lead_status: 'converted', opportunity_id: opportunityId, position_id: positionId }, undefined, db);
      return { company: upd, opportunity_id: opportunityId, position_id: positionId, contacts_created: created.length, contacts_detached: detach.length };
    });
    const co = result.company;
    await emit(ctx.orgId, 'lead.converted', { company_id: co.id, company_name: co.name, owner_id: co.owner_id, account_manager_id: co.account_manager_id, opportunity_id: result.opportunity_id, position_id: result.position_id, converted_by: ctx.userId, source: co.source });
    await notify(ctx.orgId, [co.account_manager_id, co.owner_id].filter(u => u && u !== ctx.userId), { event: 'lead.converted', title: `${co.name} is now a client`, body: `${ctx.user.name} converted this lead.`, link: `/crm/clients/${co.id}` });
    return { id: co.id, stage: co.stage, opportunity_id: result.opportunity_id, position_id: result.position_id, contacts_created: result.contacts_created, contacts_detached: result.contacts_detached };
  });

  // ── Archive (soft delete; Sales may archive their own leads) ──
  app.delete('/api/v1/leads/:id', async (req) => {
    const ctx = staff(req);
    const c = await companyOr404(ctx, (req.params as any).id);
    assertScope(ctx, 'leads', 'delete', c);
    if (c.stage === 'client' || c.stage === 'inactive') throw conflict('Clients cannot be archived from Leads');
    await q(`UPDATE companies SET archived_at=now(), updated_at=now() WHERE id=$1 AND organization_id=$2`, [c.id, ctx.orgId]);
    await activity(ctx, 'company', c.id, 'system', 'Lead archived');
    await audit(ctx, 'lead.archived', { type: 'company', id: c.id, label: c.name });
    return { ok: true };
  });

  // ── Bulk: assign owner / archive ──
  app.post('/api/v1/leads/bulk', async (req) => {
    const ctx = staff(req);
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), action: z.enum(['assign', 'archive']), owner_id: optUuid }).parse(req.body);
    const rows = await q<any>(`SELECT * FROM companies WHERE organization_id=$1 AND id = ANY($2) AND stage IN ('lead','qualified')`, [ctx.orgId, b.ids]);
    if (b.action === 'assign') {
      need(ctx, 'leads', 'edit');
      if (!b.owner_id) fieldError('owner_id', 'Pick an owner');
      await assertMember(ctx, b.owner_id, 'owner_id');
      await q(`UPDATE companies SET owner_id=$3, updated_at=now() WHERE organization_id=$1 AND id = ANY($2)`, [ctx.orgId, rows.map(r => r.id), b.owner_id]);
      const nm = (await one<any>(`SELECT name FROM users WHERE id=$1`, [b.owner_id]))?.name;
      for (const r of rows) await activity(ctx, 'company', r.id, 'system', `Owner changed to ${nm}`);
      if (b.owner_id !== ctx.userId) await notify(ctx.orgId, [b.owner_id], { event: 'lead.assigned', title: `${rows.length} lead(s) assigned to you`, body: `${ctx.user.name} assigned you ${rows.length} lead(s).`, link: `/crm/leads?owner=${b.owner_id}` });
    } else {
      for (const r of rows) assertScope(ctx, 'leads', 'delete', r);
      await q(`UPDATE companies SET archived_at=now(), updated_at=now() WHERE organization_id=$1 AND id = ANY($2)`, [ctx.orgId, rows.map(r => r.id)]);
      for (const r of rows) await activity(ctx, 'company', r.id, 'system', 'Lead archived');
      await audit(ctx, 'lead.archived.bulk', { type: 'company', label: `${rows.length} leads` }, null, { ids: rows.map(r => r.id) });
    }
    return { ok: true, count: rows.length };
  });
}

/** Generic company edit (leads & clients). Writes an Activity listing changed fields; score changes are logged. */
export async function updateCompany(ctx: Ctx, c: any, body: unknown) {
  const patchSchema = z.object({
    ...Object.fromEntries(Object.entries(leadFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
    timesheet_approval: z.enum(['agency', 'client', 'both']).optional(), portal_screenshots: z.boolean().optional(),
    payment_terms_days: optInt(0, 365), tax_bp: optInt(0, 10000),
  }).strict();
  const b = patchSchema.parse(body ?? {}) as Record<string, any>;
  if ('name' in b && !b.name) fieldError('name', 'Company name is required');
  await assertMember(ctx, b.owner_id, 'owner_id');
  await assertMember(ctx, b.account_manager_id, 'account_manager_id');
  if (('payment_terms_days' in b || 'tax_bp' in b) && !can(ctx, 'invoices', 'edit') && !can(ctx, 'clients', 'edit')) throw badRequest('Not allowed');
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (v !== undefined) patch[k] = v;
  if ('website' in patch) { patch.website = normalizeWebsite(patch.website as string); patch.domain = domainOf(patch.website as string); }
  for (const k of ['payment_terms_days', 'tax_bp']) if (patch[k] === null) delete patch[k];
  if (patch.lead_score === null) delete patch.lead_score;
  const changed = Object.keys(patch).filter(k => String(c[k] ?? '') !== String(patch[k] ?? '') && k !== 'domain');
  if (!changed.length) return c;
  const sets = Object.keys(patch).map((k, i) => `${k}=$${i + 3}`);
  const row = await one<any>(`UPDATE companies SET ${sets.join(',')}, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [c.id, ctx.orgId, ...Object.values(patch)]);
  if (changed.includes('lead_score')) await q(`INSERT INTO lead_score_events (organization_id, company_id, delta, reason) VALUES ($1,$2,$3,$4)`, [ctx.orgId, c.id, Number(patch.lead_score) - Number(c.lead_score), `Score set manually by ${ctx.user.name}`]);
  const labels: Record<string, string> = { owner_id: 'owner', account_manager_id: 'account manager', est_workers: 'estimated workers', est_monthly_value_cents: 'estimated monthly value', next_follow_up: 'next follow-up', lead_score: 'lead score' };
  await activity(ctx, 'company', c.id, 'system', `Updated ${changed.map(k => labels[k] ?? k.replace(/_/g, ' ')).join(', ')}`, null, { changed });
  if (changed.includes('owner_id') && patch.owner_id && patch.owner_id !== ctx.userId) await notify(ctx.orgId, [patch.owner_id as string], { event: 'lead.assigned', title: `You now own ${row.name}`, body: `${ctx.user.name} assigned this record to you.`, link: `/crm/companies/${row.id}` });
  if (changed.includes('account_manager_id') && patch.account_manager_id && patch.account_manager_id !== ctx.userId) await notify(ctx.orgId, [patch.account_manager_id as string], { event: 'client.assigned', title: `You are now account manager for ${row.name}`, link: `/crm/clients/${row.id}` });
  return row;
}
