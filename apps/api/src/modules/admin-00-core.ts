// ADMIN + PLATFORM — root-level plumbing (registered without encapsulation):
//  • captures the Fastify route table (onRoute + printRoutes) for the auto-generated OpenAPI document
//  • API-key guards: read-only keys cannot write; a key only ever acts inside its own organization
//  • suspended workspaces (SaaS non-payment simulation) become read-only until billing is fixed
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one } from '../core/db';
import { HttpError } from '../core/errors';
import { sha256 } from './_admin/common';

type RouteInfo = { method: string; url: string; public: boolean };
const captured = new Map<string, RouteInfo>();
let appRef: FastifyInstance | null = null;

/** Parses `printRoutes()` tree output into flat method+url pairs (covers routes registered before this module). */
function parseRouteTree(tree: string): RouteInfo[] {
  const out: RouteInfo[] = [];
  const stack: string[] = [];
  for (const raw of tree.split('\n')) {
    if (!raw.trim()) continue;
    const idx = raw.search(/[^│├└─\s]/u);
    if (idx < 0) continue;
    const depth = Math.floor(idx / 4);
    const text = raw.slice(idx);
    const m = text.match(/^(.*?)(?: \(([A-Z, ]+)\))?$/);
    if (!m) continue;
    const seg = m[1];
    stack.length = depth;
    const parent = depth > 0 ? stack[depth - 1] ?? '' : '';
    const full = parent + seg;
    stack[depth] = full;
    if (m[2]) for (const meth of m[2].split(',').map(s => s.trim())) if (meth !== 'HEAD' && full.startsWith('/')) out.push({ method: meth, url: full, public: false });
  }
  return out;
}

export function routeTable(): RouteInfo[] {
  const all = new Map(captured);
  if (appRef) {
    try { for (const r of parseRouteTree(appRef.printRoutes({ commonPrefix: false }))) { const k = `${r.method} ${r.url}`; if (!all.has(k)) all.set(k, r); } } catch { /* tree unavailable before ready */ }
  }
  return [...all.values()].filter(r => r.url.startsWith('/api/')).sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
}

const suspendedCache = new Map<string, { at: number; suspended: boolean }>();
export function clearSuspendedCache(orgId?: string) { if (orgId) suspendedCache.delete(orgId); else suspendedCache.clear(); }
async function isSuspended(orgId: string) {
  const c = suspendedCache.get(orgId);
  if (c && Date.now() - c.at < 10_000) return c.suspended;
  const r = await one<any>(`SELECT status FROM subscriptions WHERE organization_id=$1`, [orgId]);
  const suspended = r?.status === 'suspended';
  suspendedCache.set(orgId, { at: Date.now(), suspended });
  return suspended;
}
const SUSPENSION_ALLOWED = ['/api/v1/auth/', '/api/v1/billing', '/api/v1/platform/', '/api/v1/support', '/api/v1/notifications', '/api/v1/exports/log'];

async function guard(req: FastifyRequest) {
  if (!req.url.startsWith('/api/')) return;
  const authz = String(req.headers.authorization ?? '');
  if ((req as any).apiKey && authz.startsWith('Bearer vk_')) {
    const key = await one<any>(`SELECT organization_id, scopes FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL`, [sha256(authz.slice(7))]);
    if (!key || !req.ctx || req.ctx.orgId !== key.organization_id) throw new HttpError(401, 'This API key is no longer valid for its workspace');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !(key.scopes ?? []).includes('write')) throw new HttpError(403, 'This API key is read-only');
    if (req.url.startsWith('/api/v1/api-keys') || req.url.startsWith('/api/v1/platform/')) throw new HttpError(403, 'API keys cannot manage API keys or the platform');
  }
  if (req.ctx?.orgId && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.ctx.impersonatorId && !SUSPENSION_ALLOWED.some(p => req.url.startsWith(p))) {
    if (await isSuspended(req.ctx.orgId)) throw new HttpError(402, 'This workspace is suspended for non-payment and is read-only. An owner can fix billing in Settings → Billing.');
  }
}

async function plugin(app: FastifyInstance) {
  appRef = app;
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) if (m !== 'HEAD') captured.set(`${m} ${r.url}`, { method: m, url: r.url, public: !!(r.config as any)?.public });
  });
  app.addHook('preHandler', guard);
}
(plugin as any)[Symbol.for('skip-override')] = true;
export default plugin;
