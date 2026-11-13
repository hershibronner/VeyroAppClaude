import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import crypto from 'node:crypto';
import { resolveCtx, type Ctx } from './core/context';
import { HttpError } from './core/errors';
import { IS_PROD } from './core/env';
import { one, q } from './core/db';
import { rateLimit } from './core/ratelimit';
import authRoutes from './core/routes-auth';
import coreRoutes from './core/routes-core';
import { startQueue } from './jobs/queue';
import './core/events';

// Optional local secrets (e.g. ANTHROPIC_API_KEY) from apps/api/.env or the repo-root .env — both gitignored.
for (const f of ['../.env', '../../../.env']) { const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), f); if (fs.existsSync(p)) try { process.loadEnvFile(p); } catch {} }
const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 4100);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' }, bodyLimit: 30 * 1024 * 1024, trustProxy: true });
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 60 * 1024 * 1024, files: 5 } });

// Security headers on every response in production.
if (IS_PROD) app.addHook('onSend', async (_req, reply) => {
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
});

// Private beta gate: when SITE_PASSWORD is set, every request needs it (browser sign-in prompt, any username).
// Wrong guesses are limited to 20 per IP per 15 minutes.
const SITE_PASSWORD = process.env.SITE_PASSWORD;
const gateFails = new Map<string, { n: number; until: number }>();
if (SITE_PASSWORD) {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    if (req.url === '/healthz' || req.url.startsWith('/api/v1/webhooks/')) return;
    const f = gateFails.get(req.ip);
    if (f && f.until > Date.now() && f.n >= 20) return reply.status(429).send('Too many wrong passwords — try again in 15 minutes');
    const [scheme, b64] = String(req.headers.authorization ?? '').split(' ');
    const pass = scheme === 'Basic' && b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    const ok = pass.length === SITE_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(SITE_PASSWORD));
    if (ok) return;
    if (pass) { const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 15 * 60_000 }; cur.n++; gateFails.set(req.ip, cur); }
    return reply.status(401).header('WWW-Authenticate', 'Basic realm="VeyroApp beta", charset="UTF-8"').send('Password required');
  });
} else if (IS_PROD) console.warn('⚠ SITE_PASSWORD is not set — the deployed site is publicly reachable.');
app.get('/healthz', async () => ({ ok: true }));

app.decorateRequest('ctx', null);
app.addHook('onRequest', async (req) => {
  if (!req.url.startsWith('/api/')) return;
  const authz = String(req.headers.authorization ?? '');
  if (authz.startsWith('Bearer vk_')) {
    // Public API key → acts as the key creator within the key's organization.
    const hash = crypto.createHash('sha256').update(authz.slice(7)).digest('hex');
    const key = await one<any>(`SELECT * FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL`, [hash]);
    if (!key) throw new HttpError(401, 'Invalid API key');
    await rateLimit(`apikey:${key.id}`, 120, 60);
    q(`UPDATE api_keys SET last_used_at=now() WHERE id=$1`, [key.id]).catch(() => {});
    const sid = await one<any>(`SELECT id FROM sessions WHERE user_id=$1 AND active_organization_id=$2 AND user_agent='api-key' AND revoked_at IS NULL AND expires_at > now() LIMIT 1`, [key.created_by, key.organization_id]);
    let id = sid?.id;
    if (!id) { id = 'apikey_' + crypto.randomBytes(16).toString('hex'); await q(`INSERT INTO sessions (id, user_id, active_organization_id, csrf_token, user_agent, expires_at) VALUES ($1,$2,$3,'api','api-key', now() + interval '1 day')`, [id, key.created_by, key.organization_id]); }
    (req.cookies as any).vsid = id;
    (req as any).apiKey = true;
  }
  req.ctx = await resolveCtx(req);
});
// CSRF: mutating requests from a browser session must echo the session's CSRF token.
app.addHook('preHandler', async (req) => {
  if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if ((req as any).apiKey || !req.ctx) return;
  if (req.headers['x-csrf-token'] !== req.ctx.csrf) throw new HttpError(403, 'Security token expired — refresh the page and try again');
});
app.addHook('preHandler', async (req) => {
  if (!req.url.startsWith('/api/')) return;
  const cfg = (req.routeOptions?.config ?? {}) as { public?: boolean };
  if (!cfg.public && !req.ctx) throw new HttpError(401, 'Please sign in');
});

app.setErrorHandler((err: any, req, reply) => {
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const i of err.issues) fields[i.path.join('.') || '_'] = i.message;
    return reply.status(400).send({ error: 'Please check the highlighted fields', fields });
  }
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
  if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
  if (err?.code === '22P02') return reply.status(404).send({ error: 'Not found' });
  if (err?.code === '23505') return reply.status(409).send({ error: 'This already exists', details: err.detail });
  req.log.error(err);
  console.error(err);
  return reply.status(500).send({ error: 'Something went wrong on our side. The error was logged.' });
});

await app.register(authRoutes);
await app.register(coreRoutes);

// Domain modules: each file in ./modules exports `default async function (app)`. A failing module is
// logged and skipped so one broken module never takes down the whole API.
const modDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'modules');
const loaded: string[] = [];
for (const f of fs.readdirSync(modDir).filter(f => /\.(ts|js)$/.test(f) && !f.startsWith('_')).sort()) {
  try {
    const mod = await import(path.join(modDir, f));
    if (typeof mod.default === 'function') { await app.register(mod.default); loaded.push(f.replace(/\.\w+$/, '')); }
  } catch (e: any) { console.error(`✖ module ${f} failed to load:`, e?.stack ?? e); }
}

// Production: serve the built web app (apps/web/dist) from the same origin, with SPA fallback.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (fs.existsSync(path.join(webDist, 'index.html'))) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false });
  app.setNotFoundHandler((req, reply) => {
    // A missing /assets/ chunk (old hash after a deploy) must 404, not get index.html back as JavaScript.
    if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/files/') || req.url.startsWith('/assets/')) return reply.status(404).send({ error: 'Not found' });
    // Never cache index.html, so a new deploy's chunk names are picked up on the next load.
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
}

startQueue();
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`VeyroApp API on http://localhost:${PORT} — modules: ${loaded.join(', ') || '(none)'}`);
export type { Ctx };
