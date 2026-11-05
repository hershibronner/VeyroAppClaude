import { humanDate } from '../../core/templates';
// Timesheet approval engine shared by the agency app and the client portal.
import { q, one, tx } from '../../core/db';
import type { Ctx } from '../../core/context';
import { assertTransition } from '../../core/context';
import { conflict } from '../../core/errors';
import { audit, activity } from '../../core/audit';
import { notify } from '../../core/notify';
import { emit } from '../../core/events';
import { publishOrg } from '../../core/realtime';
import { placementFull, eventPayload, weekDays, rebuildTimesheet, ENTRY_MIN } from './lib';

type Actor = Pick<Ctx, 'orgId' | 'userId' | 'user' | 'impersonatorId' | 'ip'>;

export async function timesheetDetail(orgId: string, id: string) {
  const t = await one<any>(`SELECT t.*, p.title, p.timezone, p.account_manager_id, p.schedule_days, p.schedule_start, p.schedule_end, (cd.first_name || COALESCE(' ' || cd.last_name, '')) worker_name, cd.avatar_color, co.name company_name, co.timesheet_approval,
      au.name agency_approved_by_name, cu.name client_approved_by_name, am.name account_manager_name
    FROM timesheets t JOIN placements p ON p.id=t.placement_id JOIN workers w ON w.id=t.worker_id JOIN candidates cd ON cd.id=w.candidate_id JOIN companies co ON co.id=t.company_id
    LEFT JOIN users au ON au.id=t.agency_approved_by LEFT JOIN users cu ON cu.id=t.client_approved_by LEFT JOIN users am ON am.id=p.account_manager_id WHERE t.id=$1 AND t.organization_id=$2`, [id, orgId]);
  if (!t) return null;
  const [entries, history, adjustments, snapshot, live, attendance, act, shots] = await Promise.all([
    q<any>(`SELECT e.id, e.work_date::text work_date, e.started_at, e.ended_at, e.memo, e.source, e.break_seconds, e.idle_seconds, e.discarded_idle_seconds, ${ENTRY_MIN()} minutes FROM time_entries e WHERE e.placement_id=$1 AND e.work_date BETWEEN $2::date AND $2::date + 6 ORDER BY e.started_at`, [t.placement_id, t.week_start]),
    q<any>(`SELECT a.party, a.decision, a.reason, a.created_at, u.name actor_name FROM timesheet_approvals a LEFT JOIN users u ON u.id=a.actor_id WHERE a.timesheet_id=$1 ORDER BY a.created_at`, [id]),
    q<any>(`SELECT a.id, a.work_date::text work_date, a.minutes_delta, a.reason, a.created_at, a.applied_invoice_id, a.applied_payroll_run_id, u.name created_by_name FROM timesheet_adjustments a LEFT JOIN users u ON u.id=a.created_by WHERE a.timesheet_id=$1 ORDER BY a.created_at`, [id]),
    q<any>(`SELECT work_date::text work_date, minutes, invoice_id IS NOT NULL invoiced, payroll_item_id IS NOT NULL paid FROM timesheet_days WHERE timesheet_id=$1 ORDER BY work_date`, [id]),
    weekDays(t.placement_id, t.week_start, undefined, true),
    q<any>(`SELECT work_date::text work_date, kind, minutes, note FROM attendance_events WHERE placement_id=$1 AND work_date BETWEEN $2::date AND $2::date + 6 ORDER BY work_date`, [t.placement_id, t.week_start]),
    one<any>(`SELECT round(sum(a.active_seconds)::numeric * 100 / NULLIF(sum(a.bucket_seconds),0))::int pct FROM activity_samples a JOIN time_entries e ON e.id=a.time_entry_id WHERE e.placement_id=$1 AND e.work_date BETWEEN $2::date AND $2::date + 6`, [t.placement_id, t.week_start]),
    one<any>(`SELECT count(*)::int n, count(*) FILTER (WHERE s.flagged)::int flagged FROM screenshots s JOIN time_entries e ON e.id=s.time_entry_id WHERE e.placement_id=$1 AND e.work_date BETWEEN $2::date AND $2::date + 6 AND s.deleted_at IS NULL`, [t.placement_id, t.week_start]),
  ]);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(t.week_start + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); }).map(d => {
    const snap = snapshot.find(s => s.work_date === d);
    const adj = adjustments.filter(a => a.work_date === d).reduce((s, a) => s + a.minutes_delta, 0);
    return { date: d, tracked_minutes: live.find(x => x.d === d)?.m ?? 0, approved_minutes: snap ? snap.minutes : null, adjustment_minutes: adj, invoiced: snap?.invoiced ?? false, paid: snap?.paid ?? false, attendance: attendance.filter(a => a.work_date === d) };
  });
  const needs = { agency: t.timesheet_approval === 'agency' || t.timesheet_approval === 'both', client: t.timesheet_approval === 'client' || t.timesheet_approval === 'both' };
  return { ...t, days, entries, history, adjustments, avg_activity: act?.pct ?? null, screenshots: shots, needs, open_entries: entries.filter(e => !e.ended_at).length };
}

