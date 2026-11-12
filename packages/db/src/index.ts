import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://veyro:veyro@127.0.0.1:5433/veyro';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const STORAGE_DIR = process.env.STORAGE_DIR ?? path.join(REPO_ROOT, 'storage');

// Return int8/numeric as JS numbers (money is integer cents and fits safely in 2^53).
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => parseFloat(v));
// Keep DATE columns as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

export function createPool(max = 10) {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max });
  // An idle client dropped by the server (e.g. Postgres restarting) must not crash the process; the pool reconnects on next use.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}
export type { Pool, PoolClient } from 'pg';
export { pg };
export * from './orgDefaults';
