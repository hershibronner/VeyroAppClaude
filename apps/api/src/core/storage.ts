// StorageAdapter: local disk (./storage) with signed, expiring URLs. Permission is checked when signing.
// Every file is also copied into Postgres (stored_files): the disk on Railway is wiped by each deploy, so a missing file is restored from there.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STORAGE_DIR } from '@veyro/db';
import { IS_PROD } from './env';
import { q, one } from './db';

// In production never fall back to the published dev secret: use a per-process random key (signed links expire anyway).
const SECRET = process.env.FILE_SIGNING_SECRET ?? (IS_PROD ? crypto.randomBytes(32).toString('hex') : 'veyro-local-dev-signing-secret');

export function saveFile(subdir: string, filename: string, data: Buffer): string {
  const safe = filename.replace(/[^\w.\-]+/g, '_').slice(-80);
  const rel = path.posix.join(subdir, `${crypto.randomUUID()}-${safe}`);
  const abs = path.join(STORAGE_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  q(`INSERT INTO stored_files (path, data) VALUES ($1,$2) ON CONFLICT (path) DO UPDATE SET data=EXCLUDED.data`, [rel, data])
    .catch(e => console.error('[storage] durable copy failed:', rel, e.message));
  return rel;
}
export function readFile(rel: string): Buffer { return fs.readFileSync(resolveSafe(rel)); }
export function deleteFile(rel: string) {
  try { fs.unlinkSync(resolveSafe(rel)); } catch { /* already gone */ }
  q(`DELETE FROM stored_files WHERE path=$1`, [rel]).catch(() => {});
}
/** Makes sure the file is on local disk, restoring it from Postgres if a deploy wiped it. Returns the absolute path, or null. */
export async function ensureLocal(rel: string): Promise<string | null> {
  let abs: string;
  try { abs = resolveSafe(rel); } catch { return null; }
  if (fs.existsSync(abs)) return abs;
  const row = await one<{ data: Buffer }>(`SELECT data FROM stored_files WHERE path=$1`, [rel]);
  if (!row) return null;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, row.data);
  return abs;
}
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
