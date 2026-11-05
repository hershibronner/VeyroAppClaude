// RECRUITING — Submissions (Candidate × Position pipeline), Interviews (+ICS, reminders, feedback),
// Assessments (template library, Sent → Started → Completed → Scored), Offers (Draft → Approved → Sent → Viewed → Accepted/Declined/Expired).
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { q, one, insertRow, updateRow, tx } from '../core/db';
import { staff, need, can, assertTransition, getOr404, canViewComp } from '../core/context';
import { badRequest, conflict, forbidden, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify, usersWithRoles } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { every } from '../jobs/queue';
import { sendMessage, sendTemplate } from '../adapters/messaging';
import { WEB_URL } from '../core/settings';
import { canTransition, formatMoney } from '@veyro/shared';
import { draft } from '../adapters/ai';
import { viewablePosition, assertEditLinked, editScope, positionScopeSql, positionInScope, clientSafeProfile, candOut, fullName, stripOfferComp, meetingUrl, buildIcs, fmtWhen, positionRecruiters, fileUrl } from './_recruiting/common';

const SHARE = z.object({ contact: z.boolean().default(false), rate: z.boolean().default(false), notes: z.boolean().default(false) });

/** Client portal users for a company (to notify about submissions/interviews). */
async function clientUsers(orgId: string, companyId: string | null) {
  if (!companyId) return [];
  return (await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.company_id=$2 AND m.status='active' AND r.kind='client' AND r.key IN ('client_owner','client_manager','client_supervisor')`, [orgId, companyId])).map(r => r.user_id);
}
async function candidatePortalUser(orgId: string, candidateId: string) {
  return (await one<any>(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND candidate_id=$2 AND status='active'`, [orgId, candidateId]))?.user_id ?? null;
}
async function ensureCandidateInvite(ctx: any, c: any): Promise<string> {
  if (await candidatePortalUser(ctx.orgId, c.id)) return `${WEB_URL}/portal/candidate`;
  if (!c.email) return `${WEB_URL}/portal/candidate`;
  const role = await one<any>(`SELECT id FROM roles WHERE organization_id=$1 AND key='candidate'`, [ctx.orgId]);
  let inv = await one<any>(`SELECT token FROM invitations WHERE organization_id=$1 AND candidate_id=$2 AND status='pending' AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [ctx.orgId, c.id]);
  if (!inv) {
    inv = await insertRow<any>('invitations', { organization_id: ctx.orgId, email: c.email, name: fullName(c), role_id: role.id, token: crypto.randomBytes(18).toString('base64url'), candidate_id: c.id, invited_by: ctx.userId, expires_at: new Date(Date.now() + 14 * 86400000) });
    await audit(ctx, 'invitation.created', { type: 'candidate', id: c.id, label: fullName(c) }, null, { role: 'candidate', email: c.email });
  }
  return `${WEB_URL}/invite/${inv.token}`;
}
export { clientUsers, candidatePortalUser };

export default async function (app: FastifyInstance) {
  /* ════════ Submissions ════════ */
  const subSelect = `s.*, c.first_name, c.last_name, c.first_name || ' ' || coalesce(c.last_name,'') candidate_name, c.avatar_color, c.headline, c.country, c.status candidate_status, p.title position_title, p.company_id, co.name company_name, u.name submitted_by_name,
    (SELECT min(i.scheduled_at) FROM interviews i WHERE i.submission_id=s.id AND i.status IN ('scheduled','requested') AND i.scheduled_at > now()) next_interview`;
  const subFrom = 'candidate_submissions s JOIN candidates c ON c.id=s.candidate_id JOIN positions p ON p.id=s.position_id LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users u ON u.id=s.submitted_by';
  app.get('/api/v1/submissions', async (req) => {
    const ctx = staff(req);
    need(ctx, 'submissions', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId]; const where = ['s.organization_id = $1'];
    const add = (v: unknown, sql: (n: string) => string) => { params.push(v); where.push(sql(`$${params.length}`)); };
    if (f.status) add(f.status.split(','), n => `s.status = ANY(${n})`);
    if (f.position_id) add(f.position_id, n => `s.position_id = ${n}`);
    if (f.company_id) add(f.company_id, n => `p.company_id = ${n}`);
    if (f.candidate_id) add(f.candidate_id, n => `s.candidate_id = ${n}`);
    if (f.submitted_by) add(f.submitted_by === 'me' ? ctx.userId : f.submitted_by, n => `s.submitted_by = ${n}`);
    if (f.decision) add(f.decision, n => `s.client_decision = ${n}`);
    if (f.from) add(f.from, n => `s.created_at >= ${n}::date`);
    if (f.to) add(f.to, n => `s.created_at < (${n}::date + 1)`);
    if (f.mine === 'true') where.push(positionScopeSql(ctx, 'assigned', 'p', params));
    return paged({ select: subSelect, from: subFrom, where, params, lp, searchCols: ["(c.first_name || ' ' || coalesce(c.last_name,''))", 'p.title', 'co.name'],
      sortMap: { created_at: 's.created_at', updated_at: 's.updated_at', candidate_name: 'c.first_name', position_title: 'p.title', company_name: 'co.name', status: 's.status' }, defaultSort: 's.updated_at DESC' });
  });
  app.get('/api/v1/submissions/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'submissions', 'view');
    const s = await getOr404<any>('candidate_submissions', ctx, (req.params as any).id);
    const row = await one<any>(`SELECT ${subSelect} FROM ${subFrom} WHERE s.id=$1`, [s.id]);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [s.candidate_id]);
    const interviews = await q(`SELECT * FROM interviews WHERE submission_id=$1 ORDER BY scheduled_at DESC`, [s.id]);
    return { ...row, client_profile: clientSafeProfile(c, s), interviews };
  });
  app.post('/api/v1/submissions', async (req) => {
    const ctx = staff(req);
    need(ctx, 'submissions', 'create');
    const b = z.object({ candidate_id: z.string().uuid(), position_id: z.string().uuid(), shareable: SHARE.default({}), presentation: z.string().max(5000).nullable().optional() }).parse(req.body);
    const c = await getOr404<any>('candidates', ctx, b.candidate_id);
    const p = await viewablePosition(ctx, b.position_id);
    await assertEditLinked(ctx, 'submissions', p.id, c);
    if (['open', 'on_hold'].includes(p.status) === false) throw conflict(`This position is ${p.status.replace('_', ' ')} — open it before submitting candidates`);
    if (await one(`SELECT 1 FROM candidate_submissions WHERE candidate_id=$1 AND position_id=$2`, [c.id, p.id])) throw conflict('This candidate is already submitted to this position');
    if (c.status !== 'submitted' && !canTransition('candidate', c.status, 'submitted')) throw conflict(`Move the candidate to Qualified before submitting (currently ${c.status.replace(/_/g, ' ')})`, { needs: 'qualified' });
    const presentation = b.presentation?.trim() || draft('client_presentation', { candidate: c, position: p, includeRate: b.shareable.rate }).body;
    const s = await tx(async (db) => {
      const sub = await insertRow<any>('candidate_submissions', { organization_id: ctx.orgId, candidate_id: c.id, position_id: p.id, status: 'submitted', submitted_by: ctx.userId, shareable: JSON.stringify(b.shareable), presentation }, db);
      if (c.status !== 'submitted') await db.query(`UPDATE candidates SET status='submitted', updated_at=now() WHERE id=$1`, [c.id]);
      return sub;
    });
    const company = p.company_id ? await one<any>(`SELECT name FROM companies WHERE id=$1`, [p.company_id]) : null;
    await activity(ctx, 'candidate', c.id, 'status_change', `Submitted to ${p.title}${company ? ` (${company.name})` : ''}`, null, { submission_id: s.id, from: c.status, to: 'submitted' });
    await activity(ctx, 'position', p.id, 'system', `${fullName(c)} submitted by ${ctx.user.name}`);
    await activity(ctx, 'submission', s.id, 'system', 'Submission created', `Shared with client: ${Object.entries(b.shareable).filter(([, v]) => v).map(([k]) => k).join(', ') || 'profile only (no contact, rate or notes)'}`);
    await notify(ctx.orgId, await clientUsers(ctx.orgId, p.company_id), { event: 'submission.new', title: `New candidate to review: ${c.first_name}`, body: `${ctx.org.name} submitted a candidate for ${p.title}.`, link: `/portal/client/candidates/${s.id}` });
    await emit(ctx.orgId, 'submission.created', { submission_id: s.id, candidate_id: c.id, candidate_name: fullName(c), position_id: p.id, position_title: p.title, company_id: p.company_id, company_name: company?.name, recruiter_id: c.sourced_by });
    return s;
  });
  app.patch('/api/v1/submissions/:id', async (req) => {
    const ctx = staff(req);
    const s = await getOr404<any>('candidate_submissions', ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [s.candidate_id]);
    await assertEditLinked(ctx, 'submissions', s.position_id, c);
    const b = z.object({ shareable: SHARE.optional(), presentation: z.string().max(5000).nullable().optional() }).parse(req.body);
    const upd = await updateRow<any>('candidate_submissions', ctx.orgId, s.id, { shareable: b.shareable ? JSON.stringify(b.shareable) : undefined, presentation: b.presentation });
    if (b.shareable) await audit(ctx, 'submission.sharing_changed', { type: 'submission', id: s.id, label: fullName(c) }, s.shareable, b.shareable);
    await activity(ctx, 'submission', s.id, 'system', b.shareable ? 'Client sharing settings changed' : 'Client presentation edited');
    return upd;
  });
  app.post('/api/v1/submissions/:id/status', async (req) => {
    const ctx = staff(req);
    const s = await getOr404<any>('candidate_submissions', ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [s.candidate_id]);
    await assertEditLinked(ctx, 'submissions', s.position_id, c);
    const b = z.object({ status: z.string(), reason: z.string().max(2000).nullable().optional() }).parse(req.body);
    assertTransition('submission', s.status, b.status);
    if (['rejected', 'withdrawn'].includes(b.status) && !b.reason?.trim()) throw badRequest(`A reason is required to mark a submission ${b.status}`);
    if (b.status === 'client_interview' && !(await one(`SELECT 1 FROM interviews WHERE submission_id=$1 AND status IN ('scheduled','requested','completed')`, [s.id]))) throw conflict('Schedule the client interview to move to Client Interview', { needs: 'interview' });
    if (b.status === 'offer' && !(await one(`SELECT 1 FROM offers WHERE submission_id=$1 OR (candidate_id=$2 AND position_id=$3)`, [s.id, s.candidate_id, s.position_id]))) throw conflict('Create an offer to move to Offer', { needs: 'offer' });
    if (b.status === 'hired') throw conflict('Hired is set when a placement is created from the accepted offer', { needs: 'placement' });
    const upd = await updateRow<any>('candidate_submissions', ctx.orgId, s.id, { status: b.status, status_reason: b.reason ?? null });
    const p = await one<any>(`SELECT title, company_id FROM positions WHERE id=$1`, [s.position_id]);
    await activity(ctx, 'submission', s.id, 'status_change', `Moved from ${s.status.replace(/_/g, ' ')} to ${b.status.replace(/_/g, ' ')}`, b.reason ?? null, { from: s.status, to: b.status });
    await activity(ctx, 'candidate', c.id, 'status_change', `${p.title}: submission moved to ${b.status.replace(/_/g, ' ')}`, b.reason ?? null, { submission_id: s.id });
    await emit(ctx.orgId, 'submission.status_changed', { submission_id: s.id, candidate_id: c.id, candidate_name: fullName(c), position_id: s.position_id, position_title: p.title, from: s.status, to: b.status });
    return upd;
  });

  /* ════════ Interviews ════════ */
  const intSelect = `i.*, c.first_name, c.last_name, c.first_name || ' ' || coalesce(c.last_name,'') candidate_name, c.avatar_color, c.email candidate_email, p.title position_title, co.name company_name, cb.name created_by_name, rq.name requested_by_name,
    (SELECT string_agg(u.name, ', ') FROM users u WHERE u.id = ANY(i.interviewer_ids)) interviewer_names,
    (SELECT count(*)::int FROM interview_feedback f WHERE f.interview_id=i.id) feedback_count, (SELECT round(avg(f.overall),1) FROM interview_feedback f WHERE f.interview_id=i.id) avg_overall`;
  const intFrom = 'interviews i JOIN candidates c ON c.id=i.candidate_id LEFT JOIN positions p ON p.id=i.position_id LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users cb ON cb.id=i.created_by LEFT JOIN users rq ON rq.id=i.requested_by';
  app.get('/api/v1/interviews', async (req) => {
    const ctx = staff(req);
    need(ctx, 'interviews', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId]; const where = ['i.organization_id = $1'];
    const add = (v: unknown, sql: (n: string) => string) => { params.push(v); where.push(sql(`$${params.length}`)); };
    if (f.status) add(f.status.split(','), n => `i.status = ANY(${n})`);
    if (f.kind) add(f.kind, n => `i.kind = ${n}`);
    if (f.when === 'upcoming') where.push(`i.scheduled_at >= now() AND i.status IN ('scheduled','requested')`);
    if (f.when === 'today') where.push(`i.scheduled_at::date = now()::date`);
    if (f.when === 'past') where.push(`i.scheduled_at < now()`);
    if (f.when === 'needs_feedback') where.push(`i.scheduled_at < now() AND i.status IN ('scheduled','completed') AND NOT EXISTS (SELECT 1 FROM interview_feedback x WHERE x.interview_id=i.id)`);
    if (f.candidate_id) add(f.candidate_id, n => `i.candidate_id = ${n}`);
    if (f.position_id) add(f.position_id, n => `i.position_id = ${n}`);
    if (f.interviewer === 'me') add(ctx.userId, n => `${n} = ANY(i.interviewer_ids)`); else if (f.interviewer) add(f.interviewer, n => `${n}::uuid = ANY(i.interviewer_ids)`);
    if (f.from) add(f.from, n => `i.scheduled_at >= ${n}::date`);
    if (f.to) add(f.to, n => `i.scheduled_at < (${n}::date + 1)`);
    return paged({ select: intSelect, from: intFrom, where, params, lp, searchCols: ["(c.first_name || ' ' || coalesce(c.last_name,''))", 'p.title', 'co.name'],
      sortMap: { scheduled_at: 'i.scheduled_at', candidate_name: 'c.first_name', position_title: 'p.title', status: 'i.status', kind: 'i.kind' }, defaultSort: f.when === 'upcoming' ? 'i.scheduled_at ASC' : 'i.scheduled_at DESC' });
  });
  app.get('/api/v1/interviews/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'interviews', 'view');
    const i = await getOr404<any>('interviews', ctx, (req.params as any).id);
    const row = await one<any>(`SELECT ${intSelect} FROM ${intFrom} WHERE i.id=$1`, [i.id]);
    const feedback = await q(`SELECT f.*, u.name author_name FROM interview_feedback f LEFT JOIN users u ON u.id=f.author_id WHERE f.interview_id=$1 ORDER BY f.created_at`, [i.id]);
    return { ...row, feedback, ics_url: `/api/v1/interviews/${i.id}/ics` };
  });
  const intBody = z.object({
    candidate_id: z.string().uuid(), position_id: z.string().uuid().nullable().optional(), submission_id: z.string().uuid().nullable().optional(),
    kind: z.enum(['internal', 'client']).default('internal'), scheduled_at: z.string().datetime({ offset: true, message: 'Pick a date and time' }),
    duration_min: z.number().int().min(10).max(480).default(30), timezone: z.string().min(2).max(80).default('America/New_York'),
    interviewer_ids: z.array(z.string().uuid()).max(10).default([]), interviewers: z.string().max(300).nullable().optional(),
    notify_candidate: z.boolean().default(true), move_candidate: z.boolean().default(true),
  });
  app.post('/api/v1/interviews', async (req) => {
    const ctx = staff(req);
    need(ctx, 'interviews', 'create');
    const b = intBody.parse(req.body);
    const c = await getOr404<any>('candidates', ctx, b.candidate_id);
    let sub: any = null;
    if (b.submission_id) { sub = await getOr404('candidate_submissions', ctx, b.submission_id); if (sub.candidate_id !== c.id) throw badRequest('Submission belongs to another candidate'); b.position_id = sub.position_id; }
    if (b.position_id) await viewablePosition(ctx, b.position_id);
    if (b.kind === 'client' && !sub && b.position_id) sub = await one(`SELECT * FROM candidate_submissions WHERE candidate_id=$1 AND position_id=$2`, [c.id, b.position_id]);
    if (b.kind === 'client' && !sub) throw badRequest('A client interview needs a submission — submit the candidate to the position first');
    await assertEditLinked(ctx, 'interviews', b.position_id ?? null, c);
    if (new Date(b.scheduled_at).getTime() < Date.now() - 3600000) throw badRequest('Pick a time in the future');
    const members = b.interviewer_ids.length ? (await q<any>(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND user_id = ANY($2) AND status='active'`, [ctx.orgId, b.interviewer_ids])).map(r => r.user_id) : [];
    const iv = await insertRow<any>('interviews', { organization_id: ctx.orgId, candidate_id: c.id, position_id: b.position_id ?? null, submission_id: sub?.id ?? null, kind: b.kind, scheduled_at: b.scheduled_at, duration_min: b.duration_min, timezone: b.timezone, meeting_url: meetingUrl(), interviewer_ids: members, interviewers: b.interviewers ?? null, status: 'scheduled', created_by: ctx.userId });
    await afterScheduled(ctx, iv, c, sub, b.notify_candidate, b.move_candidate);
    return iv;
  });
  async function afterScheduled(ctx: any, iv: any, c: any, sub: any, notifyCandidate: boolean, moveCandidate: boolean) {
    const p = iv.position_id ? await one<any>(`SELECT title FROM positions WHERE id=$1`, [iv.position_id]) : null;
    const when = fmtWhen(iv.scheduled_at, iv.timezone);
    await activity(ctx, 'interview', iv.id, 'system', `${iv.kind === 'client' ? 'Client' : 'Internal'} interview scheduled for ${when} (${iv.timezone})`, iv.meeting_url);
    await activity(ctx, 'candidate', c.id, 'meeting', `${iv.kind === 'client' ? 'Client' : 'Internal'} interview scheduled${p ? ` — ${p.title}` : ''}`, `${when} (${iv.timezone}) · ${iv.meeting_url}`, { interview_id: iv.id });
    if (moveCandidate && iv.kind === 'internal' && canTransition('candidate', c.status, 'interview')) {
      await q(`UPDATE candidates SET status='interview', updated_at=now() WHERE id=$1`, [c.id]);
      await activity(ctx, 'candidate', c.id, 'status_change', `Status changed from ${c.status.replace(/_/g, ' ')} to interview`, null, { from: c.status, to: 'interview' });
    }
    if (sub && iv.kind === 'client' && canTransition('submission', sub.status, 'client_interview')) {
      await q(`UPDATE candidate_submissions SET status='client_interview', updated_at=now() WHERE id=$1`, [sub.id]);
      await activity(ctx, 'submission', sub.id, 'status_change', `Moved from ${sub.status.replace(/_/g, ' ')} to client interview`, null, { from: sub.status, to: 'client_interview' });
    }
    if (notifyCandidate && c.email) await sendTemplate(ctx.orgId, 'interview_scheduled', c.email, { candidate: { firstName: c.first_name }, position: { title: p?.title ?? 'your application' }, interview: { when, timezone: iv.timezone, link: iv.meeting_url } }, { related: { type: 'candidate', id: c.id } });
    const cu = await candidatePortalUser(ctx.orgId, c.id);
    if (cu) await notify(ctx.orgId, [cu], { event: 'interview.upcoming', title: `Interview scheduled: ${when}`, body: p?.title ?? null, link: '/portal/candidate/interviews' });
    const others = (iv.interviewer_ids as string[]).filter(u => u !== ctx.userId);
    if (others.length) await notify(ctx.orgId, others, { event: 'interview.upcoming', title: `You're interviewing ${fullName(c)}`, body: `${when} (${iv.timezone})${p ? ` · ${p.title}` : ''}`, link: `/recruiting/interviews?interview=${iv.id}` });
    if (iv.kind === 'client' && iv.position_id) {
      const pos = await one<any>(`SELECT company_id FROM positions WHERE id=$1`, [iv.position_id]);
      await notify(ctx.orgId, await clientUsers(ctx.orgId, pos?.company_id), { event: 'interview.upcoming', title: `Interview confirmed with ${c.first_name}`, body: `${when} (${iv.timezone})`, link: '/portal/client/interviews' });
    }
    await emit(ctx.orgId, 'interview.scheduled', { interview_id: iv.id, candidate_id: c.id, candidate_name: fullName(c), position_id: iv.position_id, kind: iv.kind, scheduled_at: iv.scheduled_at });
  }
  app.patch('/api/v1/interviews/:id', async (req) => {
    const ctx = staff(req);
    const i = await getOr404<any>('interviews', ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [i.candidate_id]);
    await assertEditLinked(ctx, 'interviews', i.position_id, c);
    if (!['scheduled', 'requested'].includes(i.status)) throw conflict(`This interview is ${i.status} and can no longer be changed`);
    const b = intBody.pick({ scheduled_at: true, duration_min: true, timezone: true, interviewer_ids: true, interviewers: true }).partial().parse(req.body);
    const upd = await updateRow<any>('interviews', ctx.orgId, i.id, { ...b, reminded_at: b.scheduled_at ? null : undefined });
    if (b.scheduled_at && new Date(b.scheduled_at).getTime() !== new Date(i.scheduled_at).getTime()) {
      const when = fmtWhen(upd.scheduled_at, upd.timezone);
      await activity(ctx, 'interview', i.id, 'system', `Rescheduled to ${when} (${upd.timezone})`);
      await activity(ctx, 'candidate', c.id, 'meeting', `Interview rescheduled to ${when}`);
      if (c.email && upd.status === 'scheduled') await sendMessage({ orgId: ctx.orgId, channel: 'email', to: c.email, subject: 'Your interview time changed', text: `Hi ${c.first_name},\n\nYour interview has moved to ${when} (${upd.timezone}).\nJoin: ${upd.meeting_url}`, related: { type: 'candidate', id: c.id } });
      await notify(ctx.orgId, (upd.interviewer_ids as string[]).filter(u => u !== ctx.userId), { event: 'interview.changed', title: `Interview moved: ${fullName(c)}`, body: `${when} (${upd.timezone})`, link: `/recruiting/interviews?interview=${i.id}` });
    } else await activity(ctx, 'interview', i.id, 'system', 'Interview details updated');
    return upd;
  });
  app.post('/api/v1/interviews/:id/confirm', async (req) => {
    const ctx = staff(req);
    const i = await getOr404<any>('interviews', ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [i.candidate_id]);
    await assertEditLinked(ctx, 'interviews', i.position_id, c);
    if (i.status !== 'requested') throw conflict('Only client-requested interviews need confirmation');
    const b = intBody.pick({ scheduled_at: true, duration_min: true, timezone: true, interviewer_ids: true, interviewers: true }).partial().parse(req.body ?? {});
    const upd = await updateRow<any>('interviews', ctx.orgId, i.id, { ...b, status: 'scheduled', meeting_url: i.meeting_url ?? meetingUrl() });
    const sub = i.submission_id ? await one(`SELECT * FROM candidate_submissions WHERE id=$1`, [i.submission_id]) : null;
    await afterScheduled(ctx, upd, c, sub, true, false);
    return upd;
  });
  app.post('/api/v1/interviews/:id/status', async (req) => {
    const ctx = staff(req);
    const i = await getOr404<any>('interviews', ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [i.candidate_id]);
    await assertEditLinked(ctx, 'interviews', i.position_id, c);
    const b = z.object({ status: z.enum(['completed', 'cancelled', 'no_show', 'scheduled']), reason: z.string().max(1000).nullable().optional() }).parse(req.body);
    if (i.status === 'requested') { if (b.status !== 'cancelled') throw conflict('Confirm the requested interview first', { allowed: ['cancelled'] }); }
    else assertTransition('interview', i.status, b.status);
    if (b.status === 'cancelled' && !b.reason?.trim()) throw badRequest('A reason is required to cancel an interview');
    const upd = await updateRow<any>('interviews', ctx.orgId, i.id, { status: b.status, cancel_reason: b.status === 'cancelled' ? b.reason : undefined });
    await activity(ctx, 'interview', i.id, 'status_change', `Interview ${b.status.replace('_', ' ')}`, b.reason ?? null, { from: i.status, to: b.status });
    await activity(ctx, 'candidate', c.id, 'status_change', `Interview ${b.status.replace('_', ' ')}`, b.reason ?? null, { interview_id: i.id });
    if (b.status === 'cancelled') {
      if (c.email) await sendMessage({ orgId: ctx.orgId, channel: 'email', to: c.email, subject: 'Your interview was cancelled', text: `Hi ${c.first_name},\n\nYour interview on ${fmtWhen(i.scheduled_at, i.timezone)} was cancelled. Your recruiter will be in touch.`, related: { type: 'candidate', id: c.id } });
      await notify(ctx.orgId, (i.interviewer_ids as string[]).filter(u => u !== ctx.userId), { event: 'interview.changed', title: `Interview cancelled: ${fullName(c)}`, body: b.reason ?? null, link: `/recruiting/interviews?interview=${i.id}` });
    }
    return upd;
  });
  app.post('/api/v1/interviews/:id/feedback', async (req) => {
    const ctx = staff(req);
    need(ctx, 'interviews', 'view');
    const i = await getOr404<any>('interviews', ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [i.candidate_id]);
    const isInterviewer = (i.interviewer_ids as string[]).includes(ctx.userId);
    if (!isInterviewer) await assertEditLinked(ctx, 'interviews', i.position_id, c);
    if (i.status === 'requested' || i.status === 'cancelled') throw conflict('Feedback can only be recorded for held interviews');
    const s15 = z.number().int().min(1).max(5);
    const b = z.object({ scores: z.object({ communication: s15, experience: s15, culture: s15, technical: s15 }), overall: s15, recommendation: z.enum(['strong_hire', 'hire', 'maybe', 'no_hire']), notes: z.string().max(5000).nullable().optional() }).parse(req.body);
    const f = await insertRow('interview_feedback', { organization_id: ctx.orgId, interview_id: i.id, author_id: ctx.userId, author_label: ctx.user.name, scores: JSON.stringify(b.scores), overall: b.overall, recommendation: b.recommendation, notes: b.notes ?? null });
    if (i.status === 'scheduled' && new Date(i.scheduled_at) <= new Date()) await updateRow('interviews', ctx.orgId, i.id, { status: 'completed' });
    await activity(ctx, 'interview', i.id, 'note', `Scorecard from ${ctx.user.name}: ${b.overall}/5 · ${b.recommendation.replace('_', ' ')}`, b.notes ?? null);
    await activity(ctx, 'candidate', c.id, 'note', `Interview feedback: ${b.overall}/5 (${b.recommendation.replace('_', ' ')})`, b.notes ?? null, { interview_id: i.id });
    const owner = [i.created_by, c.sourced_by].filter((u: string | null) => u && u !== ctx.userId);
    if (owner.length) await notify(ctx.orgId, owner, { event: 'interview.feedback', title: `Feedback recorded for ${fullName(c)}`, body: `${ctx.user.name}: ${b.overall}/5, ${b.recommendation.replace('_', ' ')}`, link: `/recruiting/candidates/${c.id}?tab=interviews` });
    return f;
  });
  app.post('/api/v1/interviews/:id/outcome', async (req) => {
    const ctx = staff(req);
    const i = await getOr404<any>('interviews', ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [i.candidate_id]);
    await assertEditLinked(ctx, 'interviews', i.position_id, c);
    if (!['scheduled', 'completed'].includes(i.status)) throw conflict(`Cannot record an outcome for a ${i.status} interview`);
    const b = z.object({ outcome: z.enum(['advance', 'hold', 'reject']), notes: z.string().max(2000).nullable().optional() }).parse(req.body);
    const upd = await updateRow<any>('interviews', ctx.orgId, i.id, { outcome: b.outcome, status: 'completed' });
    await activity(ctx, 'interview', i.id, 'status_change', `Outcome: ${b.outcome}`, b.notes ?? null);
    await activity(ctx, 'candidate', c.id, 'status_change', `Interview outcome: ${b.outcome}`, b.notes ?? null, { interview_id: i.id });
    return upd;
  });
  app.get('/api/v1/interviews/:id/ics', async (req, reply) => {
    const ctx = staff(req);
    need(ctx, 'interviews', 'view');
    const i = await getOr404<any>('interviews', ctx, (req.params as any).id);
    return sendIcs(reply, i, ctx.org.name);
  });

  // Reminders ~24h before (in-app to interviewers + creator, email to candidate).
  every('recruiting.interview-reminders', 60_000, async () => {
    const due = await q<any>(`SELECT i.*, c.first_name, c.last_name, c.email, p.title position_title FROM interviews i JOIN candidates c ON c.id=i.candidate_id LEFT JOIN positions p ON p.id=i.position_id WHERE i.status='scheduled' AND i.reminded_at IS NULL AND i.scheduled_at > now() AND i.scheduled_at <= now() + interval '24 hours' LIMIT 50`);
    for (const i of due) {
      const claimed = await one(`UPDATE interviews SET reminded_at=now() WHERE id=$1 AND reminded_at IS NULL RETURNING id`, [i.id]);
      if (!claimed) continue;
      const when = fmtWhen(i.scheduled_at, i.timezone);
      const sys = { orgId: i.organization_id, userId: null };
      await notify(i.organization_id, [...(i.interviewer_ids ?? []), i.created_by], { event: 'interview.upcoming', title: `Interview tomorrow: ${fullName(i)}`, body: `${when} (${i.timezone})${i.position_title ? ' · ' + i.position_title : ''}`, link: `/recruiting/interviews?interview=${i.id}` });
      const cu = await candidatePortalUser(i.organization_id, i.candidate_id);
      if (cu) await notify(i.organization_id, [cu], { event: 'interview.upcoming', title: `Reminder: interview ${when}`, body: i.meeting_url, link: '/portal/candidate/interviews' });
      if (i.email) await sendMessage({ orgId: i.organization_id, channel: 'email', to: i.email, subject: `Reminder: your interview is on ${when}`, text: `Hi ${i.first_name},\n\nThis is a reminder of your interview${i.position_title ? ` for ${i.position_title}` : ''} on ${when} (${i.timezone}).\nJoin: ${i.meeting_url}`, related: { type: 'candidate', id: i.candidate_id } });
      await activity(sys, 'interview', i.id, 'system', 'Reminder sent (24h before)');
    }
  });

  /* ════════ Assessments ════════ */
  app.get('/api/v1/assessment-templates', async (req) => {
    const ctx = staff(req);
    need(ctx, 'assessments', 'view');
    return q(`SELECT t.*, (SELECT count(*)::int FROM assessments a WHERE a.template_id=t.id) uses, (SELECT round(avg(a.score)) FROM assessments a WHERE a.template_id=t.id AND a.score IS NOT NULL) avg_score FROM assessment_templates t WHERE t.organization_id=$1 ORDER BY t.name`, [ctx.orgId]);
  });
  const tplBody = z.object({ name: z.string().trim().min(2).max(160), category: z.string().max(80).nullable().optional(), instructions: z.string().max(5000).nullable().optional(), questions: z.array(z.object({ q: z.string().trim().min(3).max(1000) })).min(1, 'Add at least one question').max(30), allow_file: z.boolean().default(true) });
  app.post('/api/v1/assessment-templates', async (req) => {
    const ctx = staff(req);
    need(ctx, 'assessments', 'create');
    const b = tplBody.parse(req.body);
    return insertRow('assessment_templates', { organization_id: ctx.orgId, ...b, questions: JSON.stringify(b.questions) });
  });
  app.patch('/api/v1/assessment-templates/:id', async (req) => {
    const ctx = staff(req);
    if (editScope(ctx, 'assessments') !== 'all') throw forbidden('Only managers can edit the template library');
    const t = await getOr404('assessment_templates', ctx, (req.params as any).id);
    const b = tplBody.partial().parse(req.body);
    return updateRow('assessment_templates', ctx.orgId, (t as any).id, { ...b, questions: b.questions ? JSON.stringify(b.questions) : undefined });
  });
  app.get('/api/v1/assessments', async (req) => {
    const ctx = staff(req);
    need(ctx, 'assessments', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId]; const where = ['a.organization_id = $1'];
    const add = (v: unknown, sql: (n: string) => string) => { params.push(v); where.push(sql(`$${params.length}`)); };
    if (f.status) add(f.status.split(','), n => `a.status = ANY(${n})`);
    if (f.template_id) add(f.template_id, n => `a.template_id = ${n}`);
    if (f.candidate_id) add(f.candidate_id, n => `a.candidate_id = ${n}`);
    if (f.sent_by) add(f.sent_by === 'me' ? ctx.userId : f.sent_by, n => `a.sent_by = ${n}`);
    return paged({ select: `a.id, a.status, a.score, a.sent_at, a.started_at, a.completed_at, a.scored_at, a.candidate_id, a.position_id, a.template_id, a.file, t.name template_name, t.category, c.first_name || ' ' || coalesce(c.last_name,'') candidate_name, c.avatar_color, p.title position_title, u.name sent_by_name`,
      from: 'assessments a JOIN assessment_templates t ON t.id=a.template_id JOIN candidates c ON c.id=a.candidate_id LEFT JOIN positions p ON p.id=a.position_id LEFT JOIN users u ON u.id=a.sent_by',
      where, params, lp, searchCols: ["(c.first_name || ' ' || coalesce(c.last_name,''))", 't.name'], sortMap: { sent_at: 'a.sent_at', score: 'a.score', status: 'a.status', candidate_name: 'c.first_name', template_name: 't.name', completed_at: 'a.completed_at' }, defaultSort: 'a.sent_at DESC' });
  });
  app.get('/api/v1/assessments/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'assessments', 'view');
    const a = await getOr404<any>('assessments', ctx, (req.params as any).id);
    const row = await one<any>(`SELECT a.*, t.name template_name, t.instructions, t.questions, t.category, c.first_name || ' ' || coalesce(c.last_name,'') candidate_name, p.title position_title, u.name sent_by_name, sc.name scored_by_name FROM assessments a JOIN assessment_templates t ON t.id=a.template_id JOIN candidates c ON c.id=a.candidate_id LEFT JOIN positions p ON p.id=a.position_id LEFT JOIN users u ON u.id=a.sent_by LEFT JOIN users sc ON sc.id=a.scored_by WHERE a.id=$1`, [a.id]);
    return { ...row, file_url: fileUrl(row.file) };
  });
  app.post('/api/v1/assessments', async (req) => {
    const ctx = staff(req);
    need(ctx, 'assessments', 'create');
    const b = z.object({ template_id: z.string().uuid(), candidate_id: z.string().uuid(), position_id: z.string().uuid().nullable().optional(), move_candidate: z.boolean().default(true) }).parse(req.body);
    const t = await getOr404<any>('assessment_templates', ctx, b.template_id);
    const c = await getOr404<any>('candidates', ctx, b.candidate_id);
    if (b.position_id) await viewablePosition(ctx, b.position_id);
    await assertEditLinked(ctx, 'assessments', b.position_id ?? null, c);
    if (await one(`SELECT 1 FROM assessments WHERE candidate_id=$1 AND template_id=$2 AND status IN ('sent','started')`, [c.id, t.id])) throw conflict('This assessment is already in progress for the candidate');
    const a = await insertRow<any>('assessments', { organization_id: ctx.orgId, template_id: t.id, candidate_id: c.id, position_id: b.position_id ?? null, status: 'sent', sent_by: ctx.userId });
    await activity(ctx, 'candidate', c.id, 'system', `Assessment sent: ${t.name}`, null, { assessment_id: a.id });
    if (b.move_candidate && canTransition('candidate', c.status, 'assessment')) {
      await q(`UPDATE candidates SET status='assessment', updated_at=now() WHERE id=$1`, [c.id]);
      await activity(ctx, 'candidate', c.id, 'status_change', `Status changed from ${c.status.replace(/_/g, ' ')} to assessment`, null, { from: c.status, to: 'assessment' });
    }
    const link = await ensureCandidateInvite(ctx, c);
    if (c.email) await sendMessage({ orgId: ctx.orgId, channel: 'email', to: c.email, subject: `Assessment from ${ctx.org.name}: ${t.name}`, text: `Hi ${c.first_name},\n\nPlease complete the "${t.name}" assessment in your candidate portal. You can answer in text and attach a file.\n\nOpen your portal: ${link}`, related: { type: 'candidate', id: c.id } });
    const cu = await candidatePortalUser(ctx.orgId, c.id);
    if (cu) await notify(ctx.orgId, [cu], { event: 'assessment.assigned', title: `New assessment: ${t.name}`, link: `/portal/candidate/assessments` });
    return a;
  });
  app.post('/api/v1/assessments/:id/score', async (req) => {
    const ctx = staff(req);
    const a = await getOr404<any>('assessments', ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [a.candidate_id]);
    await assertEditLinked(ctx, 'assessments', a.position_id, c);
    const b = z.object({ score: z.number().int().min(0).max(100), notes: z.string().max(5000).nullable().optional() }).parse(req.body);
    assertTransition('assessment', a.status, 'scored');
    const upd = await updateRow<any>('assessments', ctx.orgId, a.id, { status: 'scored', score: b.score, scorer_notes: b.notes ?? null, scored_at: new Date(), scored_by: ctx.userId });
    const t = await one<any>(`SELECT name FROM assessment_templates WHERE id=$1`, [a.template_id]);
    await activity(ctx, 'candidate', c.id, 'status_change', `Assessment scored: ${t.name} — ${b.score}/100`, b.notes ?? null, { assessment_id: a.id });
    return upd;
  });
  app.post('/api/v1/assessments/:id/remind', async (req) => {
    const ctx = staff(req);
    const a = await getOr404<any>('assessments', ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [a.candidate_id]);
    await assertEditLinked(ctx, 'assessments', a.position_id, c);
    if (!['sent', 'started'].includes(a.status)) throw conflict('Only open assessments can be reminded');
    if (!c.email) throw badRequest('This candidate has no email address');
    const link = await ensureCandidateInvite(ctx, c);
    await sendMessage({ orgId: ctx.orgId, channel: 'email', to: c.email, subject: 'Reminder: your assessment is waiting', text: `Hi ${c.first_name},\n\nA quick reminder to complete your assessment.\n\nOpen your portal: ${link}`, related: { type: 'candidate', id: c.id } });
    return { ok: true };
  });

  /* ════════ Offers ════════ */
  const offSelect = `o.*, c.first_name, c.last_name, c.first_name || ' ' || coalesce(c.last_name,'') candidate_name, c.avatar_color, c.email candidate_email, c.sourced_by recruiter_id, p.title position_title, p.company_id, p.timezone position_timezone, p.schedule position_schedule, co.name company_name, co.account_manager_id, cb.name created_by_name, ab.name approved_by_name`;
  const offFrom = 'offers o JOIN candidates c ON c.id=o.candidate_id LEFT JOIN positions p ON p.id=o.position_id LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users cb ON cb.id=o.created_by LEFT JOIN users ab ON ab.id=o.approved_by';
  function offerScope(ctx: any, params: unknown[]) {
    const s = need(ctx, 'offers', 'view');
    const eff: 'all' | 'team' | 'assigned' = s === 'all' ? ctx.recruitingScope : s === 'team' ? 'team' : 'assigned';
    if (eff === 'all') return 'TRUE';
    const pred = positionScopeSql(ctx, eff, 'p', params);
    params.push(ctx.userId);
    return `(${pred} OR c.sourced_by = $${params.length} OR o.created_by = $${params.length})`;
  }
  app.get('/api/v1/offers', async (req) => {
    const ctx = staff(req);
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId]; const where = ['o.organization_id = $1'];
    where.push(offerScope(ctx, params));
    const add = (v: unknown, sql: (n: string) => string) => { params.push(v); where.push(sql(`$${params.length}`)); };
    if (f.status) add(f.status.split(','), n => `o.status = ANY(${n})`);
    if (f.position_id) add(f.position_id, n => `o.position_id = ${n}`);
    if (f.candidate_id) add(f.candidate_id, n => `o.candidate_id = ${n}`);
    if (f.needs_placement === 'true') where.push(`o.status='accepted' AND o.placement_id IS NULL`);
    const r = await paged({ select: offSelect, from: offFrom, where, params, lp, searchCols: ["(c.first_name || ' ' || coalesce(c.last_name,''))", 'p.title', 'co.name'], sortMap: { created_at: 'o.created_at', start_date: 'o.start_date', status: 'o.status', candidate_name: 'c.first_name', expires_at: 'o.expires_at' }, defaultSort: 'o.created_at DESC' });
    r.rows = r.rows.map((o: any) => stripOfferComp(ctx, o));
    return r;
  });
  async function loadOffer(ctx: any, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const params: unknown[] = [id, ctx.orgId];
    const pred = offerScope(ctx, params);
    const o = await one<any>(`SELECT ${offSelect} FROM ${offFrom} WHERE o.id=$1 AND o.organization_id=$2 AND ${pred}`, params);
    if (!o) throw notFound();
    return o;
  }
  app.get('/api/v1/offers/:id', async (req) => {
    const ctx = staff(req);
    const o = await loadOffer(ctx, (req.params as any).id);
    const margin = canViewComp(ctx, 'offers') ? { margin_cents: o.bill_rate_cents - o.pay_rate_cents, margin_pct: o.bill_rate_cents ? Math.round(((o.bill_rate_cents - o.pay_rate_cents) / o.bill_rate_cents) * 1000) / 10 : null } : {};
    return { ...stripOfferComp(ctx, o), ...margin, can_approve: can(ctx, 'offers', 'approve'), create_placement_url: o.status === 'accepted' && !o.placement_id ? `/workforce/placements/new?offerId=${o.id}` : null };
  });
  const offerBody = z.object({
    candidate_id: z.string().uuid(), position_id: z.string().uuid(), submission_id: z.string().uuid().nullable().optional(),
    pay_rate_cents: z.number().int().min(1, 'Enter the pay rate'), bill_rate_cents: z.number().int().min(1, 'Enter the bill rate'),
    currency: z.string().length(3).default('USD'), rate_unit: z.enum(['hour', 'day', 'week', 'month']).default('hour'),
    weekly_hours: z.number().int().min(1).max(80).nullable().optional(), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a start date'),
    expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), terms: z.string().max(10000).nullable().optional(),
  });
  app.post('/api/v1/offers', async (req) => {
    const ctx = staff(req);
    need(ctx, 'offers', 'create');
    const b = offerBody.parse(req.body);
    if (b.bill_rate_cents < b.pay_rate_cents) throw badRequest('Bill rate must be at least the pay rate');
    const c = await getOr404<any>('candidates', ctx, b.candidate_id);
    const p = await viewablePosition(ctx, b.position_id);
    await assertEditLinked(ctx, 'offers', p.id, c);
    let sub = b.submission_id ? await getOr404<any>('candidate_submissions', ctx, b.submission_id) : await one<any>(`SELECT * FROM candidate_submissions WHERE candidate_id=$1 AND position_id=$2`, [c.id, p.id]);
    if (!sub) throw conflict('Submit the candidate to this position before creating an offer', { needs: 'submission' });
    if (await one(`SELECT 1 FROM offers WHERE candidate_id=$1 AND position_id=$2 AND status IN ('draft','approved','sent','viewed')`, [c.id, p.id])) throw conflict('An open offer already exists for this candidate and position');
    const o = await insertRow<any>('offers', { organization_id: ctx.orgId, ...b, submission_id: sub.id, status: 'draft', created_by: ctx.userId });
    if (canTransition('submission', sub.status, 'offer')) {
      await q(`UPDATE candidate_submissions SET status='offer', updated_at=now() WHERE id=$1`, [sub.id]);
      await activity(ctx, 'submission', sub.id, 'status_change', `Moved from ${sub.status.replace(/_/g, ' ')} to offer`, null, { from: sub.status, to: 'offer' });
    }
    await activity(ctx, 'offer', o.id, 'system', 'Offer drafted', `Start ${b.start_date}`);
    await activity(ctx, 'candidate', c.id, 'system', `Offer drafted for ${p.title}`, null, { offer_id: o.id });
    await audit(ctx, 'offer.created', { type: 'offer', id: o.id, label: `${fullName(c)} — ${p.title}` }, null, { pay_rate_cents: b.pay_rate_cents, bill_rate_cents: b.bill_rate_cents, currency: b.currency, start_date: b.start_date });
    if (!can(ctx, 'offers', 'approve')) {
      const approvers = (await usersWithRoles(ctx.orgId, ['owner', 'admin', 'management'])).filter(u => u !== ctx.userId);
      await notify(ctx.orgId, approvers, { event: 'offer.approval_needed', title: `Offer needs approval: ${fullName(c)}`, body: `${ctx.user.name} drafted an offer for ${p.title}.`, link: `/recruiting/offers?offer=${o.id}` });
    }
    return stripOfferComp(ctx, o);
  });
  app.patch('/api/v1/offers/:id', async (req) => {
    const ctx = staff(req);
    const o = await loadOffer(ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [o.candidate_id]);
    await assertEditLinked(ctx, 'offers', o.position_id, c);
    if (o.status !== 'draft') throw conflict('Only draft offers can be edited — move it back to draft first');
    const b = offerBody.omit({ candidate_id: true, position_id: true, submission_id: true }).partial().parse(req.body);
    const upd = await updateRow<any>('offers', ctx.orgId, o.id, b);
    if (upd.bill_rate_cents < upd.pay_rate_cents) throw badRequest('Bill rate must be at least the pay rate');
    if (b.pay_rate_cents !== undefined || b.bill_rate_cents !== undefined) await audit(ctx, 'offer.rates_changed', { type: 'offer', id: o.id, label: o.candidate_name }, { pay_rate_cents: o.pay_rate_cents, bill_rate_cents: o.bill_rate_cents }, { pay_rate_cents: upd.pay_rate_cents, bill_rate_cents: upd.bill_rate_cents });
    await activity(ctx, 'offer', o.id, 'system', 'Offer terms edited');
    return stripOfferComp(ctx, upd);
  });
  async function offerTransition(ctx: any, o: any, to: string, patch: Record<string, unknown>, title: string, body?: string | null) {
    assertTransition('offer', o.status, to);
    const upd = await updateRow<any>('offers', ctx.orgId, o.id, { status: to, ...patch });
    await activity(ctx, 'offer', o.id, 'status_change', title, body ?? null, { from: o.status, to });
    await activity(ctx, 'candidate', o.candidate_id, 'status_change', `Offer (${o.position_title ?? 'position'}): ${title.toLowerCase()}`, body ?? null, { offer_id: o.id });
    return upd;
  }
  app.post('/api/v1/offers/:id/approve', async (req) => {
    const ctx = staff(req);
    need(ctx, 'offers', 'approve');
    const o = await loadOffer(ctx, (req.params as any).id);
    const upd = await offerTransition(ctx, o, 'approved', { approved_by: ctx.userId, approved_at: new Date() }, `Approved by ${ctx.user.name}`);
    await audit(ctx, 'offer.approved', { type: 'offer', id: o.id, label: `${o.candidate_name} — ${o.position_title}` }, { status: o.status }, { status: 'approved', pay_rate_cents: o.pay_rate_cents, bill_rate_cents: o.bill_rate_cents });
    if (o.created_by && o.created_by !== ctx.userId) await notify(ctx.orgId, [o.created_by], { event: 'offer.approved', title: `Offer approved: ${o.candidate_name}`, body: 'You can send it to the candidate now.', link: `/recruiting/offers?offer=${o.id}` });
    return stripOfferComp(ctx, upd);
  });
  app.post('/api/v1/offers/:id/revert', async (req) => {
    const ctx = staff(req);
    const o = await loadOffer(ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [o.candidate_id]);
    await assertEditLinked(ctx, 'offers', o.position_id, c);
    const b = z.object({ reason: z.string().trim().min(2, 'A reason is required').max(1000) }).parse(req.body);
    const upd = await offerTransition(ctx, o, 'draft', { approved_by: null, approved_at: null }, 'Moved back to draft', b.reason);
    await audit(ctx, 'offer.reverted', { type: 'offer', id: o.id, label: o.candidate_name }, { status: o.status }, { status: 'draft' }, b.reason);
    return stripOfferComp(ctx, upd);
  });
  app.post('/api/v1/offers/:id/send', async (req) => {
    const ctx = staff(req);
    const o = await loadOffer(ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [o.candidate_id]);
    await assertEditLinked(ctx, 'offers', o.position_id, c);
    if (!c.email) throw badRequest('Add an email address to the candidate before sending the offer');
    const portal = await ensureCandidateInvite(ctx, c);
    const link = portal.includes('/invite/') ? portal : `${WEB_URL}/portal/candidate/offers`;
    const upd = await offerTransition(ctx, o, 'sent', { sent_at: new Date() }, `Sent to ${c.email}`);
    await sendTemplate(ctx.orgId, 'offer_sent', c.email, { candidate: { firstName: c.first_name }, org: { name: ctx.org.name }, position: { title: o.position_title ?? 'the' }, offer: { startDate: o.start_date }, link }, { related: { type: 'offer', id: o.id } });
    const cu = await candidatePortalUser(ctx.orgId, c.id);
    if (cu) await notify(ctx.orgId, [cu], { event: 'offer.sent', title: `You have an offer from ${ctx.org.name}`, body: o.position_title, link: '/portal/candidate/offers' });
    await emit(ctx.orgId, 'offer.sent', { offer_id: o.id, candidate_id: c.id, candidate_name: fullName(c), position_id: o.position_id, position_title: o.position_title });
    return stripOfferComp(ctx, upd);
  });
  app.post('/api/v1/offers/:id/expire', async (req) => {
    const ctx = staff(req);
    const o = await loadOffer(ctx, (req.params as any).id);
    const c = await one<any>(`SELECT * FROM candidates WHERE id=$1`, [o.candidate_id]);
    await assertEditLinked(ctx, 'offers', o.position_id, c);
    const b = z.object({ reason: z.string().trim().min(2, 'A reason is required').max(1000) }).parse(req.body);
    const upd = await offerTransition(ctx, o, 'expired', { responded_at: new Date() }, 'Offer withdrawn / expired', b.reason);
    await audit(ctx, 'offer.expired', { type: 'offer', id: o.id, label: o.candidate_name }, { status: o.status }, { status: 'expired' }, b.reason);
    return stripOfferComp(ctx, upd);
  });
  // Daily-ish expiry of offers past their expiry date.
  every('recruiting.offer-expiry', 15 * 60_000, async () => {
    const rows = await q<any>(`UPDATE offers SET status='expired', updated_at=now() WHERE status IN ('draft','approved','sent','viewed') AND expires_at IS NOT NULL AND expires_at < current_date RETURNING id, organization_id, candidate_id, created_by`);
    for (const r of rows) {
      await activity({ orgId: r.organization_id, userId: null }, 'offer', r.id, 'status_change', 'Offer expired (past expiry date)');
      if (r.created_by) await notify(r.organization_id, [r.created_by], { event: 'offer.expired', title: 'An offer expired', link: `/recruiting/offers?offer=${r.id}` });
    }
  });
  void formatMoney; void positionInScope; void candOut; void positionRecruiters;
}

export function sendIcs(reply: any, i: any, orgName: string) {
  const ics = buildIcs({ id: i.id, scheduled_at: i.scheduled_at, duration_min: i.duration_min, title: `Interview with ${orgName}`, description: `${i.kind === 'client' ? 'Client' : 'Recruiter'} interview. Join: ${i.meeting_url ?? ''}`, url: i.meeting_url, organizer: orgName });
  reply.header('Content-Type', 'text/calendar; charset=utf-8').header('Content-Disposition', `attachment; filename="interview-${String(i.id).slice(0, 8)}.ics"`);
  return reply.send(ics);
}
