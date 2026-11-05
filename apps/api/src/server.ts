import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import crypto from 'node:crypto';
import { resolveCtx, type Ctx } from './core/context';
import { HttpError } from './core/errors';
import { one, q } from './core/db';
import { rateLimit } from './core/ratelimit';
import authRoutes from './core/routes-auth';
import coreRoutes from './core/routes-core';
import { startQueue } from './jobs/queue';
import './core/events';

const PORT = Number(process.env.API_PORT ?? 4100);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' }, bodyLimit: 30 * 1024 * 1024, trustProxy: true });
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 60 * 1024 * 1024, files: 5 } });

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

startQueue();
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`VeyroApp API on http://localhost:${PORT} — modules: ${loaded.join(', ') || '(none)'}`);
export type { Ctx };
