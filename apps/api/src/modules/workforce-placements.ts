// WORKFORCE: placements (create from offer, status machine, onboarding checklist, activation, invite,
// replacement, offboarding, equipment) + equipment templates.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { rateForDate, todayUtc } from '@veyro/shared';
import { q, one, tx, type Db, pool } from '../core/db';
import { staff, need, can, canViewComp, redact, assertTransition, getOr404, type Ctx } from '../core/context';
import { badRequest, conflict, forbidden, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify, usersWithRoles } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { every } from '../jobs/queue';
import { sendTemplate } from '../adapters/messaging';
import { signedUrl } from '../core/storage';
import { WEB_URL } from '../core/settings';
import { WNAME, placementFull, eventPayload, rebuildTimesheet, weekStart, todayIn, simulateWorkday, scheduledDays, broadcastPresence, fieldErr } from './_wf/lib';

type Actor = Pick<Ctx, 'orgId' | 'userId' | 'user' | 'impersonatorId' | 'ip'>;
const sysActor = (orgId: string): Actor => ({ orgId, userId: null as any, user: { id: '', name: 'System', email: '', avatar_color: null }, impersonatorId: null, ip: '127.0.0.1' });
const uuid = z.string().uuid();
const time = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

function parseSchedule(s: string | null | undefined) {
  const m = (s ?? '').match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
  const days = /sat|weekend|7 days/i.test(s ?? '') ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
  return m ? { schedule_days: days, schedule_start: `${m[1].padStart(2, '0')}:${m[2]}`, schedule_end: `${m[3].padStart(2, '0')}:${m[4]}` } : { schedule_days: days, schedule_start: '09:00', schedule_end: '17:00' };
}

async function assertMember(orgId: string, userId: string | null | undefined, label: string) {
  if (!userId) return;
  const m = await one(`SELECT 1 FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='active' AND r.kind='agency'`, [orgId, userId]);
  if (!m) throw fieldErr({ [label]: 'Pick a member of this workspace' });
}

/** Onboarding items = agency default template + client template(s) + position requirements (+ manual). */
async function onboardingPreview(orgId: string, companyId: string, positionId: string | null, db: Db = pool) {
  const agency = await q<any>(`SELECT i.title, i.required, i.owner FROM onboarding_template_items i JOIN onboarding_templates t ON t.id=i.template_id WHERE t.organization_id=$1 AND t.scope='agency' AND t.is_default ORDER BY i.sort`, [orgId], db);
  const client = await q<any>(`SELECT i.title, i.required, i.owner FROM onboarding_template_items i JOIN onboarding_templates t ON t.id=i.template_id WHERE t.organization_id=$1 AND t.company_id=$2 ORDER BY i.sort`, [orgId, companyId], db);
  const pos = positionId ? await q<any>(`SELECT title, required, 'agency' owner FROM position_requirements WHERE organization_id=$1 AND position_id=$2 ORDER BY created_at`, [orgId, positionId], db) : [];
  return [...agency.map(i => ({ ...i, source: 'agency' })), ...client.map(i => ({ ...i, source: 'client' })), ...pos.map(i => ({ ...i, source: 'position' }))];
}

async function syncWorkerStatus(orgId: string, workerId: string, db: Db = pool) {
  const ps = await q<any>(`SELECT status FROM placements WHERE worker_id=$1 AND organization_id=$2`, [workerId, orgId], db);
  const w = await one<any>(`SELECT status FROM workers WHERE id=$1`, [workerId], db);
  if (w?.status === 'inactive' && !ps.some(p => p.status === 'active')) return 'inactive';
  const st = ps.some(p => p.status === 'active' || p.status === 'notice') ? 'active' : ps.some(p => p.status === 'on_leave') ? 'on_leave' : ps.some(p => p.status === 'onboarding') ? 'pending' : 'available';
  await q(`UPDATE workers SET status=$3, updated_at=now() WHERE id=$1 AND organization_id=$2`, [workerId, orgId, st], db);
  return st;
}

/** Ends a placement: stop tracking, end seat, optional final timesheet, worker status; history kept. */
export async function endPlacement(actor: Actor, placementId: string, o: { end_date: string; reason: string; final_timesheet: boolean }) {
  const p = await placementFull(actor.orgId, placementId);
  if (!p) throw notFound();
  assertTransition('placement', p.status, 'ended');
  const result = await tx(async c => {
    const open = await q<any>(`SELECT id FROM time_entries WHERE placement_id=$1 AND ended_at IS NULL`, [p.id], c);
    for (const e of open) {
      await q(`UPDATE breaks SET ended_at=now() WHERE time_entry_id=$1 AND ended_at IS NULL`, [e.id], c);
      await q(`UPDATE time_entries SET ended_at=now(), memo=COALESCE(memo,'') || CASE WHEN memo IS NULL THEN 'Stopped at offboarding' ELSE ' (stopped at offboarding)' END WHERE id=$1`, [e.id], c);
    }
    await q(`UPDATE worker_presence SET state='offline', time_entry_id=NULL, session_started_at=NULL, simulated=false, updated_at=now() WHERE worker_id=$1 AND placement_id=$2`, [p.worker_id, p.id], c);
    await q(`UPDATE placements SET status='ended', end_date=$3, end_reason=$4, ended_at=now(), updated_at=now() WHERE id=$1 AND organization_id=$2`, [p.id, actor.orgId, o.end_date, o.reason], c);
    const seats = await q<any>(`UPDATE seat_usage SET ended_at=now(), ended_by=$2 WHERE placement_id=$1 AND ended_at IS NULL RETURNING id`, [p.id, actor.userId || null], c);
    const submitted: string[] = [];
    if (o.final_timesheet) {
      const weeks = await q<any>(`SELECT DISTINCT date_trunc('week', work_date)::date::text wk FROM time_entries WHERE placement_id=$1 UNION SELECT $2::text`, [p.id, weekStart(o.end_date)], c);
      for (const { wk } of weeks) {
        const t = await rebuildTimesheet(actor.orgId, p.id, wk, c);
        if (t && (t.status === 'open' || t.status === 'rejected') && t.total_minutes > 0) {
          await q(`UPDATE timesheets SET status='submitted', submitted_at=now(), rejected_reason=NULL, updated_at=now() WHERE id=$1`, [t.id], c);
          await q(`INSERT INTO timesheet_approvals (organization_id, timesheet_id, actor_id, party, decision, reason) VALUES ($1,$2,$3,'agency','submitted','Final timesheet at offboarding')`, [actor.orgId, t.id, actor.userId || null], c);
          submitted.push(wk);
        }
      }
    }
    if (p.position_id) await q(`UPDATE positions SET filled=(SELECT count(*) FROM placements WHERE position_id=$1 AND status <> 'ended'), updated_at=now() WHERE id=$1`, [p.position_id], c);
    const ws = await syncWorkerStatus(actor.orgId, p.worker_id, c);
    await activity(actor, 'placement', p.id, 'status_change', `Offboarded — ${o.reason}`, `End date ${o.end_date}.${submitted.length ? ` Final timesheet submitted (${submitted.join(', ')}).` : ''} Tracking stopped.`, { from: p.status, to: 'ended' }, c);
    await activity(actor, 'worker', p.worker_id, 'status_change', `Placement at ${p.company_name} ended`, o.reason, {}, c);
    return { seats: seats.length, submitted, workerStatus: ws };
  });
  await audit(actor, 'placement.offboarded', { type: 'placement', id: p.id, label: `${p.worker_name} @ ${p.company_name}` }, { status: p.status }, { status: 'ended', end_date: o.end_date }, o.reason);
  if (result.seats) await audit(actor, 'seat.ended', { type: 'placement', id: p.id, label: p.worker_name });
  await emit(actor.orgId, 'placement.ended', eventPayload(p, { end_date: o.end_date, reason: o.reason }));
  if (result.workerStatus !== 'active') await emit(actor.orgId, 'worker.terminated', eventPayload(p, { end_date: o.end_date, reason: o.reason }));
  await notify(actor.orgId, [p.account_manager_id, p.recruiter_id].filter(u => u !== actor.userId), { event: 'placement.ended', title: `${p.worker_name} offboarded from ${p.company_name}`, body: o.reason, link: `/workforce/placements/${p.id}` });
  await broadcastPresence(actor.orgId, p.worker_id).catch(() => {});
  return result;
}

