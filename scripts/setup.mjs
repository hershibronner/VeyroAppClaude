// One-shot local setup: start Postgres (Docker), wait for it, migrate, seed.
import { execSync } from 'node:child_process';
import net from 'node:net';
const run = (c) => execSync(c, { stdio: 'inherit' });
function waitPort(port, ms = 60000) {
  const end = Date.now() + ms;
  return new Promise((res, rej) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.end(); res(); });
      s.on('error', () => { if (Date.now() > end) rej(new Error('Postgres did not start')); else setTimeout(tryOnce, 500); });
    };
    tryOnce();
  });
}
run('docker compose up -d db');
await waitPort(5433);
for (let i = 0; i < 30; i++) {
  try { execSync('docker exec veyroapp-db pg_isready -U veyro', { stdio: 'ignore' }); break; } catch { await new Promise(r => setTimeout(r, 1000)); }
}
run('pnpm --filter @veyro/db reset');
console.log('\n✔ VeyroApp is set up. Run `pnpm dev` and open http://localhost:3100');
