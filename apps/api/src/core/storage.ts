// StorageAdapter: local disk (./storage) with signed, expiring URLs. Permission is checked when signing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STORAGE_DIR } from '@veyro/db';
import { IS_PROD } from './env';

// In production never fall back to the published dev secret: use a per-process random key (signed links expire anyway).
const SECRET = process.env.FILE_SIGNING_SECRET ?? (IS_PROD ? crypto.randomBytes(32).toString('hex') : 'veyro-local-dev-signing-secret');

export function saveFile(subdir: string, filename: string, data: Buffer): string {
  const safe = filename.replace(/[^\w.\-]+/g, '_').slice(-80);
  const rel = path.posix.join(subdir, `${crypto.randomUUID()}-${safe}`);
  const abs = path.join(STORAGE_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return rel;
}
export function readFile(rel: string): Buffer { return fs.readFileSync(resolveSafe(rel)); }
export function deleteFile(rel: string) { try { fs.unlinkSync(resolveSafe(rel)); } catch { /* already gone */ } }
export function resolveSafe(rel: string): string {
  const abs = path.resolve(STORAGE_DIR, rel);
  if (!abs.startsWith(path.resolve(STORAGE_DIR) + path.sep)) throw new Error('Invalid path');
  return abs;
}
/** Signed URL valid for `ttlSec`. Only call after checking the viewer may access the file. */
export function signedUrl(rel: string | null | undefined, ttlSec = 900, opts: { download?: string } = {}): string | null {
  if (!rel) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', SECRET).update(`${rel}:${exp}`).digest('base64url');
  const dl = opts.download ? `&dl=${encodeURIComponent(opts.download)}` : '';
  return `/files/${rel.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sig}${dl}`;
}
export function verifySignature(rel: string, exp: string, sig: string): boolean {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(`${rel}:${exp}`).digest('base64url');
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
export const MIME: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', webm: 'video/webm', mp4: 'video/mp4', csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ics: 'text/calendar', json: 'application/json' };
