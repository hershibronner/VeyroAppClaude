// Production start helper: seeds the demo data only when the database has no organizations yet.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './index';

const pool = createPool(1);
const { rows } = await pool.query('SELECT count(*)::int n FROM organizations');
await pool.end();
if (rows[0].n > 0) { console.log(`database already has ${rows[0].n} organization(s) — skipping seed`); process.exit(0); }
console.log('empty database — seeding demo data');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('pnpm', ['seed'], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
