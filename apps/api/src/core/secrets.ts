// Encryption for per-workspace provider credentials (AES-256-GCM) and signed OAuth `state` values.
// INTEGRATIONS_ENCRYPTION_KEY: 32 random bytes as base64 or hex (`openssl rand -base64 32`). Required in production;
// local dev falls back to a fixed key so connecting test accounts works out of the box.
import crypto from 'node:crypto';
import { IS_PROD } from './env';
import { HttpError } from './errors';

function key(): Buffer {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    if (IS_PROD) throw new HttpError(503, 'Integrations are not set up on this server yet (INTEGRATIONS_ENCRYPTION_KEY is missing)');
    return crypto.createHash('sha256').update('veyro-local-dev-integrations-key').digest();
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new HttpError(503, 'INTEGRATIONS_ENCRYPTION_KEY must be 32 bytes (base64 or hex)');
  return buf;
}

export function encryptionReady() { try { key(); return true; } catch { return false; } }

/** Encrypts a JSON value → "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
export function decryptJson<T = any>(enc: string): T {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1') throw new Error('Unknown credential format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
}

/** Short-lived signed state for OAuth redirects (binds the callback to the workspace + user that started it). */
export function signState(data: Record<string, unknown>, ttlSec = 900): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSec, n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  const mac = crypto.createHmac('sha256', key()).update(`state.${body}`).digest('base64url');
  return `${body}.${mac}`;
}
export function verifyState<T = Record<string, any>>(state: string): T | null {
  const [body, mac] = String(state ?? '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', key()).update(`state.${body}`).digest('base64url');
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return data.exp > Date.now() / 1000 ? data : null;
}
