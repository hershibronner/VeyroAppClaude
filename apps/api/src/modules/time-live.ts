// TIME: live demo simulator. Keeps ~40% of each agency's active workers (max 8) clocked in at any hour so
// Live Now is never empty: open time entries started earlier today, breaks, idle spells, activity samples
// and fresh mock desktop screenshots. Workers with a portal login (e.g. the demo worker) are never simulated.
// Also generates demo screenshots for real workers who declined/couldn't share their screen.
import type { FastifyInstance } from 'fastify';
import { dateInTz, weekStart, MOCK_APPS } from '@veyro/shared';
import { q, one, pool as db } from '../core/db';
import { every } from '../jobs/queue';
import { createMockShot, insertActivity, rebuildTimesheet, broadcastPresence, rand, pick } from './_wf/lib';

const MAX_LIVE = 8;
let running = false;

async function clockOutSim(pr: any, reason: string) {
  if (pr.time_entry_id) {
    const b = await one<any>(`SELECT id, started_at FROM breaks WHERE time_entry_id=$1 AND ended_at IS NULL`, [pr.time_entry_id]);
    if (b) { await q(`UPDATE breaks SET ended_at=now() WHERE id=$1`, [b.id]); await q(`UPDATE time_entries SET break_seconds=break_seconds + EXTRACT(EPOCH FROM now() - $2::timestamptz)::int WHERE id=$1`, [pr.time_entry_id, b.started_at]); }
    const e = await one<any>(`UPDATE time_entries SET ended_at=now(), memo=COALESCE(memo, $2) WHERE id=$1 AND ended_at IS NULL RETURNING placement_id, work_date`, [pr.time_entry_id, reason]);
    if (e) await rebuildTimesheet(pr.organization_id, e.placement_id, weekStart(e.work_date));
  }
  await q(`UPDATE worker_presence SET state='offline', time_entry_id=NULL, session_started_at=NULL, simulated=false, updated_at=now() WHERE worker_id=$1`, [pr.worker_id]);
  await broadcastPresence(pr.organization_id, pr.worker_id);
}

async function clockInSim(orgId: string, p: any) {
  const today = dateInTz(new Date(), p.timezone);
  const prev = await one<any>(`SELECT max(COALESCE(ended_at, now())) t FROM time_entries WHERE worker_id=$1 AND started_at >= now() - interval '24 hours'`, [p.worker_id]);
  let start = new Date(Date.now() - rand(25, 210) * 60000);
  if (prev?.t && new Date(prev.t) > start) start = new Date(new Date(prev.t).getTime() + 5 * 60000);
  if (start.getTime() > Date.now() - 60000) start = new Date(Date.now() - 60000);
  if (dateInTz(start, p.timezone) !== today) start = new Date(Math.max(start.getTime(), Date.now() - 20 * 60000));
  const e = await one<any>(`INSERT INTO time_entries (organization_id, placement_id, worker_id, work_date, started_at, memo, source) VALUES ($1,$2,$3,$4,$5,$6,'simulated') RETURNING *`,
    [orgId, p.id, p.worker_id, dateInTz(start, p.timezone), start.toISOString(), pick(['Inbox + scheduling', 'Insurance verifications', 'Weekly report prep', 'Client callbacks', 'CRM updates', 'Order processing', null])]);
  // Backfill the elapsed part of the session (10-minute activity buckets + screenshots from the shared mock library).
  const interval = Math.max(1, Math.round((p.screenshot_interval_min ?? 10) / 10)) * 600000;
  for (let t = start.getTime(); t + 600000 <= Date.now(); t += 600000) {
    const pct = rand(45, 94);
    if (p.activity_tracking !== false) await insertActivity(db, { orgId, workerId: p.worker_id, placementId: p.id, entryId: e.id, bucket: new Date(t), pct, app: pick(MOCK_APPS).app });
    if (p.screenshots_enabled !== false && (t - start.getTime()) % interval === 0) await createMockShot({ orgId, workerId: p.worker_id, placementId: p.id, entryId: e.id, at: new Date(t + rand(30, 540) * 1000), tz: p.timezone, blur: !!p.blur, activityPct: pct, writeFile: false, broadcast: false });
  }
  await q(`INSERT INTO worker_presence (worker_id, organization_id, placement_id, time_entry_id, state, session_started_at, last_heartbeat_at, activity_pct, screen_share, simulated, updated_at) VALUES ($1,$2,$3,$4,'working',$5,now(),$6,'granted',true,now())
    ON CONFLICT (worker_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, placement_id=EXCLUDED.placement_id, time_entry_id=EXCLUDED.time_entry_id, state='working', session_started_at=EXCLUDED.session_started_at, last_heartbeat_at=now(), activity_pct=EXCLUDED.activity_pct, screen_share='granted', simulated=true, updated_at=now()`,
    [p.worker_id, orgId, p.id, e.id, start.toISOString(), rand(55, 90)]);
  await rebuildTimesheet(orgId, p.id, weekStart(e.work_date));
  await broadcastPresence(orgId, p.worker_id);
}

