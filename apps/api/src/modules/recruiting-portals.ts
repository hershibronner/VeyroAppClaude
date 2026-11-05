// RECRUITING — Candidate Portal API (/api/v1/portal/candidate/*) and the client portal's Candidates & Interviews
// (/api/v1/portal/client/candidates*, /api/v1/portal/client/interviews*). Scoped by ctx.candidateId / ctx.companyId.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, one, insertRow, updateRow, tx } from '../core/db';
import { auth, assertTransition, type Ctx } from '../core/context';
import { badRequest, conflict, forbidden, notFound } from '../core/errors';
import { activity, audit } from '../core/audit';
import { notify, usersWithRoles } from '../core/notify';
import { emit } from '../core/events';
import { saveFile } from '../core/storage';
import { canTransition } from '@veyro/shared';
import { candBody, saveCandidateMedia } from './recruiting-candidates';
import { sendIcs } from './recruiting-pipeline';
import { clientSafeProfile, fileUrl, fullName, positionRecruiters, meetingUrl, fmtWhen, candOut } from './_recruiting/common';

function candidateCtx(req: FastifyRequest): Ctx & { candidateId: string } {
  const ctx = auth(req);
  if (ctx.role.kind !== 'candidate' || !ctx.candidateId) throw notFound();
  return ctx as any;
}
function clientCtx(req: FastifyRequest): Ctx & { companyId: string } {
  const ctx = auth(req);
  if (ctx.role.kind !== 'client' || !ctx.companyId) throw notFound();
  return ctx as any;
}
const CLIENT_DECIDERS = ['client_owner', 'client_manager', 'client_supervisor'];

/** Candidate-friendly stage label (never exposes internal notes, blacklist, or rejection reasons). */
function publicStage(candStatus: string, subStatus?: string | null, appStatus?: string | null) {
  if (subStatus === 'hired' || candStatus === 'hired') return 'Hired';
  if (subStatus === 'offer') return 'Offer';
  if (subStatus === 'client_interview') return 'Interviewing with client';
  if (subStatus === 'client_review' || subStatus === 'submitted') return 'Presented to client';
  if (['rejected', 'withdrawn'].includes(subStatus ?? '') || appStatus === 'rejected' || ['rejected', 'blacklisted'].includes(candStatus)) return 'Not moving forward';
  if (candStatus === 'withdrawn') return 'Withdrawn';
  if (['interview'].includes(candStatus)) return 'Interview';
  if (candStatus === 'assessment') return 'Assessment';
  if (['screening', 'recruiter_review'].includes(candStatus) || appStatus === 'reviewed' || appStatus === 'advanced') return 'In review';
  if (['qualified', 'talent_pool', 'future', 'on_hold'].includes(candStatus)) return 'In talent pool';
  return 'Received';
}

