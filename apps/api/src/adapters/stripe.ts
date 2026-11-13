// Real Stripe, via Stripe Connect (Standard accounts, OAuth). Each agency connects its own Stripe account; the platform
// acts on it with the platform secret key + the `Stripe-Account` header, so card data never touches VeyroApp (clients pay
// on Stripe Checkout). Platform env (set on the server, never per agency):
//   STRIPE_SECRET_KEY         platform secret key (sk_live_… / sk_test_…)
//   STRIPE_CONNECT_CLIENT_ID  ca_… from Stripe Dashboard → Connect → Settings (OAuth)
//   STRIPE_WEBHOOK_SECRET     whsec_… of the Connect webhook endpoint → <site>/api/v1/webhooks/stripe
import crypto from 'node:crypto';
import { one, q, type Db, pool } from '../core/db';
import { HttpError } from '../core/errors';
import { encryptJson } from '../core/secrets';

const API_VERSION = '2024-06-20';
const apiBase = () => process.env.STRIPE_API_BASE ?? 'https://api.stripe.com';
const connectBase = () => process.env.STRIPE_CONNECT_BASE ?? 'https://connect.stripe.com';

export function stripePlatform() {
  const secret = process.env.STRIPE_SECRET_KEY?.trim(); const clientId = process.env.STRIPE_CONNECT_CLIENT_ID?.trim();
  if (!secret || !clientId) return null;
  return { secret, clientId, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || null, testMode: /^(sk|rk)_test_/.test(secret) };
}
function platformOrThrow() {
  const p = stripePlatform();
  if (!p) throw new HttpError(503, 'Stripe is not set up on this server yet');
  return p;
}

export class StripeError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

/** Stripe's form encoding: nested objects → a[b][c]=v, arrays → a[0]=v. */
function encode(obj: Record<string, unknown>, out = new URLSearchParams(), prefix = ''): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === 'object' ? encode(x as any, out, `${name}[${i}]`) : out.append(`${name}[${i}]`, String(x)));
    else if (typeof v === 'object') encode(v as any, out, name);
    else out.append(name, String(v));
  }
  return out;
}

async function call<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, o: { params?: Record<string, unknown>; account?: string; idempotencyKey?: string; base?: string } = {}): Promise<T> {
  const p = platformOrThrow();
  const url = new URL(path, o.base ?? apiBase());
  const body = o.params ? encode(o.params) : undefined;
  if (method === 'GET' && body) url.search = body.toString();
  const headers: Record<string, string> = { authorization: `Bearer ${p.secret}`, 'stripe-version': API_VERSION, 'content-type': 'application/x-www-form-urlencoded' };
  if (o.account) headers['stripe-account'] = o.account;
  if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
  let res: Response;
  try { res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : body?.toString(), signal: AbortSignal.timeout(20_000) }); }
  catch (e: any) { throw new StripeError(`Could not reach Stripe (${e?.cause?.code ?? e?.message ?? e})`, 502); }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(json?.error?.message ?? json?.error_description ?? `Stripe returned ${res.status}`, res.status, json?.error?.code ?? (typeof json?.error === 'string' ? json.error : undefined));
  return json;
}

// ── OAuth ──
export function authorizeUrl(state: string, redirectUri: string) {
  const u = new URL('/oauth/authorize', connectBase());
  u.search = new URLSearchParams({ response_type: 'code', client_id: platformOrThrow().clientId, scope: 'read_write', state, redirect_uri: redirectUri }).toString();
  return u.toString();
}
export const exchangeCode = (code: string) => call<{ stripe_user_id: string; access_token?: string; refresh_token?: string; scope?: string; livemode: boolean; stripe_publishable_key?: string }>('POST', '/oauth/token', { base: connectBase(), params: { grant_type: 'authorization_code', code } });
export const deauthorize = (accountId: string) => call('POST', '/oauth/deauthorize', { base: connectBase(), params: { client_id: platformOrThrow().clientId, stripe_user_id: accountId } });

