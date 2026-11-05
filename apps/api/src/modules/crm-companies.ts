// CRM — Companies & Clients: generic company list/detail/edit, duplicate warnings, client detail tabs
// (positions, placements, finance, documents, onboarding requirements), portal invitations,
// deactivate/reactivate, and permanent delete with dependency analysis.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { q, one, tx } from '../core/db';
import { staff, need, can, canViewComp, redact, assertTransition, type Ctx } from '../core/context';
import { conflict, forbidden, notFound, badRequest } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { sendTemplate } from '../adapters/messaging';
import { saveFile, signedUrl } from '../core/storage';
import { WEB_URL } from '../core/settings';
import { normalizeCompanyName, normalizeEmail, normalizePhone } from '@veyro/shared';
import { leadFields, updateCompany } from './crm-leads';
import { companyOr404, companyResource, assertMember, domainOf, normalizeWebsite, insertContact, isOwnerAdmin, monthBuckets, pctDelta, CLIENT_ROLE_KEYS, optStr, fieldError, isUuid } from './_crm/util';

const ATTENTION_LATERAL = `
  LEFT JOIN LATERAL (SELECT
    (SELECT count(*) FROM positions p WHERE p.company_id=c.id AND p.status IN ('open','on_hold') AND p.archived_at IS NULL)::int open_roles,
    (SELECT count(*) FROM placements p WHERE p.company_id=c.id AND p.status IN ('active','on_leave','notice'))::int active_workers,
    (SELECT count(*) FROM placements p WHERE p.company_id=c.id AND p.status='onboarding')::int onboarding_workers,
    (SELECT count(*) FROM invoices i WHERE i.company_id=c.id AND i.status='overdue')::int overdue_invoices,
    (SELECT count(*) FROM issues i JOIN placements p ON p.id=i.placement_id WHERE p.company_id=c.id AND i.status IN ('open','investigating'))::int open_issues,
    (SELECT count(*) FROM attendance_events a JOIN placements p ON p.id=a.placement_id WHERE p.company_id=c.id AND a.work_date=current_date AND a.kind IN ('late','absent'))::int late_today,
    (SELECT count(*) FROM contacts ct WHERE ct.company_id=c.id AND ct.archived_at IS NULL)::int contacts_count
  ) k ON true`;
const ATTN = `(k.overdue_invoices > 0 OR k.open_issues > 0 OR k.late_today > 0)`;

function attentionReasons(r: any, ctx: Ctx) {
  const out: string[] = [];
  if (r.overdue_invoices && can(ctx, 'invoices', 'view')) out.push(`${r.overdue_invoices} overdue invoice${r.overdue_invoices > 1 ? 's' : ''}`);
  else if (r.overdue_invoices) out.push('Overdue billing');
  if (r.open_issues) out.push(`${r.open_issues} open issue${r.open_issues > 1 ? 's' : ''}`);
  if (r.late_today) out.push(`${r.late_today} late/absent today`);
  return out;
}

