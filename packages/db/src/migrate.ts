import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './index';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const pool = createPool(1);
await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const applied = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
for (const f of files) {
  if (applied.has(f)) continue;
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    await c.query('COMMIT');
    console.log('migrated', f);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('migration failed', f, e);
    process.exit(1);
  } finally { c.release(); }
}
await pool.end();