/** Approve as agency or client. Final approval (per companies.timesheet_approval) snapshots timesheet_days. */
export async function approveTimesheet(actor: Actor, id: string, party: 'agency' | 'client', opts: { onBehalf?: boolean; reason?: string } = {}) {
  const t = await one<any>(`SELECT t.*, co.timesheet_approval mode FROM timesheets t JOIN companies co ON co.id=t.company_id WHERE t.id=$1 AND t.organization_id=$2`, [id, actor.orgId]);
  if (!t) return null;
  if (t.status !== 'submitted') assertTransition('timesheet', t.status, 'approved');
  const mode: string = t.mode;
  if (party === 'agency' && mode === 'client' && !opts.onBehalf) throw conflict('This client approves timesheets in the Client Portal. Approve on their behalf with a reason if they asked you to.', { needs_on_behalf: true });
  if (party === 'client' && mode === 'agency') throw conflict('Your agency approves these timesheets — no action is needed from you');
  const asClient = party === 'client' || (party === 'agency' && !!opts.onBehalf && mode !== 'agency');
  if (!asClient && t.agency_approved_at) throw conflict('The agency has already approved this timesheet');
  if (asClient && t.client_approved_at) throw conflict(party === 'client' ? 'You have already approved this timesheet' : 'The client has already approved this timesheet');
  const open = await one(`SELECT 1 FROM time_entries WHERE placement_id=$1 AND ended_at IS NULL AND work_date BETWEEN $2::date AND $2::date + 6`, [t.placement_id, t.week_start]);
  if (open) throw conflict('The worker is still clocked in for this week — approve after they clock out');
  const p = await placementFull(actor.orgId, t.placement_id);
  const res = await tx(async c => {
    if (asClient) await q(`UPDATE timesheets SET client_approved_at=now(), client_approved_by=$2 WHERE id=$1`, [id, actor.userId], c);
    else await q(`UPDATE timesheets SET agency_approved_at=now(), agency_approved_by=$2 WHERE id=$1`, [id, actor.userId], c);
    await q(`INSERT INTO timesheet_approvals (organization_id, timesheet_id, actor_id, party, decision, reason) VALUES ($1,$2,$3,$4,'approved',$5)`, [actor.orgId, id, actor.userId, asClient ? 'client' : 'agency', opts.onBehalf ? `On behalf of client: ${opts.reason ?? ''}` : null], c);
    const cur = await one<any>(`SELECT agency_approved_at, client_approved_at FROM timesheets WHERE id=$1`, [id], c);
    const final = mode === 'agency' ? !!cur.agency_approved_at : mode === 'client' ? !!cur.client_approved_at : !!(cur.agency_approved_at && cur.client_approved_at);
    if (!final) return { final: false, total: t.total_minutes };
    const days = await weekDays(t.placement_id, t.week_start, c);
    for (const d of days) await q(`INSERT INTO timesheet_days (organization_id, timesheet_id, placement_id, work_date, minutes) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (timesheet_id, work_date) DO NOTHING`, [actor.orgId, id, t.placement_id, d.d, d.m], c);
    const total = days.reduce((s, d) => s + d.m, 0);
    await q(`UPDATE timesheets SET status='approved', approved_at=now(), total_minutes=$2, rejected_reason=NULL, updated_at=now() WHERE id=$1`, [id, total], c);
    return { final: true, total };
  });
  const hrs = (res.total / 60).toFixed(1);
  if (res.final) {
    await activity(actor, 'timesheet', id, 'status_change', `Timesheet approved (${hrs}h)`, `${asClient ? 'Client' : 'Agency'} approval by ${actor.user.name}${opts.onBehalf ? ' on behalf of the client' : ''}. Approved time is now locked for invoicing and payroll.`, { from: 'submitted', to: 'approved' });
    await activity(actor, 'placement', t.placement_id, 'system', `Timesheet approved — week of ${humanDate(t.week_start)} (${hrs}h)`);
    await audit(actor, 'timesheet.approved', { type: 'timesheet', id, label: `${p.worker_name} · week of ${humanDate(t.week_start)}` }, { status: 'submitted' }, { status: 'approved', total_minutes: res.total, party: asClient ? 'client' : 'agency' }, opts.onBehalf ? opts.reason : undefined);
    await emit(actor.orgId, 'timesheet.approved', eventPayload(p, { timesheet_id: id, week_start: t.week_start, total_minutes: res.total, approved_by: actor.user.name, party: asClient ? 'client' : 'agency' }));
    await notify(actor.orgId, [p.account_manager_id].filter(u => u && u !== actor.userId), { event: 'timesheet.approved', title: `Timesheet approved: week of ${humanDate(t.week_start)}`, body: `${p.worker_name} · ${hrs}h approved by ${actor.user.name}`, link: `/time/timesheets/${id}` });
    await notify(actor.orgId, [p.worker_user_id].filter(u => u && u !== actor.userId), { event: 'timesheet.approved', title: `Your timesheet was approved: week of ${humanDate(t.week_start)}`, body: `${hrs}h approved by ${actor.user.name}`, link: '/portal/worker/timesheets' });
  } else {
    await activity(actor, 'timesheet', id, 'system', `${asClient ? 'Client' : 'Agency'} approved — awaiting ${asClient ? 'agency' : 'client'} approval`, `By ${actor.user.name}`);
    await audit(actor, 'timesheet.partially_approved', { type: 'timesheet', id, label: `${p.worker_name} · week of ${humanDate(t.week_start)}` }, null, { party: asClient ? 'client' : 'agency' });
  }
  publishOrg(actor.orgId, 'timesheet', { id, status: res.final ? 'approved' : 'submitted' });
  return { ok: true, final: res.final, status: res.final ? 'approved' : 'submitted', total_minutes: res.total };
}