export default async function (app: FastifyInstance) {
  const LIST_SELECT = `p.id, p.title, p.status, p.start_date, p.end_date, p.timezone, p.weekly_hours, p.worker_id, p.company_id, p.position_id, p.replaces_placement_id, p.created_at, p.activated_at,
    ${WNAME} worker_name, cd.avatar_color, co.name company_name, am.name account_manager_name, rc.name recruiter_name, mp.name policy_name,
    (SELECT count(*)::int FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.removed_at IS NULL AND i.required) req_total,
    (SELECT count(*)::int FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.removed_at IS NULL AND i.required AND i.done_at IS NOT NULL) req_done,
    (SELECT count(*)::int FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.removed_at IS NULL) items_total,
    (SELECT count(*)::int FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.removed_at IS NULL AND i.done_at IS NOT NULL) items_done,
    (SELECT r.pay_rate_cents FROM placement_rates r WHERE r.placement_id=p.id ORDER BY (r.effective_from <= CURRENT_DATE) DESC, r.effective_from DESC LIMIT 1) pay_rate_cents,
    (SELECT r.bill_rate_cents FROM placement_rates r WHERE r.placement_id=p.id ORDER BY (r.effective_from <= CURRENT_DATE) DESC, r.effective_from DESC LIMIT 1) bill_rate_cents,
    (SELECT r.currency FROM placement_rates r WHERE r.placement_id=p.id ORDER BY r.effective_from DESC LIMIT 1) currency`;
  const LIST_FROM = `placements p JOIN workers w ON w.id=p.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=p.company_id LEFT JOIN users am ON am.id=p.account_manager_id LEFT JOIN users rc ON rc.id=p.recruiter_id LEFT JOIN monitoring_policies mp ON mp.id=p.monitoring_policy_id`;

  app.get('/api/v1/placements', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'view');
    const lp = listParams(req);
    const where = ['p.organization_id = $1']; const params: unknown[] = [ctx.orgId];
    const f = lp.filters;
    if (f.status) { params.push(f.status.split(',')); where.push(`p.status = ANY($${params.length})`); }
    for (const k of ['company_id', 'worker_id', 'account_manager_id', 'recruiter_id', 'position_id'] as const) if (f[k]) { params.push(f[k]); where.push(`p.${k} = $${params.length}`); }
    if (f.mine === 'true') { params.push(ctx.userId); where.push(`(p.account_manager_id=$${params.length} OR p.recruiter_id=$${params.length})`); }
    if (f.blocked === 'true') where.push(`p.status='onboarding' AND EXISTS (SELECT 1 FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.required AND i.done_at IS NULL AND i.removed_at IS NULL)`);
    if (f.ready === 'true') where.push(`p.status='onboarding' AND NOT EXISTS (SELECT 1 FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.required AND i.done_at IS NULL AND i.removed_at IS NULL)`);
    if (f.replacement === 'true') where.push(`p.replaces_placement_id IS NOT NULL`);
    if (f.starting_before) { params.push(f.starting_before); where.push(`p.start_date <= $${params.length}`); }
    const r = await paged({ select: LIST_SELECT, from: LIST_FROM, where, params, lp, searchCols: ['cd.first_name', 'cd.last_name', 'co.name', 'p.title'],
      sortMap: { worker_name: 'cd.first_name', company_name: 'co.name', start_date: 'p.start_date', status: 'p.status', created_at: 'p.created_at', title: 'p.title', progress: '(SELECT count(*) FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.done_at IS NOT NULL)' }, defaultSort: 'p.created_at DESC' });
    return { ...r, rows: r.rows.map(x => redact(ctx, x)) };
  });

  app.get('/api/v1/placements/summary', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'view');
    const s = await one<any>(`SELECT count(*) FILTER (WHERE status='active')::int active, count(*) FILTER (WHERE status='onboarding')::int onboarding, count(*) FILTER (WHERE status='on_leave')::int on_leave,
      count(*) FILTER (WHERE status='notice')::int notice, count(*) FILTER (WHERE status='ended')::int ended, count(*)::int total,
      count(*) FILTER (WHERE status='active' AND activated_at >= date_trunc('month', now()))::int started_this_month,
      count(*) FILTER (WHERE status='active' AND activated_at >= date_trunc('month', now()) - interval '1 month' AND activated_at < date_trunc('month', now()))::int started_last_month,
      count(*) FILTER (WHERE status='ended' AND ended_at >= now() - interval '90 days')::int ended_90d,
      count(*) FILTER (WHERE status='onboarding' AND EXISTS (SELECT 1 FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.required AND i.done_at IS NULL AND i.removed_at IS NULL))::int blocked,
      count(*) FILTER (WHERE status='onboarding' AND NOT EXISTS (SELECT 1 FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.required AND i.done_at IS NULL AND i.removed_at IS NULL))::int ready,
      count(*) FILTER (WHERE status='onboarding' AND start_date <= CURRENT_DATE + 7)::int starting_soon,
      count(*) FILTER (WHERE replaces_placement_id IS NOT NULL AND status <> 'ended')::int replacements
      FROM placements p WHERE organization_id=$1`, [ctx.orgId]);
    const byClient = await q<any>(`SELECT co.id, co.name label, count(*)::int value FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.organization_id=$1 AND p.status IN ('active','notice','on_leave') GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8`, [ctx.orgId]);
    const trend = await q<any>(`SELECT to_char(m, 'Mon') label, m::date::text AS month, (SELECT count(*)::int FROM placements p WHERE p.organization_id=$1 AND p.start_date <= (m + interval '1 month - 1 day')::date AND (p.end_date IS NULL OR p.end_date >= m::date) AND p.status <> 'onboarding') value
      FROM generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m ORDER BY m`, [ctx.orgId]);
    return { ...s, byClient, trend };
  });

  // Prefill for /workforce/placements/new (?offerId= from an accepted offer, ?replacesId= for a replacement, ?candidateId=).
  app.get('/api/v1/placements/prefill', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'create');
    const { offerId, replacesId, candidateId } = req.query as Record<string, string | undefined>;
    const policy = await one<any>(`SELECT id FROM monitoring_policies WHERE organization_id=$1 ORDER BY is_default DESC, created_at LIMIT 1`, [ctx.orgId]);
    let out: any = { source: 'blank', defaults: { schedule_days: [1, 2, 3, 4, 5], schedule_start: '09:00', schedule_end: '17:00', timezone: 'America/New_York', weekly_hours: 40, monitoring_policy_id: policy?.id ?? null, currency: 'USD', unit: 'hour', start_date: todayUtc() } };
    const candInfo = async (id: string) => one<any>(`SELECT cd.id, cd.first_name, cd.last_name, cd.email, cd.status, cd.country, cd.timezone, w.id worker_id, w.status worker_status, w.employee_code,
      (SELECT count(*)::int FROM placements p WHERE p.worker_id=w.id AND p.status <> 'ended') open_placements FROM candidates cd LEFT JOIN workers w ON w.candidate_id=cd.id WHERE cd.id=$1 AND cd.organization_id=$2`, [id, ctx.orgId]);
    if (offerId) {
      const o = await getOr404<any>('offers', ctx, offerId);
      if (o.status !== 'accepted') throw conflict(`This offer is ${o.status.replace('_', ' ')} — only accepted offers can become placements`);
      const pos = o.position_id ? await one<any>(`SELECT p.*, co.name company_name, co.account_manager_id co_am, co.owner_id co_owner FROM positions p LEFT JOIN companies co ON co.id=p.company_id WHERE p.id=$1`, [o.position_id]) : null;
      const recruiter = o.position_id ? await one<any>(`SELECT user_id FROM position_recruiter_assignments WHERE position_id=$1 AND unassigned_at IS NULL ORDER BY is_lead DESC, assigned_at LIMIT 1`, [o.position_id]) : null;
      const sched = parseSchedule(pos?.schedule);
      out = {
        source: 'offer', offer: { id: o.id, status: o.status, signed_at: o.signed_at, start_date: o.start_date, weekly_hours: o.weekly_hours, ...(canViewComp(ctx) ? { pay_rate_cents: o.pay_rate_cents, bill_rate_cents: o.bill_rate_cents } : {}), currency: o.currency, rate_unit: o.rate_unit },
        existing_placement_id: o.placement_id ?? null,
        candidate: await candInfo(o.candidate_id),
        company: pos?.company_id ? { id: pos.company_id, name: pos.company_name } : null,
        position: pos ? { id: pos.id, title: pos.title } : null,
        defaults: { ...out.defaults, ...sched, offer_id: o.id, candidate_id: o.candidate_id, company_id: pos?.company_id ?? null, position_id: pos?.id ?? null, title: pos?.title ?? '', start_date: o.start_date ?? todayUtc(), timezone: pos?.timezone ?? 'America/New_York', weekly_hours: o.weekly_hours ?? pos?.weekly_hours ?? 40,
          account_manager_id: pos?.co_am ?? null, recruiter_id: recruiter?.user_id ?? o.created_by ?? null, sales_id: pos?.co_owner ?? null, currency: o.currency, unit: o.rate_unit, ...(canViewComp(ctx) ? { pay_rate_cents: o.pay_rate_cents, bill_rate_cents: o.bill_rate_cents } : {}) },
      };
    } else if (replacesId) {
      const p = await placementFull(ctx.orgId, replacesId);
      if (!p) throw notFound();
      const rate = await one<any>(`SELECT * FROM placement_rates WHERE placement_id=$1 AND effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1`, [p.id]);
      out = { source: 'replacement', replaces: { id: p.id, worker_name: p.worker_name, company_name: p.company_name, title: p.title, status: p.status },
        company: { id: p.company_id, name: p.company_name }, position: p.position_id ? await one(`SELECT id, title FROM positions WHERE id=$1`, [p.position_id]) : null,
        defaults: { ...out.defaults, replaces_placement_id: p.id, company_id: p.company_id, position_id: p.position_id, title: p.title, schedule_days: p.schedule_days, schedule_start: p.schedule_start.slice(0, 5), schedule_end: p.schedule_end.slice(0, 5), timezone: p.timezone, weekly_hours: p.weekly_hours,
          account_manager_id: p.account_manager_id, recruiter_id: p.recruiter_id, sales_id: p.sales_id, monitoring_policy_id: p.monitoring_policy_id, currency: rate?.currency ?? 'USD', unit: rate?.unit ?? 'hour', ...(canViewComp(ctx) && rate ? { pay_rate_cents: rate.pay_rate_cents, bill_rate_cents: rate.bill_rate_cents } : {}) } };
    } else if (candidateId) {
      const c = await candInfo(candidateId);
      if (!c) throw notFound();
      out = { ...out, source: 'candidate', candidate: c, defaults: { ...out.defaults, candidate_id: c.id } };
    }
    if (out.defaults.company_id) out.onboarding_preview = await onboardingPreview(ctx.orgId, out.defaults.company_id, out.defaults.position_id ?? null);
    return out;
  });

  app.get('/api/v1/placements/onboarding-preview', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'view');
    const { company_id, position_id } = req.query as Record<string, string>;
    if (!company_id) return [];
    await getOr404('companies', ctx, company_id);
    return onboardingPreview(ctx.orgId, company_id, position_id || null);
  });

  // ── Create (CONTRACTS §4) ──
  app.post('/api/v1/placements', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'create');
    const b = z.object({
      offer_id: uuid.optional().nullable(), candidate_id: uuid.optional().nullable(), worker_id: uuid.optional().nullable(), company_id: uuid, position_id: uuid.optional().nullable(),
      title: z.string().min(2).max(160), start_date: date, schedule_days: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]), schedule_start: time.default('09:00'), schedule_end: time.default('17:00'),
      timezone: z.string().min(3).default('America/New_York'), weekly_hours: z.number().int().min(1).max(80).default(40), account_manager_id: uuid.optional().nullable(), recruiter_id: uuid.optional().nullable(), sales_id: uuid.optional().nullable(),
      monitoring_policy_id: uuid.optional().nullable(), pay_rate_cents: z.number().int().min(0).optional().nullable(), bill_rate_cents: z.number().int().min(0).optional().nullable(), currency: z.string().length(3).default('USD'), unit: z.enum(['hour', 'day', 'week', 'month']).default('hour'),
      replaces_placement_id: uuid.optional().nullable(), equipment: z.array(z.string().min(1).max(120)).optional(), manual_items: z.array(z.object({ title: z.string().min(2).max(200), required: z.boolean().default(false), owner: z.enum(['agency', 'worker', 'client']).default('agency') })).default([]),
    }).parse(req.body);
    if (b.schedule_end <= b.schedule_start) throw fieldErr({ schedule_end: 'Shift must end after it starts' });
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch { throw badRequest('Unknown timezone'); }
    const company = await getOr404<any>('companies', ctx, b.company_id);
    if (company.stage !== 'client') throw conflict(`${company.name} is not a client yet — convert the lead first`);
    if (b.position_id) { const pos = await getOr404<any>('positions', ctx, b.position_id); if (pos.company_id && pos.company_id !== b.company_id) throw badRequest('The position belongs to a different client'); }
    for (const [k, v] of [['account_manager_id', b.account_manager_id], ['recruiter_id', b.recruiter_id], ['sales_id', b.sales_id]] as const) await assertMember(ctx.orgId, v, k);
    if (b.monitoring_policy_id) await getOr404('monitoring_policies', ctx, b.monitoring_policy_id);
    let offer: any = null;
    if (b.offer_id) {
      offer = await getOr404<any>('offers', ctx, b.offer_id);
      if (offer.status !== 'accepted') throw conflict('Only accepted offers can become placements');
      if (offer.placement_id) throw conflict('A placement was already created from this offer', { placement_id: offer.placement_id });
      b.candidate_id = offer.candidate_id;
    }
    let candidateId = b.candidate_id ?? null;
    if (b.worker_id) { const w = await getOr404<any>('workers', ctx, b.worker_id); candidateId = w.candidate_id; }
    if (!candidateId) throw fieldErr({ candidate_id: 'Choose the person to place' });
    const cand = await getOr404<any>('candidates', ctx, candidateId);
    // Rates: comp-restricted users fall back to the offer's rates.
    let pay = b.pay_rate_cents ?? null, bill = b.bill_rate_cents ?? null;
    if (!canViewComp(ctx)) { pay = offer?.pay_rate_cents ?? null; bill = offer?.bill_rate_cents ?? null; }
    if (pay === null || bill === null) throw fieldErr({ pay_rate_cents: 'Pay rate is required', bill_rate_cents: 'Bill rate is required' });
    if (bill < pay) throw fieldErr({ bill_rate_cents: 'Bill rate must be at least the pay rate' });
    let replaced: any = null;
    if (b.replaces_placement_id) { replaced = await getOr404<any>('placements', ctx, b.replaces_placement_id); if (replaced.status === 'ended') throw conflict('That placement has already ended'); }
    const policyId = b.monitoring_policy_id ?? (await one<any>(`SELECT id FROM monitoring_policies WHERE organization_id=$1 ORDER BY is_default DESC LIMIT 1`, [ctx.orgId]))?.id ?? null;

    const created = await tx(async c => {
      let worker = (await c.query(`SELECT * FROM workers WHERE candidate_id=$1 AND organization_id=$2`, [candidateId, ctx.orgId])).rows[0];
      const reused = !!worker;
      if (!worker) {
        const n = (await c.query(`SELECT count(*)::int n FROM workers WHERE organization_id=$1`, [ctx.orgId])).rows[0].n;
        worker = (await c.query(`INSERT INTO workers (organization_id, candidate_id, user_id, status, employee_code) VALUES ($1,$2,$3,'pending',$4) RETURNING *`, [ctx.orgId, candidateId, cand.user_id ?? null, `W-${1000 + n}`])).rows[0];
      }
      const dup = (await c.query(`SELECT id FROM placements WHERE worker_id=$1 AND company_id=$2 AND title=$3 AND status IN ('onboarding','active') AND organization_id=$4`, [worker.id, b.company_id, b.title, ctx.orgId])).rows[0];
      if (dup) throw conflict('This person already has an open placement with this client for this role', { placement_id: dup.id });
      const tpl = b.equipment ?? (await c.query(`SELECT items FROM equipment_templates WHERE organization_id=$1 ORDER BY created_at LIMIT 1`, [ctx.orgId])).rows[0]?.items ?? [];
      const pl = (await c.query(`INSERT INTO placements (organization_id, worker_id, company_id, position_id, offer_id, title, status, start_date, schedule_days, schedule_start, schedule_end, timezone, weekly_hours, account_manager_id, recruiter_id, sales_id, monitoring_policy_id, replaces_placement_id, equipment, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,'onboarding',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [ctx.orgId, worker.id, b.company_id, b.position_id ?? offer?.position_id ?? null, offer?.id ?? null, b.title, b.start_date, b.schedule_days, b.schedule_start, b.schedule_end, b.timezone, b.weekly_hours, b.account_manager_id ?? company.account_manager_id ?? null, b.recruiter_id ?? null, b.sales_id ?? company.owner_id ?? null, policyId, b.replaces_placement_id ?? null, JSON.stringify(tpl), ctx.userId])).rows[0];
      await c.query(`INSERT INTO placement_rates (organization_id, placement_id, effective_from, pay_rate_cents, bill_rate_cents, currency, unit, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'Initial rate',$8)`, [ctx.orgId, pl.id, b.start_date, pay, bill, b.currency, b.unit, ctx.userId]);
      const items = [...await onboardingPreview(ctx.orgId, b.company_id, pl.position_id, c), ...b.manual_items.map(i => ({ ...i, source: 'manual' }))];
      for (const [i, it] of items.entries()) await c.query(`INSERT INTO placement_onboarding_items (organization_id, placement_id, title, source, required, owner, sort, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [ctx.orgId, pl.id, it.title, it.source, it.required, it.owner, i, ctx.userId]);
      await c.query(`UPDATE candidates SET status='hired', updated_at=now() WHERE id=$1 AND organization_id=$2`, [candidateId, ctx.orgId]);
      if (pl.position_id) {
        await c.query(`UPDATE candidate_submissions SET status='hired', updated_at=now() WHERE candidate_id=$1 AND position_id=$2 AND organization_id=$3`, [candidateId, pl.position_id, ctx.orgId]);
        await c.query(`UPDATE positions SET filled=(SELECT count(*) FROM placements WHERE position_id=$1 AND status <> 'ended'), updated_at=now() WHERE id=$1`, [pl.position_id]);
      }
      if (offer) await c.query(`UPDATE offers SET placement_id=$1, updated_at=now() WHERE id=$2`, [pl.id, offer.id]);
      if (replaced) await c.query(`UPDATE issues SET status='replacement', replacement_placement_id=$2 WHERE placement_id=$1 AND status IN ('open','investigating')`, [replaced.id, pl.id]);
      const name = `${cand.first_name} ${cand.last_name ?? ''}`.trim();
      await activity(ctx, 'placement', pl.id, 'system', replaced ? `Replacement placement created for ${name}` : 'Placement created', `${b.title} at ${company.name}, starting ${b.start_date}. ${items.length} onboarding items.${offer ? ' Created from accepted offer.' : ''}`, { offer_id: offer?.id, replaces: replaced?.id }, c);
      await activity(ctx, 'worker', worker.id, 'system', `Placed at ${company.name} as ${b.title}`, reused ? 'Existing worker record reused (same person).' : 'Worker record created from candidate (same person).', {}, c);
      await activity(ctx, 'candidate', candidateId!, 'status_change', `Hired — placement at ${company.name}`, null, { placement_id: pl.id }, c);
      if (replaced) await activity(ctx, 'placement', replaced.id, 'system', `Replacement started: ${name}`, `New placement starts ${b.start_date}; this placement stays active until offboarded.`, { replacement_id: pl.id }, c);
      return { pl, worker, reused, name };
    });
    await audit(ctx, 'placement.created', { type: 'placement', id: created.pl.id, label: `${created.name} @ ${company.name}` }, null, { start_date: b.start_date, offer_id: offer?.id ?? null, replaces: replaced?.id ?? null });
    const full = await placementFull(ctx.orgId, created.pl.id);
    await emit(ctx.orgId, 'placement.created', eventPayload(full));
    await notify(ctx.orgId, [full.account_manager_id, full.recruiter_id].filter(u => u && u !== ctx.userId), { event: 'placement.created', title: `New placement: ${created.name} → ${company.name}`, body: `Onboarding started. Starts ${b.start_date}.`, link: `/workforce/placements/${created.pl.id}` });
    return { ...redact(ctx, created.pl), worker_reused: created.reused };
  });

  app.get('/api/v1/placements/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'view');
    const { id } = req.params as { id: string };
    await getOr404('placements', ctx, id);
    const p = await placementFull(ctx.orgId, id);
    const [rates, people, items, issues, seat, invite, related, ts] = await Promise.all([
      q<any>(`SELECT id, effective_from, effective_to, pay_rate_cents, bill_rate_cents, currency, unit FROM placement_rates WHERE placement_id=$1 ORDER BY effective_from`, [id]),
      q<any>(`SELECT id, name FROM users WHERE id = ANY($1)`, [[p.account_manager_id, p.recruiter_id, p.sales_id, p.activated_by, p.created_by].filter(Boolean)]),
      one<any>(`SELECT count(*) FILTER (WHERE required)::int req_total, count(*) FILTER (WHERE required AND done_at IS NOT NULL)::int req_done, count(*)::int total, count(*) FILTER (WHERE done_at IS NOT NULL)::int done FROM placement_onboarding_items WHERE placement_id=$1 AND removed_at IS NULL`, [id]),
      one<any>(`SELECT count(*) FILTER (WHERE status IN ('open','investigating'))::int open, count(*)::int total FROM issues WHERE placement_id=$1`, [id]),
      one<any>(`SELECT started_at, ended_at FROM seat_usage WHERE placement_id=$1 ORDER BY started_at DESC LIMIT 1`, [id]),
      one<any>(`SELECT status, created_at, expires_at, email FROM invitations WHERE worker_id=$1 AND organization_id=$2 ORDER BY created_at DESC LIMIT 1`, [p.worker_id, ctx.orgId]),
      q<any>(`SELECT p2.id, p2.status, p2.start_date, p2.end_date, ${WNAME} worker_name, CASE WHEN p2.id=$2 THEN 'replaces' ELSE 'replaced_by' END relation FROM placements p2 JOIN workers w ON w.id=p2.worker_id JOIN candidates cd ON cd.id=w.candidate_id WHERE p2.organization_id=$3 AND (p2.id=$2 OR p2.replaces_placement_id=$1)`, [id, p.replaces_placement_id, ctx.orgId]),
      one<any>(`SELECT count(*) FILTER (WHERE status='submitted')::int submitted, count(*) FILTER (WHERE status IN ('approved','locked'))::int approved, COALESCE(sum(total_minutes) FILTER (WHERE status IN ('approved','locked')),0)::int approved_minutes FROM timesheets WHERE placement_id=$1`, [id]),
    ]);
    const nm = (u: string | null) => people.find(x => x.id === u)?.name ?? null;
    const cur = rateForDate(rates.map(r => ({ ...r, effectiveFrom: r.effective_from, effectiveTo: r.effective_to })), todayUtc()) ?? rates[rates.length - 1] ?? null;
    const presence = await one<any>(`SELECT state, session_started_at, activity_pct, screen_share FROM worker_presence WHERE worker_id=$1 AND placement_id=$2`, [p.worker_id, id]);
    const out: any = {
      ...p, account_manager_name: nm(p.account_manager_id), recruiter_name: nm(p.recruiter_id), sales_name: nm(p.sales_id), activated_by_name: nm(p.activated_by), created_by_name: nm(p.created_by),
      onboarding: items, issues, seat, invite: invite ?? null, related, timesheet_stats: ts, presence, has_portal: !!p.worker_user_id,
      current_rate: cur ? { effective_from: cur.effective_from, currency: cur.currency, unit: cur.unit, pay_rate_cents: cur.pay_rate_cents, bill_rate_cents: cur.bill_rate_cents } : null,
      allowed_status: ({ onboarding: ['active'], active: ['on_leave', 'notice'], on_leave: ['active', 'notice'], notice: ['active'], ended: [] } as Record<string, string[]>)[p.status] ?? [],
      can: { edit: can(ctx, 'placements', 'edit'), approve: can(ctx, 'placements', 'approve'), onboarding: can(ctx, 'onboarding', 'edit') || can(ctx, 'placements', 'edit'), view_comp: canViewComp(ctx), time: can(ctx, 'time', 'view') },
    };
    if (out.current_rate) out.current_rate = redact(ctx, out.current_rate);
    return out;
  });

  app.patch('/api/v1/placements/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'edit');
    const { id } = req.params as { id: string };
    const before = await getOr404<any>('placements', ctx, id);
    if (before.status === 'ended') throw conflict('Ended placements are read-only (history is preserved)');
    const b = z.object({ title: z.string().min(2).max(160).optional(), start_date: date.optional(), schedule_days: z.array(z.number().int().min(1).max(7)).min(1).optional(), schedule_start: time.optional(), schedule_end: time.optional(), timezone: z.string().optional(), weekly_hours: z.number().int().min(1).max(80).optional(),
      account_manager_id: uuid.nullable().optional(), recruiter_id: uuid.nullable().optional(), sales_id: uuid.nullable().optional(), monitoring_policy_id: uuid.optional(), equipment: z.array(z.string().min(1).max(120)).optional() }).parse(req.body);
    if (b.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch { throw fieldErr({ timezone: 'Unknown timezone' }); } }
    for (const k of ['account_manager_id', 'recruiter_id', 'sales_id'] as const) await assertMember(ctx.orgId, b[k], k);
    if (b.start_date && before.status !== 'onboarding') throw conflict('The start date can only change before activation');
    const patch: Record<string, unknown> = { ...b, equipment: b.equipment ? JSON.stringify(b.equipment) : undefined };
    let policyChanged = false;
    if (b.monitoring_policy_id && b.monitoring_policy_id !== before.monitoring_policy_id) { await getOr404('monitoring_policies', ctx, b.monitoring_policy_id); patch.policy_accepted_at = null; policyChanged = true; }
    const cols = Object.keys(patch).filter(k => patch[k] !== undefined);
    if (!cols.length) return before;
    const after = await one<any>(`UPDATE placements SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')}, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, ctx.orgId, ...cols.map(k => patch[k])]);
    const changed = cols.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]) && k !== 'policy_accepted_at');
    if (changed.length) await activity(ctx, 'placement', id, 'system', `Updated ${changed.map(c => c.replace(/_id$/, '').replace(/_/g, ' ')).join(', ')}`, policyChanged ? 'Monitoring policy changed — the worker must accept the new policy before their next clock-in.' : null);
    if (policyChanged) await audit(ctx, 'placement.monitoring_policy_changed', { type: 'placement', id }, { monitoring_policy_id: before.monitoring_policy_id }, { monitoring_policy_id: b.monitoring_policy_id });
    return after;
  });

  app.post('/api/v1/placements/:id/status', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'edit');
    const { id } = req.params as { id: string };
    const b = z.object({ status: z.enum(['active', 'on_leave', 'notice']), reason: z.string().min(3, 'Add a short reason').max(500), end_date: date.optional() }).parse(req.body);
    const p = await placementFull(ctx.orgId, id);
    if (!p) throw notFound();
    if (p.status === 'onboarding' && b.status === 'active') throw conflict('Use Activate to start an onboarding placement (required items are checked)');
    assertTransition('placement', p.status, b.status);
    if (b.status === 'notice' && !b.end_date && !p.end_date) throw fieldErr({ end_date: 'Notice needs an end date' });
    await q(`UPDATE placements SET status=$3, end_date=COALESCE($4, end_date), updated_at=now() WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId, b.status, b.end_date ?? null]);
    if (b.status === 'active' && p.status === 'notice') await q(`UPDATE placements SET end_date=NULL WHERE id=$1`, [id]);
    await syncWorkerStatus(ctx.orgId, p.worker_id);
    await activity(ctx, 'placement', id, 'status_change', `Status changed: ${p.status.replace('_', ' ')} → ${b.status.replace('_', ' ')}`, b.reason, { from: p.status, to: b.status });
    await audit(ctx, 'placement.status_changed', { type: 'placement', id, label: p.worker_name }, { status: p.status }, { status: b.status, end_date: b.end_date }, b.reason);
    await emit(ctx.orgId, `placement.${b.status}`, eventPayload(p, { reason: b.reason }));
    return placementFull(ctx.orgId, id);
  });

  // ── Onboarding checklist ──
  app.get('/api/v1/placements/:id/onboarding', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'view');
    const { id } = req.params as { id: string };
    await getOr404('placements', ctx, id);
    return q(`SELECT i.*, du.name done_by_name, cu.name created_by_name, ru.name required_changed_by_name FROM placement_onboarding_items i LEFT JOIN users du ON du.id=i.done_by LEFT JOIN users cu ON cu.id=i.created_by LEFT JOIN users ru ON ru.id=i.required_changed_by
      WHERE i.placement_id=$1 AND i.organization_id=$2 AND i.removed_at IS NULL ORDER BY CASE i.source WHEN 'agency' THEN 0 WHEN 'client' THEN 1 WHEN 'position' THEN 2 ELSE 3 END, i.sort, i.created_at`, [id, ctx.orgId]);
  });
  const canOnb = (ctx: Ctx) => { if (!can(ctx, 'onboarding', 'edit') && !can(ctx, 'placements', 'edit')) throw forbidden(`Your role (${ctx.role.name}) cannot edit onboarding`); };
  app.post('/api/v1/placements/:id/onboarding', async (req) => {
    const ctx = staff(req); canOnb(ctx);
    const { id } = req.params as { id: string };
    const p = await getOr404<any>('placements', ctx, id);
    if (p.status === 'ended') throw conflict('Ended placements are read-only');
    const b = z.object({ title: z.string().min(2, 'Give the item a title').max(200), required: z.boolean().default(false), owner: z.enum(['agency', 'worker', 'client']).default('agency') }).parse(req.body);
    const r = await one<any>(`INSERT INTO placement_onboarding_items (organization_id, placement_id, title, source, required, owner, sort, created_by) VALUES ($1,$2,$3,'manual',$4,$5,(SELECT COALESCE(max(sort),0)+1 FROM placement_onboarding_items WHERE placement_id=$2),$6) RETURNING *`, [ctx.orgId, id, b.title, b.required, b.owner, ctx.userId]);
    await activity(ctx, 'placement', id, 'system', `Onboarding item added: ${b.title}`, b.required ? 'Required for activation' : 'Optional');
    return r;
  });
  app.patch('/api/v1/onboarding/items/:itemId', async (req) => {
    const ctx = staff(req); canOnb(ctx);
    const { itemId } = req.params as { itemId: string };
    const it = await getOr404<any>('placement_onboarding_items', ctx, itemId, 'AND removed_at IS NULL');
    const p = await getOr404<any>('placements', ctx, it.placement_id);
    if (p.status === 'ended') throw conflict('Ended placements are read-only');
    const b = z.object({ done: z.boolean().optional(), required: z.boolean().optional(), note: z.string().max(500).nullable().optional() }).parse(req.body);
    if (b.done !== undefined) {
      await q(`UPDATE placement_onboarding_items SET done_at=$2, done_by=$3 WHERE id=$1`, [itemId, b.done ? new Date().toISOString() : null, b.done ? ctx.userId : null]);
      await activity(ctx, 'placement', it.placement_id, 'system', `${b.done ? 'Completed' : 'Reopened'}: ${it.title}`, null, { item_id: itemId });
    }
    if (b.required !== undefined && b.required !== it.required) {
      await q(`UPDATE placement_onboarding_items SET required=$2, required_changed_by=$3, required_changed_at=now() WHERE id=$1`, [itemId, b.required, ctx.userId]);
      await activity(ctx, 'placement', it.placement_id, 'system', `Marked ${b.required ? 'required' : 'optional'}: ${it.title}`);
      await audit(ctx, 'onboarding.required_changed', { type: 'placement', id: it.placement_id, label: it.title }, { required: it.required }, { required: b.required });
    }
    if (b.note !== undefined) await q(`UPDATE placement_onboarding_items SET note=$2 WHERE id=$1`, [itemId, b.note]);
    return one(`SELECT i.*, du.name done_by_name FROM placement_onboarding_items i LEFT JOIN users du ON du.id=i.done_by WHERE i.id=$1`, [itemId]);
  });
  app.delete('/api/v1/onboarding/items/:itemId', async (req) => {
    const ctx = staff(req); canOnb(ctx);
    const { itemId } = req.params as { itemId: string };
    const it = await getOr404<any>('placement_onboarding_items', ctx, itemId, 'AND removed_at IS NULL');
    if (it.source !== 'manual') throw conflict(`Only manual items can be removed — this item comes from the ${it.source} requirements. Mark it optional instead.`);
    await q(`UPDATE placement_onboarding_items SET removed_at=now(), removed_by=$2 WHERE id=$1`, [itemId, ctx.userId]);
    await activity(ctx, 'placement', it.placement_id, 'system', `Onboarding item removed: ${it.title}`);
    return { ok: true };
  });
  // Onboarding overview (all placements in onboarding with progress).
  app.get('/api/v1/onboarding', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'view');
    const lp = listParams(req);
    const where = ['p.organization_id=$1', `p.status='onboarding'`]; const params: unknown[] = [ctx.orgId];
    if (lp.filters.blocked === 'true') where.push(`EXISTS (SELECT 1 FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.required AND i.done_at IS NULL AND i.removed_at IS NULL)`);
    if (lp.filters.ready === 'true') where.push(`NOT EXISTS (SELECT 1 FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.required AND i.done_at IS NULL AND i.removed_at IS NULL)`);
    if (lp.filters.company_id) { params.push(lp.filters.company_id); where.push(`p.company_id=$${params.length}`); }
    const r = await paged({ select: `${LIST_SELECT}, (SELECT string_agg(i.title, ', ' ORDER BY i.sort) FROM placement_onboarding_items i WHERE i.placement_id=p.id AND i.required AND i.done_at IS NULL AND i.removed_at IS NULL) missing`, from: LIST_FROM, where, params, lp, searchCols: ['cd.first_name', 'cd.last_name', 'co.name', 'p.title'], sortMap: { start_date: 'p.start_date', worker_name: 'cd.first_name', company_name: 'co.name' }, defaultSort: 'p.start_date ASC' });
    return { ...r, rows: r.rows.map(x => redact(ctx, x)) };
  });

  // ── Activation (CONTRACTS §5) ──
  app.post('/api/v1/placements/:id/activate', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'edit');
    const { id } = req.params as { id: string };
    const b = z.object({ override_reason: z.string().max(1000).optional() }).parse(req.body ?? {});
    const p = await placementFull(ctx.orgId, id);
    if (!p) throw notFound();
    assertTransition('placement', p.status, 'active');
    const missing = await q<any>(`SELECT title FROM placement_onboarding_items WHERE placement_id=$1 AND required AND done_at IS NULL AND removed_at IS NULL ORDER BY sort, created_at`, [id]);
    const override = !!b.override_reason?.trim();
    if (missing.length && !override) throw conflict(`Cannot activate: ${missing.length} required onboarding item${missing.length === 1 ? ' is' : 's are'} incomplete — ${missing.map(m => m.title).join('; ')}`, { missing: missing.map(m => m.title) });
    if (missing.length && override) { if (!can(ctx, 'placements', 'approve')) throw forbidden('Only roles with placement approval can override activation blockers'); if (b.override_reason!.trim().length < 5) throw fieldErr({ override_reason: 'Explain why activation is being overridden' }); }
    await tx(async c => {
      await q(`UPDATE placements SET status='active', activated_at=now(), activated_by=$3, activation_override_reason=$4, updated_at=now() WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId, ctx.userId, missing.length ? b.override_reason : null], c);
      await q(`UPDATE workers SET status='active', updated_at=now() WHERE id=$1`, [p.worker_id], c);
      const open = await one(`SELECT 1 FROM seat_usage WHERE placement_id=$1 AND ended_at IS NULL`, [id], c);
      if (!open) await q(`INSERT INTO seat_usage (organization_id, worker_id, placement_id, started_by) VALUES ($1,$2,$3,$4)`, [ctx.orgId, p.worker_id, id, ctx.userId], c);
      await activity(ctx, 'placement', id, 'status_change', missing.length ? 'Activated with override' : 'Worker activated — placement started', missing.length ? `Override reason: ${b.override_reason}. Incomplete required items: ${missing.map(m => m.title).join(', ')}` : 'All required onboarding items complete. Active-worker seat started.', { from: 'onboarding', to: 'active' }, c);
      await activity(ctx, 'worker', p.worker_id, 'status_change', `Activated at ${p.company_name}`, null, {}, c);
    });
    await audit(ctx, missing.length ? 'placement.activation_override' : 'placement.activated', { type: 'placement', id, label: `${p.worker_name} @ ${p.company_name}` }, { status: 'onboarding' }, { status: 'active', missing: missing.map(m => m.title) }, b.override_reason);
    await audit(ctx, 'seat.started', { type: 'placement', id, label: p.worker_name }, null, { worker_id: p.worker_id });
    if (missing.length) await notify(ctx.orgId, (await usersWithRoles(ctx.orgId, ['owner', 'admin'])).filter(u => u !== ctx.userId), { event: 'activation.override', title: `Activation override: ${p.worker_name}`, body: `${ctx.user.name} activated ${p.worker_name} at ${p.company_name} with ${missing.length} incomplete required item(s). Reason: ${b.override_reason}`, link: `/workforce/placements/${id}` });
    await notify(ctx.orgId, [p.account_manager_id, p.recruiter_id].filter(u => u && u !== ctx.userId), { event: 'placement.started', title: `${p.worker_name} is now active at ${p.company_name}`, link: `/workforce/placements/${id}` });
    await emit(ctx.orgId, 'placement.started', eventPayload(p, { start_date: p.start_date, override: missing.length > 0 }));
    return placementFull(ctx.orgId, id);
  });

  // ── Invite to Worker Portal (explicit, separate from activation) ──
  app.post('/api/v1/placements/:id/invite', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'edit');
    const { id } = req.params as { id: string };
    const p = await placementFull(ctx.orgId, id);
    if (!p) throw notFound();
    if (p.status === 'ended') throw conflict('This placement has ended');
    // Only an active *worker* membership counts; a hired candidate's candidate-portal login must still be invitable.
    if (p.worker_user_id) { const m = await one(`SELECT 1 FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='active' AND r.kind='worker'`, [ctx.orgId, p.worker_user_id]); if (m) throw conflict(`${p.worker_name} already has Worker Portal access`); }
    if (!p.worker_email) throw badRequest('This worker has no email address on file — add one to the candidate profile first');
    const role = await one<any>(`SELECT id FROM roles WHERE organization_id=$1 AND key='worker'`, [ctx.orgId]);
    await q(`UPDATE invitations SET status='revoked' WHERE organization_id=$1 AND worker_id=$2 AND status='pending'`, [ctx.orgId, p.worker_id]);
    const token = crypto.randomBytes(24).toString('base64url');
    const inv = await one<any>(`INSERT INTO invitations (organization_id, email, name, role_id, token, worker_id, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '7 days') RETURNING id, email, expires_at, status, created_at`, [ctx.orgId, p.worker_email.toLowerCase(), p.worker_name, role.id, token, p.worker_id, ctx.userId]);
    await sendTemplate(ctx.orgId, 'invite_worker_portal', p.worker_email, { invitee: { name: p.worker_name }, org: { name: ctx.org.name }, link: `${WEB_URL}/invite/${token}` }, { related: { type: 'placement', id } });
    await activity(ctx, 'placement', id, 'system', `Invited ${p.worker_name} to the Worker Portal`, `Invitation emailed to ${p.worker_email}; expires in 7 days.`);
    await audit(ctx, 'invitation.sent', { type: 'worker', id: p.worker_id, label: p.worker_email }, null, { role: 'worker', placement_id: id });
    return inv;
  });

  // ── Offboarding ──
  app.post('/api/v1/placements/:id/offboard', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'edit');
    const { id } = req.params as { id: string };
    const b = z.object({ end_date: date, reason: z.string().min(3, 'Give a reason').max(500), final_timesheet: z.boolean().default(true) }).parse(req.body);
    const p = await placementFull(ctx.orgId, id);
    if (!p) throw notFound();
    if (b.end_date < p.start_date) throw fieldErr({ end_date: 'End date cannot be before the start date' });
    if (b.end_date > todayIn(p.timezone)) {
      // Future end date → notice period; the daily job completes offboarding on the end date.
      if (p.status !== 'notice') assertTransition('placement', p.status, 'notice');
      await q(`UPDATE placements SET status='notice', end_date=$3, end_reason=$4, updated_at=now() WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId, b.end_date, b.reason]);
      await activity(ctx, 'placement', id, 'status_change', `Offboarding scheduled for ${b.end_date}`, b.reason, { from: p.status, to: 'notice' });
      await audit(ctx, 'placement.offboarding_scheduled', { type: 'placement', id, label: p.worker_name }, { status: p.status }, { status: 'notice', end_date: b.end_date }, b.reason);
      return { scheduled: true, end_date: b.end_date };
    }
    return endPlacement(ctx, id, b);
  });

  // Staff "Simulate rest of week" (demo): fills unworked scheduled days this week and optionally submits.
  app.post('/api/v1/placements/:id/simulate-week', async (req) => {
    const ctx = staff(req); need(ctx, 'time', 'edit');
    const { id } = req.params as { id: string };
    const b = z.object({ submit: z.boolean().default(true), week_start: date.optional() }).parse(req.body ?? {});
    const p = await placementFull(ctx.orgId, id);
    if (!p) throw notFound();
    if (p.status !== 'active' && p.status !== 'notice') throw conflict('Only active placements can log time');
    return simulateWeek(ctx, p, b.week_start ?? weekStart(todayIn(p.timezone)), b.submit, 'agency');
  });

  // ── Equipment ──
  app.get('/api/v1/equipment-templates', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'view');
    return q(`SELECT * FROM equipment_templates WHERE organization_id=$1 ORDER BY name`, [ctx.orgId]);
  });
  const eqBody = z.object({ name: z.string().min(2).max(120), items: z.array(z.string().min(1).max(120)).min(1, 'Add at least one item') });
  app.post('/api/v1/equipment-templates', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'edit');
    const b = eqBody.parse(req.body);
    return one(`INSERT INTO equipment_templates (organization_id, name, items) VALUES ($1,$2,$3) RETURNING *`, [ctx.orgId, b.name, JSON.stringify(b.items)]);
  });
  app.patch('/api/v1/equipment-templates/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'edit');
    const { id } = req.params as { id: string };
    await getOr404('equipment_templates', ctx, id);
    const b = eqBody.partial().parse(req.body);
    return one(`UPDATE equipment_templates SET name=COALESCE($3,name), items=COALESCE($4,items) WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, ctx.orgId, b.name ?? null, b.items ? JSON.stringify(b.items) : null]);
  });
  app.delete('/api/v1/equipment-templates/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'edit');
    const { id } = req.params as { id: string };
    const t = await getOr404<any>('equipment_templates', ctx, id);
    await q(`DELETE FROM equipment_templates WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]);
    await audit(ctx, 'equipment_template.deleted', { type: 'equipment_template', id, label: t.name });
    return { ok: true };
  });
  app.post('/api/v1/placements/:id/equipment/apply-template', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'edit');
    const { id } = req.params as { id: string };
    const { template_id } = z.object({ template_id: uuid }).parse(req.body);
    await getOr404('placements', ctx, id);
    const t = await getOr404<any>('equipment_templates', ctx, template_id);
    const r = await one(`UPDATE placements SET equipment=$3, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING equipment`, [id, ctx.orgId, JSON.stringify(t.items)]);
    await activity(ctx, 'placement', id, 'system', `Equipment set from template "${t.name}"`);
    return r;
  });

  // Documents for the placement's worker (read-only listing with signed links).
  app.get('/api/v1/placements/:id/documents', async (req) => {
    const ctx = staff(req); need(ctx, 'placements', 'view');
    const { id } = req.params as { id: string };
    const p = await getOr404<any>('placements', ctx, id);
    if (!can(ctx, 'documents', 'view')) return { rows: [], restricted: true };
    const rows = await q<any>(`SELECT id, name, category, file, mime, visibility, issue_date, expires_at, verification, signature_status, created_at FROM documents WHERE organization_id=$1 AND archived_at IS NULL AND ((entity_type='worker' AND entity_id=$2) OR (entity_type='placement' AND entity_id=$3)) ORDER BY created_at DESC`, [ctx.orgId, p.worker_id, id]);
    return { rows: rows.map(r => ({ ...r, url: signedUrl(r.file), file: undefined })), restricted: false };
  });

  // Notice periods ending → complete offboarding automatically (runs every 10 minutes).
  every('workforce.notice_end', 10 * 60 * 1000, async () => {
    const due = await q<any>(`SELECT id, organization_id, end_date, end_reason, timezone FROM placements WHERE status IN ('notice','active','on_leave') AND end_date IS NOT NULL AND end_date < (now() AT TIME ZONE timezone)::date LIMIT 20`);
    for (const p of due) {
      try { await endPlacement(sysActor(p.organization_id), p.id, { end_date: p.end_date, reason: p.end_reason ?? 'End date reached', final_timesheet: true }); } catch (e: any) { console.error('[notice_end]', e?.message); }
    }
  });
}

