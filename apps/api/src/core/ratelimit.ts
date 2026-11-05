import { one } from './db';
import { tooMany } from './errors';
/** Fixed-window rate limit stored in Postgres (works across restarts). */
export async function rateLimit(key: string, max: number, windowSec: number) {
  const r = await one<{ count: number }>(`INSERT INTO rate_limits (key, count, window_start) VALUES ($1, 1, now())
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
    window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END RETURNING count`, [key, windowSec]);
  if (r && r.count > max) throw tooMany();
}
