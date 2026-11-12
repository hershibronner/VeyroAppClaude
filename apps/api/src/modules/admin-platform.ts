// Platform Control Center (VeyroApp staff only): agencies, subscriptions & SaaS invoices, seats, feature flags,
// provider health, support tickets, impersonation, system health, audit & security, platform admins, plans, settings.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { q, one, tx } from '../core/db';
import { SESSION_COOKIE } from '../core/context';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { createSession } from '../core/routes-auth';
import { sendMessage } from '../adapters/messaging';
import { WEB_URL } from '../core/settings';
import { platform, auditAs, isUuid, randomToken, monthBounds, pad } from './_admin/common';
import { fieldError } from './_admin/common';
import { activeSeats, generateInvoice, mrrFor, quoteMonth, seatHistory } from './_admin/saas';
import { chargeInvoice, enterGrace, reactivateIfSettled, suspend } from './_admin/billingflow';
import { clearSuspendedCache } from './admin-00-core';

const FLAG_KEYS = ['ai_matching', 'screenshots', 'client_portal', 'worker_portal', 'automation', 'report_builder', 'public_api', 'white_label'];
const PLATFORM_DEFAULTS: Record<string, unknown> = { platform_name: 'VeyroApp', support_email: 'support@veyro.local', default_trial_days: 14, default_tax_bp: 0, seat_price_cents: 2900, maintenance_banner: '', impersonation_max_minutes: 60, require_impersonation_reason: true };
const START_OF_TIME = '1970-01-01';
void START_OF_TIME;

