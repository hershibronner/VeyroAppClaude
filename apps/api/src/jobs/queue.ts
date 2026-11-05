// In-process job queue backed by the Postgres `jobs` table.
import { one, q, pool } from '../core/db';
import { publishOrg } from '../core/realtime';

export type JobHandler = (payload: any, job: { id: string; orgId: string | null; attempts: number; progress: (pct: number) => Promise<void> }) => Promise<unknown>;
const handlers = new Map<string, JobHandler>();
export function registerJob(kind: string, h: JobHandler) { handlers.set(kind, h); }

export async function enqueue(kind: string, payload: unknown, opts: { orgId?: string | null; runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
  return one<any>(`INSERT INTO jobs (kind, payload, organization_id, run_at, dedupe_key, max_attempts) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [kind, JSON.stringify(payload ?? {}), opts.orgId ?? null, (opts.runAt ?? new Date()).toISOString(), opts.dedupeKey ?? null, opts.maxAttempts ?? 5]);
}

type Recurring = { name: string; everyMs: number; fn: () => Promise<void>; last: number };
const recurring: Recurring[] = [];
/** Registers a recurring in-process task (scheduler tick: automations, retention, overdue, simulator...). */
export function every(name: string, everyMs: number, fn: () => Promise<void>) { recurring.push({ name, everyMs, fn, last: 0 }); }

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    for (let i = 0; i < 20; i++) {
      const job = await one<any>(`UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1 WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_at <= now() ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
      if (!job) break;
      const h = handlers.get(job.kind);
      try {
        if (!h) throw new Error(`No handler for job kind ${job.kind}`);
        await h(job.payload, { id: job.id, orgId: job.organization_id, attempts: job.attempts, progress: async (pct) => { await q(`UPDATE jobs SET progress=$2 WHERE id=$1`, [job.id, pct]); if (job.organization_id) publishOrg(job.organization_id, 'job', { id: job.id, kind: job.kind, progress: pct }); } });
        await q(`UPDATE jobs SET status='succeeded', progress=100, finished_at=now() WHERE id=$1`, [job.id]);
        if (job.organization_id) publishOrg(job.organization_id, 'job', { id: job.id, kind: job.kind, progress: 100, status: 'succeeded' });
      } catch (e: any) {
        const retry = job.attempts < job.max_attempts;
        const backoff = Math.min(300, 2 ** job.attempts * 2);
        await q(`UPDATE jobs SET status=$2, last_error=$3, run_at=now() + make_interval(secs => $4), finished_at=CASE WHEN $2='failed' THEN now() END WHERE id=$1`, [job.id, retry ? 'queued' : 'failed', String(e?.message ?? e), backoff]);
        console.error(`[job ${job.kind}] failed (attempt ${job.attempts}):`, e?.message ?? e);
      }
    }
    const now = Date.now();
    for (const r of recurring) {
      if (now - r.last < r.everyMs) continue;
      r.last = now;
      try { await r.fn(); } catch (e: any) { console.error(`[every ${r.name}]`, e?.message ?? e); }
    }
  } finally { running = false; }
}
export function startQueue() {
  setInterval(() => { tick().catch(e => console.error('[queue]', e)); }, 1000).unref();
}
export { pool };