// ── Connected-account calls ──
export const getAccount = (account: string) => call<any>('GET', '/v1/account', { account });
export const accountName = (a: any) => a?.business_profile?.name || a?.settings?.dashboard?.display_name || a?.email || a?.id;
export const createCheckoutSession = (account: string, params: Record<string, unknown>, idempotencyKey: string) => call<any>('POST', '/v1/checkout/sessions', { account, params, idempotencyKey });
export const getCheckoutSession = (account: string, id: string) => call<any>('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`, { account, params: { expand: ['payment_intent.latest_charge'] } });
export const listCompletedCheckoutSessions = (account: string, createdGte: number, startingAfter?: string) =>
  call<{ data: any[]; has_more: boolean }>('GET', '/v1/checkout/sessions', { account, params: { limit: 100, status: 'complete', created: { gte: createdGte }, starting_after: startingAfter, expand: ['data.payment_intent.latest_charge'] } });
export const createRefund = (account: string, paymentIntent: string, amountCents: number, metadata: Record<string, string>, idempotencyKey: string) =>
  call<any>('POST', '/v1/refunds', { account, idempotencyKey, params: { payment_intent: paymentIntent, amount: amountCents, metadata } });

/** Verifies a `Stripe-Signature` header against the raw body and returns the parsed event. */
export function verifyWebhook(raw: Buffer | string, header: string | undefined, secret: string, toleranceSec = 300) {
  const parts = String(header ?? '').split(',').map(s => s.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) throw new StripeError('Missing Stripe signature', 400);
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) throw new StripeError('Stripe signature timestamp is too old', 400);
  const want = crypto.createHmac('sha256', secret).update(`${t}.${raw.toString()}`).digest('hex');
  if (!sigs.some(s => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)))) throw new StripeError('Invalid Stripe signature', 400);
  return JSON.parse(raw.toString());
}

// ── Stored connection (per workspace) ──
export interface StripeConnection { organization_id: string; external_account_id: string; account_name: string | null; livemode: boolean; created_at: string }
export async function stripeConnection(orgId: string, db: Db = pool): Promise<StripeConnection | null> {
  if (!stripePlatform()) return null;
  return one<StripeConnection>(`SELECT organization_id, external_account_id, account_name, livemode, created_at FROM integration_credentials WHERE organization_id=$1 AND integration_key='payments'`, [orgId], db);
}
export async function orgForAccount(accountId: string) {
  return (await one<{ organization_id: string }>(`SELECT organization_id FROM integration_credentials WHERE integration_key='payments' AND external_account_id=$1`, [accountId]))?.organization_id ?? null;
}
export async function saveConnection(orgId: string, tok: Awaited<ReturnType<typeof exchangeCode>>, name: string | null, userId: string | null) {
  const taken = await one<any>(`SELECT organization_id FROM integration_credentials WHERE integration_key='payments' AND external_account_id=$1`, [tok.stripe_user_id]);
  if (taken && taken.organization_id !== orgId) throw new HttpError(409, 'This Stripe account is already connected to another workspace');
  const secret = encryptJson({ access_token: tok.access_token ?? null, refresh_token: tok.refresh_token ?? null, scope: tok.scope ?? null, publishable_key: tok.stripe_publishable_key ?? null });
  await q(`INSERT INTO integration_credentials (organization_id, integration_key, external_account_id, account_name, livemode, secret_enc, connected_by) VALUES ($1,'payments',$2,$3,$4,$5,$6)
    ON CONFLICT (organization_id, integration_key) DO UPDATE SET external_account_id=$2, account_name=$3, livemode=$4, secret_enc=$5, connected_by=$6, updated_at=now()`, [orgId, tok.stripe_user_id, name, tok.livemode, secret, userId]);
}
export async function deleteConnection(orgId: string) {
  await q(`DELETE FROM integration_credentials WHERE organization_id=$1 AND integration_key='payments'`, [orgId]);
}