async function orgOr404(id: string) {
  if (!isUuid(id)) throw notFound();
  const o = await one<any>(`SELECT * FROM organizations WHERE id=$1`, [id]);
  if (!o) throw notFound();
  return o;
}
const ymOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}`;
const lastMonth = () => { const n = new Date(); return ymOf(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1))); };

export default async function (app: FastifyInstance) {
  // ── Overview ──
  app.get('/api/v1/platform/overview', async (req) => {
    platform(req);
    const orgs = await q<any>(`SELECT o.id, o.name, s.status, s.plan_key, s.comped FROM organizations o LEFT JOIN subscriptions s ON s.organization_id=o.id WHERE o.status <> 'deleted'`);
    let mrrNet = 0; let mrrGross = 0; let seats = 0;
    for (const o of orgs) { const m = await mrrFor(o.id); mrrNet += m.net; mrrGross += m.gross; seats += m.seats ?? 0; }
    const tickets = await one<any>(`SELECT count(*) FILTER (WHERE status='open')::int open, count(*) FILTER (WHERE status='pending')::int pending, count(*) FILTER (WHERE priority IN ('high','urgent') AND status <> 'resolved')::int urgent FROM support_tickets`);
    const jobs = await one<any>(`SELECT count(*) FILTER (WHERE status='queued')::int queued, count(*) FILTER (WHERE status='running')::int running, count(*) FILTER (WHERE status='failed' AND created_at > now() - interval '7 days')::int failed_7d FROM jobs`);
    const inv = await one<any>(`SELECT COALESCE(sum(total_cents) FILTER (WHERE status='paid' AND paid_at > date_trunc('month', now()) - interval '1 month'),0)::bigint collected, COALESCE(sum(total_cents) FILTER (WHERE status IN ('open','failed')),0)::bigint outstanding, count(*) FILTER (WHERE status='failed')::int failed FROM saas_invoices`);
    const users = await one<any>(`SELECT count(DISTINCT m.user_id)::int n FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.status='active' AND r.kind='agency'`);
    const impersonating = await one<any>(`SELECT count(*)::int n FROM impersonation_sessions WHERE ended_at IS NULL`);
    const history = await seatHistory(null, 6);
    const mrrTrend = await q<any>(`SELECT to_char(period_start,'Mon') label, period_start, sum(total_cents)::bigint billed, sum(subtotal_cents)::bigint gross FROM saas_invoices WHERE period_start > now() - interval '7 months' AND status <> 'void' GROUP BY period_start ORDER BY period_start`);
    const statuses = orgs.reduce((a: Record<string, number>, o) => { a[o.status ?? 'none'] = (a[o.status ?? 'none'] ?? 0) + 1; return a; }, {});
    const recent = await q<any>(`SELECT a.id::text id, a.created_at, a.action, a.actor_label, a.entity_label, o.name org_name FROM audit_events a LEFT JOIN organizations o ON o.id=a.organization_id WHERE a.action LIKE 'impersonation.%' OR a.action LIKE 'subscription.%' OR a.action LIKE 'platform.%' OR a.action LIKE 'organization.%' ORDER BY a.created_at DESC LIMIT 8`);
    // "Needs attention" queue: the things a platform admin should act on today.
    const attention = {
      tickets: await q<any>(`SELECT t.id, t.number, t.subject, t.priority, t.status, o.name org_name, t.last_activity_at,
          (t.first_response_at IS NULL AND now() > COALESCE(t.sla_due_at, t.created_at + interval '8 hours')) overdue
        FROM support_tickets t LEFT JOIN organizations o ON o.id=t.organization_id
        WHERE t.status='open' AND (t.priority IN ('urgent','high') OR (t.first_response_at IS NULL AND now() > COALESCE(t.sla_due_at, t.created_at + interval '8 hours')))
        ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, t.created_at LIMIT 5`),
      billing: await q<any>(`SELECT o.id, o.name, s.status, s.trial_ends_at, s.grace_ends_at, s.suspended_at,
          (SELECT count(*)::int FROM saas_invoices i WHERE i.organization_id=o.id AND i.status='failed') failed_invoices
        FROM organizations o JOIN subscriptions s ON s.organization_id=o.id
        WHERE o.status <> 'deleted' AND (s.status IN ('grace','suspended') OR (s.status='trialing' AND s.trial_ends_at < now() + interval '7 days')
          OR EXISTS (SELECT 1 FROM saas_invoices i WHERE i.organization_id=o.id AND i.status='failed'))
        ORDER BY CASE s.status WHEN 'suspended' THEN 0 WHEN 'grace' THEN 1 ELSE 2 END, s.trial_ends_at NULLS LAST LIMIT 6`),
      sessions: await q<any>(`SELECT i.id, i.started_at, pu.name agent, tu.name target, o.name org_name FROM impersonation_sessions i JOIN users pu ON pu.id=i.platform_user_id JOIN users tu ON tu.id=i.target_user_id JOIN organizations o ON o.id=i.organization_id WHERE i.ended_at IS NULL ORDER BY i.started_at DESC LIMIT 5`),
    };
    return { agencies: orgs.length, statuses, seats, mrr_net_cents: mrrNet, mrr_gross_cents: mrrGross, tickets, jobs, invoices: inv, staff_users: users.n, active_impersonations: impersonating.n, seat_history: history, billed_trend: mrrTrend, recent, attention };
  });
  // Sidebar badges for the Platform Control Center.
  app.get('/api/v1/platform/nav-counts', async (req) => {
    const ctx = platform(req);
    return one(`SELECT
        (SELECT count(*)::int FROM support_tickets WHERE status='open') tickets,
        (SELECT count(*)::int FROM support_tickets WHERE status='open' AND assigned_to=$1) my_tickets,
        (SELECT count(*)::int FROM saas_invoices WHERE status='failed') failed_invoices,
        (SELECT count(*)::int FROM impersonation_sessions WHERE ended_at IS NULL) sessions,
        (SELECT count(*)::int FROM jobs WHERE status='failed' AND created_at > now() - interval '24 hours') failed_jobs`, [ctx.userId]);
  });
  app.get('/api/v1/platform/notifications', async (req) => {
    const ctx = platform(req);
    const rows = await q<any>(`SELECT * FROM notifications WHERE user_id=$1 AND organization_id IS NULL ORDER BY created_at DESC LIMIT 50`, [ctx.userId]);
    return { rows, unread: rows.filter(r => !r.read_at).length };
  });
  app.post('/api/v1/platform/notifications/read-all', async (req) => {
    const ctx = platform(req);
    await q(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND organization_id IS NULL AND read_at IS NULL`, [ctx.userId]);
    return { ok: true };
  });

  // ── Agencies ──
  app.get('/api/v1/platform/agencies', async (req) => {
    platform(req);
    const lp = listParams(req);
    const where = ["o.status <> 'deleted'"]; const params: unknown[] = [];
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`s.status=$${params.length}`); }
    if (lp.filters.plan) { params.push(lp.filters.plan); where.push(`s.plan_key=$${params.length}`); }
    if (lp.filters.comped) { params.push(lp.filters.comped === 'true'); where.push(`s.comped=$${params.length}`); }
    const res = await paged<any>({ select: `o.id, o.name, o.slug, o.status org_status, o.created_at, s.plan_key, p.name plan_name, s.status, s.comped, s.discount_pct, s.trial_ends_at, s.grace_ends_at, b.primary_color, b.logo_text,
        (SELECT count(*)::int FROM seat_usage su WHERE su.organization_id=o.id AND su.ended_at IS NULL) seats,
        (SELECT count(*)::int FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=o.id AND m.status='active' AND r.kind='agency') staff,
        (SELECT count(*)::int FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=o.id AND m.status='active' AND r.kind='client') client_users,
        (SELECT max(u.last_login_at) FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=o.id) last_active_at,
        (SELECT count(*)::int FROM support_tickets t WHERE t.organization_id=o.id AND t.status <> 'resolved') open_tickets`,
      from: 'organizations o LEFT JOIN subscriptions s ON s.organization_id=o.id LEFT JOIN plans p ON p.key=s.plan_key LEFT JOIN organization_branding b ON b.organization_id=o.id', where, params, lp,
      searchCols: ['o.name', 'o.slug'], sortMap: { name: 'o.name', created_at: 'o.created_at', seats: 'seats', staff: 'staff', status: 's.status' }, defaultSort: 'o.name ASC' });
    for (const r of res.rows) { const m = await mrrFor(r.id); r.mrr_cents = m.net; r.mrr_gross_cents = m.gross; }
    return res;
  });
  app.get('/api/v1/platform/agencies/:id', async (req) => {
    platform(req);
    const o = await orgOr404((req.params as any).id);
    const sub = await one<any>(`SELECT s.*, p.name plan_name, p.price_per_seat_cents, p.features FROM subscriptions s JOIN plans p ON p.key=s.plan_key WHERE s.organization_id=$1`, [o.id]);
    const branding = await one<any>(`SELECT logo_text, primary_color, accent_color, custom_domain, domain_verified, hide_powered_by, support_email FROM organization_branding WHERE organization_id=$1`, [o.id]);
    const usage = await one<any>(`SELECT
      (SELECT count(*)::int FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.kind='agency') staff,
      (SELECT count(*)::int FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.kind='client') client_users,
      (SELECT count(*)::int FROM workers WHERE organization_id=$1) workers, (SELECT count(*)::int FROM placements WHERE organization_id=$1 AND status='active') active_placements,
      (SELECT count(*)::int FROM companies WHERE organization_id=$1 AND stage='client') clients, (SELECT count(*)::int FROM candidates WHERE organization_id=$1) candidates,
      (SELECT COALESCE(sum(minutes),0)::bigint FROM timesheet_days WHERE organization_id=$1 AND work_date > current_date - 30) approved_minutes_30d,
      (SELECT count(*)::int FROM invoices WHERE organization_id=$1 AND created_at > now() - interval '30 days') invoices_30d`, [o.id]).catch(async () => one<any>(`SELECT 0 staff`));
    const members = await q<any>(`SELECT u.id, u.name, u.email, r.name role_name, r.kind role_kind, m.status, u.last_login_at FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' ORDER BY (r.kind='agency') DESC, (r.key='owner') DESC, u.name LIMIT 200`, [o.id]);
    const invoices = await q<any>(`SELECT * FROM saas_invoices WHERE organization_id=$1 ORDER BY period_start DESC LIMIT 24`, [o.id]);
    const flags = await q<any>(`SELECT key, enabled, updated_at FROM feature_flags WHERE organization_id=$1 ORDER BY key`, [o.id]);
    const integrations = await q<any>(`SELECT key, category, provider, status, last_sync_at, last_error FROM integrations WHERE organization_id=$1 ORDER BY category`, [o.id]);
    const tickets = await q<any>(`SELECT id, subject, status, priority, created_at FROM support_tickets WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 10`, [o.id]);
    const activity = await q<any>(`SELECT id::text id, created_at, action, actor_label, entity_label, impersonator_id IS NOT NULL impersonated FROM audit_events WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 15`, [o.id]);
    const now = new Date();
    return { org: o, subscription: sub, branding, usage, members, invoices, flags, integrations, tickets, activity, seats_now: await activeSeats(o.id), mrr: await mrrFor(o.id), seat_history: await seatHistory(o.id, 6), estimate: await quoteMonth(o.id, ymOf(now)), last_month: lastMonth() };
  });
  app.patch('/api/v1/platform/agencies/:id/subscription', async (req) => {
    const ctx = platform(req);
    const o = await orgOr404((req.params as any).id);
    const b = z.object({ plan_key: z.string().optional(), comped: z.boolean().optional(), discount_pct: z.number().int().min(0).max(100).optional(), tax_bp: z.number().int().min(0).max(5000).optional(), trial_ends_at: z.string().nullable().optional(), notes: z.string().max(1000).nullable().optional(), reason: z.string().min(3, 'Add a short reason').max(300) }).parse(req.body);
    const before = await one<any>(`SELECT plan_key, comped, discount_pct, tax_bp, trial_ends_at, status, notes FROM subscriptions WHERE organization_id=$1`, [o.id]);
    if (!before) throw notFound();
    if (b.plan_key && !(await one(`SELECT 1 FROM plans WHERE key=$1`, [b.plan_key]))) throw badRequest('Unknown plan');
    await tx(async (c) => {
      await c.query(`UPDATE subscriptions SET plan_key=COALESCE($2,plan_key), comped=COALESCE($3,comped), discount_pct=COALESCE($4,discount_pct), tax_bp=COALESCE($5,tax_bp),
        trial_ends_at=CASE WHEN $6::boolean THEN $7::timestamptz ELSE trial_ends_at END, notes=CASE WHEN $8::boolean THEN $9 ELSE notes END,
        status=CASE WHEN $2 IS NOT NULL AND $2 <> 'trial' AND status='trialing' THEN 'active' WHEN $2='trial' THEN 'trialing' ELSE status END, updated_at=now() WHERE organization_id=$1`,
        [o.id, b.plan_key ?? null, b.comped ?? null, b.discount_pct ?? null, b.tax_bp ?? null, b.trial_ends_at !== undefined, b.trial_ends_at ?? null, b.notes !== undefined, b.notes ?? null]);
      if (b.plan_key) await c.query(`INSERT INTO feature_flags (organization_id, key, enabled) VALUES ($1,'white_label',$2) ON CONFLICT (organization_id, key) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()`, [o.id, b.plan_key === 'white_label']);
      const { reason, ...rest } = b;
      await audit(auditAs(ctx, o.id), 'platform.subscription_updated', { type: 'subscription', id: o.id, label: o.name }, before, rest, reason, c);
    });
    clearSuspendedCache(o.id);
    return { ok: true };
  });
  app.post('/api/v1/platform/agencies/:id/status', async (req) => {
    const ctx = platform(req);
    const o = await orgOr404((req.params as any).id);
    const b = z.object({ action: z.enum(['suspend', 'reactivate', 'start_grace', 'end_grace_now']), reason: z.string().min(3, 'Add a short reason').max(300) }).parse(req.body);
    const actor = auditAs(ctx, o.id) as any;
    if (b.action === 'suspend') await suspend(o.id, actor, b.reason);
    else if (b.action === 'reactivate') await reactivateIfSettled(o.id, actor, true);
    else if (b.action === 'start_grace') await enterGrace(o.id, actor, b.reason);
    else {
      const s = await one<any>(`SELECT status FROM subscriptions WHERE organization_id=$1`, [o.id]);
      if (s?.status !== 'grace') throw conflict('This agency is not in a grace period');
      await q(`UPDATE subscriptions SET grace_ends_at=now() WHERE organization_id=$1`, [o.id]);
      await audit(actor, 'platform.grace_fast_forwarded', { type: 'subscription', id: o.id, label: o.name }, null, null, b.reason);
      await suspend(o.id, actor, `Grace period ended (simulated): ${b.reason}`);
    }
    return one(`SELECT status, grace_ends_at, suspended_at FROM subscriptions WHERE organization_id=$1`, [o.id]);
  });
  app.post('/api/v1/platform/agencies/:id/invoices', async (req) => {
    const ctx = platform(req);
    const o = await orgOr404((req.params as any).id);
    const b = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body);
    const { end } = monthBounds(b.month);
    if (end >= new Date().toISOString().slice(0, 10)) throw conflict('Invoices are generated after the month ends — the current month is shown as an estimate');
    const r = await generateInvoice(o.id, b.month);
    if (!r.existing) await audit(auditAs(ctx, o.id), 'saas_invoice.generated', { type: 'saas_invoice', id: r.invoice.id, label: r.invoice.number }, null, { total_cents: r.invoice.total_cents, seat_days: r.invoice.seat_days, status: r.invoice.status });
    return r;
  });
  app.post('/api/v1/platform/invoices/generate-all', async (req) => {
    const ctx = platform(req);
    const b = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(lastMonth()) }).parse(req.body ?? {});
    const { end } = monthBounds(b.month);
    if (end >= new Date().toISOString().slice(0, 10)) throw conflict('Choose a month that has ended');
    const orgs = await q<any>(`SELECT o.id FROM organizations o JOIN subscriptions s ON s.organization_id=o.id WHERE o.status <> 'deleted'`);
    let created = 0;
    for (const o of orgs) { const r = await generateInvoice(o.id, b.month); if (!r.existing) { created++; await audit(auditAs(ctx, o.id), 'saas_invoice.generated', { type: 'saas_invoice', id: r.invoice.id, label: r.invoice.number }, null, { total_cents: r.invoice.total_cents }); } }
    return { created, agencies: orgs.length, month: b.month };
  });
  app.get('/api/v1/platform/invoices', async (req) => {
    platform(req);
    const lp = listParams(req);
    const where: string[] = []; const params: unknown[] = [];
    if (lp.filters.status) { params.push(lp.filters.status); where.push(`i.status=$${params.length}`); }
    if (lp.filters.organization_id && isUuid(lp.filters.organization_id)) { params.push(lp.filters.organization_id); where.push(`i.organization_id=$${params.length}`); }
    return paged({ select: 'i.id, i.number, i.organization_id, o.name org_name, i.period_start, i.period_end, i.seat_days, i.avg_seats, i.subtotal_cents, i.discount_cents, i.tax_cents, i.total_cents, i.status, i.created_at, i.paid_at, i.attempts, i.failure_reason', from: 'saas_invoices i JOIN organizations o ON o.id=i.organization_id', where, params, lp,
      searchCols: ['i.number', 'o.name'], sortMap: { period_start: 'i.period_start', total_cents: 'i.total_cents', org_name: 'o.name', status: 'i.status' }, defaultSort: 'i.period_start DESC, o.name' });
  });
  app.get('/api/v1/platform/invoices/:id', async (req) => {
    platform(req);
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const inv = await one<any>(`SELECT i.*, o.name org_name FROM saas_invoices i JOIN organizations o ON o.id=i.organization_id WHERE i.id=$1`, [id]);
    if (!inv) throw notFound();
    return inv;
  });
  app.post('/api/v1/platform/invoices/:id/:action', async (req) => {
    const ctx = platform(req);
    const { id, action } = req.params as any; if (!isUuid(id)) throw notFound();
    const inv = await one<any>(`SELECT i.*, o.name org_name FROM saas_invoices i JOIN organizations o ON o.id=i.organization_id WHERE i.id=$1`, [id]);
    if (!inv) throw notFound();
    const actor = auditAs(ctx, inv.organization_id) as any;
    if (action === 'charge') return chargeInvoice(inv.id, actor);
    if (action === 'simulate-failure') { if (!['open', 'failed'].includes(inv.status)) throw conflict(`Invoice is ${inv.status}`); return chargeInvoice(inv.id, actor, { forceFail: true }); }
    if (action === 'mark-paid' || action === 'void') {
      const { reason } = z.object({ reason: z.string().min(3, 'Add a short reason').max(300) }).parse(req.body);
      if (!['open', 'failed'].includes(inv.status)) throw conflict(`Invoice is ${inv.status}`);
      const status = action === 'mark-paid' ? 'paid' : 'void';
      await q(`UPDATE saas_invoices SET status=$2, paid_at=CASE WHEN $2='paid' THEN now() ELSE paid_at END WHERE id=$1`, [inv.id, status]);
      await audit(actor, `saas_invoice.${action === 'mark-paid' ? 'marked_paid' : 'voided'}`, { type: 'saas_invoice', id: inv.id, label: inv.number }, { status: inv.status }, { status }, reason);
      await reactivateIfSettled(inv.organization_id, actor);
      return { ok: true, status };
    }
    throw notFound();
  });

  // ── Seats ──
  app.get('/api/v1/platform/seats', async (req) => {
    platform(req);
    const lp = listParams(req);
    const where: string[] = []; const params: unknown[] = [];
    if (lp.filters.status === 'active') where.push('s.ended_at IS NULL'); else if (lp.filters.status === 'ended') where.push('s.ended_at IS NOT NULL');
    if (lp.filters.organization_id && isUuid(lp.filters.organization_id)) { params.push(lp.filters.organization_id); where.push(`s.organization_id=$${params.length}`); }
    return paged({ select: `s.id, s.started_at, s.ended_at, o.name org_name, s.organization_id, c.first_name || ' ' || COALESCE(c.last_name,'') worker_name, co.name company_name, (LEAST(COALESCE(s.ended_at::date, current_date), current_date) - s.started_at::date + 1) days_active`,
      from: 'seat_usage s JOIN organizations o ON o.id=s.organization_id JOIN workers w ON w.id=s.worker_id JOIN candidates c ON c.id=w.candidate_id LEFT JOIN placements p ON p.id=s.placement_id LEFT JOIN companies co ON co.id=p.company_id',
      where, params, lp, searchCols: ['o.name', 'c.first_name', 'c.last_name', 'co.name'], sortMap: { started_at: 's.started_at', ended_at: 's.ended_at', org_name: 'o.name' }, defaultSort: 's.started_at DESC' });
  });
  app.get('/api/v1/platform/seats/summary', async (req) => {
    platform(req);
    const ym = ymOf(new Date());
    const orgs = await q<any>(`SELECT o.id, o.name FROM organizations o WHERE o.status <> 'deleted' ORDER BY o.name`);
    const rows = [];
    for (const o of orgs) { const qt = await quoteMonth(o.id, ym).catch(() => null); rows.push({ id: o.id, name: o.name, seats_now: await activeSeats(o.id), seat_days_mtd: qt?.seat_days ?? 0, estimate_cents: qt?.total_cents ?? 0, comped: qt?.comped ?? false }); }
    return { rows, history: await seatHistory(null, 12) };
  });

  // ── Feature flags ──
  app.get('/api/v1/platform/flags', async (req) => {
    platform(req);
    const orgs = await q<any>(`SELECT o.id, o.name, s.plan_key FROM organizations o LEFT JOIN subscriptions s ON s.organization_id=o.id WHERE o.status <> 'deleted' ORDER BY o.name`);
    const flags = await q<any>(`SELECT organization_id, key, enabled, updated_at FROM feature_flags`);
    const keys = [...new Set([...FLAG_KEYS, ...flags.map(f => f.key)])];
    return { keys, orgs: orgs.map(o => ({ ...o, flags: Object.fromEntries(keys.map(k => [k, flags.find(f => f.organization_id === o.id && f.key === k)?.enabled ?? false])) })) };
  });
  app.put('/api/v1/platform/agencies/:id/flags/:key', async (req) => {
    const ctx = platform(req);
    const o = await orgOr404((req.params as any).id);
    const key = String((req.params as any).key);
    if (!/^[a-z_]{2,40}$/.test(key)) throw badRequest('Invalid flag key');
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const before = await one<any>(`SELECT enabled FROM feature_flags WHERE organization_id=$1 AND key=$2`, [o.id, key]);
    await q(`INSERT INTO feature_flags (organization_id, key, enabled) VALUES ($1,$2,$3) ON CONFLICT (organization_id, key) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()`, [o.id, key, enabled]);
    await audit(auditAs(ctx, o.id), 'platform.feature_flag_changed', { type: 'feature_flag', id: key, label: `${o.name}: ${key}` }, { enabled: before?.enabled ?? null }, { enabled });
    return { ok: true };
  });

  // ── Integration / provider health ──
  app.get('/api/v1/platform/integrations', async (req) => {
    platform(req);
    const by = await q<any>(`SELECT key, category, provider, count(*)::int total, count(*) FILTER (WHERE status='connected')::int connected, count(*) FILTER (WHERE status='error')::int error, count(*) FILTER (WHERE status='disconnected')::int disconnected, max(last_sync_at) last_sync_at FROM integrations GROUP BY key, category, provider ORDER BY category, key`);
    const errs = await q<any>(`SELECT integration_key, count(*)::int n FROM integration_logs WHERE level='error' AND created_at > now() - interval '24 hours' GROUP BY 1`);
    const recent = await q<any>(`SELECT l.id, l.integration_key, l.level, l.message, l.created_at, o.name org_name FROM integration_logs l LEFT JOIN organizations o ON o.id=l.organization_id WHERE l.level IN ('error','warn') ORDER BY l.created_at DESC LIMIT 30`);
    const problems = await q<any>(`SELECT i.key, i.status, i.last_error, i.updated_at, o.name org_name, o.id organization_id FROM integrations i JOIN organizations o ON o.id=i.organization_id WHERE i.status <> 'connected' ORDER BY i.updated_at DESC`);
    const webhooks = await one<any>(`SELECT count(*) FILTER (WHERE status='delivered')::int delivered, count(*) FILTER (WHERE status='failed')::int failed, count(*) FILTER (WHERE status IN ('pending','retrying'))::int in_flight FROM webhook_deliveries WHERE created_at > now() - interval '7 days'`);
    return { providers: by.map(p => ({ ...p, errors_24h: errs.find(e => e.integration_key === p.key)?.n ?? 0, health: p.error ? 'degraded' : p.disconnected === p.total ? 'disconnected' : 'operational' })), recent, problems, webhooks };
  });

  // Support tickets live in admin-helpdesk.ts

  // ── Impersonation (support mode) ──
  app.get('/api/v1/platform/impersonations', async (req) => {
    platform(req);
    const lp = listParams(req);
    return paged({ select: `i.id, i.reason, i.started_at, i.ended_at, pu.name platform_user_name, tu.name target_name, tu.email target_email, o.name org_name, EXTRACT(EPOCH FROM (COALESCE(i.ended_at, now()) - i.started_at))::int seconds`,
      from: 'impersonation_sessions i JOIN users pu ON pu.id=i.platform_user_id JOIN users tu ON tu.id=i.target_user_id JOIN organizations o ON o.id=i.organization_id', where: [], params: [], lp,
      searchCols: ['tu.name', 'tu.email', 'o.name', 'i.reason'], sortMap: { started_at: 'i.started_at' }, defaultSort: 'i.started_at DESC' });
  });
  app.post('/api/v1/platform/impersonation/start', async (req, reply) => {
    const ctx = platform(req);
    const b = z.object({ user_id: z.string().uuid(), organization_id: z.string().uuid(), reason: z.string().trim().min(10, 'Describe why you need support access (10+ characters)').max(500) }).parse(req.body);
    const m = await one<any>(`SELECT m.*, u.name, u.email, o.name org_name, r.name role_name FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.organization_id JOIN roles r ON r.id=m.role_id WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='active'`, [b.user_id, b.organization_id]);
    if (!m) throw notFound('That user has no active membership in this agency');
    if (b.user_id === ctx.userId) throw conflict('You cannot impersonate yourself');
    if (await one(`SELECT 1 FROM platform_admins WHERE user_id=$1 AND status='active'`, [b.user_id])) throw conflict('Platform admins cannot be impersonated');
    const restore = ctx.sessionId;
    const sid = await createSession(reply, req, b.user_id, b.organization_id, { impersonatorId: ctx.userId, reason: b.reason });
    const imp = await one<any>(`INSERT INTO impersonation_sessions (platform_user_id, target_user_id, organization_id, session_id, reason, restore_session_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ctx.userId, b.user_id, b.organization_id, sid, b.reason, restore]);
    const maxMin = Number((await one<any>(`SELECT value FROM platform_settings WHERE key='impersonation_max_minutes'`))?.value ?? 60);
    await q(`UPDATE sessions SET expires_at=now() + make_interval(mins => $2) WHERE id=$1`, [sid, maxMin]);
    await audit({ ...auditAs(ctx, b.organization_id), impersonatorId: ctx.userId }, 'impersonation.started', { type: 'user', id: b.user_id, label: `${m.name} (${m.role_name})` }, null, { impersonation_id: imp.id, platform_admin: ctx.user.name, target: m.email, organization: m.org_name }, b.reason);
    const admins = await q<any>(`SELECT user_id FROM platform_admins WHERE status='active' AND user_id <> $1`, [ctx.userId]);
    for (const a of admins) await q(`INSERT INTO notifications (organization_id, user_id, event, title, body, link) VALUES (NULL,$1,'impersonation.started',$2,$3,'/platform/impersonation')`, [a.user_id, `${ctx.user.name} started support mode as ${m.name}`, `${m.org_name} — ${b.reason}`]);
    const landing = m.role_kind === 'client' ? '/portal/client' : m.worker_id ? '/portal/worker' : m.candidate_id ? '/portal/candidate' : '/';
    const kind = (await one<any>(`SELECT kind FROM roles WHERE id=$1`, [m.role_id])).kind;
    return { ok: true, impersonation_id: imp.id, redirect: kind === 'client' ? '/portal/client' : kind === 'worker' ? '/portal/worker' : kind === 'candidate' ? '/portal/candidate' : landing };
  });
  // Called from the support banner inside the impersonated session (any portal/shell).
  app.post('/api/v1/platform/impersonation/end', async (req, reply) => {
    const ctx = req.ctx;
    if (!ctx || !ctx.impersonatorId) throw notFound();
    const imp = await one<any>(`SELECT * FROM impersonation_sessions WHERE session_id=$1 ORDER BY started_at DESC LIMIT 1`, [ctx.sessionId]);
    await q(`UPDATE impersonation_sessions SET ended_at=now() WHERE session_id=$1 AND ended_at IS NULL`, [ctx.sessionId]);
    await q(`UPDATE sessions SET revoked_at=now() WHERE id=$1`, [ctx.sessionId]);
    const admin = await one<any>(`SELECT id, name FROM users WHERE id=$1`, [ctx.impersonatorId]);
    await audit({ orgId: ctx.orgId, userId: ctx.impersonatorId, user: admin ?? { name: 'Platform admin' }, impersonatorId: ctx.impersonatorId, ip: ctx.ip } as any, 'impersonation.ended', { type: 'user', id: ctx.userId, label: ctx.user.name }, null, { impersonation_id: imp?.id ?? null, duration_seconds: imp ? Math.round((Date.now() - new Date(imp.started_at).getTime()) / 1000) : null });
    const restore = imp?.restore_session_id ? await one<any>(`SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at > now()`, [imp.restore_session_id, ctx.impersonatorId]) : null;
    if (restore) reply.setCookie(SESSION_COOKIE, restore.id, { path: '/', httpOnly: true, sameSite: 'lax', secure: false, maxAge: 14 * 86400 });
    else await createSession(reply, req, ctx.impersonatorId, null);
    return { ok: true, redirect: '/platform' };
  });
  // Auto-expire long support sessions.
  app.addHook('onReady', async () => {
    setInterval(async () => {
      try {
        const rows = await q<any>(`UPDATE impersonation_sessions i SET ended_at=now() FROM sessions s WHERE s.id=i.session_id AND i.ended_at IS NULL AND (s.expires_at <= now() OR s.revoked_at IS NOT NULL) RETURNING i.*`);
        for (const r of rows) await audit({ orgId: r.organization_id, userId: r.platform_user_id, user: { name: 'Support session' } as any, impersonatorId: r.platform_user_id, ip: 'system' }, 'impersonation.ended', { type: 'user', id: r.target_user_id }, null, { impersonation_id: r.id, reason: 'expired' });
      } catch { /* retry next tick */ }
    }, 60_000).unref();
  });

  // ── System health ──
  app.get('/api/v1/platform/system', async (req) => {
    platform(req);
    const byStatus = await q<any>(`SELECT status, count(*)::int n FROM jobs GROUP BY status`);
    const byKind = await q<any>(`SELECT kind, count(*) FILTER (WHERE status='queued')::int queued, count(*) FILTER (WHERE status='running')::int running, count(*) FILTER (WHERE status='succeeded' AND finished_at > now() - interval '24 hours')::int succeeded_24h,
      count(*) FILTER (WHERE status='failed')::int failed, max(finished_at) last_finished_at, (avg(EXTRACT(EPOCH FROM (finished_at - locked_at))) FILTER (WHERE status='succeeded' AND finished_at > now() - interval '24 hours'))::numeric(10,2) avg_seconds FROM jobs GROUP BY kind ORDER BY kind`);
    const failed = await q<any>(`SELECT j.id, j.kind, j.attempts, j.max_attempts, j.last_error, j.finished_at, j.created_at, o.name org_name FROM jobs j LEFT JOIN organizations o ON o.id=j.organization_id WHERE j.status='failed' ORDER BY j.finished_at DESC NULLS LAST LIMIT 25`);
    const stuck = await q<any>(`SELECT id, kind, locked_at FROM jobs WHERE status='running' AND locked_at < now() - interval '10 minutes' LIMIT 20`);
    const lag = await one<any>(`SELECT EXTRACT(EPOCH FROM (now() - min(run_at)))::int seconds FROM jobs WHERE status='queued' AND run_at <= now()`);
    const errors = await q<any>(`SELECT l.id, l.integration_key, l.level, l.message, l.created_at, o.name org_name FROM integration_logs l LEFT JOIN organizations o ON o.id=l.organization_id WHERE l.level='error' ORDER BY l.created_at DESC LIMIT 25`);
    const db = await one<any>(`SELECT pg_database_size(current_database())::bigint bytes, (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) connections, now() db_time`);
    const throughput = await q<any>(`SELECT to_char(date_trunc('hour', finished_at),'HH24:00') label, count(*)::int value FROM jobs WHERE finished_at > now() - interval '24 hours' AND status='succeeded' GROUP BY date_trunc('hour', finished_at) ORDER BY date_trunc('hour', finished_at)`);
    return { status: byStatus, kinds: byKind, failed, stuck, queue_lag_seconds: lag?.seconds ?? 0, errors, db, uptime_seconds: Math.round(process.uptime()), memory_mb: Math.round(process.memoryUsage().rss / 1048576), node: process.version, throughput };
  });
  app.post('/api/v1/platform/jobs/:id/retry', async (req) => {
    const ctx = platform(req);
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const j = await one<any>(`UPDATE jobs SET status='queued', run_at=now(), attempts=0, last_error=NULL, finished_at=NULL WHERE id=$1 AND status='failed' RETURNING *`, [id]);
    if (!j) throw conflict('Only failed jobs can be retried');
    await audit(auditAs(ctx, j.organization_id), 'platform.job_retried', { type: 'job', id, label: j.kind });
    return { ok: true };
  });

  // ── Audit & security ──
  app.get('/api/v1/platform/audit', async (req) => {
    platform(req);
    const lp = listParams(req);
    const where: string[] = []; const params: unknown[] = [];
    if (lp.filters.organization_id && isUuid(lp.filters.organization_id)) { params.push(lp.filters.organization_id); where.push(`a.organization_id=$${params.length}`); }
    if (lp.filters.action) { params.push(`${lp.filters.action}%`); where.push(`a.action LIKE $${params.length}`); }
    if (lp.filters.impersonated === 'true') where.push('a.impersonator_id IS NOT NULL');
    if (lp.filters.from) { params.push(lp.filters.from); where.push(`a.created_at >= $${params.length}::date`); }
    if (lp.filters.to) { params.push(lp.filters.to); where.push(`a.created_at < ($${params.length}::date + 1)`); }
    return paged({ select: `a.id::text id, a.created_at, a.actor_label, a.action, a.entity_type, a.entity_label, a.reason, a.ip, o.name org_name, iu.name impersonator_name, a.before, a.after`,
      from: 'audit_events a LEFT JOIN organizations o ON o.id=a.organization_id LEFT JOIN users iu ON iu.id=a.impersonator_id', where, params, lp, searchCols: ['a.action', 'a.actor_label', 'a.entity_label', 'o.name', 'a.reason'], sortMap: { created_at: 'a.created_at' }, defaultSort: 'a.created_at DESC' });
  });
  app.get('/api/v1/platform/security', async (req) => {
    platform(req);
    const s = await one<any>(`SELECT (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at > now()) active_sessions,
      (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at > now() AND user_agent='api-key') api_sessions,
      (SELECT count(*)::int FROM audit_events WHERE action='auth.login' AND created_at > now() - interval '24 hours') logins_24h,
      (SELECT count(*)::int FROM users) users, (SELECT count(*)::int FROM users WHERE mfa_enabled) mfa_users,
      (SELECT count(*)::int FROM api_keys WHERE revoked_at IS NULL) api_keys, (SELECT count(*)::int FROM impersonation_sessions WHERE started_at > now() - interval '30 days') impersonations_30d,
      (SELECT count(*)::int FROM audit_events WHERE action LIKE 'export%' AND created_at > now() - interval '7 days') exports_7d,
      (SELECT count(*)::int FROM rate_limits WHERE count > 10 AND window_start > now() - interval '1 hour') throttled_keys`);
    const logins = await q<any>(`SELECT to_char(d,'Mon DD') label, (SELECT count(*)::int FROM audit_events a WHERE a.action='auth.login' AND a.created_at::date = d::date) value FROM generate_series(current_date - 13, current_date, interval '1 day') d`);
    const sensitive = await q<any>(`SELECT a.id::text id, a.created_at, a.actor_label, a.action, a.entity_label, o.name org_name, a.reason FROM audit_events a LEFT JOIN organizations o ON o.id=a.organization_id WHERE a.action ~ '^(impersonation|role\\.|member\\.|api_key|export|audit\\.exported|platform\\.|subscription\\.)' ORDER BY a.created_at DESC LIMIT 20`);
    return { ...s, logins, sensitive };
  });

  // ── Platform admins ──
  app.get('/api/v1/platform/admins', async (req) => {
    const ctx = platform(req);
    const rows = await q<any>(`SELECT p.user_id id, p.status, p.expires_at, p.created_at, u.name, u.email, u.last_login_at, u.password_hash IS NOT NULL has_password, iu.name invited_by_name,
      CASE WHEN p.status='active' AND p.expires_at IS NOT NULL AND p.expires_at <= now() THEN 'expired' ELSE p.status END effective_status
      FROM platform_admins p JOIN users u ON u.id=p.user_id LEFT JOIN users iu ON iu.id=p.invited_by ORDER BY p.created_at`);
    return rows.map(r => ({ ...r, is_me: r.id === ctx.userId }));
  });
  app.post('/api/v1/platform/admins', async (req) => {
    const ctx = platform(req);
    const b = z.object({ email: z.string().email(), name: z.string().min(2).max(80), expires_at: z.string().nullable().optional() }).parse(req.body);
    if (b.expires_at && new Date(b.expires_at) <= new Date()) throw fieldError({ expires_at: 'Pick a future date' });
    const res = await tx(async (c) => {
      let u = (await c.query(`SELECT * FROM users WHERE lower(email)=lower($1)`, [b.email])).rows[0];
      const isNew = !u;
      if (!u) u = (await c.query(`INSERT INTO users (email, name, password_hash, avatar_color) VALUES (lower($1),$2,$3,'#0A0E16') RETURNING *`, [b.email, b.name, await bcrypt.hash(randomToken(24), 10)])).rows[0];
      const ex = (await c.query(`SELECT * FROM platform_admins WHERE user_id=$1`, [u.id])).rows[0];
      if (ex && ex.status === 'active' && (!ex.expires_at || new Date(ex.expires_at) > new Date())) throw conflict(`${b.email} is already a platform admin`);
      await c.query(`INSERT INTO platform_admins (user_id, status, expires_at, invited_by) VALUES ($1,'active',$2,$3) ON CONFLICT (user_id) DO UPDATE SET status='active', expires_at=EXCLUDED.expires_at, invited_by=EXCLUDED.invited_by`, [u.id, b.expires_at ?? null, ctx.userId]);
      const token = randomToken();
      await c.query(`INSERT INTO password_resets (token, user_id, expires_at) VALUES ($1,$2, now() + interval '7 days')`, [token, u.id]);
      await audit(auditAs(ctx, null) as any, 'platform.admin_invited', { type: 'user', id: u.id, label: b.email }, null, { expires_at: b.expires_at ?? null, new_user: isNew }, undefined, c);
      return { u, token, isNew };
    });
    await sendMessage({ orgId: null, channel: 'email', to: b.email, subject: 'You are now a VeyroApp platform admin', fromName: 'VeyroApp', text: `Hi ${b.name},\n\n${ctx.user.name} gave you access to the VeyroApp Platform Control Center${b.expires_at ? ` until ${new Date(b.expires_at).toDateString()}` : ''}.\n\n${res.isNew ? 'Set your password' : 'Sign in (or reset your password)'}: ${WEB_URL}/reset-password?token=${res.token}\n\nThen open ${WEB_URL}/platform` });
    return { ok: true, id: res.u.id };
  });
  app.patch('/api/v1/platform/admins/:id', async (req) => {
    const ctx = platform(req);
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const p = await one<any>(`SELECT p.*, u.email FROM platform_admins p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1`, [id]); if (!p) throw notFound();
    const b = z.object({ expires_at: z.string().nullable().optional(), status: z.enum(['active', 'revoked']).optional() }).parse(req.body);
    if (id === ctx.userId && (b.status === 'revoked' || (b.expires_at && new Date(b.expires_at) <= new Date()))) throw conflict('You cannot revoke your own platform access');
    if (b.status === 'revoked') { const others = (await one<any>(`SELECT count(*)::int n FROM platform_admins WHERE status='active' AND user_id <> $1 AND (expires_at IS NULL OR expires_at > now())`, [id])).n; if (!others) throw conflict('At least one active platform admin is required'); }
    await q(`UPDATE platform_admins SET status=COALESCE($2,status), expires_at=CASE WHEN $3::boolean THEN $4::timestamptz ELSE expires_at END WHERE user_id=$1`, [id, b.status ?? null, b.expires_at !== undefined, b.expires_at ?? null]);
    if (b.status === 'revoked') await q(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND active_organization_id IS NULL AND revoked_at IS NULL`, [id]);
    await audit(auditAs(ctx, null) as any, b.status === 'revoked' ? 'platform.admin_revoked' : 'platform.admin_updated', { type: 'user', id, label: p.email }, { status: p.status, expires_at: p.expires_at }, b);
    return { ok: true };
  });

  // ── Plans & pricing ──
  app.get('/api/v1/platform/plans', async (req) => {
    platform(req);
    return q(`SELECT p.*, (SELECT count(*)::int FROM subscriptions s WHERE s.plan_key=p.key) subscribers FROM plans p ORDER BY p.sort, p.price_per_seat_cents, p.key`);
  });
  app.patch('/api/v1/platform/plans/:key', async (req) => {
    const ctx = platform(req);
    const { key } = req.params as any;
    const p = await one<any>(`SELECT * FROM plans WHERE key=$1`, [key]); if (!p) throw notFound();
    const b = z.object({ name: z.string().min(2).max(40).optional(), price_per_seat_cents: z.number().int().min(0).max(100000).optional(), trial_days: z.number().int().min(0).max(90).optional(), addon_monthly_cents: z.number().int().min(0).max(1000000).optional(), description: z.string().max(300).nullable().optional(), active: z.boolean().optional() }).parse(req.body);
    const features = { ...(p.features ?? {}), ...(b.addon_monthly_cents !== undefined ? { addon_monthly_cents: b.addon_monthly_cents } : {}) };
    await q(`UPDATE plans SET name=COALESCE($2,name), price_per_seat_cents=COALESCE($3,price_per_seat_cents), trial_days=COALESCE($4,trial_days), features=$5, description=CASE WHEN $6::boolean THEN $7 ELSE description END, active=COALESCE($8,active) WHERE key=$1`,
      [key, b.name ?? null, b.price_per_seat_cents ?? null, b.trial_days ?? null, JSON.stringify(features), b.description !== undefined, b.description ?? null, b.active ?? null]);
    await audit(auditAs(ctx, null) as any, 'platform.plan_updated', { type: 'plan', id: key, label: p.name }, { name: p.name, price_per_seat_cents: p.price_per_seat_cents, trial_days: p.trial_days, features: p.features, active: p.active }, b);
    return { ok: true };
  });

  // ── Platform settings ──
  app.get('/api/v1/platform/settings', async (req) => {
    platform(req);
    const rows = await q<any>(`SELECT key, value, updated_at FROM platform_settings`);
    return { ...PLATFORM_DEFAULTS, ...Object.fromEntries(rows.map(r => [r.key, r.value])) };
  });
  app.put('/api/v1/platform/settings', async (req) => {
    const ctx = platform(req);
    const b = z.object({ platform_name: z.string().min(2).max(40), support_email: z.string().email(), default_trial_days: z.number().int().min(0).max(90), default_tax_bp: z.number().int().min(0).max(5000), seat_price_cents: z.number().int().min(0).max(100000), maintenance_banner: z.string().max(200), impersonation_max_minutes: z.number().int().min(5).max(480), require_impersonation_reason: z.boolean() }).partial().parse(req.body);
    const before = Object.fromEntries((await q<any>(`SELECT key, value FROM platform_settings`)).map(r => [r.key, r.value]));
    for (const [k, v] of Object.entries(b)) await q(`INSERT INTO platform_settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [k, JSON.stringify(v), ctx.userId]);
    await audit(auditAs(ctx, null) as any, 'platform.settings_updated', { type: 'platform_settings', label: Object.keys(b).join(', ') }, Object.fromEntries(Object.keys(b).map(k => [k, before[k] ?? PLATFORM_DEFAULTS[k]])), b);
    return { ok: true };
  });
  // Lightweight public read of platform banner/name (used by the login page if desired).
  app.get('/api/v1/platform/public-settings', { config: { public: true } }, async () => {
    const rows = await q<any>(`SELECT key, value FROM platform_settings WHERE key IN ('platform_name','maintenance_banner','support_email')`);
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return { platform_name: m.platform_name ?? PLATFORM_DEFAULTS.platform_name, maintenance_banner: m.maintenance_banner ?? '', support_email: m.support_email ?? PLATFORM_DEFAULTS.support_email };
  });
}
