// "Continue with Google" — OAuth 2.0 authorization-code flow, no SDK. Needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET;
// the Google OAuth client must list `${WEB_URL}/api/v1/auth/google/callback` as an authorized redirect URI.
//  • Existing account (matched by Google-verified email) → signed in (2FA still applies).
//  • New email → a verified sign-up token, then /register continues with name + email filled in and no password needed.
import type { FastifyInstance, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { one, q } from '../core/db';
import { rateLimit } from '../core/ratelimit';
import { IS_PROD } from '../core/env';
import { WEB_URL } from '../core/settings';
import { audit } from '../core/audit';
import { createSession } from '../core/routes-auth';
import { sendTemplate } from '../adapters/messaging';

const STATE_COOKIE = 'vg_state';
const clientId = () => process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET?.trim();
const enabled = () => !!(clientId() && clientSecret());
const redirectUri = () => `${WEB_URL.replace(/\/$/, '')}/api/v1/auth/google/callback`;
/** Only same-site paths are allowed as a post-login destination. */
const safeNext = (n?: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n.slice(0, 300) : '');

function fail(reply: FastifyReply, page: 'login' | 'register', message: string) {
  return reply.redirect(`/${page}?google_error=${encodeURIComponent(message)}`);
}

export default async function googleAuth(app: FastifyInstance) {
  app.get('/api/v1/auth/google/config', { config: { public: true } }, async () => ({ enabled: enabled() }));

  app.get('/api/v1/auth/google/start', { config: { public: true } }, async (req, reply) => {
    const qs = z.object({ intent: z.enum(['signin', 'signup']).default('signin'), next: z.string().optional() }).parse(req.query);
    if (!enabled()) return fail(reply, qs.intent === 'signup' ? 'register' : 'login', 'Google sign-in is not set up yet');
    await rateLimit(`google-start:${req.ip}`, 30, 600);
    const nonce = crypto.randomBytes(24).toString('base64url');
    reply.setCookie(STATE_COOKIE, JSON.stringify({ nonce, intent: qs.intent, next: safeNext(qs.next) }), { path: '/api/v1/auth/google', httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 600 });
    const p = new URLSearchParams({ client_id: clientId()!, redirect_uri: redirectUri(), response_type: 'code', scope: 'openid email profile', state: nonce, prompt: 'select_account' });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
  });

  app.get('/api/v1/auth/google/callback', { config: { public: true } }, async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    let st: { nonce: string; intent: 'signin' | 'signup'; next: string } | null = null;
    try { st = JSON.parse((req.cookies as any)?.[STATE_COOKIE] ?? 'null'); } catch { st = null; }
    reply.clearCookie(STATE_COOKIE, { path: '/api/v1/auth/google' });
    const page = st?.intent === 'signup' ? 'register' : 'login';
    if (qs.error) return fail(reply, page, qs.error === 'access_denied' ? 'Google sign-in was cancelled' : 'Google sign-in failed');
    if (!st || !qs.state || qs.state !== st.nonce || !qs.code) return fail(reply, page, 'Google sign-in expired — please try again');
    if (!enabled()) return fail(reply, page, 'Google sign-in is not set up yet');

    let profile: { sub: string; email: string; email_verified: boolean; name?: string; given_name?: string };
    try {
      const tok = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: qs.code, client_id: clientId()!, client_secret: clientSecret()!, redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
      }).then(r => r.json() as Promise<any>);
      if (!tok.access_token) throw new Error(tok.error_description || tok.error || 'no access token');
      profile = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } }).then(r => r.json() as Promise<any>);
      if (!profile?.email) throw new Error('no email');
    } catch (e: any) {
      req.log.warn({ err: e?.message }, 'google oauth exchange failed');
      return fail(reply, page, 'Google sign-in failed — please try again');
    }
    if (!profile.email_verified) return fail(reply, page, 'Your Google email is not verified');
    const email = profile.email.toLowerCase();

    const u = await one<any>(`SELECT * FROM users WHERE lower(email)=$1`, [email]);
    if (u) {
      const m = await one<any>(`SELECT m.organization_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=$1 AND m.status='active' ORDER BY (r.kind='agency') DESC, m.created_at LIMIT 1`, [u.id]);
      const isPlatform = await one(`SELECT 1 FROM platform_admins WHERE user_id=$1 AND status='active'`, [u.id]);
      if (!m && !isPlatform) return fail(reply, 'login', 'Your account has no active workspace. Ask your agency to re-invite you.');
      if (u.mfa_enabled) {
        await createSession(reply, req, u.id, m?.organization_id ?? null, { mfaPending: true });
        const code = String(crypto.randomInt(100000, 999999));
        await q(`INSERT INTO mfa_codes (user_id, code, expires_at) VALUES ($1,$2, now() + interval '10 minutes')`, [u.id, code]);
        await sendTemplate(m?.organization_id ?? null, 'mfa_code', u.email, { code });
        return reply.redirect(`/login?mfa=1${st.next ? `&next=${encodeURIComponent(st.next)}` : ''}`);
      }
      await createSession(reply, req, u.id, m?.organization_id ?? null);
      await q(`UPDATE users SET last_login_at=now(), email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1`, [u.id]);
      await audit({ orgId: m?.organization_id ?? '', userId: u.id, user: u, impersonatorId: null, ip: req.ip }, 'auth.login', { type: 'user', id: u.id, label: u.email }, null, { method: 'google' });
      return reply.redirect(st.next || '/');
    }

    // New person: hand the sign-up flow a pre-verified email (same token the 6-digit code would give).
    const token = crypto.randomBytes(24).toString('base64url');
    await q(`INSERT INTO email_verifications (email, code_hash, token, expires_at, verified_at, ip) VALUES ($1,'google',$2, now() + interval '2 hours', now(), $3)`, [email, token, req.ip]);
    const h = new URLSearchParams({ token, email, name: profile.name || profile.given_name || '' });
    return reply.redirect(`/register#google=1&${h}`);
  });
}
