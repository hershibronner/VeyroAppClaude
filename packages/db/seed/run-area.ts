// Runs one area seed file (packages/db/seed/areas/<name>.ts) against the current database, idempotently.
// Usage: pnpm --filter @veyro/db exec tsx seed/run-area.ts <name>
import { createPool } from '../src/index';
const name = process.argv[2];
if (!name) { console.error('usage: run-area.ts <area>'); process.exit(1); }
const mod = await import(`./areas/${name}.ts`);
const pool = createPool(2);
const c = await pool.connect();
try {
  await c.query('BEGIN');
  await mod.default(c);
  await c.query('COMMIT');
  console.log(`area seed "${name}" applied`);
} catch (e) { await c.query('ROLLBACK'); console.error(e); process.exitCode = 1; } finally { c.release(); await pool.end(); }
