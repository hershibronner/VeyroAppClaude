// Client portal: Request a Worker, Users & permissions, Settings. Worker portal: Profile, Training.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { CLIENT_ROLES } from '@veyro/shared';
import { q, one, tx } from '../core/db';
import { auth, type Ctx } from '../core/context';
import { badRequest, conflict, forbidden, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify, usersWithRoles } from '../core/notify';
import { emit } from '../core/events';
import { sendTemplate } from '../adapters/messaging';
import { WEB_URL, getSetting } from '../core/settings';
import { rateLimit } from '../core/ratelimit';
import { isUuid, randomToken } from './_admin/common';
import { fieldError } from './_admin/common';

function client(req: FastifyRequest): Ctx & { companyId: string } {
  const ctx = auth(req);
  if (ctx.role.kind !== 'client' || !ctx.companyId) throw notFound();
  return ctx as Ctx & { companyId: string };
}
function worker(req: FastifyRequest): Ctx & { workerId: string } {
  const ctx = auth(req);
  if (ctx.role.kind !== 'worker' || !ctx.workerId) throw notFound();
  return ctx as Ctx & { workerId: string };
}
const isClientOwner = (ctx: Ctx) => ctx.role.key === 'client_owner';
const CLIENT_NOTIFY_EVENTS = [
  { key: 'timesheet.submitted', label: 'A timesheet is waiting for my approval' }, { key: 'invoice.sent', label: 'A new invoice is issued' }, { key: 'invoice.overdue', label: 'An invoice becomes overdue' },
  { key: 'submission.created', label: 'New candidates to review' }, { key: 'interview.scheduled', label: 'Interviews are scheduled or changed' }, { key: 'attendance.late', label: 'A team member is late or absent' },
  { key: 'document.signature_requested', label: 'A document needs my signature' }, { key: 'message.received', label: 'New messages from the agency' },
];
const WORKER_NOTIFY_EVENTS = [
  { key: 'timesheet.approved', label: 'Timesheet approved' }, { key: 'timesheet.rejected', label: 'Timesheet rejected' }, { key: 'payslip.ready', label: 'Payslip ready' }, { key: 'training.assigned', label: 'New training assigned' }, { key: 'message.received', label: 'New messages' },
];