/** Shared by staff + worker "simulate rest of week": creates each unworked scheduled day, then submits. */
export async function simulateWeek(actor: Actor, p: any, wk: string, submit: boolean, party: 'agency' | 'worker') {
  const worked = new Set((await q<any>(`SELECT DISTINCT work_date::text d FROM time_entries WHERE placement_id=$1 AND work_date BETWEEN $2::date AND $2::date + 6`, [p.id, wk])).map(r => r.d));
  const open = await one<any>(`SELECT id FROM time_entries WHERE placement_id=$1 AND ended_at IS NULL`, [p.id]);
  const ts0 = await one<any>(`SELECT status FROM timesheets WHERE placement_id=$1 AND week_start=$2`, [p.id, wk]);
  if (ts0 && ['submitted', 'approved', 'locked'].includes(ts0.status)) throw conflict(`This week's timesheet is already ${ts0.status}`);
  const days = scheduledDays(p, wk).filter(d => !worked.has(d) && d >= p.start_date && (!p.end_date || d <= p.end_date));
  let shots = 0, minutes = 0;
  await tx(async c => {
    for (const d of days) { const r = await simulateWorkday(actor.orgId, p, d, c); shots += r.shots; minutes += r.minutes; }
  });
  let ts = await rebuildTimesheet(actor.orgId, p.id, wk);
  if (submit && !open && ts && (ts.status === 'open' || ts.status === 'rejected')) {
    ts = await one<any>(`UPDATE timesheets SET status='submitted', submitted_at=now(), rejected_reason=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [ts.id]);
    await q(`INSERT INTO timesheet_approvals (organization_id, timesheet_id, actor_id, party, decision, reason) VALUES ($1,$2,$3,'agency','submitted',$4)`, [actor.orgId, ts.id, actor.userId || null, party === 'worker' ? 'Submitted by worker' : 'Submitted by staff (simulated week)']);
    await activity(actor, 'timesheet', ts.id, 'status_change', `Timesheet submitted (${(ts.total_minutes / 60).toFixed(1)}h)`, null, { from: 'open', to: 'submitted' });
    await emit(actor.orgId, 'timesheet.submitted', eventPayload(p, { timesheet_id: ts.id, week_start: wk, total_minutes: ts.total_minutes }));
    const approverIds = p.timesheet_approval === 'agency' ? [p.account_manager_id] : await clientApprovers(actor.orgId, p.company_id);
    await notify(actor.orgId, approverIds, { event: 'timesheet.submitted', title: `Timesheet to approve: ${p.worker_name}`, body: `Week of ${wk} · ${(ts.total_minutes / 60).toFixed(1)}h`, link: p.timesheet_approval === 'agency' ? `/time/timesheets/${ts.id}` : `/portal/client/timesheets` });
    if (p.timesheet_approval !== 'agency') await notify(actor.orgId, [p.account_manager_id], { event: 'timesheet.submitted', title: `Timesheet submitted: ${p.worker_name}`, body: `Week of ${wk} · awaiting client approval`, link: `/time/timesheets/${ts.id}` });
  }
  await activity(actor, 'placement', p.id, 'system', `Simulated ${days.length} workday${days.length === 1 ? '' : 's'} (demo)`, `${(minutes / 60).toFixed(1)}h, ${shots} screenshots, activity samples generated.`);
  return { days, shots, minutes, timesheet: ts, submitted: ts?.status === 'submitted' };
}

export async function clientApprovers(orgId: string, companyId: string) {
  return (await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.company_id=$2 AND m.status='active' AND r.key IN ('client_owner','client_manager','client_supervisor')`, [orgId, companyId])).map(r => r.user_id);
}
