import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { ensureOrgDefaults } from '@veyro/db';
import { one, q, tx } from './db';
import { auth, resolveCtx, SESSION_COOKIE, type Ctx } from './context';
import { badRequest, forbidden, notFound, unauthorized, conflict } from './errors';
import { audit } from './audit';
import { rateLimit } from './ratelimit';
import { IS_PROD } from './env';
import { sendTemplate } from '../adapters/messaging';
import { notifyPlatform } from '../modules/_admin/common';
import { WEB_URL } from './settings';
import { signedUrl } from './storage';

const SESSION_DAYS = 14;
const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: IS_PROD, maxAge: SESSION_DAYS * 86400 };

export async function createSession(reply: FastifyReply, req: FastifyRequest, userId: string, orgId: string | null, opts: { mfaPending?: boolean; impersonatorId?: string; reason?: string } = {}) {
  const id = crypto.randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions (id, user_id, active_organization_id, csrf_token, mfa_pending, impersonator_user_id, impersonation_reason, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + interval '${SESSION_DAYS} days')`,
    [id, userId, orgId, crypto.randomBytes(24).toString('base64url'), !!opts.mfaPending, opts.impersonatorId ?? null, opts.reason ?? null, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)]);
  reply.setCookie(SESSION_COOKIE, id, cookieOpts);
  return id;
}

/** Everything the web app needs to render the shell for the active workspace. */
export async function mePayload(ctx: Ctx) {
  const memberships = await q<any>(`SELECT m.organization_id id, o.name, o.slug, r.key role_key, r.name role_name, r.kind role_kind, b.logo_text, b.primary_color, b.accent_color, b.logo_file
    FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id JOIN roles r ON r.id=m.role_id LEFT JOIN organization_branding b ON b.organization_id=o.id
    WHERE m.user_id=$1 AND m.status='active' AND o.status <> 'deleted' ORDER BY o.name`, [ctx.userId]);
  const branding = ctx.orgId ? await one<any>(`SELECT * FROM organization_branding WHERE organization_id=$1`, [ctx.orgId]) : null;
  const flags = ctx.orgId ? Object.fromEntries((await q<any>(`SELECT key, enabled FROM feature_flags WHERE organization_id=$1`, [ctx.orgId])).map(f => [f.key, f.enabled])) : {};
  const sub = ctx.orgId ? await one<any>(`SELECT s.*, p.name plan_name FROM subscriptions s JOIN plans p ON p.key=s.plan_key WHERE organization_id=$1`, [ctx.orgId]) : null;
  const u = await one<any>(`SELECT id, name, email, phone, avatar_color, avatar_file, mfa_enabled FROM users WHERE id=$1`, [ctx.userId]);
  const impersonator = ctx.impersonatorId ? await one<any>(`SELECT name, email FROM users WHERE id=$1`, [ctx.impersonatorId]) : null;
  const approval = ctx.orgId ? await one<any>(`SELECT o.approval_status status, a.submitted_at, a.rejection_reason, a.logo_file IS NOT NULL has_logo, a.registration_file IS NOT NULL has_registration, (a.organization_id IS NOT NULL) self_serve
    FROM organizations o LEFT JOIN agency_applications a ON a.organization_id=o.id WHERE o.id=$1`, [ctx.orgId]) : null;
  const personalLink = ctx.role.kind === 'agency' && ctx.orgId ? await one<any>(`SELECT token FROM sourcing_links WHERE organization_id=$1 AND user_id=$2 AND position_id IS NULL AND active ORDER BY created_at LIMIT 1`, [ctx.orgId, ctx.userId]) : null;
  return {
    user: { ...u, avatar_url: signedUrl(u?.avatar_file, 86400) },
    csrf: ctx.csrf,
    isPlatformAdmin: ctx.isPlatformAdmin,
    impersonator,
    memberships: memberships.map(m => ({ ...m, logo_url: signedUrl(m.logo_file, 86400) })),
    workspace: ctx.orgId ? {
      org: ctx.org, role: ctx.role, recruitingScope: ctx.recruitingScope, team: ctx.team, perms: ctx.perms,
      companyId: ctx.companyId, workerId: ctx.workerId, candidateId: ctx.candidateId,
      branding: branding ? { ...branding, logo_url: signedUrl(branding.logo_file, 86400) } : null, flags,
      subscription: sub ? { plan: sub.plan_key, plan_name: sub.plan_name, status: sub.status, comped: sub.comped, trial_ends_at: sub.trial_ends_at } : null,
      personalLinkToken: personalLink?.token ?? null,
      approval,
    } : null,
  };
}

function slugify(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agency'; }
async function uniqueSlug(name: string) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) { const s = i ? `${base}-${i + 1}` : base; if (!(await one(`SELECT 1 FROM organizations WHERE slug=$1`, [s]))) return s; }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function createAgency(ownerId: string, name: string, c?: any) {
  const run = async (db: any) => {
    const slug = await uniqueSlug(name);
    const org = (await db.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING *`, [name, slug])).rows[0];
    const roles = await ensureOrgDefaults(db, org.id, { ownerId });
    await db.query(`UPDATE organization_branding SET logo_text=$2, email_sender_name=$2 WHERE organization_id=$1`, [org.id, name]);
    await db.query(`INSERT INTO organization_memberships (organization_id, user_id, role_id) VALUES ($1,$2,$3)`, [org.id, ownerId, roles.owner]);
    await db.query(`INSERT INTO subscriptions (organization_id, plan_key, status, trial_ends_at) VALUES ($1,'trial','trialing', now() + interval '14 days')`, [org.id]);
    for (const k of ['ai_matching', 'screenshots', 'client_portal', 'worker_portal', 'automation', 'report_builder', 'public_api']) await db.query(`INSERT INTO feature_flags (organization_id, key, enabled) VALUES ($1,$2,true)`, [org.id, k]);
    await db.query(`INSERT INTO feature_flags (organization_id, key, enabled) VALUES ($1,'white_label',false)`, [org.id]);
    await db.query(`INSERT INTO sourcing_links (organization_id, user_id, token, label) VALUES ($1,$2,$3,'Personal link')`, [org.id, ownerId, crypto.randomBytes(7).toString('base64url')]);
    return org;
  };
  return c ? run(c) : tx(run);
}

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    await rateLimit(`login:${req.ip}`, 30, 300);
    await rateLimit(`login:${body.email.toLowerCase()}`, 10, 300);
    const u = await one<any>(`SELECT * FROM users WHERE lower(email)=lower($1)`, [body.email]);
    if (!u || !u.password_hash || !(await bcrypt.compare(body.password, u.password_hash))) throw unauthorized('Incorrect email or password');
    const m = await one<any>(`SELECT m.organization_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=$1 AND m.status='active' ORDER BY (r.kind='agency') DESC, m.created_at LIMIT 1`, [u.id]);
    const isPlatform = await one(`SELECT 1 FROM platform_admins WHERE user_id=$1 AND status='active'`, [u.id]);
    if (!m && !isPlatform) throw forbidden('Your account has no active workspace. Ask your agency to re-invite you.');
    if (u.mfa_enabled) {
      await createSession(reply, req, u.id, m?.organization_id ?? null, { mfaPending: true });
      const code = String(crypto.randomInt(100000, 999999));
      await q(`INSERT INTO mfa_codes (user_id, code, expires_at) VALUES ($1,$2, now() + interval '10 minutes')`, [u.id, code]);
      await sendTemplate(m?.organization_id ?? null, 'mfa_code', u.email, { code });
      return { mfaRequired: true };
    }
    await createSession(reply, req, u.id, m?.organization_id ?? null);
    await q(`UPDATE users SET last_login_at=now() WHERE id=$1`, [u.id]);
    await audit({ orgId: m?.organization_id ?? '', userId: u.id, user: u, impersonatorId: null, ip: req.ip }, 'auth.login', { type: 'user', id: u.id, label: u.email });
    return { ok: true };
  });

  app.post('/api/v1/auth/mfa', { config: { public: true } }, async (req) => {
    const { code } = z.object({ code: z.string().min(6).max(6) }).parse(req.body);
    const sid = req.cookies?.[SESSION_COOKIE];
    if (!sid) throw unauthorized();
    await rateLimit(`mfa:${sid}`, 8, 300);
    const s = await one<any>(`SELECT * FROM sessions WHERE id=$1 AND mfa_pending AND revoked_at IS NULL`, [sid]);
    if (!s) throw unauthorized();
    const c = await one<any>(`SELECT id FROM mfa_codes WHERE user_id=$1 AND code=$2 AND used_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`, [s.user_id, code]);
    if (!c) throw badRequest('That code is incorrect or expired');
    await q(`UPDATE mfa_codes SET used_at=now() WHERE id=$1`, [c.id]);
    await q(`UPDATE sessions SET mfa_pending=false WHERE id=$1`, [sid]);
    return { ok: true };
  });

  app.post('/api/v1/auth/logout', { config: { public: true } }, async (req, reply) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) {
      const s = await one<any>(`SELECT * FROM sessions WHERE id=$1`, [sid]);
      if (s?.impersonator_user_id) await q(`UPDATE impersonation_sessions SET ended_at=now() WHERE session_id=$1 AND ended_at IS NULL`, [sid]);
      await q(`UPDATE sessions SET revoked_at=now() WHERE id=$1`, [sid]);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/auth/me', { config: { public: true } }, async (req) => {
    if (!req.ctx) return { user: null }; // anonymous probe: not an error
    return mePayload(req.ctx);
  });

  app.post('/api/v1/auth/switch', async (req) => {
    if (!req.ctx) throw unauthorized();
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(req.body);
    const m = await one<any>(`SELECT m.id, o.name FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='active'`, [req.ctx.userId, organizationId]);
    if (!m) throw notFound();
    const from = req.ctx.org;
    await q(`UPDATE sessions SET active_organization_id=$2 WHERE id=$1`, [req.ctx.sessionId, organizationId]);
    await audit(req.ctx, 'workspace.switched_out', { type: 'organization', id: from.id, label: from.name }, null, { to: m.name });
    const ctx = await resolveCtx(req);
    await audit(ctx!, 'workspace.switched_in', { type: 'organization', id: organizationId, label: m.name }, { from: from.name }, null);
    return mePayload(ctx!);
  });

  // Self-serve sign-up: creates the owner + agency in "pending" state. A VeyroApp platform admin approves it
  // (Platform → Agencies); until then the owner only sees the pending-approval screen.
  app.post('/api/v1/auth/register', { config: { public: true } }, async (req, reply) => {
    const opt = (max: number) => z.string().trim().max(max).optional().nullable().transform(v => v || null);
    const b = z.object({
      agencyName: z.string().trim().min(2, 'Enter your business name').max(80), name: z.string().trim().min(2, 'Enter your name').max(80), email: z.string().trim().email('Enter a valid email'), password: z.string().min(8, 'Use at least 8 characters').max(200),
      phone: opt(40), website: opt(200), country: opt(80), team_size: opt(40), active_workers: opt(40), industries: z.array(z.string().max(60)).max(20).default([]),
      previous_software: opt(80), heard_from: opt(120), legal_name: opt(160), registration_number: opt(80),
    }).parse(req.body);
    await rateLimit(`register:${req.ip}`, 10, 3600);
    if (await one(`SELECT 1 FROM users WHERE lower(email)=lower($1)`, [b.email])) throw conflict('An account with this email already exists. Sign in, then use "Create another agency".');
    const org = await tx(async (c) => {
      const u = (await c.query(`INSERT INTO users (email, name, password_hash, phone, avatar_color) VALUES ($1,$2,$3,$4,'#345CFF') RETURNING *`, [b.email.toLowerCase(), b.name, await bcrypt.hash(b.password, 10), b.phone])).rows[0];
      const o = await createAgency(u.id, b.agencyName, c);
      await c.query(`UPDATE organizations SET approval_status='pending' WHERE id=$1`, [o.id]);
      await c.query(`INSERT INTO agency_applications (organization_id, applicant_user_id, phone, website, country, team_size, active_workers, industries, previous_software, heard_from, legal_name, registration_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [o.id, u.id, b.phone, b.website, b.country, b.team_size, b.active_workers, b.industries, b.previous_software, b.heard_from, b.legal_name, b.registration_number]);
      return { ...o, userId: u.id };
    });
    await createSession(reply, req, org.userId, org.id);
    await audit({ orgId: org.id, userId: org.userId, user: { name: b.name } as any, impersonatorId: null, ip: req.ip }, 'organization.created', { type: 'organization', id: org.id, label: org.name });
    await sendTemplate(null, 'agency_application_received', b.email, { user: { name: b.name }, agency: { name: b.agencyName } }).catch(() => {});
    await notifyPlatform(`New agency application: ${b.agencyName}`, `${b.name} · ${b.email}${b.country ? ` · ${b.country}` : ''}`, '/platform/agencies?tab=applications', 'agency.applied').catch(() => {});
    return { ok: true, slug: org.slug, pending: true };
  });

  app.post('/api/v1/auth/create-agency', async (req) => {
    const ctx = auth(req);
    if (!['owner', 'admin'].includes(ctx.role.key)) throw forbidden('Only owners and admins can create another agency');
    const { name } = z.object({ name: z.string().min(2).max(80) }).parse(req.body);
    const org = await createAgency(ctx.userId, name);
    await audit({ ...ctx, orgId: org.id }, 'organization.created', { type: 'organization', id: org.id, label: org.name });
    return org;
  });

  app.post('/api/v1/auth/forgot', { config: { public: true } }, async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    await rateLimit(`forgot:${req.ip}`, 10, 600);
    const u = await one<any>(`SELECT * FROM users WHERE lower(email)=lower($1)`, [email]);
    if (u) {
      const token = crypto.randomBytes(24).toString('base64url');
      await q(`INSERT INTO password_resets (token, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [token, u.id]);
      await sendTemplate(null, 'password_reset', u.email, { user: { name: u.name }, link: `${WEB_URL}/reset-password?token=${token}` });
    }
    return { ok: true }; // never reveal whether the email exists
  });

  app.post('/api/v1/auth/reset', { config: { public: true } }, async (req) => {
    const b = z.object({ token: z.string().min(10), password: z.string().min(8, 'Use at least 8 characters') }).parse(req.body);
    const r = await one<any>(`SELECT * FROM password_resets WHERE token=$1 AND used_at IS NULL AND expires_at > now()`, [b.token]);
    if (!r) throw badRequest('This reset link is invalid or has expired');
    await q(`UPDATE users SET password_hash=$2 WHERE id=$1`, [r.user_id, await bcrypt.hash(b.password, 10)]);
    await q(`UPDATE password_resets SET used_at=now() WHERE token=$1`, [b.token]);
    await q(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [r.user_id]);
    return { ok: true };
  });

  app.get('/api/v1/auth/invitations/:token', { config: { public: true } }, async (req) => {
    const { token } = req.params as { token: string };
    const inv = await one<any>(`SELECT i.email, i.name, i.status, i.expires_at, r.name role_name, r.kind role_kind, o.name org_name, b.logo_text, b.primary_color, b.accent_color, (SELECT 1 FROM users u WHERE lower(u.email)=lower(i.email)) existing
      FROM invitations i JOIN roles r ON r.id=i.role_id JOIN organizations o ON o.id=i.organization_id LEFT JOIN organization_branding b ON b.organization_id=o.id WHERE i.token=$1`, [token]);
    if (!inv) throw notFound('Invitation not found');
    const expired = new Date(inv.expires_at) < new Date();
    return { ...inv, existing: !!inv.existing, status: inv.status === 'pending' && expired ? 'expired' : inv.status };
  });

  app.post('/api/v1/auth/invitations/:token/accept', { config: { public: true } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const b = z.object({ name: z.string().min(2).optional(), password: z.string().min(8, 'Use at least 8 characters') }).parse(req.body);
    const inv = await one<any>(`SELECT * FROM invitations WHERE token=$1`, [token]);
    if (!inv || inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) throw badRequest('This invitation is no longer valid');
    const userId = await tx(async (c) => {
      let u = (await c.query(`SELECT * FROM users WHERE lower(email)=lower($1)`, [inv.email])).rows[0];
      if (u) { if (!(await bcrypt.compare(b.password, u.password_hash ?? ''))) throw unauthorized('This email already has an account — enter its current password to accept'); }
      else u = (await c.query(`INSERT INTO users (email, name, password_hash, avatar_color) VALUES ($1,$2,$3,'#7044FF') RETURNING *`, [inv.email.toLowerCase(), b.name ?? inv.name ?? inv.email, await bcrypt.hash(b.password, 10)])).rows[0];
      await c.query(`INSERT INTO organization_memberships (organization_id, user_id, role_id, company_id, worker_id, candidate_id) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (organization_id, user_id) DO UPDATE SET role_id=EXCLUDED.role_id, status='active', company_id=COALESCE(EXCLUDED.company_id, organization_memberships.company_id), worker_id=COALESCE(EXCLUDED.worker_id, organization_memberships.worker_id), candidate_id=COALESCE(EXCLUDED.candidate_id, organization_memberships.candidate_id)`,
        [inv.organization_id, u.id, inv.role_id, inv.company_id, inv.worker_id, inv.candidate_id]);
      if (inv.worker_id) await c.query(`UPDATE workers SET user_id=$1 WHERE id=$2`, [u.id, inv.worker_id]);
      if (inv.candidate_id) await c.query(`UPDATE candidates SET user_id=$1 WHERE id=$2`, [u.id, inv.candidate_id]);
      await c.query(`UPDATE invitations SET status='accepted', accepted_at=now() WHERE id=$1`, [inv.id]);
      return u.id as string;
    });
    await createSession(reply, req, userId, inv.organization_id);
    await audit({ orgId: inv.organization_id, userId, user: { name: inv.email } as any, impersonatorId: null, ip: req.ip }, 'invitation.accepted', { type: 'invitation', id: inv.id, label: inv.email });
    return { ok: true };
  });

  app.get('/api/v1/auth/sessions', async (req) => {
    if (!req.ctx) throw unauthorized();
    const rows = await q<any>(`SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [req.ctx.userId]);
    return rows.map(r => ({ ...r, id: r.id.slice(0, 8), current: r.id === req.ctx!.sessionId }));
  });
  app.post('/api/v1/auth/sessions/revoke-others', async (req) => {
    if (!req.ctx) throw unauthorized();
    const r = await q(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id <> $2 AND revoked_at IS NULL RETURNING id`, [req.ctx.userId, req.ctx.sessionId]);
    await audit(req.ctx, 'auth.sessions_revoked', { type: 'user', id: req.ctx.userId }, null, { count: r.length });
    return { revoked: r.length };
  });

  app.patch('/api/v1/me/profile', async (req) => {
    if (!req.ctx) throw unauthorized();
    const b = z.object({ name: z.string().min(2).optional(), phone: z.string().max(40).nullable().optional(), currentPassword: z.string().optional(), newPassword: z.string().min(8).optional(), mfaEnabled: z.boolean().optional() }).parse(req.body);
    if (b.newPassword) {
      const u = await one<any>(`SELECT password_hash FROM users WHERE id=$1`, [req.ctx.userId]);
      if (!(await bcrypt.compare(b.currentPassword ?? '', u.password_hash))) throw badRequest('Current password is incorrect');
      await q(`UPDATE users SET password_hash=$2 WHERE id=$1`, [req.ctx.userId, await bcrypt.hash(b.newPassword, 10)]);
      await audit(req.ctx, 'user.password_changed', { type: 'user', id: req.ctx.userId });
    }
    await q(`UPDATE users SET name=COALESCE($2,name), phone=CASE WHEN $3::boolean THEN $4 ELSE phone END, mfa_enabled=COALESCE($5, mfa_enabled), updated_at=now() WHERE id=$1`, [req.ctx.userId, b.name ?? null, b.phone !== undefined, b.phone ?? null, b.mfaEnabled ?? null]);
    if (b.mfaEnabled !== undefined) await audit(req.ctx, b.mfaEnabled ? 'user.mfa_enabled' : 'user.mfa_disabled', { type: 'user', id: req.ctx.userId });
    return mePayload(req.ctx);
  });
}