export async function rejectTimesheet(actor: Actor, id: string, party: 'agency' | 'client', reason: string) {
  const t = await one<any>(`SELECT t.*, co.timesheet_approval mode FROM timesheets t JOIN companies co ON co.id=t.company_id WHERE t.id=$1 AND t.organization_id=$2`, [id, actor.orgId]);
  if (!t) return null;
  assertTransition('timesheet', t.status, 'rejected');
  if (party === 'client' && t.mode === 'agency') throw conflict('Your agency approves these timesheets — contact your account manager about changes');
  const p = await placementFull(actor.orgId, t.placement_id);
  await q(`UPDATE timesheets SET status='rejected', rejected_reason=$2, agency_approved_at=NULL, agency_approved_by=NULL, client_approved_at=NULL, client_approved_by=NULL, updated_at=now() WHERE id=$1`, [id, reason]);
  await q(`INSERT INTO timesheet_approvals (organization_id, timesheet_id, actor_id, party, decision, reason) VALUES ($1,$2,$3,$4,'rejected',$5)`, [actor.orgId, id, actor.userId, party, reason]);
  await activity(actor, 'timesheet', id, 'status_change', `Timesheet rejected by ${actor.user.name}`, reason, { from: 'submitted', to: 'rejected' });
  await activity(actor, 'placement', t.placement_id, 'system', `Timesheet rejected — week of ${humanDate(t.week_start)}`, reason);
  await audit(actor, 'timesheet.rejected', { type: 'timesheet', id, label: `${p.worker_name} · week of ${humanDate(t.week_start)}` }, { status: t.status }, { status: 'rejected', party }, reason);
  await emit(actor.orgId, 'timesheet.rejected', eventPayload(p, { timesheet_id: id, week_start: t.week_start, reason, party }));
  await notify(actor.orgId, [p.account_manager_id].filter(u => u && u !== actor.userId), { event: 'timesheet.rejected', title: `Timesheet rejected: week of ${humanDate(t.week_start)}`, body: `${p.worker_name} — ${reason}`, link: `/time/timesheets/${id}` });
  await notify(actor.orgId, [p.worker_user_id].filter(u => u && u !== actor.userId), { event: 'timesheet.rejected', title: `Your timesheet was rejected: week of ${humanDate(t.week_start)}`, body: reason, link: '/portal/worker/timesheets' });
  publishOrg(actor.orgId, 'timesheet', { id, status: 'rejected' });
  return { ok: true, status: 'rejected' };
}

export async function submitTimesheet(actor: Actor, id: string, note: string) {
  const t0 = await one<any>(`SELECT * FROM timesheets WHERE id=$1 AND organization_id=$2`, [id, actor.orgId]);
  if (!t0) return null;
  assertTransition('timesheet', t0.status, 'submitted');
  const open = await one(`SELECT 1 FROM time_entries WHERE placement_id=$1 AND ended_at IS NULL AND work_date BETWEEN $2::date AND $2::date + 6`, [t0.placement_id, t0.week_start]);
  if (open) throw conflict('The worker is still clocked in for this week');
  const t = await rebuildTimesheet(actor.orgId, t0.placement_id, t0.week_start);
  if (!t.total_minutes) throw conflict('There is no time on this timesheet yet');
  await q(`UPDATE timesheets SET status='submitted', submitted_at=now(), rejected_reason=NULL, updated_at=now() WHERE id=$1`, [id]);
  await q(`INSERT INTO timesheet_approvals (organization_id, timesheet_id, actor_id, party, decision, reason) VALUES ($1,$2,$3,'agency','submitted',$4)`, [actor.orgId, id, actor.userId, note]);
  const p = await placementFull(actor.orgId, t0.placement_id);
  await activity(actor, 'timesheet', id, 'status_change', `Timesheet submitted by ${actor.user.name}`, note, { from: t0.status, to: 'submitted' });
  await emit(actor.orgId, 'timesheet.submitted', eventPayload(p, { timesheet_id: id, week_start: t0.week_start, total_minutes: t.total_minutes }));
  publishOrg(actor.orgId, 'timesheet', { id, status: 'submitted' });
  return { ok: true, status: 'submitted' };
}