export default async function (app: FastifyInstance) {
  // ── Duplicate warning (warn, don't block) ──
  app.get('/api/v1/companies/duplicates', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'leads', 'view') && !can(ctx, 'clients', 'view') && !can(ctx, 'contacts', 'view')) throw notFound();
    const { name, domain, website, email, phone, exclude } = req.query as Record<string, string | undefined>;
    const nName = normalizeCompanyName(name); const nDomain = domainOf(domain || website) ?? (email?.includes('@') ? email.split('@')[1].toLowerCase() : null);
    const nEmail = normalizeEmail(email); const nPhone = normalizePhone(phone);
    const FREE = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com', 'proton.me'];
    const matches: { type: string; id: string; name: string; stage?: string; reason: string; link: string }[] = [];
    if (nName.length >= 3 || nDomain) {
      const cs = await q<any>(`SELECT id, name, domain, website, stage, email, phone FROM companies WHERE organization_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`, [ctx.orgId, isUuid(exclude) ? exclude : null]);
      for (const c of cs) {
        const reasons: string[] = [];
        if (nName.length >= 3 && normalizeCompanyName(c.name) === nName) reasons.push('Same company name');
        else if (nName.length >= 5 && (normalizeCompanyName(c.name).startsWith(nName) || nName.startsWith(normalizeCompanyName(c.name))) && normalizeCompanyName(c.name).length >= 5) reasons.push('Similar company name');
        if (nDomain && !FREE.includes(nDomain) && (c.domain === nDomain || domainOf(c.website) === nDomain)) reasons.push(`Same domain (${nDomain})`);
        if (nPhone && normalizePhone(c.phone) === nPhone) reasons.push('Same company phone');
        if (reasons.length) matches.push({ type: c.stage === 'lead' || c.stage === 'qualified' ? 'lead' : 'client', id: c.id, name: c.name, stage: c.stage, reason: reasons.join(' · '), link: c.stage === 'lead' || c.stage === 'qualified' ? `/crm/leads/${c.id}` : `/crm/clients/${c.id}` });
      }
    }
    if (nEmail || nPhone) {
      const ms = await q<any>(`SELECT DISTINCT ON (ct.id) ct.id, concat_ws(' ', ct.first_name, ct.last_name) nm, co.name company_name, m.kind, m.value FROM contact_methods m JOIN contacts ct ON ct.id=m.contact_id LEFT JOIN companies co ON co.id=ct.company_id
        WHERE m.organization_id=$1 AND ct.archived_at IS NULL AND ((m.kind='email' AND lower(m.value)=$2) OR (m.kind<>'email' AND regexp_replace(m.value, '[^0-9+]', '', 'g') = $3)) AND ($4::uuid IS NULL OR ct.company_id IS DISTINCT FROM $4::uuid)`, [ctx.orgId, nEmail, nPhone, isUuid(exclude) ? exclude : null]);
      for (const m of ms) matches.push({ type: 'contact', id: m.id, name: m.nm + (m.company_name ? ` (${m.company_name})` : ''), reason: m.kind === 'email' ? `Contact with email ${m.value}` : `Contact with phone ${m.value}`, link: `/crm/contacts/${m.id}` });
    }
    return { matches: matches.slice(0, 20) };
  });

  // ── Generic company list (clients list + pickers). ?stage=client,inactive ──
  app.get('/api/v1/companies', async (req) => {
    const ctx = staff(req);
    const lp = listParams(req); const f = lp.filters;
    const stages = (f.stage ?? '').split(',').filter(s => ['lead', 'qualified', 'client', 'inactive'].includes(s));
    const wantsLeads = !stages.length || stages.some(s => s === 'lead' || s === 'qualified');
    const wantsClients = !stages.length || stages.some(s => s === 'client' || s === 'inactive');
    const vis: string[] = [];
    if (can(ctx, 'leads', 'view') && wantsLeads) vis.push(`c.stage IN ('lead','qualified')`);
    if (can(ctx, 'clients', 'view') && wantsClients) vis.push(`c.stage IN ('client','inactive')`);
    if (!vis.length) { if (!can(ctx, 'leads', 'view') && !can(ctx, 'clients', 'view')) throw notFound(); return { rows: [], total: 0, page: lp.page, pageSize: lp.pageSize }; }
    const params: unknown[] = [ctx.orgId];
    const where = ['c.organization_id=$1', 'c.archived_at IS NULL', `(${vis.join(' OR ')})`];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (stages.length) add('c.stage = ANY(?)', stages);
    if (f.account_manager) add('c.account_manager_id = ?', f.account_manager === 'me' ? ctx.userId : f.account_manager);
    if (f.owner) add('c.owner_id = ?', f.owner === 'me' ? ctx.userId : f.owner);
    if (f.industry) add('c.industry = ?', f.industry);
    if (f.source) add('c.source = ?', f.source);
    if (f.attention === 'true') where.push(ATTN);
    if (f.has_workers === 'true') where.push('k.active_workers > 0');
    if (f.open_roles === 'true') where.push('k.open_roles > 0');
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.converted_from ?? '')) add('COALESCE(c.converted_at, c.created_at) >= ?::date', f.converted_from);
    const res = await paged<any>({
      select: `c.id, c.name, c.website, c.industry, c.size, c.country, c.phone, c.email, c.stage, c.lead_status, c.source, c.owner_id, c.account_manager_id, c.created_at, c.converted_at,
        am.name account_manager_name, am.avatar_color account_manager_color, ow.name owner_name,
        pc.id primary_contact_id, NULLIF(concat_ws(' ', pc.first_name, pc.last_name), '') primary_contact_name, pc.email primary_contact_email, pc.phone primary_contact_phone,
        k.open_roles, k.active_workers, k.onboarding_workers, k.overdue_invoices, k.open_issues, k.late_today, k.contacts_count, ${ATTN} attention`,
      from: `companies c LEFT JOIN users am ON am.id=c.account_manager_id LEFT JOIN users ow ON ow.id=c.owner_id
        LEFT JOIN LATERAL (SELECT id, first_name, last_name, email, phone FROM contacts WHERE company_id=c.id AND archived_at IS NULL ORDER BY is_primary DESC, created_at LIMIT 1) pc ON true ${ATTENTION_LATERAL}`,
      where, params, lp, searchCols: ['c.name', 'c.domain', 'c.industry', "concat_ws(' ', pc.first_name, pc.last_name)", 'pc.email'],
      sortMap: { name: 'c.name', open_roles: 'k.open_roles', active_workers: 'k.active_workers', created_at: 'c.created_at', account_manager_name: 'am.name', industry: 'c.industry', converted_at: 'c.converted_at' },
      defaultSort: 'c.name ASC',
    });
    res.rows = res.rows.map(r => ({ ...r, attention_reasons: attentionReasons(r, ctx), overdue_invoices: can(ctx, 'invoices', 'view') ? r.overdue_invoices : undefined }));
    return res;
  });

  // ── Clients page KPIs + charts ──
  app.get('/api/v1/companies/client-stats', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'view');
    const months = Math.min(24, Math.max(3, Number((req.query as any).months) || 6));
    const r = await one<any>(`SELECT
      count(*) FILTER (WHERE c.stage='client')::int active_clients,
      count(*) FILTER (WHERE c.stage='client' AND COALESCE(c.converted_at, c.created_at) < date_trunc('month', now()))::int clients_at_month_start,
      count(*) FILTER (WHERE c.stage='client' AND COALESCE(c.converted_at, c.created_at) >= date_trunc('month', now()))::int new_this_month,
      count(*) FILTER (WHERE c.stage='client' AND COALESCE(c.converted_at, c.created_at) >= date_trunc('month', now()) - interval '1 month' AND COALESCE(c.converted_at, c.created_at) < date_trunc('month', now()))::int new_last_month,
      count(*) FILTER (WHERE c.stage='inactive')::int inactive,
      count(*) FILTER (WHERE c.stage='client' AND ${ATTN})::int needs_attention,
      COALESCE(sum(k.active_workers) FILTER (WHERE c.stage='client'),0)::int active_workers,
      COALESCE(sum(k.open_roles) FILTER (WHERE c.stage='client'),0)::int open_roles,
      COALESCE(sum(k.overdue_invoices) FILTER (WHERE c.stage='client'),0)::int overdue_invoices,
      COALESCE(sum(k.late_today) FILTER (WHERE c.stage='client'),0)::int late_today,
      COALESCE(sum(k.open_issues) FILTER (WHERE c.stage='client'),0)::int open_issues,
      count(*) FILTER (WHERE c.stage='client' AND k.active_workers > 0)::int clients_with_workers
      FROM companies c ${ATTENTION_LATERAL} WHERE c.organization_id=$1 AND c.archived_at IS NULL`, [ctx.orgId]);
    const byClient = await q<any>(`SELECT c.id, c.name label, count(p.id)::int value FROM companies c JOIN placements p ON p.company_id=c.id AND p.status IN ('active','on_leave','notice') WHERE c.organization_id=$1 GROUP BY c.id ORDER BY value DESC, c.name LIMIT 8`, [ctx.orgId]);
    const buckets = monthBuckets(months);
    const growth = await q<any>(`SELECT to_char(date_trunc('month', COALESCE(converted_at, created_at)), 'YYYY-MM') m, count(*)::int n FROM companies WHERE organization_id=$1 AND stage IN ('client','inactive') AND archived_at IS NULL GROUP BY 1`, [ctx.orgId]);
    let running = growth.filter(g => g.m < buckets[0].key).reduce((a, g) => a + g.n, 0);
    const trend = buckets.map(b => { running += growth.find(g => g.m === b.key)?.n ?? 0; return { label: b.label, value: running, month: b.key }; });
    return { ...r, active_delta: pctDelta(r.active_clients, r.clients_at_month_start), new_delta: pctDelta(r.new_this_month, r.new_last_month), overdue_invoices: can(ctx, 'invoices', 'view') ? r.overdue_invoices : null,
      workers_by_client: byClient, client_trend: trend, month_start: (await one<any>(`SELECT to_char(date_trunc('month', now()), 'YYYY-MM-DD') d`))!.d };
  });

  // ── Create a client directly (Quick Create → Client) ──
  app.post('/api/v1/companies', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'create');
    const b = z.object({ ...leadFields, stage: z.enum(['client']).default('client'), contact: z.object({ first_name: z.string().trim().min(1).max(100), last_name: optStr(100), title: optStr(120), email: z.preprocess(v => (v === '' ? null : v), z.string().email().nullable().optional()), phone: optStr(40) }).nullable().optional() }).parse(req.body);
    await assertMember(ctx, b.owner_id, 'owner_id'); await assertMember(ctx, b.account_manager_id, 'account_manager_id');
    const row = await tx(async db => {
      const c = (await db.query(`INSERT INTO companies (organization_id, name, website, domain, industry, size, country, phone, email, address, stage, lead_status, source, campaign, owner_id, account_manager_id, est_workers, est_monthly_value_cents, notes, converted_at, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'client',NULL,$11,$12,$13,$14,$15,$16,$17,now(),$18) RETURNING *`,
        [ctx.orgId, b.name, normalizeWebsite(b.website), domainOf(b.website), b.industry ?? null, b.size ?? null, b.country ?? null, b.phone ?? null, b.email ?? null, b.address ?? null, b.source ?? null, b.campaign ?? null, b.owner_id ?? ctx.userId, b.account_manager_id ?? null, b.est_workers ?? null, b.est_monthly_value_cents ?? null, b.notes ?? null, ctx.userId])).rows[0];
      if (b.contact?.first_name) await insertContact(ctx, { ...b.contact, company_id: c.id, is_primary: true }, db);
      await activity(ctx, 'company', c.id, 'system', 'Client created', null, {}, db);
      return c;
    });
    await audit(ctx, 'client.created', { type: 'company', id: row.id, label: row.name });
    if (row.account_manager_id && row.account_manager_id !== ctx.userId) await notify(ctx.orgId, [row.account_manager_id], { event: 'client.assigned', title: `You are account manager for ${row.name}`, link: `/crm/clients/${row.id}` });
    return row;
  });

  // ── Detail (header + overview) ──
  app.get('/api/v1/companies/:id', async (req) => {
    const ctx = staff(req);
    const c = await companyOr404(ctx, (req.params as any).id);
    need(ctx, companyResource(c), 'view');
    const k = await one<any>(`SELECT k.* FROM companies c ${ATTENTION_LATERAL} WHERE c.id=$1`, [c.id]);
    const [am, owner, primary, pipeline, hours, portalUsers, openTasks] = await Promise.all([
      one<any>(`SELECT id, name, email, avatar_color FROM users WHERE id=$1`, [c.account_manager_id]),
      one<any>(`SELECT id, name, email, avatar_color FROM users WHERE id=$1`, [c.owner_id]),
      one<any>(`SELECT id, first_name, last_name, title, email, phone FROM contacts WHERE company_id=$1 AND archived_at IS NULL ORDER BY is_primary DESC, created_at LIMIT 1`, [c.id]),
      one<any>(`SELECT count(*) FILTER (WHERE s.status NOT IN ('hired','rejected','withdrawn'))::int in_pipeline, count(*) FILTER (WHERE s.status='hired')::int hired FROM candidate_submissions s JOIN positions p ON p.id=s.position_id WHERE p.company_id=$1`, [c.id]),
      one<any>(`SELECT COALESCE(sum(d.minutes),0)::int minutes_30d FROM timesheet_days d JOIN placements p ON p.id=d.placement_id WHERE p.company_id=$1 AND d.work_date >= current_date - 30`, [c.id]),
      one<any>(`SELECT count(*)::int n FROM organization_memberships WHERE organization_id=$1 AND company_id=$2 AND status='active'`, [ctx.orgId, c.id]),
      one<any>(`SELECT count(*)::int n FROM tasks WHERE organization_id=$1 AND related_type='company' AND related_id=$2 AND status IN ('open','in_progress') AND archived_at IS NULL`, [ctx.orgId, c.id]),
    ]);
    return {
      ...c, account_manager_name: am?.name ?? null, account_manager_color: am?.avatar_color ?? null, owner_name: owner?.name ?? null, primary_contact: primary,
      counts: { ...k, overdue_invoices: can(ctx, 'invoices', 'view') ? k.overdue_invoices : null, in_pipeline: pipeline?.in_pipeline ?? 0, hired: pipeline?.hired ?? 0, minutes_30d: hours?.minutes_30d ?? 0, portal_users: portalUsers?.n ?? 0, open_tasks: openTasks?.n ?? 0 },
      attention_reasons: attentionReasons(k, ctx),
      can: { edit: can(ctx, companyResource(c), 'edit'), finance: can(ctx, 'invoices', 'view'), delete_permanent: isOwnerAdmin(ctx), create_position: can(ctx, 'positions', 'create'), create_invoice: can(ctx, 'invoices', 'create'), create_task: can(ctx, 'tasks', 'create'), documents: can(ctx, 'documents', 'view'), upload_documents: can(ctx, 'documents', 'create') },
    };
  });

  // ── Edit ──
  app.patch('/api/v1/companies/:id', async (req) => {
    const ctx = staff(req);
    const c = await companyOr404(ctx, (req.params as any).id);
    need(ctx, companyResource(c), 'edit');
    return updateCompany(ctx, c, req.body);
  });

  // ── Deactivate / reactivate (company state machine) ──
  app.post('/api/v1/companies/:id/deactivate', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'edit');
    const b = z.object({ reason: z.string({ required_error: 'A reason is required' }).trim().min(3, 'A reason is required').max(1000) }).parse(req.body ?? {});
    const c = await companyOr404(ctx, (req.params as any).id);
    assertTransition('company', c.stage, 'inactive');
    const active = await one<any>(`SELECT count(*)::int n FROM placements WHERE company_id=$1 AND status IN ('active','on_leave','notice','onboarding')`, [c.id]);
    if (active!.n > 0) throw conflict(`${c.name} still has ${active!.n} active or onboarding placement(s). End or transfer them before deactivating.`);
    const row = await one<any>(`UPDATE companies SET stage='inactive', updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [c.id, ctx.orgId]);
    await q(`UPDATE positions SET status='closed', updated_at=now() WHERE company_id=$1 AND status IN ('draft','open','on_hold')`, [c.id]);
    await activity(ctx, 'company', c.id, 'status_change', 'Client deactivated', b.reason, { from: c.stage, to: 'inactive', field: 'stage' });
    await audit(ctx, 'client.deactivated', { type: 'company', id: c.id, label: c.name }, { stage: c.stage }, { stage: 'inactive' }, b.reason);
    await emit(ctx.orgId, 'client.deactivated', { company_id: c.id, company_name: c.name, account_manager_id: c.account_manager_id, reason: b.reason });
    return row;
  });
  app.post('/api/v1/companies/:id/reactivate', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'edit');
    const c = await companyOr404(ctx, (req.params as any).id);
    assertTransition('company', c.stage, 'client');
    const row = await one<any>(`UPDATE companies SET stage='client', updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [c.id, ctx.orgId]);
    await activity(ctx, 'company', c.id, 'status_change', 'Client reactivated', null, { from: c.stage, to: 'client', field: 'stage' });
    await audit(ctx, 'client.reactivated', { type: 'company', id: c.id, label: c.name }, { stage: c.stage }, { stage: 'client' });
    return row;
  });

  // ── Hiring tab: positions ──
  app.get('/api/v1/companies/:id/positions', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'view');
    const c = await companyOr404(ctx, (req.params as any).id);
    if (!can(ctx, 'positions', 'view')) return { rows: [], restricted: true };
    const rows = await q<any>(`SELECT p.id, p.title, p.status, p.openings, p.filled, p.urgency, p.health, p.employment_type, p.created_at,
      (SELECT count(*) FROM candidate_submissions s WHERE s.position_id=p.id AND s.status NOT IN ('rejected','withdrawn'))::int submissions,
      (SELECT count(*) FROM applications a WHERE a.position_id=p.id)::int applications,
      (SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM position_recruiter_assignments ra JOIN users u ON u.id=ra.user_id WHERE ra.position_id=p.id AND ra.unassigned_at IS NULL) recruiters
      FROM positions p WHERE p.organization_id=$1 AND p.company_id=$2 AND p.archived_at IS NULL ORDER BY (p.status IN ('open','on_hold','draft')) DESC, p.created_at DESC`, [ctx.orgId, c.id]);
    return { rows };
  });

  // ── Workforce tab: placements with worker names ──
  app.get('/api/v1/companies/:id/placements', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'view');
    const c = await companyOr404(ctx, (req.params as any).id);
    if (!can(ctx, 'placements', 'view')) return { rows: [], restricted: true };
    const rows = await q<any>(`SELECT p.id, p.title, p.status, p.start_date, p.end_date, p.worker_id, w.status worker_status, concat_ws(' ', ca.first_name, ca.last_name) worker_name, ca.country worker_country,
      am.name account_manager_name, rc.name recruiter_name,
      r.pay_rate_cents, r.bill_rate_cents, r.currency, r.unit,
      (SELECT COALESCE(sum(d.minutes),0) FROM timesheet_days d WHERE d.placement_id=p.id AND d.work_date >= current_date - 30)::int minutes_30d,
      (SELECT wp.state FROM worker_presence wp WHERE wp.worker_id=p.worker_id LIMIT 1) presence
      FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates ca ON ca.id=w.candidate_id
      LEFT JOIN users am ON am.id=p.account_manager_id LEFT JOIN users rc ON rc.id=p.recruiter_id
      LEFT JOIN LATERAL (SELECT pay_rate_cents, bill_rate_cents, currency, unit FROM placement_rates pr WHERE pr.placement_id=p.id AND pr.effective_from <= current_date ORDER BY pr.effective_from DESC LIMIT 1) r ON true
      WHERE p.organization_id=$1 AND p.company_id=$2 ORDER BY (p.status='ended'), worker_name`, [ctx.orgId, c.id]);
    return { rows: rows.map(r => redact(ctx, r)), comp_visible: canViewComp(ctx) };
  });

  // ── Finance tab (permission-gated): invoices, AR, margin ──
  app.get('/api/v1/companies/:id/finance', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'view'); need(ctx, 'invoices', 'view');
    const c = await companyOr404(ctx, (req.params as any).id);
    const invoices = await q<any>(`SELECT id, number, issue_date, due_date, status, currency, total_cents, paid_cents, (total_cents - paid_cents) balance_cents, period_start, period_end FROM invoices WHERE organization_id=$1 AND company_id=$2 ORDER BY issue_date DESC, number DESC LIMIT 50`, [ctx.orgId, c.id]);
    const ar = await one<any>(`SELECT COALESCE(sum(total_cents - paid_cents) FILTER (WHERE status IN ('sent','viewed','partially_paid','overdue')),0)::bigint outstanding_cents,
      COALESCE(sum(total_cents - paid_cents) FILTER (WHERE status='overdue'),0)::bigint overdue_cents,
      count(*) FILTER (WHERE status IN ('sent','viewed','partially_paid','overdue'))::int open_count, count(*) FILTER (WHERE status='overdue')::int overdue_count,
      COALESCE(sum(total_cents) FILTER (WHERE status NOT IN ('draft','void','written_off') AND issue_date >= current_date - 365),0)::bigint billed_12m_cents,
      COALESCE(sum(paid_cents) FILTER (WHERE issue_date >= current_date - 365),0)::bigint collected_12m_cents
      FROM invoices WHERE organization_id=$1 AND company_id=$2`, [ctx.orgId, c.id]);
    const buckets = monthBuckets(6);
    const monthly = await q<any>(`SELECT to_char(issue_date, 'YYYY-MM') m, sum(total_cents)::bigint billed, sum(paid_cents)::bigint paid FROM invoices WHERE organization_id=$1 AND company_id=$2 AND status NOT IN ('draft','void') AND issue_date >= $3::date GROUP BY 1`, [ctx.orgId, c.id, buckets[0].key + '-01']);
    const trend = buckets.map(b => ({ label: b.label, value: Number(monthly.find(m => m.m === b.key)?.billed ?? 0) }));
    let margin: any = null;
    if (can(ctx, 'margin', 'view') || canViewComp(ctx)) {
      margin = await one<any>(`SELECT COALESCE(round(sum(d.minutes * r.bill_rate_cents) / 60.0),0)::bigint revenue_cents, COALESCE(round(sum(d.minutes * r.pay_rate_cents) / 60.0),0)::bigint cost_cents, COALESCE(sum(d.minutes),0)::int minutes
        FROM timesheet_days d JOIN timesheets t ON t.id=d.timesheet_id AND t.status IN ('approved','locked') JOIN placements p ON p.id=d.placement_id
        JOIN LATERAL (SELECT pay_rate_cents, bill_rate_cents FROM placement_rates pr WHERE pr.placement_id=d.placement_id AND pr.effective_from <= d.work_date ORDER BY pr.effective_from DESC LIMIT 1) r ON true
        WHERE p.organization_id=$1 AND p.company_id=$2 AND d.work_date >= current_date - 182`, [ctx.orgId, c.id]);
      const rev = Number(margin.revenue_cents), cost = Number(margin.cost_cents);
      margin = { ...margin, revenue_cents: rev, cost_cents: cost, margin_cents: rev - cost, margin_pct: rev ? Math.round(((rev - cost) / rev) * 1000) / 10 : null, period: 'Last 6 months (approved time)' };
    }
    return { invoices, ar: { ...ar, outstanding_cents: Number(ar.outstanding_cents), overdue_cents: Number(ar.overdue_cents), billed_12m_cents: Number(ar.billed_12m_cents), collected_12m_cents: Number(ar.collected_12m_cents) }, trend, margin, currency: c.currency, payment_terms_days: c.payment_terms_days };
  });

  // ── Documents tab ──
  app.get('/api/v1/companies/:id/documents', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'view');
    const c = await companyOr404(ctx, (req.params as any).id);
    if (!can(ctx, 'documents', 'view')) return { rows: [], restricted: true };
    const rows = await q<any>(`SELECT d.id, d.name, d.category, d.file, d.mime, d.size_bytes, d.visibility, d.expires_at, d.signature_status, d.verification, d.created_at, u.name created_by_name
      FROM documents d LEFT JOIN users u ON u.id=d.created_by WHERE d.organization_id=$1 AND d.entity_type='company' AND d.entity_id=$2 AND d.archived_at IS NULL ORDER BY d.created_at DESC`, [ctx.orgId, c.id]);
    return { rows: rows.map(r => ({ ...r, url: signedUrl(r.file), download_url: signedUrl(r.file, 900, { download: r.name }), file: undefined })) };
  });
  app.post('/api/v1/companies/:id/documents', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'view'); need(ctx, 'documents', 'create');
    const c = await companyOr404(ctx, (req.params as any).id);
    let buf: Buffer | null = null; let filename = 'document'; let mime = 'application/octet-stream';
    const fields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') { buf = await part.toBuffer(); filename = part.filename || filename; mime = part.mimetype || mime; }
      else fields[part.fieldname] = String((part as any).value ?? '');
    }
    if (!buf || !buf.length) fieldError('file', 'Choose a file to upload');
    const meta = z.object({ name: optStr(200), category: z.enum(['contract', 'nda', 'policy', 'compliance', 'invoice', 'general']).default('general'), visibility: z.enum(['internal', 'client']).default('internal'), expires_at: z.preprocess(v => (v === '' ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()) }).parse(fields);
    const rel = saveFile(`companies/${c.id}`, filename, buf!);
    const doc = await one<any>(`INSERT INTO documents (organization_id, entity_type, entity_id, name, category, file, mime, size_bytes, visibility, expires_at, created_by) VALUES ($1,'company',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, name, category`,
      [ctx.orgId, c.id, meta.name || filename, meta.category, rel, mime, buf!.length, meta.visibility, meta.expires_at ?? null, ctx.userId]);
    await activity(ctx, 'company', c.id, 'system', `Document uploaded: ${doc!.name}`, null, { document_id: doc!.id });
    return doc;
  });

  // ── Onboarding requirements (client-scope onboarding template + items) ──
  async function clientTemplate(ctx: Ctx, companyId: string, create = false) {
    let t = await one<any>(`SELECT * FROM onboarding_templates WHERE organization_id=$1 AND scope='client' AND company_id=$2 ORDER BY created_at LIMIT 1`, [ctx.orgId, companyId]);
    if (!t && create) {
      const c = await one<any>(`SELECT name FROM companies WHERE id=$1`, [companyId]);
      t = await one<any>(`INSERT INTO onboarding_templates (organization_id, name, scope, company_id) VALUES ($1,$2,'client',$3) RETURNING *`, [ctx.orgId, `${c!.name} requirements`, companyId]);
    }
    return t;
  }
  app.get('/api/v1/companies/:id/onboarding', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'view');
    const c = await companyOr404(ctx, (req.params as any).id);
    const t = await clientTemplate(ctx, c.id);
    const items = t ? await q<any>(`SELECT id, title, required, owner, sort FROM onboarding_template_items WHERE template_id=$1 ORDER BY sort, title`, [t.id]) : [];
    const agency = await q<any>(`SELECT i.id, i.title, i.required, i.owner FROM onboarding_template_items i JOIN onboarding_templates t ON t.id=i.template_id WHERE t.organization_id=$1 AND t.scope='agency' AND t.is_default ORDER BY i.sort, i.title`, [ctx.orgId]);
    const inFlight = await one<any>(`SELECT count(*)::int n FROM placements WHERE company_id=$1 AND status='onboarding'`, [c.id]);
    return { template: t ? { id: t.id, name: t.name } : null, items, agency_items: agency, onboarding_placements: inFlight?.n ?? 0, can_edit: can(ctx, 'clients', 'edit') };
  });
  const itemBody = z.object({ title: z.string().trim().min(2, 'Title is required').max(200), required: z.boolean().default(true), owner: z.enum(['agency', 'worker', 'client']).default('agency') });
  app.post('/api/v1/companies/:id/onboarding/items', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'edit');
    const c = await companyOr404(ctx, (req.params as any).id);
    const b = itemBody.parse(req.body);
    const t = await clientTemplate(ctx, c.id, true);
    const sort = (await one<any>(`SELECT COALESCE(max(sort),0)+1 n FROM onboarding_template_items WHERE template_id=$1`, [t.id]))!.n;
    const item = await one<any>(`INSERT INTO onboarding_template_items (organization_id, template_id, title, required, owner, sort) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ctx.orgId, t.id, b.title, b.required, b.owner, sort]);
    await activity(ctx, 'company', c.id, 'system', `Onboarding requirement added: ${b.title}`, b.required ? 'Required for activation' : 'Optional');
    return item;
  });
  app.patch('/api/v1/companies/:id/onboarding/items/:itemId', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'edit');
    const c = await companyOr404(ctx, (req.params as any).id);
    const t = await clientTemplate(ctx, c.id);
    const { itemId } = req.params as any;
    if (!t || !isUuid(itemId)) throw notFound();
    const b = itemBody.partial().extend({ sort: z.number().int().min(0).max(1000).optional() }).parse(req.body);
    const cur = await one<any>(`SELECT * FROM onboarding_template_items WHERE id=$1 AND template_id=$2`, [itemId, t.id]);
    if (!cur) throw notFound();
    const item = await one<any>(`UPDATE onboarding_template_items SET title=COALESCE($3,title), required=COALESCE($4,required), owner=COALESCE($5,owner), sort=COALESCE($6,sort) WHERE id=$1 AND template_id=$2 RETURNING *`, [itemId, t.id, b.title ?? null, b.required ?? null, b.owner ?? null, b.sort ?? null]);
    await activity(ctx, 'company', c.id, 'system', `Onboarding requirement updated: ${item!.title}`, b.required !== undefined && b.required !== cur.required ? (b.required ? 'Now required' : 'Now optional') : null);
    return item;
  });
  app.delete('/api/v1/companies/:id/onboarding/items/:itemId', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'edit');
    const c = await companyOr404(ctx, (req.params as any).id);
    const t = await clientTemplate(ctx, c.id);
    const { itemId } = req.params as any;
    if (!t || !isUuid(itemId)) throw notFound();
    const cur = await one<any>(`DELETE FROM onboarding_template_items WHERE id=$1 AND template_id=$2 RETURNING title`, [itemId, t.id]);
    if (!cur) throw notFound();
    await activity(ctx, 'company', c.id, 'system', `Onboarding requirement removed: ${cur.title}`);
    return { ok: true };
  });

  // ── Client portal invitations (explicit, expiring, revocable, audited) ──
  app.get('/api/v1/companies/:id/portal-invitations', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'view');
    const c = await companyOr404(ctx, (req.params as any).id);
    const invites = await q<any>(`SELECT i.id, i.email, i.name, i.status, i.expires_at, i.accepted_at, i.created_at, r.key role_key, r.name role_name, u.name invited_by_name
      FROM invitations i JOIN roles r ON r.id=i.role_id LEFT JOIN users u ON u.id=i.invited_by WHERE i.organization_id=$1 AND i.company_id=$2 ORDER BY i.created_at DESC`, [ctx.orgId, c.id]);
    const users = await q<any>(`SELECT m.id membership_id, u.id user_id, u.name, u.email, u.last_login_at, r.name role_name, m.status FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.company_id=$2 AND r.kind='client' ORDER BY u.name`, [ctx.orgId, c.id]);
    return { invitations: invites.map(i => ({ ...i, status: i.status === 'pending' && new Date(i.expires_at) < new Date() ? 'expired' : i.status })), users, roles: (await q<any>(`SELECT key, name FROM roles WHERE organization_id=$1 AND kind='client' ORDER BY name`, [ctx.orgId])) };
  });
  app.post('/api/v1/companies/:id/portal-invitations', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'edit');
    const b = z.object({ contact_id: z.string({ required_error: 'Pick a contact' }).uuid('Pick a contact'), role_key: z.enum(CLIENT_ROLE_KEYS).default('client_owner'), expires_days: z.number().int().min(1).max(30).default(7) }).parse(req.body);
    const c = await companyOr404(ctx, (req.params as any).id);
    if (c.stage !== 'client') throw conflict('Only active clients can be invited to the client portal');
    const contact = await one<any>(`SELECT * FROM contacts WHERE id=$1 AND organization_id=$2 AND company_id=$3 AND archived_at IS NULL`, [b.contact_id, ctx.orgId, c.id]);
    if (!contact) fieldError('contact_id', 'Contact not found on this client');
    if (!contact.email) fieldError('contact_id', 'This contact has no email address');
    const role = await one<any>(`SELECT id, name FROM roles WHERE organization_id=$1 AND key=$2 AND kind='client'`, [ctx.orgId, b.role_key]);
    if (!role) throw badRequest('Client role not configured');
    const already = await one<any>(`SELECT 1 FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND lower(u.email)=lower($2) AND m.status='active'`, [ctx.orgId, contact.email]);
    if (already) throw conflict(`${contact.email} already has access to this workspace`);
    const token = crypto.randomBytes(24).toString('base64url');
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
    const inv = await tx(async db => {
      await db.query(`UPDATE invitations SET status='revoked' WHERE organization_id=$1 AND company_id=$2 AND lower(email)=lower($3) AND status='pending'`, [ctx.orgId, c.id, contact.email]);
      return (await db.query(`INSERT INTO invitations (organization_id, email, name, role_id, token, status, company_id, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7, now() + make_interval(days => $8)) RETURNING id, email, name, status, expires_at`,
        [ctx.orgId, contact.email.toLowerCase(), name, role.id, token, c.id, ctx.userId, b.expires_days])).rows[0];
    });
    await sendTemplate(ctx.orgId, 'invite_client_portal', contact.email, { invitee: { name: contact.first_name }, org: { name: ctx.org.name }, company: { name: c.name }, inviter: { name: ctx.user.name }, role: { name: role.name }, link: `${WEB_URL}/invite/${token}` }, { related: { type: 'company', id: c.id } });
    await activity(ctx, 'contact', contact.id, 'system', `Invited to the client portal as ${role.name}`);
    await audit(ctx, 'portal.invitation_sent', { type: 'company', id: c.id, label: c.name }, null, { email: contact.email, role: b.role_key, invitation_id: inv.id, expires_at: inv.expires_at });
    return { ...inv, role_name: role.name };
  });
  app.post('/api/v1/companies/:id/portal-invitations/:invId/revoke', async (req) => {
    const ctx = staff(req); need(ctx, 'clients', 'edit');
    const c = await companyOr404(ctx, (req.params as any).id);
    const { invId } = req.params as any;
    if (!isUuid(invId)) throw notFound();
    const inv = await one<any>(`SELECT * FROM invitations WHERE id=$1 AND organization_id=$2 AND company_id=$3`, [invId, ctx.orgId, c.id]);
    if (!inv) throw notFound();
    if (inv.status !== 'pending') throw conflict(`This invitation is already ${inv.status}`);
    await q(`UPDATE invitations SET status='revoked' WHERE id=$1`, [inv.id]);
    await activity(ctx, 'company', c.id, 'system', `Portal invitation for ${inv.email} revoked`);
    await audit(ctx, 'portal.invitation_revoked', { type: 'company', id: c.id, label: c.name }, { status: 'pending' }, { status: 'revoked', email: inv.email });
    return { ok: true };
  });

  // ── Permanent delete: dependency analysis + two-step confirm (owner/admin only, audited) ──
  async function dependencies(ctx: Ctx, id: string) {
    const r = await one<any>(`SELECT
      (SELECT count(*) FROM contacts WHERE company_id=$1)::int contacts,
      (SELECT count(*) FROM opportunities WHERE company_id=$1)::int opportunities,
      (SELECT count(*) FROM positions WHERE company_id=$1)::int positions,
      (SELECT count(*) FROM applications a JOIN positions p ON p.id=a.position_id WHERE p.company_id=$1)::int applications,
      (SELECT count(*) FROM candidate_submissions s JOIN positions p ON p.id=s.position_id WHERE p.company_id=$1)::int submissions,
      (SELECT count(*) FROM offers o JOIN positions p ON p.id=o.position_id WHERE p.company_id=$1)::int offers,
      (SELECT count(*) FROM interviews i JOIN positions p ON p.id=i.position_id WHERE p.company_id=$1)::int interviews,
      (SELECT count(*) FROM assessments a JOIN positions p ON p.id=a.position_id WHERE p.company_id=$1)::int assessments,
      (SELECT count(*) FROM placements WHERE company_id=$1)::int placements,
      (SELECT count(*) FROM timesheets WHERE company_id=$1)::int timesheets,
      (SELECT count(*) FROM invoices WHERE company_id=$1)::int invoices,
      (SELECT count(*) FROM payments WHERE company_id=$1)::int payments,
      (SELECT count(*) FROM credit_notes WHERE company_id=$1)::int credit_notes,
      (SELECT count(*) FROM payroll_items WHERE company_id=$1)::int payroll_items,
      (SELECT count(*) FROM documents WHERE organization_id=$2 AND entity_type='company' AND entity_id=$1)::int documents,
      (SELECT count(*) FROM tasks WHERE organization_id=$2 AND related_type='company' AND related_id=$1)::int tasks,
      (SELECT count(*) FROM activities WHERE organization_id=$2 AND entity_type='company' AND entity_id=$1)::int activities,
      (SELECT count(*) FROM invitations WHERE organization_id=$2 AND company_id=$1)::int invitations,
      (SELECT count(*) FROM organization_memberships WHERE organization_id=$2 AND company_id=$1 AND status='active')::int portal_users,
      (SELECT count(*) FROM onboarding_templates WHERE company_id=$1)::int onboarding_templates`, [id, ctx.orgId]);
    const LABELS: Record<string, [string, 'delete' | 'block' | 'revoke']> = {
      invoices: ['Invoices', 'block'], payments: ['Payments', 'block'], credit_notes: ['Credit notes', 'block'], payroll_items: ['Payroll items', 'block'], placements: ['Placements', 'block'], timesheets: ['Timesheets', 'block'],
      applications: ['Applications on its positions', 'block'], submissions: ['Submissions on its positions', 'block'], offers: ['Offers', 'block'], interviews: ['Interviews', 'block'], assessments: ['Assessments', 'block'],
      contacts: ['Contacts', 'delete'], opportunities: ['Opportunities', 'delete'], positions: ['Positions (no candidates)', 'delete'], documents: ['Documents', 'delete'], tasks: ['Tasks', 'delete'], activities: ['Timeline entries', 'delete'],
      onboarding_templates: ['Onboarding requirement sets', 'delete'], invitations: ['Portal invitations', 'delete'], portal_users: ['Portal users (access removed)', 'revoke'],
    };
    const items = Object.entries(LABELS).map(([key, [label, effect]]) => ({ key, label, count: Number(r[key]), effect })).filter(i => i.count > 0);
    const blockers = items.filter(i => i.effect === 'block');
    return { items, blockers, blocked: blockers.length > 0, financial: ['invoices', 'payments', 'credit_notes', 'payroll_items', 'timesheets', 'placements'].some(k => Number(r[k]) > 0) };
  }
  app.get('/api/v1/companies/:id/dependencies', async (req) => {
    const ctx = staff(req);
    const c = await companyOr404(ctx, (req.params as any).id);
    need(ctx, companyResource(c), 'view');
    if (!isOwnerAdmin(ctx)) throw forbidden('Only Owners and Admins can permanently delete records');
    return { company: { id: c.id, name: c.name, stage: c.stage }, ...(await dependencies(ctx, c.id)) };
  });
  app.delete('/api/v1/companies/:id', async (req) => {
    const ctx = staff(req);
    const c = await companyOr404(ctx, (req.params as any).id);
    if (!isOwnerAdmin(ctx)) throw forbidden('Only Owners and Admins can permanently delete records');
    const b = z.object({ confirm: z.string({ required_error: 'Type the company name to confirm' }), reason: z.string({ required_error: 'A reason is required' }).trim().min(3, 'A reason is required').max(1000) }).parse(req.body ?? {});
    if (b.confirm.trim() !== c.name.trim()) fieldError('confirm', 'The name does not match');
    const dep = await dependencies(ctx, c.id);
    if (dep.blocked) throw conflict(`${c.name} cannot be deleted: it has ${dep.blockers.map(x => `${x.count} ${x.label.toLowerCase()}`).join(', ')}. ${dep.financial ? 'Financial history must be kept — deactivate the client instead.' : 'Remove those first or deactivate instead.'}`, { blockers: dep.blockers });
    await tx(async db => {
      const o = ctx.orgId;
      const contacts = (await db.query(`SELECT id FROM contacts WHERE company_id=$1 AND organization_id=$2`, [c.id, o])).rows.map(r => r.id);
      const opps = (await db.query(`SELECT id FROM opportunities WHERE company_id=$1 AND organization_id=$2`, [c.id, o])).rows.map(r => r.id);
      const positions = (await db.query(`SELECT id FROM positions WHERE company_id=$1 AND organization_id=$2`, [c.id, o])).rows.map(r => r.id);
      await db.query(`DELETE FROM sourcing_links WHERE position_id = ANY($1)`, [positions]);
      await db.query(`DELETE FROM positions WHERE id = ANY($1)`, [positions]);
      await db.query(`UPDATE opportunities SET contact_id=NULL WHERE contact_id = ANY($1) AND organization_id=$2`, [contacts, o]);
      await db.query(`DELETE FROM opportunities WHERE id = ANY($1)`, [opps]);
      await db.query(`DELETE FROM contacts WHERE id = ANY($1)`, [contacts]);
      const ents: [string, string[]][] = [['company', [c.id]], ['contact', contacts], ['opportunity', opps], ['position', positions]];
      for (const [t, ids] of ents) {
        if (!ids.length) continue;
        await db.query(`DELETE FROM tasks WHERE organization_id=$1 AND related_type=$2 AND related_id = ANY($3)`, [o, t, ids]);
        await db.query(`DELETE FROM activities WHERE organization_id=$1 AND entity_type=$2 AND entity_id = ANY($3)`, [o, t, ids]);
        await db.query(`DELETE FROM reminders WHERE organization_id=$1 AND related_type=$2 AND related_id = ANY($3)`, [o, t, ids]);
      }
      await db.query(`UPDATE documents SET archived_at=now() WHERE organization_id=$1 AND entity_type='company' AND entity_id=$2`, [o, c.id]);
      await db.query(`DELETE FROM documents WHERE organization_id=$1 AND entity_type='company' AND entity_id=$2`, [o, c.id]);
      await db.query(`DELETE FROM onboarding_templates WHERE company_id=$1 AND organization_id=$2`, [c.id, o]);
      await db.query(`DELETE FROM invitations WHERE company_id=$1 AND organization_id=$2`, [c.id, o]);
      await db.query(`UPDATE organization_memberships SET status='removed', company_id=NULL, updated_at=now() WHERE organization_id=$1 AND company_id=$2`, [o, c.id]);
      await db.query(`DELETE FROM companies WHERE id=$1 AND organization_id=$2`, [c.id, o]);
      await audit(ctx, 'company.deleted_permanently', { type: 'company', id: c.id, label: c.name }, { company: c, dependencies: dep.items }, null, b.reason, db);
    });
    await notify(ctx.orgId, (await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.key IN ('owner','admin')`, [ctx.orgId])).map(r => r.user_id).filter((u: string) => u !== ctx.userId),
      { event: 'record.deleted', title: `${ctx.user.name} permanently deleted ${c.name}`, body: b.reason, link: '/settings/audit' });
    return { ok: true };
  });
}