async function stepSim(pr: any) {
  const e = pr.time_entry_id ? await one<any>(`SELECT e.*, p.timezone, p.status pstatus, mp.screenshots_enabled, mp.screenshot_interval_min, mp.blur, mp.activity_tracking FROM time_entries e JOIN placements p ON p.id=e.placement_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id WHERE e.id=$1`, [pr.time_entry_id]) : null;
  if (!e || e.ended_at || !['active', 'notice'].includes(e.pstatus)) return clockOutSim(pr, 'Session ended');
  const hours = (Date.now() - new Date(e.started_at).getTime()) / 3600000;
  if (e.work_date !== dateInTz(new Date(), e.timezone) || hours > 7.5 || (hours > 4 && Math.random() < 0.01)) return clockOutSim(pr, 'Shift complete');
  const sinceChange = (Date.now() - new Date(pr.updated_at).getTime()) / 60000;
  let state = pr.state;
  if (state === 'working') {
    const r = Math.random();
    if (r < 0.03) { state = 'on_break'; await q(`INSERT INTO breaks (organization_id, time_entry_id, started_at) VALUES ($1,$2,now())`, [pr.organization_id, e.id]); }
    else if (r < 0.06) state = 'idle';
  } else if (state === 'on_break') {
    if (sinceChange > 8 && Math.random() < 0.3) {
      const b = await one<any>(`UPDATE breaks SET ended_at=now() WHERE time_entry_id=$1 AND ended_at IS NULL RETURNING started_at`, [e.id]);
      if (b) await q(`UPDATE time_entries SET break_seconds=break_seconds + EXTRACT(EPOCH FROM now() - $2::timestamptz)::int WHERE id=$1`, [e.id, b.started_at]);
      state = 'working';
    }
  } else if (state === 'idle') {
    if (sinceChange > 2 && Math.random() < 0.45) {
      const secs = Math.round(sinceChange * 60);
      const discard = Math.random() < 0.3;
      await q(`INSERT INTO idle_events (organization_id, worker_id, time_entry_id, started_at, ended_at, seconds, decision) VALUES ($1,$2,$3,now() - make_interval(secs => $4), now(), $4, $5)`, [pr.organization_id, pr.worker_id, e.id, secs, discard ? 'discard' : 'keep']);
      await q(`UPDATE time_entries SET idle_seconds=idle_seconds+$2, discarded_idle_seconds=discarded_idle_seconds+$3 WHERE id=$1`, [e.id, secs, discard ? secs : 0]);
      state = 'working';
    }
  }
  const pct = state === 'working' ? rand(52, 96) : state === 'idle' ? rand(0, 12) : 0;
  if (state !== 'on_break' && e.activity_tracking !== false) await insertActivity(db, { orgId: pr.organization_id, workerId: pr.worker_id, placementId: e.placement_id, entryId: e.id, bucket: new Date(Date.now() - 60000), pct, app: pick(MOCK_APPS).app, seconds: 60 });
  if (state !== 'on_break' && e.screenshots_enabled !== false) {
    const last = await one<any>(`SELECT max(taken_at) t FROM screenshots WHERE worker_id=$1`, [pr.worker_id]);
    const every = Math.min(10, Math.max(3, e.screenshot_interval_min ?? 10)) * 60000;
    if (!last?.t || Date.now() - new Date(last.t).getTime() > every * (0.6 + Math.random() * 0.5)) await createMockShot({ orgId: pr.organization_id, workerId: pr.worker_id, placementId: e.placement_id, entryId: e.id, at: new Date(), tz: e.timezone, blur: !!e.blur, activityPct: pct || rand(40, 80) });
  }
  const recent = await one<any>(`SELECT round(sum(active_seconds)::numeric*100/NULLIF(sum(bucket_seconds),0))::int pct FROM activity_samples WHERE time_entry_id=$1 AND bucket_start >= now() - interval '10 minutes'`, [e.id]);
  await q(`UPDATE worker_presence SET state=$2, last_heartbeat_at=now(), activity_pct=$3, updated_at=CASE WHEN state=$2 THEN updated_at ELSE now() END WHERE worker_id=$1`, [pr.worker_id, state, recent?.pct ?? pct]);
  await broadcastPresence(pr.organization_id, pr.worker_id);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const orgs = await q<any>(`SELECT organization_id, count(*)::int n FROM placements WHERE status IN ('active','notice') GROUP BY 1`);
    for (const o of orgs) {
      const sims = await q<any>(`SELECT * FROM worker_presence WHERE organization_id=$1 AND simulated AND state <> 'offline'`, [o.organization_id]);
      for (const pr of sims) { try { await stepSim(pr); } catch (e: any) { console.error('[simulator step]', e?.message); } }
      const live = (await one<any>(`SELECT count(*)::int n FROM worker_presence WHERE organization_id=$1 AND simulated AND state <> 'offline'`, [o.organization_id])).n;
      const target = Math.min(MAX_LIVE, Math.ceil(o.n * 0.4));
      if (live >= target) continue;
      const cands = await q<any>(`SELECT p.*, mp.screenshots_enabled, mp.screenshot_interval_min, mp.blur, mp.activity_tracking FROM placements p JOIN workers w ON w.id=p.worker_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id LEFT JOIN worker_presence wp ON wp.worker_id=p.worker_id
        WHERE p.organization_id=$1 AND p.status IN ('active','notice') AND w.user_id IS NULL AND p.policy_accepted_at IS NOT NULL AND (wp.worker_id IS NULL OR wp.state='offline')
          AND NOT EXISTS (SELECT 1 FROM time_off_requests r WHERE r.worker_id=p.worker_id AND r.status='approved' AND (now() AT TIME ZONE p.timezone)::date BETWEEN r.start_date AND r.end_date)
          AND NOT EXISTS (SELECT 1 FROM time_entries e WHERE e.worker_id=p.worker_id AND e.ended_at IS NULL)
        ORDER BY COALESCE((SELECT sum(EXTRACT(EPOCH FROM COALESCE(e.ended_at, now()) - e.started_at)) FROM time_entries e WHERE e.worker_id=p.worker_id AND e.started_at >= now() - interval '12 hours'), 0) < 4 * 3600 DESC, random() LIMIT $2`, [o.organization_id, target - live]);
      for (const p of cands) { try { await clockInSim(o.organization_id, p); } catch (e: any) { console.error('[simulator clock-in]', e?.message); } }
    }
    // Demo screenshots for real workers who declined or cannot share their screen.
    const declined = await q<any>(`SELECT wp.*, e.id entry_id, p.timezone, mp.screenshot_interval_min, mp.blur FROM worker_presence wp JOIN time_entries e ON e.id=wp.time_entry_id AND e.ended_at IS NULL JOIN placements p ON p.id=e.placement_id JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id
      WHERE NOT wp.simulated AND wp.state IN ('working','idle') AND wp.screen_share IN ('declined','unsupported') AND mp.screenshots_enabled AND wp.last_heartbeat_at > now() - interval '15 minutes'`);
    for (const d of declined) {
      const last = await one<any>(`SELECT max(taken_at) t FROM screenshots WHERE worker_id=$1`, [d.worker_id]);
      const intervalMs = (d.screenshot_interval_min ?? 10) * 60000;
      if (!last?.t || Date.now() - new Date(last.t).getTime() >= intervalMs * (0.5 + Math.random() * 0.5)) await createMockShot({ orgId: d.organization_id, workerId: d.worker_id, placementId: d.placement_id, entryId: d.entry_id, at: new Date(), tz: d.timezone, blur: !!d.blur, activityPct: d.activity_pct ?? rand(50, 85) });
    }
  } finally { running = false; }
}

export default async function (app: FastifyInstance) {
  void app;
  every('time.live_simulator', 60000, tick);
}