export default async function (app: FastifyInstance) {
  // ───────────── Client: Request a Worker ─────────────
  app.get('/api/v1/portal/client/request', async (req) => {
    const ctx = client(req);
    const co = await one<any>(`SELECT c.name, c.timezone_hint, u.name am_name, u.email am_email FROM (SELECT name, NULL::text timezone_hint, account_manager_id, owner_id FROM companies WHERE id=$1 AND organization_id=$2) c LEFT JOIN users u ON u.id=COALESCE(c.account_manager_id, c.owner_id)`, [ctx.companyId, ctx.orgId]);
    const rows = await q<any>(`SELECT p.id, p.title, p.status, p.openings, p.filled, p.urgency, p.employment_type, p.weekly_hours, p.schedule, p.timezone, p.created_at, u.name requested_by_name,
      (SELECT count(*)::int FROM candidate_submissions s WHERE s.position_id=p.id AND s.organization_id=p.organization_id) submissions
      FROM positions p LEFT JOIN users u ON u.id=p.created_by WHERE p.organization_id=$1 AND p.company_id=$2 AND p.created_by IN (SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND company_id=$2) ORDER BY p.created_at DESC LIMIT 50`, [ctx.orgId, ctx.companyId]);
    const portals = await getSetting(ctx.orgId, 'portals');
    return { company: co?.name, account_manager: co?.am_name ? { name: co.am_name, email: co.am_email } : null, requests: rows, enabled: portals.client_can_request_workers !== false };
  });
  app.post('/api/v1/portal/client/request', async (req) => {
    const ctx = client(req);
    if (ctx.role.key === 'client_viewer') throw forbidden('Viewers cannot request workers — ask your client owner');
    const portals = await getSetting(ctx.orgId, 'portals');
    if (portals.client_can_request_workers === false) throw forbidden('Your agency has turned off worker requests in the portal — message your account manager instead');
    await rateLimit(`client-request:${ctx.userId}`, 20, 3600);
    const b = z.object({ title: z.string().min(3, 'Give the role a title').max(120), openings: z.number().int().min(1).max(50).default(1), employment_type: z.enum(['full_time', 'part_time', 'contract']).default('full_time'),
      weekly_hours: z.number().int().min(1).max(80).nullable().optional(), schedule: z.string().max(120).nullable().optional(), timezone: z.string().max(60).nullable().optional(), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      skills: z.array(z.string().max(40)).max(20).default([]), software: z.array(z.string().max(40)).max(20).default([]), languages: z.array(z.string().max(40)).max(10).default([]),
      budget_cents: z.number().int().min(0).max(100000000).nullable().optional(), urgency: z.enum(['low', 'normal', 'high', 'critical']).default('normal'), description: z.string().min(20, 'Describe the work (20+ characters)').max(5000) }).parse(req.body);
    const co = await one<any>(`SELECT id, name, account_manager_id, owner_id FROM companies WHERE id=$1 AND organization_id=$2`, [ctx.companyId, ctx.orgId]);
    if (!co) throw notFound();
    const desc = `${b.description}${b.start_date ? `\n\nDesired start: ${b.start_date}` : ''}\n\nRequested by ${ctx.user.name} via the client portal.`;
    const pos = await tx(async (c) => {
      const p = (await c.query(`INSERT INTO positions (organization_id, company_id, title, openings, urgency, employment_type, schedule, timezone, weekly_hours, skills, software, languages, bill_budget_cents, description, status, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15) RETURNING *`,
        [ctx.orgId, co.id, b.title, b.openings, b.urgency, b.employment_type, b.schedule ?? null, b.timezone ?? null, b.weekly_hours ?? null, b.skills, b.software, b.languages, b.budget_cents ?? null, desc, ctx.userId])).rows[0];
      await activity(ctx, 'position', p.id, 'created', 'Requested by client', `${ctx.user.name} (${co.name}) requested ${b.openings} × ${b.title} in the client portal`, {}, c);
      await activity(ctx, 'company', co.id, 'request', `Worker request: ${b.title}`, `${b.openings} opening(s) · ${b.urgency} urgency`, { position_id: p.id }, c);
      return p;
    });
    const recipients = [co.account_manager_id ?? co.owner_id].filter(Boolean) as string[];
    const fallback = recipients.length ? [] : await usersWithRoles(ctx.orgId, ['owner', 'admin']);
    await notify(ctx.orgId, [...recipients, ...fallback], { event: 'position.requested', title: `${co.name} requested a worker`, body: `${b.openings} × ${b.title} (${b.urgency} urgency) — review the draft position`, link: `/recruiting/positions/${pos.id}` });
    await emit(ctx.orgId, 'position.requested', { position_id: pos.id, position_title: pos.title, company_id: co.id, company_name: co.name, account_manager_id: co.account_manager_id, requested_by: ctx.userId, requested_by_name: ctx.user.name, openings: b.openings });
    return { id: pos.id, title: pos.title, status: pos.status };
  });

  // ───────────── Client: Users & permissions ─────────────
  app.get('/api/v1/portal/client/users', async (req) => {
    const ctx = client(req);
    const users = await q<any>(`SELECT m.id, m.user_id, m.status, m.created_at, u.name, u.email, u.last_login_at, r.key role_key, r.name role_name, (m.user_id=$3) is_me FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id
      WHERE m.organization_id=$1 AND m.company_id=$2 AND r.kind='client' AND m.status <> 'removed' ORDER BY (r.key='client_owner') DESC, u.name`, [ctx.orgId, ctx.companyId, ctx.userId]);
    const invites = await q<any>(`SELECT i.id, i.email, i.name, i.created_at, i.expires_at, r.name role_name, r.key role_key, CASE WHEN i.status='pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END status FROM invitations i JOIN roles r ON r.id=i.role_id
      WHERE i.organization_id=$1 AND i.company_id=$2 AND r.kind='client' AND i.status='pending' ORDER BY i.created_at DESC`, [ctx.orgId, ctx.companyId]);
    const roles = await q<any>(`SELECT id, key, name FROM roles WHERE organization_id=$1 AND kind='client' ORDER BY array_position($2::text[], key)`, [ctx.orgId, CLIENT_ROLES.map(r => r.key)]);
    return { users, invites, roles: roles.map(r => ({ ...r, description: ({ client_owner: 'Everything, including users and settings', client_manager: 'Team, candidates, interviews, timesheet approval', client_supervisor: 'Team status and timesheet approval', client_finance: 'Invoices and payments', client_viewer: 'Read-only' } as Record<string, string>)[r.key] })), can_manage: isClientOwner(ctx) };
  });
  app.post('/api/v1/portal/client/users', async (req) => {
    const ctx = client(req);
    if (!isClientOwner(ctx)) throw forbidden('Only the client owner can invite users');
    await rateLimit(`client-invite:${ctx.userId}`, 30, 3600);
    const b = z.object({ email: z.string().email(), name: z.string().min(2).max(80), role_key: z.enum(CLIENT_ROLES.map(r => r.key) as [string, ...string[]]) }).parse(req.body);
    const role = await one<any>(`SELECT * FROM roles WHERE organization_id=$1 AND key=$2 AND kind='client'`, [ctx.orgId, b.role_key]);
    if (!role) throw badRequest('Unknown role');
    const member = await one<any>(`SELECT m.status, m.company_id, r.kind FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND lower(u.email)=lower($2)`, [ctx.orgId, b.email]);
    if (member && member.status === 'active') throw conflict(member.kind === 'client' && member.company_id === ctx.companyId ? `${b.email} already has access` : 'This email already belongs to another account with this agency — ask your account manager');
    if (await one(`SELECT 1 FROM invitations WHERE organization_id=$1 AND lower(email)=lower($2) AND status='pending' AND expires_at > now()`, [ctx.orgId, b.email])) throw conflict('An invitation is already pending for this email');
    const co = await one<any>(`SELECT name FROM companies WHERE id=$1`, [ctx.companyId]);
    const inv = await one<any>(`INSERT INTO invitations (organization_id, email, name, role_id, token, company_id, invited_by, expires_at, last_sent_at) VALUES ($1,lower($2),$3,$4,$5,$6,$7, now() + interval '7 days', now()) RETURNING *`, [ctx.orgId, b.email, b.name, role.id, randomToken(), ctx.companyId, ctx.userId]);
    await sendTemplate(ctx.orgId, 'invite_client_portal', b.email, { invitee: { name: b.name }, org: { name: ctx.org.name }, company: { name: co?.name }, link: `${WEB_URL}/invite/${inv.token}` }, { related: { type: 'company', id: ctx.companyId } });
    await audit(ctx, 'client_user.invited', { type: 'company', id: ctx.companyId, label: `${b.email} → ${co?.name}` }, null, { role: role.name });
    return { id: inv.id };
  });
  app.post('/api/v1/portal/client/users/invites/:id/revoke', async (req) => {
    const ctx = client(req);
    if (!isClientOwner(ctx)) throw forbidden('Only the client owner can manage users');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const inv = await one<any>(`UPDATE invitations SET status='revoked', revoked_at=now() WHERE id=$1 AND organization_id=$2 AND company_id=$3 AND status='pending' RETURNING *`, [id, ctx.orgId, ctx.companyId]);
    if (!inv) throw notFound();
    await audit(ctx, 'client_user.invitation_revoked', { type: 'company', id: ctx.companyId, label: inv.email });
    return { ok: true };
  });
  app.post('/api/v1/portal/client/users/invites/:id/resend', async (req) => {
    const ctx = client(req);
    if (!isClientOwner(ctx)) throw forbidden('Only the client owner can manage users');
    const { id } = req.params as any; if (!isUuid(id)) throw notFound();
    const token = randomToken();
    const inv = await one<any>(`UPDATE invitations SET token=$4, expires_at=now() + interval '7 days', resent_count=resent_count+1, last_sent_at=now() WHERE id=$1 AND organization_id=$2 AND company_id=$3 AND status='pending' RETURNING *`, [id, ctx.orgId, ctx.companyId, token]);
    if (!inv) throw notFound();
    const co = await one<any>(`SELECT name FROM companies WHERE id=$1`, [ctx.companyId]);
    await sendTemplate(ctx.orgId, 'invite_client_portal', inv.email, { invitee: { name: inv.name ?? inv.email }, org: { name: ctx.org.name }, company: { name: co?.name }, link: `${WEB_URL}/invite/${token}` }, { related: { type: 'company', id: ctx.companyId } });
    await audit(ctx, 'client_user.invitation_resent', { type: 'company', id: ctx.companyId, label: inv.email });
    return { ok: true };
  });
  async function clientMember(ctx: Ctx & { companyId: string }, id: string) {
    if (!isUuid(id)) throw notFound();
    const m = await one<any>(`SELECT m.*, u.name, u.email, r.key role_key, r.name role_name FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.id=$1 AND m.organization_id=$2 AND m.company_id=$3 AND r.kind='client'`, [id, ctx.orgId, ctx.companyId]);
    if (!m) throw notFound();
    return m;
  }
  const ownersLeft = async (ctx: Ctx & { companyId: string }) => (await one<any>(`SELECT count(*)::int n FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.company_id=$2 AND m.status='active' AND r.key='client_owner'`, [ctx.orgId, ctx.companyId])).n;
  app.patch('/api/v1/portal/client/users/:id', async (req) => {
    const ctx = client(req);
    if (!isClientOwner(ctx)) throw forbidden('Only the client owner can change roles');
    const m = await clientMember(ctx, (req.params as any).id);
    const b = z.object({ role_key: z.enum(CLIENT_ROLES.map(r => r.key) as [string, ...string[]]) }).parse(req.body);
    if (m.role_key === 'client_owner' && b.role_key !== 'client_owner' && (await ownersLeft(ctx)) <= 1) throw conflict('Your company needs at least one client owner');
    const role = await one<any>(`SELECT * FROM roles WHERE organization_id=$1 AND key=$2`, [ctx.orgId, b.role_key]);
    await q(`UPDATE organization_memberships SET role_id=$2, updated_at=now() WHERE id=$1`, [m.id, role.id]);
    await audit(ctx, 'client_user.role_changed', { type: 'user', id: m.user_id, label: m.name }, { role: m.role_name }, { role: role.name });
    if (m.user_id !== ctx.userId) await notify(ctx.orgId, [m.user_id], { event: 'role.changed', title: `Your portal role is now ${role.name}`, body: `${ctx.user.name} changed your access.`, link: '/portal/client' });
    return { ok: true };
  });
  app.post('/api/v1/portal/client/users/:id/revoke', async (req) => {
    const ctx = client(req);
    if (!isClientOwner(ctx)) throw forbidden('Only the client owner can revoke access');
    const m = await clientMember(ctx, (req.params as any).id);
    if (m.user_id === ctx.userId) throw conflict('You cannot revoke your own access');
    if (m.role_key === 'client_owner' && (await ownersLeft(ctx)) <= 1) throw conflict('Your company needs at least one client owner');
    await q(`UPDATE organization_memberships SET status='removed', updated_at=now() WHERE id=$1`, [m.id]);
    await q(`UPDATE sessions SET active_organization_id=NULL WHERE user_id=$1 AND active_organization_id=$2`, [m.user_id, ctx.orgId]);
    await audit(ctx, 'client_user.revoked', { type: 'user', id: m.user_id, label: m.name }, { status: m.status }, { status: 'removed' });
    return { ok: true };
  });

  // ───────────── Client: Settings ─────────────
  app.get('/api/v1/portal/client/settings', async (req) => {
    const ctx = client(req);
    const co = await one<any>(`SELECT id, name, timesheet_approval, portal_screenshots, payment_terms_days, email, phone, address FROM companies WHERE id=$1 AND organization_id=$2`, [ctx.companyId, ctx.orgId]);
    const s = await one<any>(`SELECT s.*, u.name contact_name FROM client_portal_settings s LEFT JOIN users u ON u.id=s.timesheet_contact_user_id WHERE s.organization_id=$1 AND s.company_id=$2`, [ctx.orgId, ctx.companyId]);
    const approvers = await q<any>(`SELECT u.id, u.name, r.name role_name FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.company_id=$2 AND m.status='active' AND r.key IN ('client_owner','client_manager','client_supervisor') ORDER BY u.name`, [ctx.orgId, ctx.companyId]);
    const prefs = await q<any>(`SELECT event, in_app, email FROM notification_preferences WHERE user_id=$1 AND organization_id=$2`, [ctx.userId, ctx.orgId]);
    return { company: co, settings: { timesheet_contact_user_id: s?.timesheet_contact_user_id ?? null, timesheet_contact_name: s?.contact_name ?? null, invoice_email: s?.invoice_email ?? co?.email ?? null, weekly_digest: s?.weekly_digest ?? true },
      approvers, notifications: CLIENT_NOTIFY_EVENTS.map(e => { const p = prefs.find(x => x.event === e.key); return { ...e, in_app: p ? p.in_app : true, email: p ? p.email : false }; }), can_edit_company: isClientOwner(ctx) };
  });
  app.put('/api/v1/portal/client/settings', async (req) => {
    const ctx = client(req);
    if (!isClientOwner(ctx)) throw forbidden('Only the client owner can change company settings');
    const b = z.object({ timesheet_contact_user_id: z.string().uuid().nullable(), invoice_email: z.string().email().nullable(), weekly_digest: z.boolean() }).partial().parse(req.body);
    if (b.timesheet_contact_user_id && !(await one(`SELECT 1 FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.company_id=$2 AND m.user_id=$3 AND m.status='active' AND r.key IN ('client_owner','client_manager','client_supervisor')`, [ctx.orgId, ctx.companyId, b.timesheet_contact_user_id])))
      throw fieldError({ timesheet_contact_user_id: 'Choose an owner, manager or supervisor' });
    const before = await one<any>(`SELECT timesheet_contact_user_id, invoice_email, weekly_digest FROM client_portal_settings WHERE organization_id=$1 AND company_id=$2`, [ctx.orgId, ctx.companyId]);
    await q(`INSERT INTO client_portal_settings (organization_id, company_id, timesheet_contact_user_id, invoice_email, weekly_digest, updated_by) VALUES ($1,$2,$3,$4,COALESCE($5,true),$6)
      ON CONFLICT (organization_id, company_id) DO UPDATE SET timesheet_contact_user_id=CASE WHEN $7::boolean THEN EXCLUDED.timesheet_contact_user_id ELSE client_portal_settings.timesheet_contact_user_id END,
      invoice_email=CASE WHEN $8::boolean THEN EXCLUDED.invoice_email ELSE client_portal_settings.invoice_email END, weekly_digest=COALESCE($5, client_portal_settings.weekly_digest), updated_by=$6, updated_at=now()`,
      [ctx.orgId, ctx.companyId, b.timesheet_contact_user_id ?? null, b.invoice_email ?? null, b.weekly_digest ?? null, ctx.userId, b.timesheet_contact_user_id !== undefined, b.invoice_email !== undefined]);
    await audit(ctx, 'client_portal.settings_updated', { type: 'company', id: ctx.companyId, label: 'Client portal settings' }, before, b);
    await activity(ctx, 'company', ctx.companyId, 'update', 'Client updated portal settings', Object.keys(b).join(', '));
    return { ok: true };
  });
  app.put('/api/v1/portal/client/settings/notifications', async (req) => {
    const ctx = client(req);
    const b = z.object({ prefs: z.array(z.object({ event: z.string(), in_app: z.boolean(), email: z.boolean() })).max(30) }).parse(req.body);
    const allowed = new Set(CLIENT_NOTIFY_EVENTS.map(e => e.key));
    for (const p of b.prefs.filter(p => allowed.has(p.event))) await q(`INSERT INTO notification_preferences (user_id, organization_id, event, in_app, email) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, organization_id, event) DO UPDATE SET in_app=EXCLUDED.in_app, email=EXCLUDED.email`, [ctx.userId, ctx.orgId, p.event, p.in_app, p.email]);
    return { ok: true };
  });

  // ───────────── Worker: Profile ─────────────
  app.get('/api/v1/portal/worker/profile', async (req) => {
    const ctx = worker(req);
    const w = await one<any>(`SELECT w.id, w.status, w.employee_code, w.payout_method, w.payout_account_label, c.first_name, c.last_name, c.email, c.phone, c.country, c.city, c.timezone, c.headline, c.languages, c.skills
      FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.id=$1 AND w.organization_id=$2`, [ctx.workerId, ctx.orgId]);
    if (!w) throw notFound();
    const u = await one<any>(`SELECT name, email, phone, mfa_enabled, last_login_at FROM users WHERE id=$1`, [ctx.userId]);
    const prefs = await q<any>(`SELECT event, in_app, email FROM notification_preferences WHERE user_id=$1 AND organization_id=$2`, [ctx.userId, ctx.orgId]);
    const placement = await one<any>(`SELECT p.title, p.start_date, p.timezone, co.name company_name FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.worker_id=$1 AND p.organization_id=$2 AND p.status IN ('active','on_leave','notice','onboarding') ORDER BY p.start_date DESC LIMIT 1`, [ctx.workerId, ctx.orgId]);
    return { worker: w, user: u, placement, notifications: WORKER_NOTIFY_EVENTS.map(e => { const p = prefs.find(x => x.event === e.key); return { ...e, in_app: p ? p.in_app : true, email: p ? p.email : false }; }) };
  });
  app.patch('/api/v1/portal/worker/profile', async (req) => {
    const ctx = worker(req);
    const b = z.object({ first_name: z.string().min(1).max(60), last_name: z.string().max(60).nullable(), phone: z.string().max(40).nullable(), country: z.string().max(60).nullable(), city: z.string().max(80).nullable(), timezone: z.string().max(60).nullable(), headline: z.string().max(120).nullable(),
      payout_method: z.enum(['wise', 'bank', 'paypal', 'payoneer']), payout_account_label: z.string().max(60).nullable() }).partial().parse(req.body);
    if (b.payout_account_label && /\d{7,}/.test(b.payout_account_label.replace(/[\s-]/g, ''))) throw fieldError({ payout_account_label: 'Enter a label only (e.g. "Wise •••• 4821"), never a full account number' });
    const w = await one<any>(`SELECT w.*, c.first_name, c.last_name, c.phone, c.country, c.city, c.timezone, c.headline FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.id=$1 AND w.organization_id=$2`, [ctx.workerId, ctx.orgId]);
    if (!w) throw notFound();
    const payoutChanged = (b.payout_method !== undefined && b.payout_method !== w.payout_method) || (b.payout_account_label !== undefined && b.payout_account_label !== w.payout_account_label);
    await tx(async (c) => {
      await c.query(`UPDATE candidates SET first_name=COALESCE($3,first_name), last_name=CASE WHEN $4::boolean THEN $5 ELSE last_name END, phone=CASE WHEN $6::boolean THEN $7 ELSE phone END, country=CASE WHEN $8::boolean THEN $9 ELSE country END,
        city=CASE WHEN $10::boolean THEN $11 ELSE city END, timezone=CASE WHEN $12::boolean THEN $13 ELSE timezone END, headline=CASE WHEN $14::boolean THEN $15 ELSE headline END, updated_at=now() WHERE id=$1 AND organization_id=$2`,
        [w.candidate_id, ctx.orgId, b.first_name ?? null, b.last_name !== undefined, b.last_name ?? null, b.phone !== undefined, b.phone ?? null, b.country !== undefined, b.country ?? null, b.city !== undefined, b.city ?? null, b.timezone !== undefined, b.timezone ?? null, b.headline !== undefined, b.headline ?? null]);
      if (b.first_name || b.last_name !== undefined || b.phone !== undefined) await c.query(`UPDATE users SET name=COALESCE($2, name), phone=CASE WHEN $3::boolean THEN $4 ELSE phone END, updated_at=now() WHERE id=$1`, [ctx.userId, b.first_name ? `${b.first_name} ${b.last_name ?? w.last_name ?? ''}`.trim() : null, b.phone !== undefined, b.phone ?? null]);
      if (payoutChanged) {
        await c.query(`UPDATE workers SET payout_method=COALESCE($3,payout_method), payout_account_label=CASE WHEN $4::boolean THEN $5 ELSE payout_account_label END, updated_at=now() WHERE id=$1 AND organization_id=$2`, [ctx.workerId, ctx.orgId, b.payout_method ?? null, b.payout_account_label !== undefined, b.payout_account_label ?? null]);
        await audit(ctx, 'worker.payout_details_changed', { type: 'worker', id: ctx.workerId, label: `${w.first_name} ${w.last_name ?? ''}`.trim() }, { payout_method: w.payout_method, payout_account_label: w.payout_account_label }, { payout_method: b.payout_method ?? w.payout_method, payout_account_label: b.payout_account_label !== undefined ? b.payout_account_label : w.payout_account_label }, undefined, c);
      }
      await activity(ctx, 'worker', ctx.workerId, 'update', payoutChanged ? 'Worker updated profile and payout details' : 'Worker updated profile', Object.keys(b).join(', '), {}, c);
    });
    if (payoutChanged) await notify(ctx.orgId, await usersWithRoles(ctx.orgId, ['finance', 'owner']), { event: 'worker.payout_changed', title: `${w.first_name} ${w.last_name ?? ''} changed payout details`.trim(), body: `${b.payout_method ?? w.payout_method} · ${b.payout_account_label ?? w.payout_account_label ?? '—'} — verify before the next payroll run`, link: `/workforce/workers/${ctx.workerId}` });
    return { ok: true };
  });
  app.post('/api/v1/portal/worker/profile/password', async (req) => {
    const ctx = worker(req);
    await rateLimit(`pw:${ctx.userId}`, 10, 600);
    const b = z.object({ current_password: z.string().min(1, 'Enter your current password'), new_password: z.string().min(8, 'Use at least 8 characters') }).parse(req.body);
    const u = await one<any>(`SELECT password_hash FROM users WHERE id=$1`, [ctx.userId]);
    if (!(await bcrypt.compare(b.current_password, u?.password_hash ?? ''))) throw fieldError({ current_password: 'Current password is incorrect' });
    await q(`UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1`, [ctx.userId, await bcrypt.hash(b.new_password, 10)]);
    await q(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id <> $2 AND revoked_at IS NULL`, [ctx.userId, ctx.sessionId]);
    await audit(ctx, 'user.password_changed', { type: 'user', id: ctx.userId, label: ctx.user.name });
    return { ok: true };
  });
  app.put('/api/v1/portal/worker/profile/notifications', async (req) => {
    const ctx = worker(req);
    const b = z.object({ prefs: z.array(z.object({ event: z.string(), in_app: z.boolean(), email: z.boolean() })).max(30) }).parse(req.body);
    const allowed = new Set(WORKER_NOTIFY_EVENTS.map(e => e.key));
    for (const p of b.prefs.filter(p => allowed.has(p.event))) await q(`INSERT INTO notification_preferences (user_id, organization_id, event, in_app, email) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, organization_id, event) DO UPDATE SET in_app=EXCLUDED.in_app, email=EXCLUDED.email`, [ctx.userId, ctx.orgId, p.event, p.in_app, p.email]);
    return { ok: true };
  });

  // ───────────── Worker: Training ─────────────
  app.get('/api/v1/portal/worker/training', async (req) => {
    const ctx = worker(req);
    const rows = await q<any>(`SELECT m.id, m.title, m.description, m.content, m.kind, m.url, m.required, m.duration_min, m.sort, p.status, p.started_at, p.completed_at FROM training_modules m
      LEFT JOIN training_progress p ON p.module_id=m.id AND p.worker_id=$2 WHERE m.organization_id=$1 AND m.active ORDER BY m.required DESC, m.sort, m.created_at`, [ctx.orgId, ctx.workerId]);
    const done = rows.filter(r => r.status === 'completed').length;
    return { rows, completed: done, total: rows.length, required_open: rows.filter(r => r.required && r.status !== 'completed').length };
  });
  app.post('/api/v1/portal/worker/training/:id/:action', async (req) => {
    const ctx = worker(req);
    const { id, action } = req.params as any;
    if (!isUuid(id) || !['start', 'complete'].includes(action)) throw notFound();
    const m = await one<any>(`SELECT * FROM training_modules WHERE id=$1 AND organization_id=$2 AND active`, [id, ctx.orgId]);
    if (!m) throw notFound();
    const cur = await one<any>(`SELECT * FROM training_progress WHERE module_id=$1 AND worker_id=$2`, [id, ctx.workerId]);
    if (action === 'start') {
      if (!cur) await q(`INSERT INTO training_progress (organization_id, module_id, worker_id, status) VALUES ($1,$2,$3,'in_progress')`, [ctx.orgId, id, ctx.workerId]);
      return { ok: true, status: cur?.status ?? 'in_progress' };
    }
    if (cur?.status === 'completed') throw conflict('You already completed this training');
    const b = z.object({ acknowledged: z.boolean().optional() }).parse(req.body ?? {});
    if (m.kind === 'policy' && !b.acknowledged) throw badRequest('Please confirm you have read and accept this policy');
    await q(`INSERT INTO training_progress (organization_id, module_id, worker_id, status, completed_at) VALUES ($1,$2,$3,'completed', now()) ON CONFLICT (module_id, worker_id) DO UPDATE SET status='completed', completed_at=now()`, [ctx.orgId, id, ctx.workerId]);
    await activity(ctx, 'worker', ctx.workerId, 'training', `Completed training: ${m.title}`, m.kind === 'policy' ? 'Policy acknowledged' : null);
    if (m.required) {
      const pl = await one<any>(`SELECT account_manager_id FROM placements WHERE worker_id=$1 AND organization_id=$2 AND status IN ('active','onboarding','on_leave') ORDER BY start_date DESC LIMIT 1`, [ctx.workerId, ctx.orgId]);
      await notify(ctx.orgId, [pl?.account_manager_id, ...(await usersWithRoles(ctx.orgId, ['hr']))], { event: 'training.completed', title: `${ctx.user.name} completed "${m.title}"`, body: 'Required training', link: `/workforce/workers/${ctx.workerId}` });
    }
    return { ok: true, status: 'completed' };
  });
}