export default async function (app: FastifyInstance) {
  /* ═════════ Candidate Portal ═════════ */
  const myCandidate = async (ctx: any) => { const c = await one<any>(`SELECT * FROM candidates WHERE id=$1 AND organization_id=$2`, [ctx.candidateId, ctx.orgId]); if (!c) throw notFound(); return c; };
  const PORTAL_SAFE = (c: any) => { const o = candOut(null as any, c); for (const k of ['status_reason', 'tags', 'sourced_by', 'created_by', 'legacy_id', 'resume_text', 'source']) delete (o as any)[k]; return o; };

  app.get('/api/v1/portal/candidate/me', async (req) => {
    const ctx = candidateCtx(req);
    const c = await myCandidate(ctx);
    const recruiter = c.sourced_by ? await one<any>(`SELECT name, email FROM users WHERE id=$1`, [c.sourced_by]) : null;
    const counts = await one<any>(`SELECT (SELECT count(*)::int FROM applications WHERE candidate_id=$1) applications, (SELECT count(*)::int FROM assessments WHERE candidate_id=$1 AND status IN ('sent','started')) open_assessments,
      (SELECT count(*)::int FROM interviews WHERE candidate_id=$1 AND status='scheduled' AND scheduled_at > now()) upcoming_interviews, (SELECT count(*)::int FROM offers WHERE candidate_id=$1 AND status IN ('sent','viewed')) open_offers`, [c.id]);
    const missing = [!c.resume_file && !c.resume_text && 'Upload your resume', !c.video_file && 'Add an intro video', !(c.skills?.length) && 'Add your skills', c.rate_min_cents === null && 'Set your rate range', !c.timezone && 'Set your timezone'].filter(Boolean);
    return { ...PORTAL_SAFE(c), stage: publicStage(c.status), recruiter, counts, missing };
  });
  app.patch('/api/v1/portal/candidate/profile', async (req) => {
    const ctx = candidateCtx(req);
    const c = await myCandidate(ctx);
    const b = candBody.pick({ first_name: true, last_name: true, phone: true, country: true, city: true, timezone: true, headline: true, years_experience: true, skills: true, software: true, languages: true, education: true, experience: true, portfolio_url: true, rate_min_cents: true, rate_target_cents: true, rate_currency: true, rate_unit: true, rate_note: true }).partial().parse(req.body);
    if (b.rate_min_cents && b.rate_target_cents && b.rate_min_cents > b.rate_target_cents) throw badRequest('Your minimum rate cannot be higher than your target rate');
    const upd = await updateRow<any>('candidates', ctx.orgId, c.id, { ...b, education: b.education ? JSON.stringify(b.education) : undefined, experience: b.experience ? JSON.stringify(b.experience) : undefined });
    await activity(ctx, 'candidate', c.id, 'system', 'Candidate updated their profile in the portal', Object.keys(b).map(k => k.replace(/_cents$/, '').replace(/_/g, ' ')).join(', '));
    return PORTAL_SAFE(upd);
  });
  app.patch('/api/v1/portal/candidate/availability', async (req) => {
    const ctx = candidateCtx(req);
    const c = await myCandidate(ctx);
    const b = candBody.pick({ availability_status: true, earliest_start: true, weekly_hours: true, preferred_hours: true, timezone: true }).partial().parse(req.body);
    const upd = await updateRow<any>('candidates', ctx.orgId, c.id, b);
    await activity(ctx, 'candidate', c.id, 'system', `Candidate updated availability: ${String(upd.availability_status).replace('_', ' ')}`);
    if (c.sourced_by) await notify(ctx.orgId, [c.sourced_by], { event: 'candidate.updated', title: `${fullName(c)} updated their availability`, body: `${String(upd.availability_status).replace('_', ' ')}${upd.earliest_start ? `, from ${upd.earliest_start}` : ''}`, link: `/recruiting/candidates/${c.id}` });
    return PORTAL_SAFE(upd);
  });
  app.post('/api/v1/portal/candidate/media/:kind', async (req) => {
    const ctx = candidateCtx(req);
    const { kind } = req.params as any;
    if (!['resume', 'video', 'portfolio'].includes(kind)) throw notFound();
    const c = await myCandidate(ctx);
    const f = await (req as any).file();
    if (!f) throw badRequest('Choose a file to upload');
    const buf = await f.toBuffer();
    if (!buf.length) throw badRequest('The file is empty');
    return saveCandidateMedia(ctx, c, kind, { buf, filename: f.filename, mime: f.mimetype });
  });
  app.post('/api/v1/portal/candidate/portfolio-url', async (req) => {
    const ctx = candidateCtx(req);
    const c = await myCandidate(ctx);
    const b = z.object({ url: z.string().url('Enter a full URL (https://…)').max(500).or(z.literal('')) }).parse(req.body);
    await updateRow('candidates', ctx.orgId, c.id, { portfolio_url: b.url || null });
    await activity(ctx, 'candidate', c.id, 'system', b.url ? 'Candidate updated portfolio link' : 'Candidate removed portfolio link', b.url || null);
    return { ok: true };
  });
  app.get('/api/v1/portal/candidate/applications', async (req) => {
    const ctx = candidateCtx(req);
    const c = await myCandidate(ctx);
    const apps = await q<any>(`SELECT a.id, a.created_at, a.status, a.source, p.id position_id, p.title position_title, p.employment_type, p.schedule, s.status submission_status, s.created_at submitted_at
      FROM applications a LEFT JOIN positions p ON p.id=a.position_id LEFT JOIN candidate_submissions s ON s.candidate_id=a.candidate_id AND s.position_id=a.position_id WHERE a.candidate_id=$1 ORDER BY a.created_at DESC`, [c.id]);
    const extraSubs = await q<any>(`SELECT s.id, s.created_at, s.status submission_status, p.id position_id, p.title position_title, p.employment_type, p.schedule FROM candidate_submissions s JOIN positions p ON p.id=s.position_id WHERE s.candidate_id=$1 AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=s.candidate_id AND a.position_id=s.position_id)`, [c.id]);
    const steps = ['Received', 'In review', 'Assessment', 'Interview', 'Presented to client', 'Interviewing with client', 'Offer', 'Hired'];
    const rows = [...apps.map(a => ({ ...a, kind: 'application' })), ...extraSubs.map(s => ({ ...s, kind: 'submission', status: 'advanced' }))].map(r => ({ id: r.id, kind: r.kind, created_at: r.created_at, position_title: r.position_title ?? 'General application', schedule: r.schedule, employment_type: r.employment_type, stage: publicStage(c.status, r.submission_status, r.status) }));
    return { rows, steps, overall_stage: publicStage(c.status) };
  });
  app.get('/api/v1/portal/candidate/assessments', async (req) => {
    const ctx = candidateCtx(req);
    const rows = await q<any>(`SELECT a.id, a.status, a.answers, a.file, a.file_name, a.sent_at, a.started_at, a.completed_at, a.scored_at, a.score, t.name, t.category, t.instructions, t.questions, t.allow_file, p.title position_title FROM assessments a JOIN assessment_templates t ON t.id=a.template_id LEFT JOIN positions p ON p.id=a.position_id WHERE a.candidate_id=$1 AND a.organization_id=$2 ORDER BY a.sent_at DESC`, [ctx.candidateId, ctx.orgId]);
    return rows.map(r => ({ ...r, file_url: fileUrl(r.file), file: undefined, score: r.status === 'scored' ? r.score : null }));
  });
  const myAssessment = async (ctx: any, id: string) => { if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(); const a = await one<any>(`SELECT a.*, t.name, t.questions, t.allow_file FROM assessments a JOIN assessment_templates t ON t.id=a.template_id WHERE a.id=$1 AND a.candidate_id=$2 AND a.organization_id=$3`, [id, ctx.candidateId, ctx.orgId]); if (!a) throw notFound(); return a; };
  app.post('/api/v1/portal/candidate/assessments/:id/start', async (req) => {
    const ctx = candidateCtx(req);
    const a = await myAssessment(ctx, (req.params as any).id);
    if (a.status === 'started') return { ok: true };
    assertTransition('assessment', a.status, 'started');
    await updateRow('assessments', ctx.orgId, a.id, { status: 'started', started_at: new Date() });
    await activity(ctx, 'candidate', ctx.candidateId, 'system', `Candidate started assessment: ${a.name}`);
    return { ok: true };
  });
  app.post('/api/v1/portal/candidate/assessments/:id/save', async (req) => {
    const ctx = candidateCtx(req);
    const a = await myAssessment(ctx, (req.params as any).id);
    if (!['sent', 'started'].includes(a.status)) throw conflict('This assessment was already submitted');
    const b = z.object({ answers: z.record(z.string().max(20000)) }).parse(req.body);
    await updateRow('assessments', ctx.orgId, a.id, { answers: JSON.stringify(b.answers), status: 'started', started_at: a.started_at ?? new Date() });
    return { ok: true, saved_at: new Date() };
  });
  app.post('/api/v1/portal/candidate/assessments/:id/file', async (req) => {
    const ctx = candidateCtx(req);
    const a = await myAssessment(ctx, (req.params as any).id);
    if (!['sent', 'started'].includes(a.status)) throw conflict('This assessment was already submitted');
    if (!a.allow_file) throw badRequest('This assessment does not accept files');
    const f = await (req as any).file();
    if (!f) throw badRequest('Choose a file');
    const buf = await f.toBuffer();
    if (!buf.length || buf.length > 25 * 1024 * 1024) throw badRequest('File must be between 1 byte and 25 MB');
    const rel = saveFile(`assessments/${a.id}`, f.filename, buf);
    await updateRow('assessments', ctx.orgId, a.id, { file: rel, file_name: f.filename, status: a.status === 'sent' ? 'started' : undefined, started_at: a.started_at ?? new Date() });
    return { ok: true, file_name: f.filename, file_url: fileUrl(rel) };
  });
  app.post('/api/v1/portal/candidate/assessments/:id/submit', async (req) => {
    const ctx = candidateCtx(req);
    const a = await myAssessment(ctx, (req.params as any).id);
    const b = z.object({ answers: z.record(z.string().max(20000)) }).parse(req.body);
    const qs = (a.questions as any[]) ?? [];
    const missing = qs.map((_, i) => i).filter(i => !(b.answers[String(i)] ?? '').trim());
    if (missing.length) throw badRequest(`Answer every question before submitting (missing: ${missing.map(i => `Q${i + 1}`).join(', ')})`);
    assertTransition('assessment', a.status, 'completed');
    await updateRow('assessments', ctx.orgId, a.id, { answers: JSON.stringify(b.answers), status: 'completed', completed_at: new Date(), started_at: a.started_at ?? new Date() });
    const c = await myCandidate(ctx);
    await activity(ctx, 'candidate', c.id, 'status_change', `Candidate completed assessment: ${a.name}`, 'Ready to score', { assessment_id: a.id });
    await notify(ctx.orgId, [a.sent_by, c.sourced_by], { event: 'assessment.completed', title: `${fullName(c)} completed ${a.name}`, body: 'Ready to score.', link: `/recruiting/assessments?assessment=${a.id}` });
    return { ok: true };
  });
  app.get('/api/v1/portal/candidate/interviews', async (req) => {
    const ctx = candidateCtx(req);
    const rows = await q<any>(`SELECT i.id, i.kind, i.scheduled_at, i.duration_min, i.timezone, i.meeting_url, i.status, p.title position_title FROM interviews i LEFT JOIN positions p ON p.id=i.position_id WHERE i.candidate_id=$1 AND i.organization_id=$2 AND i.status <> 'requested' ORDER BY i.scheduled_at DESC`, [ctx.candidateId, ctx.orgId]);
    return rows.map(r => ({ ...r, meeting_url: r.status === 'scheduled' ? r.meeting_url : null, ics_url: r.status === 'scheduled' ? `/api/v1/portal/candidate/interviews/${r.id}/ics` : null }));
  });
  app.get('/api/v1/portal/candidate/interviews/:id/ics', async (req, reply) => {
    const ctx = candidateCtx(req);
    const i = await one<any>(`SELECT * FROM interviews WHERE id=$1 AND candidate_id=$2 AND organization_id=$3 AND status='scheduled'`, [(req.params as any).id, ctx.candidateId, ctx.orgId]);
    if (!i) throw notFound();
    return sendIcs(reply, i, ctx.org.name);
  });
  const offerOut = (o: any) => ({ id: o.id, status: o.status, position_title: o.position_title, company_name: o.company_name, pay_rate_cents: o.pay_rate_cents, currency: o.currency, rate_unit: o.rate_unit, weekly_hours: o.weekly_hours, start_date: o.start_date, expires_at: o.expires_at, terms: o.terms, sent_at: o.sent_at, viewed_at: o.viewed_at, responded_at: o.responded_at, signature_name: o.signature_name, signature_data: o.signature_data, signed_at: o.signed_at, signed_ip: o.signed_ip, decline_reason: o.decline_reason });
  const offerSql = `SELECT o.*, p.title position_title, co.name company_name FROM offers o LEFT JOIN positions p ON p.id=o.position_id LEFT JOIN companies co ON co.id=p.company_id WHERE o.candidate_id=$1 AND o.organization_id=$2`;
  app.get('/api/v1/portal/candidate/offers', async (req) => {
    const ctx = candidateCtx(req);
    // The candidate sees their own pay terms; the client bill rate is never returned.
    const rows = await q<any>(`${offerSql} AND o.status IN ('sent','viewed','accepted','declined','expired') AND o.sent_at IS NOT NULL ORDER BY o.created_at DESC`, [ctx.candidateId, ctx.orgId]);
    return rows.map(offerOut);
  });
  const myOffer = async (ctx: any, id: string) => { if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(); const o = await one<any>(`${offerSql} AND o.id=$3 AND o.sent_at IS NOT NULL`, [ctx.candidateId, ctx.orgId, id]); if (!o) throw notFound(); return o; };
  app.post('/api/v1/portal/candidate/offers/:id/view', async (req) => {
    const ctx = candidateCtx(req);
    const o = await myOffer(ctx, (req.params as any).id);
    if (o.status === 'sent') {
      await updateRow('offers', ctx.orgId, o.id, { status: 'viewed', viewed_at: new Date() });
      await activity(ctx, 'offer', o.id, 'status_change', 'Candidate viewed the offer', null, { from: 'sent', to: 'viewed' });
    }
    return offerOut(await myOffer(ctx, o.id));
  });
  app.post('/api/v1/portal/candidate/offers/:id/accept', async (req) => {
    const ctx = candidateCtx(req);
    const o = await myOffer(ctx, (req.params as any).id);
    const b = z.object({ signature_name: z.string().trim().min(2, 'Type your full name').max(120), signature_data: z.string().startsWith('data:image/png;base64,', 'Draw your signature').max(400_000, 'Signature image is too large'), agree: z.literal(true, { errorMap: () => ({ message: 'Please confirm you agree to the terms' }) }) }).parse(req.body);
    if (o.expires_at && o.expires_at < new Date().toISOString().slice(0, 10)) throw conflict('This offer has expired — contact your recruiter');
    assertTransition('offer', o.status, 'accepted');
    const c = await myCandidate(ctx);
    const signedAt = new Date();
    const cert = [`SIGNED OFFER — ${ctx.org.name}`, '', `Candidate: ${fullName(c)} (${c.email ?? ''})`, `Role: ${o.position_title ?? '—'}${o.company_name ? ` at ${o.company_name}` : ''}`, `Start date: ${o.start_date ?? '—'}`, `Weekly hours: ${o.weekly_hours ?? '—'}`, '', 'Terms:', o.terms ?? '—', '', '— Signature certificate —', `Typed name: ${b.signature_name}`, `Signed at (UTC): ${signedAt.toISOString()}`, `IP address: ${req.ip}`, `User: ${ctx.user.email}`, `Offer id: ${o.id}`].join('\n');
    const rel = saveFile(`offers/${o.id}`, 'signed-offer.txt', Buffer.from(cert));
    await tx(async (db) => {
      await updateRow('offers', ctx.orgId, o.id, { status: 'accepted', responded_at: signedAt, signature_name: b.signature_name, signature_data: b.signature_data, signed_at: signedAt, signed_ip: req.ip, viewed_at: o.viewed_at ?? signedAt }, db);
      await insertRow('documents', { organization_id: ctx.orgId, entity_type: 'candidate', entity_id: c.id, name: `Signed offer — ${o.position_title ?? 'position'}`, category: 'offer_letter', file: rel, mime: 'text/plain', size_bytes: cert.length, visibility: 'candidate', signature_status: 'signed', issue_date: signedAt.toISOString().slice(0, 10), created_by: ctx.userId }, db);
    });
    await activity(ctx, 'offer', o.id, 'status_change', `Accepted and e-signed by ${b.signature_name}`, `IP ${req.ip} · ${signedAt.toISOString()}`, { from: o.status, to: 'accepted' });
    await activity(ctx, 'candidate', c.id, 'status_change', `Offer accepted and signed — ${o.position_title ?? ''}`, 'Next step: create the placement', { offer_id: o.id });
    await audit(ctx, 'offer.accepted', { type: 'offer', id: o.id, label: `${fullName(c)} — ${o.position_title ?? ''}` }, { status: o.status }, { status: 'accepted', signed_ip: req.ip, signed_at: signedAt });
    const recruiters = await positionRecruiters(o.position_id);
    const approvers = await usersWithRoles(ctx.orgId, ['owner', 'admin']);
    await notify(ctx.orgId, [o.created_by, c.sourced_by, ...recruiters, o.approved_by, ...approvers.slice(0, 3)], { event: 'offer.accepted', title: `${fullName(c)} accepted the offer`, body: `${o.position_title ?? ''} — create the placement next.`, link: `/recruiting/offers?offer=${o.id}` });
    const pos = o.position_id ? await one<any>(`SELECT company_id FROM positions WHERE id=$1`, [o.position_id]) : null;
    await emit(ctx.orgId, 'offer.accepted', { offer_id: o.id, candidate_id: c.id, candidate_name: fullName(c), position_id: o.position_id, position_title: o.position_title, company_id: pos?.company_id ?? null, company_name: o.company_name, recruiter_id: c.sourced_by, start_date: o.start_date });
    return offerOut(await myOffer(ctx, o.id));
  });
  app.post('/api/v1/portal/candidate/offers/:id/decline', async (req) => {
    const ctx = candidateCtx(req);
    const o = await myOffer(ctx, (req.params as any).id);
    const b = z.object({ reason: z.string().trim().min(2, 'Let us know why (a few words is fine)').max(2000) }).parse(req.body);
    assertTransition('offer', o.status, 'declined');
    await updateRow('offers', ctx.orgId, o.id, { status: 'declined', responded_at: new Date(), decline_reason: b.reason });
    const c = await myCandidate(ctx);
    await activity(ctx, 'offer', o.id, 'status_change', 'Candidate declined the offer', b.reason, { from: o.status, to: 'declined' });
    await activity(ctx, 'candidate', c.id, 'status_change', `Offer declined — ${o.position_title ?? ''}`, b.reason);
    await audit(ctx, 'offer.declined', { type: 'offer', id: o.id, label: fullName(c) }, { status: o.status }, { status: 'declined' }, b.reason);
    await notify(ctx.orgId, [o.created_by, c.sourced_by, ...(await positionRecruiters(o.position_id))], { event: 'offer.declined', title: `${fullName(c)} declined the offer`, body: b.reason, link: `/recruiting/offers?offer=${o.id}` });
    await emit(ctx.orgId, 'offer.declined', { offer_id: o.id, candidate_id: c.id, candidate_name: fullName(c), position_id: o.position_id });
    return offerOut(await myOffer(ctx, o.id));
  });
  app.get('/api/v1/portal/candidate/documents', async (req) => {
    const ctx = candidateCtx(req);
    const docs = await q<any>(`SELECT id, name, category, file, created_at, signature_status, expires_at FROM documents WHERE organization_id=$1 AND entity_type='candidate' AND entity_id=$2 AND visibility='candidate' AND archived_at IS NULL ORDER BY created_at DESC`, [ctx.orgId, ctx.candidateId]);
    const media = await q<any>(`SELECT id, kind, file, file_name, url, created_at FROM candidate_media WHERE candidate_id=$1 AND organization_id=$2 ORDER BY created_at DESC`, [ctx.candidateId, ctx.orgId]);
    return { documents: docs.map(d => ({ ...d, file_url: fileUrl(d.file), file: undefined })), uploads: media.map(m => ({ ...m, file_url: fileUrl(m.file), file: undefined })) };
  });
  /* Messages: one thread between the candidate and their recruiter (message_threads kind 'candidate'). */
  async function candidateThread(ctx: any, create: boolean) {
    let t = await one<any>(`SELECT t.* FROM message_threads t JOIN thread_participants tp ON tp.thread_id=t.id AND tp.user_id=$3 WHERE t.organization_id=$1 AND t.kind='candidate' AND t.related_type='candidate' AND t.related_id=$2 ORDER BY t.created_at LIMIT 1`, [ctx.orgId, ctx.candidateId, ctx.userId]);
    if (!t && create) {
      const c = await myCandidate(ctx);
      const staffId = c.sourced_by ?? (await usersWithRoles(ctx.orgId, ['owner']))[0];
      t = await insertRow<any>('message_threads', { organization_id: ctx.orgId, subject: `${fullName(c)} — candidate messages`, kind: 'candidate', related_type: 'candidate', related_id: c.id, created_by: ctx.userId });
      for (const u of [ctx.userId, staffId].filter(Boolean)) await q(`INSERT INTO thread_participants (thread_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.id, u]);
    }
    return t;
  }
  app.get('/api/v1/portal/candidate/messages', async (req) => {
    const ctx = candidateCtx(req);
    const t = await candidateThread(ctx, false);
    const c = await myCandidate(ctx);
    const recruiter = c.sourced_by ? await one<any>(`SELECT name FROM users WHERE id=$1`, [c.sourced_by]) : null;
    if (!t) return { thread: null, messages: [], recruiter_name: recruiter?.name ?? null };
    await q(`UPDATE thread_participants SET last_read_at=now() WHERE thread_id=$1 AND user_id=$2`, [t.id, ctx.userId]);
    const messages = await q<any>(`SELECT m.id, m.body, m.created_at, m.author_id, u.name author_name, (m.author_id=$2) mine FROM messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.thread_id=$1 ORDER BY m.created_at`, [t.id, ctx.userId]);
    return { thread: { id: t.id, subject: t.subject }, messages, recruiter_name: recruiter?.name ?? null };
  });
  app.post('/api/v1/portal/candidate/messages', async (req) => {
    const ctx = candidateCtx(req);
    const b = z.object({ body: z.string().trim().min(1, 'Write a message').max(5000) }).parse(req.body);
    await rateLimitMsg(ctx.userId);
    const t = await candidateThread(ctx, true);
    const m = await insertRow<any>('messages', { organization_id: ctx.orgId, thread_id: t.id, author_id: ctx.userId, body: b.body });
    await q(`UPDATE message_threads SET last_message_at=now() WHERE id=$1`, [t.id]);
    const others = (await q<any>(`SELECT user_id FROM thread_participants WHERE thread_id=$1 AND user_id <> $2`, [t.id, ctx.userId])).map(r => r.user_id);
    await notify(ctx.orgId, others, { event: 'message.new', title: `Message from ${ctx.user.name}`, body: b.body.slice(0, 140), link: `/comms/inbox?thread=${t.id}` });
    await activity(ctx, 'candidate', ctx.candidateId, 'message', 'Candidate sent a message', b.body.slice(0, 500));
    return m;
  });
  async function rateLimitMsg(uid: string) { const { rateLimit } = await import('../core/ratelimit'); await rateLimit(`cand-msg:${uid}`, 30, 600); }

  /* ═════════ Client Portal: Candidates & Interviews ═════════ */
  const clientSubs = `SELECT s.*, p.title position_title, p.id position_id, c.first_name, c.last_name, c.headline, c.country, c.city, c.timezone, c.years_experience, c.skills, c.software, c.languages, c.education, c.experience, c.availability_status, c.earliest_start, c.weekly_hours, c.preferred_hours, c.portfolio_url, c.avatar_color, c.video_file, c.email, c.phone, c.rate_target_cents, c.rate_currency, c.rate_unit, c.id cand_id,
    (SELECT min(i.scheduled_at) FROM interviews i WHERE i.submission_id=s.id AND i.status IN ('scheduled','requested') AND i.scheduled_at > now()) next_interview
    FROM candidate_submissions s JOIN positions p ON p.id=s.position_id JOIN candidates c ON c.id=s.candidate_id WHERE s.organization_id=$1 AND p.company_id=$2 AND s.status <> 'withdrawn'`;
  const subOut = (r: any) => ({ id: r.id, submission_id: r.id, status: r.status, client_decision: r.client_decision, client_feedback: r.client_feedback, created_at: r.created_at, position_id: r.position_id, position_title: r.position_title, next_interview: r.next_interview, profile: clientSafeProfile({ ...r, id: r.cand_id }, r) });
  app.get('/api/v1/portal/client/candidates', async (req) => {
    const ctx = clientCtx(req);
    const f = req.query as any;
    const params: unknown[] = [ctx.orgId, ctx.companyId];
    let extra = '';
    if (f.status === 'to_review') extra = ` AND s.status IN ('submitted','client_review') AND s.client_decision IS NULL`;
    else if (f.status) { params.push(String(f.status).split(',')); extra = ` AND s.status = ANY($${params.length})`; }
    if (f.position_id) { params.push(f.position_id); extra += ` AND s.position_id = $${params.length}`; }
    const rows = await q<any>(`${clientSubs}${extra} ORDER BY s.created_at DESC LIMIT 200`, params);
    const positions = await q<any>(`SELECT p.id, p.title, count(s.id)::int n FROM positions p JOIN candidate_submissions s ON s.position_id=p.id AND s.status <> 'withdrawn' WHERE p.organization_id=$1 AND p.company_id=$2 GROUP BY p.id, p.title ORDER BY p.title`, [ctx.orgId, ctx.companyId]);
    const counts = await one<any>(`SELECT count(*) FILTER (WHERE s.status IN ('submitted','client_review') AND s.client_decision IS NULL)::int to_review, count(*) FILTER (WHERE s.status='client_interview')::int interviewing, count(*) FILTER (WHERE s.status IN ('offer','hired'))::int offers, count(*)::int total FROM candidate_submissions s JOIN positions p ON p.id=s.position_id WHERE s.organization_id=$1 AND p.company_id=$2 AND s.status <> 'withdrawn'`, [ctx.orgId, ctx.companyId]);
    return { rows: rows.map(subOut), positions, counts, can_decide: CLIENT_DECIDERS.includes(ctx.role.key) };
  });
  app.get('/api/v1/portal/client/candidates/compare', async (req) => {
    const ctx = clientCtx(req);
    const ids = String((req.query as any).ids ?? '').split(',').filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 4);
    if (ids.length < 2) throw badRequest('Pick 2 to 4 candidates to compare');
    const rows = await q<any>(`${clientSubs} AND s.id = ANY($3)`, [ctx.orgId, ctx.companyId, ids]);
    if (rows.length !== ids.length) throw notFound();
    return rows.map(subOut);
  });
  const loadClientSub = async (ctx: any, id: string) => { if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(); const r = await one<any>(`${clientSubs} AND s.id=$3`, [ctx.orgId, ctx.companyId, id]); if (!r) throw notFound(); return r; };
  app.get('/api/v1/portal/client/candidates/:id', async (req) => {
    const ctx = clientCtx(req);
    let r = await loadClientSub(ctx, (req.params as any).id);
    if (r.status === 'submitted') {
      await updateRow('candidate_submissions', ctx.orgId, r.id, { status: 'client_review' });
      await activity(ctx, 'submission', r.id, 'status_change', `Client opened the profile (${ctx.user.name}) — moved to client review`, null, { from: 'submitted', to: 'client_review' });
      r = await loadClientSub(ctx, r.id);
    }
    const interviews = await q<any>(`SELECT i.id, i.scheduled_at, i.duration_min, i.timezone, i.status, i.meeting_url, i.request_note, i.outcome FROM interviews i WHERE i.submission_id=$1 ORDER BY i.scheduled_at DESC`, [r.id]);
    return { ...subOut(r), interviews: interviews.map(i => ({ ...i, meeting_url: i.status === 'scheduled' ? i.meeting_url : null })), can_decide: CLIENT_DECIDERS.includes(ctx.role.key) };
  });
  app.post('/api/v1/portal/client/candidates/:id/decision', async (req) => {
    const ctx = clientCtx(req);
    if (!CLIENT_DECIDERS.includes(ctx.role.key)) throw forbidden('Your client role can view candidates but not decide on them');
    const r = await loadClientSub(ctx, (req.params as any).id);
    const b = z.object({ decision: z.enum(['approve', 'reject', 'interview']), feedback: z.string().trim().max(3000).optional(), preferred_time: z.string().datetime({ offset: true }).optional(), duration_min: z.number().int().min(15).max(240).default(45), timezone: z.string().max(80).default('America/New_York') }).parse(req.body);
    if (['hired', 'rejected'].includes(r.status)) throw conflict(`This candidate is already ${r.status}`);
    const recruiters = [...(await positionRecruiters(r.position_id)), r.submitted_by];
    const cname = `${r.first_name} ${r.last_name ? r.last_name[0] + '.' : ''}`;
    if (b.decision === 'reject') {
      if (!b.feedback) throw badRequest('Please share a short reason so the recruiter can find a better match');
      assertTransition('submission', r.status, 'rejected');
      await updateRow('candidate_submissions', ctx.orgId, r.id, { status: 'rejected', client_decision: 'reject', client_feedback: b.feedback, status_reason: `Client: ${b.feedback}`, client_decided_by: ctx.userId, client_decided_at: new Date() });
      await activity(ctx, 'submission', r.id, 'status_change', `Client rejected (${ctx.user.name})`, b.feedback, { from: r.status, to: 'rejected' });
    } else if (b.decision === 'approve') {
      if (r.status === 'submitted') await updateRow('candidate_submissions', ctx.orgId, r.id, { status: 'client_review' });
      await updateRow('candidate_submissions', ctx.orgId, r.id, { client_decision: 'approve', client_feedback: b.feedback ?? r.client_feedback, client_decided_by: ctx.userId, client_decided_at: new Date() });
      await activity(ctx, 'submission', r.id, 'note', `Client approved the candidate (${ctx.user.name})`, b.feedback ?? null);
    } else {
      if (!b.preferred_time) throw badRequest('Pick a preferred date and time for the interview');
      if (new Date(b.preferred_time).getTime() < Date.now()) throw badRequest('Pick a time in the future');
      if (!canTransition('submission', r.status, 'client_interview') && r.status !== 'client_interview') throw conflict(`An interview cannot be requested at the ${r.status.replace('_', ' ')} stage`);
      if (await one(`SELECT 1 FROM interviews WHERE submission_id=$1 AND status IN ('requested','scheduled') AND scheduled_at > now()`, [r.id])) throw conflict('An interview is already requested or scheduled for this candidate');
      if (r.status === 'submitted') await updateRow('candidate_submissions', ctx.orgId, r.id, { status: 'client_review' });
      const iv = await insertRow<any>('interviews', { organization_id: ctx.orgId, candidate_id: r.cand_id, position_id: r.position_id, submission_id: r.id, kind: 'client', scheduled_at: b.preferred_time, duration_min: b.duration_min, timezone: b.timezone, meeting_url: meetingUrl(), interviewers: ctx.user.name, interviewer_ids: [], status: 'requested', requested_by: ctx.userId, request_note: b.feedback ?? null });
      await updateRow('candidate_submissions', ctx.orgId, r.id, { client_decision: 'interview', client_feedback: b.feedback ?? r.client_feedback, client_decided_by: ctx.userId, client_decided_at: new Date() });
      await activity(ctx, 'interview', iv.id, 'system', `Interview requested by client (${ctx.user.name}) for ${fmtWhen(b.preferred_time, b.timezone)} (${b.timezone})`, b.feedback ?? null);
      await activity(ctx, 'submission', r.id, 'note', `Client requested an interview (${ctx.user.name})`, b.feedback ?? null, { interview_id: iv.id });
      await activity(ctx, 'candidate', r.cand_id, 'meeting', `Client requested an interview — ${r.position_title}`, `Preferred: ${fmtWhen(b.preferred_time, b.timezone)} (${b.timezone})`, { interview_id: iv.id });
      await notify(ctx.orgId, recruiters, { event: 'client.feedback', title: `${ctx.user.name} requested an interview with ${cname}`, body: `${r.position_title} · preferred ${fmtWhen(b.preferred_time, b.timezone)}`, link: `/recruiting/interviews?interview=${iv.id}` });
      await emit(ctx.orgId, 'interview.requested', { interview_id: iv.id, submission_id: r.id, candidate_id: r.cand_id, position_id: r.position_id, company_id: ctx.companyId });
      return { ok: true, interview_id: iv.id };
    }
    await activity(ctx, 'candidate', r.cand_id, 'note', `Client ${b.decision === 'approve' ? 'approved' : 'rejected'} for ${r.position_title}`, b.feedback ?? null, { submission_id: r.id });
    await notify(ctx.orgId, recruiters, { event: 'client.feedback', title: `Client ${b.decision === 'approve' ? 'approved' : 'rejected'} ${cname}`, body: `${r.position_title}${b.feedback ? ' — ' + b.feedback.slice(0, 120) : ''}`, link: `/recruiting/positions/${r.position_id}?tab=pipeline` });
    await emit(ctx.orgId, 'submission.client_decision', { submission_id: r.id, decision: b.decision, candidate_id: r.cand_id, position_id: r.position_id, company_id: ctx.companyId });
    return { ok: true };
  });
  app.post('/api/v1/portal/client/candidates/:id/feedback', async (req) => {
    const ctx = clientCtx(req);
    const r = await loadClientSub(ctx, (req.params as any).id);
    const b = z.object({ feedback: z.string().trim().min(2, 'Write your feedback').max(3000) }).parse(req.body);
    const merged = [r.client_feedback, `${ctx.user.name}: ${b.feedback}`].filter(Boolean).join('\n');
    await updateRow('candidate_submissions', ctx.orgId, r.id, { client_feedback: merged });
    await activity(ctx, 'submission', r.id, 'note', `Client feedback from ${ctx.user.name}`, b.feedback);
    await notify(ctx.orgId, [...(await positionRecruiters(r.position_id)), r.submitted_by], { event: 'client.feedback', title: `Client feedback on ${r.first_name}`, body: b.feedback.slice(0, 140), link: `/recruiting/positions/${r.position_id}?tab=pipeline` });
    return { ok: true };
  });

  app.get('/api/v1/portal/client/interviews', async (req) => {
    const ctx = clientCtx(req);
    const rows = await q<any>(`SELECT i.id, i.scheduled_at, i.duration_min, i.timezone, i.status, i.meeting_url, i.request_note, i.outcome, i.submission_id, p.title position_title, c.first_name, c.last_name, c.avatar_color, c.headline,
      (SELECT json_agg(json_build_object('overall', f.overall, 'recommendation', f.recommendation, 'notes', f.notes, 'author', f.author_label, 'created_at', f.created_at)) FROM interview_feedback f WHERE f.interview_id=i.id AND f.author_id=$3) my_feedback
      FROM interviews i JOIN positions p ON p.id=i.position_id JOIN candidates c ON c.id=i.candidate_id WHERE i.organization_id=$1 AND p.company_id=$2 AND i.kind='client' ORDER BY i.scheduled_at DESC LIMIT 200`, [ctx.orgId, ctx.companyId, ctx.userId]);
    return rows.map(r => ({ ...r, candidate_name: `${r.first_name} ${r.last_name ? r.last_name[0] + '.' : ''}`.trim(), last_name: undefined, meeting_url: r.status === 'scheduled' ? r.meeting_url : null, ics_url: r.status === 'scheduled' ? `/api/v1/portal/client/interviews/${r.id}/ics` : null }));
  });
  const loadClientInterview = async (ctx: any, id: string) => { if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(); const i = await one<any>(`SELECT i.*, p.title position_title, c.first_name, c.last_name FROM interviews i JOIN positions p ON p.id=i.position_id JOIN candidates c ON c.id=i.candidate_id WHERE i.id=$1 AND i.organization_id=$2 AND p.company_id=$3 AND i.kind='client'`, [id, ctx.orgId, ctx.companyId]); if (!i) throw notFound(); return i; };
  app.get('/api/v1/portal/client/interviews/:id/ics', async (req, reply) => {
    const ctx = clientCtx(req);
    const i = await loadClientInterview(ctx, (req.params as any).id);
    if (i.status !== 'scheduled') throw notFound();
    return sendIcs(reply, i, ctx.org.name);
  });
  app.post('/api/v1/portal/client/interviews/:id/feedback', async (req) => {
    const ctx = clientCtx(req);
    if (!CLIENT_DECIDERS.includes(ctx.role.key)) throw forbidden('Your client role cannot leave interview feedback');
    const i = await loadClientInterview(ctx, (req.params as any).id);
    if (!['scheduled', 'completed'].includes(i.status) || new Date(i.scheduled_at) > new Date(Date.now() + 15 * 60000)) throw conflict('Feedback opens once the interview has taken place');
    const b = z.object({ overall: z.number().int().min(1).max(5), recommendation: z.enum(['strong_hire', 'hire', 'maybe', 'no_hire']), notes: z.string().trim().max(5000).optional() }).parse(req.body);
    const f = await insertRow('interview_feedback', { organization_id: ctx.orgId, interview_id: i.id, author_id: ctx.userId, author_label: `Client: ${ctx.user.name}`, scores: JSON.stringify({}), overall: b.overall, recommendation: b.recommendation, notes: b.notes ?? null });
    if (i.status === 'scheduled') await updateRow('interviews', ctx.orgId, i.id, { status: 'completed' });
    await activity(ctx, 'interview', i.id, 'note', `Client feedback (${ctx.user.name}): ${b.overall}/5 · ${b.recommendation.replace('_', ' ')}`, b.notes ?? null);
    await activity(ctx, 'candidate', i.candidate_id, 'note', `Client interview feedback: ${b.overall}/5 (${b.recommendation.replace('_', ' ')})`, b.notes ?? null, { interview_id: i.id });
    if (i.submission_id) await q(`UPDATE candidate_submissions SET client_feedback = concat_ws(E'\\n', client_feedback, $2::text), updated_at=now() WHERE id=$1`, [i.submission_id, `${ctx.user.name} (interview): ${b.overall}/5 ${b.recommendation.replace('_', ' ')}${b.notes ? ' — ' + b.notes : ''}`]);
    const sub = i.submission_id ? await one<any>(`SELECT submitted_by FROM candidate_submissions WHERE id=$1`, [i.submission_id]) : null;
    await notify(ctx.orgId, [...(await positionRecruiters(i.position_id)), i.created_by, sub?.submitted_by], { event: 'client.feedback', title: `Client interview feedback: ${i.first_name}`, body: `${b.overall}/5 · ${b.recommendation.replace('_', ' ')}`, link: `/recruiting/interviews?interview=${i.id}` });
    return f;
  });
  app.post('/api/v1/portal/client/interviews/:id/change-request', async (req) => {
    const ctx = clientCtx(req);
    const i = await loadClientInterview(ctx, (req.params as any).id);
    if (!['scheduled', 'requested'].includes(i.status)) throw conflict('This interview can no longer be changed');
    const b = z.object({ message: z.string().trim().min(2, 'Tell us what to change').max(2000) }).parse(req.body);
    await activity(ctx, 'interview', i.id, 'note', `Client asked to change the interview (${ctx.user.name})`, b.message);
    await notify(ctx.orgId, [...(await positionRecruiters(i.position_id)), i.created_by], { event: 'interview.changed', title: `${ctx.user.name} asked to change an interview`, body: `${i.first_name} · ${b.message.slice(0, 120)}`, link: `/recruiting/interviews?interview=${i.id}` });
    return { ok: true };
  });
}
