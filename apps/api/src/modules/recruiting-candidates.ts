// RECRUITING — Candidates (persistent people), lifecycle machine, media uploads, Analyze Resume, applications,
// natural-language search, AI drafts.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, insertRow, updateRow, tx } from '../core/db';
import { staff, need, can, assertTransition, getOr404 } from '../core/context';
import { badRequest, conflict, forbidden, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { saveFile } from '../core/storage';
import { allowedNext, normalizeEmail, normalizePhone } from '@veyro/shared';
import { assertAiAvailable, logAi, analyzeResumeAI, extractTextFromFile, parseSearch, draft, expandCountry, AI_MODEL, type DraftKind } from '../adapters/ai';
import { canEditCandidate, assertEditCandidate, candOut, fullName, stripOfferComp, fileUrl, viewablePosition, positionScopeSql, positionViewScope } from './_recruiting/common';

const money = z.number().int().min(0).nullable().optional();
export const candBody = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(80),
  last_name: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().email('Enter a valid email').max(200).nullable().optional().or(z.literal('').transform(() => null)),
  phone: z.string().trim().max(40).nullable().optional(),
  country: z.string().max(80).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  timezone: z.string().max(80).nullable().optional(),
  headline: z.string().max(200).nullable().optional(),
  years_experience: z.number().int().min(0).max(60).nullable().optional(),
  skills: z.array(z.string().max(80)).max(60).optional(),
  software: z.array(z.string().max(80)).max(60).optional(),
  languages: z.array(z.string().max(60)).max(20).optional(),
  education: z.array(z.object({ degree: z.string().max(200), school: z.string().max(200).nullable().optional(), year: z.number().int().nullable().optional(), evidence: z.string().max(500).nullable().optional() })).max(20).optional(),
  experience: z.array(z.object({ title: z.string().max(200), company: z.string().max(200).nullable().optional(), start: z.string().max(20).nullable().optional(), end: z.string().max(20).nullable().optional(), evidence: z.string().max(500).nullable().optional() })).max(30).optional(),
  rate_min_cents: money, rate_target_cents: money,
  rate_currency: z.string().length(3).optional(), rate_unit: z.enum(['hour', 'day', 'week', 'month']).optional(), rate_note: z.string().max(500).nullable().optional(),
  availability_status: z.enum(['available', 'employed', 'not_available']).optional(),
  earliest_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal('').transform(() => null)),
  weekly_hours: z.number().int().min(1).max(80).nullable().optional(),
  preferred_hours: z.string().max(200).nullable().optional(),
  portfolio_url: z.string().url('Enter a full URL (https://…)').max(500).nullable().optional().or(z.literal('').transform(() => null)),
  source: z.string().max(80).nullable().optional(),
  sourced_by: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  resume_text: z.string().max(100000).nullable().optional(),
});
const jsonCols = (b: any) => ({ ...b, education: b.education ? JSON.stringify(b.education) : undefined, experience: b.experience ? JSON.stringify(b.experience) : undefined });
const REASON_REQUIRED = ['rejected', 'blacklisted', 'on_hold', 'withdrawn'];

export async function findDuplicates(orgId: string, email: string | null | undefined, phone: string | null | undefined, excludeId?: string) {
  const e = normalizeEmail(email), p = normalizePhone(phone);
  if (!e && !p) return [];
  return q<any>(`SELECT id, first_name, last_name, email, phone, status, sourced_by, created_at FROM candidates WHERE organization_id=$1 AND archived_at IS NULL AND ($4::uuid IS NULL OR id <> $4) AND ((($2)::text IS NOT NULL AND lower(email)=$2) OR (($3)::text IS NOT NULL AND regexp_replace(coalesce(phone,''), '[^0-9+]', '', 'g')=$3)) LIMIT 5`, [orgId, e, p, excludeId ?? null]);
}

export default async function (app: FastifyInstance) {
  /* ── List with filters ── */
  app.get('/api/v1/candidates', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'view');
    const lp = listParams(req);
    const f = lp.filters;
    const params: unknown[] = [ctx.orgId];
    const where = ['c.organization_id = $1', 'c.archived_at IS NULL'];
    const add = (v: unknown, sql: (n: string) => string) => { params.push(v); where.push(sql(`$${params.length}`)); };
    if (f.status) add(f.status.split(','), n => `c.status = ANY(${n})`);
    if (f.exclude_status) add(f.exclude_status.split(','), n => `NOT (c.status = ANY(${n}))`);
    if (f.source) add(f.source, n => `c.source = ${n}`);
    if (f.recruiter_id) add(f.recruiter_id === 'me' ? ctx.userId : f.recruiter_id, n => `c.sourced_by = ${n}`);
    if (f.position_id) add(f.position_id, n => `(EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=c.id AND a.position_id=${n}) OR EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id AND s.position_id=${n}))`);
    if (f.has_resume === 'true') where.push(`(c.resume_file IS NOT NULL OR coalesce(c.resume_text,'') <> '')`); else if (f.has_resume === 'false') where.push(`(c.resume_file IS NULL AND coalesce(c.resume_text,'') = '')`);
    if (f.has_video === 'true') where.push('c.video_file IS NOT NULL'); else if (f.has_video === 'false') where.push('c.video_file IS NULL');
    if (f.from) add(f.from, n => `c.created_at >= ${n}::date`);
    if (f.to) add(f.to, n => `c.created_at < (${n}::date + 1)`);
    if (f.skills) add(f.skills.split(',').map(s => s.trim().toLowerCase()).filter(Boolean), n => `(SELECT count(*) FROM unnest(c.skills) x WHERE lower(x) = ANY(${n})) >= cardinality(${n})`);
    if (f.software) add(f.software.split(',').map(s => s.trim().toLowerCase()).filter(Boolean), n => `(SELECT count(*) FROM unnest(c.software) x WHERE lower(x) = ANY(${n})) >= cardinality(${n})`);
    if (f.languages) add(f.languages.split(',').map(s => s.trim().toLowerCase()).filter(Boolean), n => `(SELECT count(*) FROM unnest(c.languages) x WHERE lower(x) = ANY(${n})) >= cardinality(${n})`);
    if (f.bilingual === 'true') where.push('cardinality(c.languages) >= 2');
    if (f.country) add(f.country.split(',').flatMap(expandCountry).map(s => s.toLowerCase()), n => `lower(c.country) = ANY(${n})`);
    if (f.max_rate) add(Math.round(Number(f.max_rate)), n => `c.rate_min_cents IS NOT NULL AND c.rate_min_cents <= ${n}`);
    if (f.min_years) add(Number(f.min_years), n => `c.years_experience >= ${n}`);
    if (f.available === 'true') where.push(`c.availability_status = 'available'`);
    if (f.tag) add(f.tag, n => `${n} = ANY(c.tags)`);
    if (f.keywords) for (const k of f.keywords.split(',').filter(Boolean)) add(`%${k}%`, n => `(c.headline ILIKE ${n} OR c.resume_text ILIKE ${n} OR array_to_string(c.skills,' ') ILIKE ${n})`);
    if (f.needs_review === 'true') where.push(`(c.status = 'new_applicant' OR EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=c.id AND a.status='new'))`);
    if (f.stage) {
      const STAGE: Record<string, string> = {
        submitted: `EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id)`,
        client_interview: `EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id AND s.status IN ('client_interview','offer','hired'))`,
        offer: `EXISTS (SELECT 1 FROM offers o WHERE o.candidate_id=c.id)`,
        qualified: `(c.status IN ('qualified','talent_pool','submitted','hired') OR EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id))`,
        hired: `c.status = 'hired'`,
      };
      if (STAGE[f.stage]) where.push(STAGE[f.stage]);
    }
    const r = await paged({
      select: `c.*, u.name sourced_by_name, (SELECT max(a.created_at) FROM applications a WHERE a.candidate_id=c.id) last_applied_at, (SELECT count(*)::int FROM applications a WHERE a.candidate_id=c.id) applications_count, (SELECT count(*)::int FROM candidate_submissions s WHERE s.candidate_id=c.id) submissions_count, (SELECT p.title FROM applications a JOIN positions p ON p.id=a.position_id WHERE a.candidate_id=c.id ORDER BY a.created_at DESC LIMIT 1) last_position_title`,
      from: 'candidates c LEFT JOIN users u ON u.id=c.sourced_by', where, params, lp,
      searchCols: ["(c.first_name || ' ' || coalesce(c.last_name,''))", 'c.email', 'c.phone', 'c.headline', "array_to_string(c.skills,' ')", "array_to_string(c.software,' ')", 'c.country'],
      sortMap: { name: 'c.first_name', created_at: 'c.created_at', status: 'c.status', years_experience: 'c.years_experience', country: 'c.country', source: 'c.source', sourced_by_name: 'u.name', last_applied_at: '(SELECT max(a.created_at) FROM applications a WHERE a.candidate_id=c.id)', rate_min_cents: 'c.rate_min_cents' },
      defaultSort: 'c.created_at DESC',
    });
    r.rows = r.rows.map((c: any) => { const o = candOut(ctx, c); delete o.resume_text; return { ...o, has_resume: !!(c.resume_file || c.resume_text), has_video: !!c.video_file }; });
    return r;
  });

  app.get('/api/v1/candidates/facets', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'view');
    const [countries, sources, skills] = await Promise.all([
      q<any>(`SELECT country v, count(*)::int n FROM candidates WHERE organization_id=$1 AND country IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [ctx.orgId]),
      q<any>(`SELECT source v, count(*)::int n FROM candidates WHERE organization_id=$1 AND source IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [ctx.orgId]),
      q<any>(`SELECT x v, count(*)::int n FROM candidates, unnest(skills) x WHERE organization_id=$1 GROUP BY 1 ORDER BY 2 DESC LIMIT 60`, [ctx.orgId]),
    ]);
    return { countries, sources, skills };
  });

  app.get('/api/v1/candidates/duplicates', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'view');
    const { email, phone, exclude } = req.query as any;
    return { duplicates: (await findDuplicates(ctx.orgId, email, phone, exclude)).map(d => ({ ...d, name: fullName(d) })) };
  });

  /* ── Create (no position or client required) ── */
  app.post('/api/v1/candidates', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'create');
    const b = candBody.extend({ status: z.enum(['new_applicant', 'screening', 'talent_pool', 'future']).default('new_applicant'), force: z.boolean().default(false), position_id: z.string().uuid().nullable().optional() }).parse(req.body);
    const { force, position_id, ...fields } = b;
    const dups = await findDuplicates(ctx.orgId, b.email, b.phone);
    if (dups.length && !force) throw conflict('Possible duplicate candidate — same email or phone already exists', { duplicates: dups.map(d => ({ ...d, name: fullName(d) })) });
    if (fields.sourced_by && !(await one(`SELECT 1 FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'`, [ctx.orgId, fields.sourced_by]))) throw badRequest('Sourced-by must be a team member');
    if (position_id) await viewablePosition(ctx, position_id);
    const c = await tx(async (db) => {
      const cand = await insertRow<any>('candidates', { organization_id: ctx.orgId, ...jsonCols(fields), email: normalizeEmail(fields.email), sourced_by: fields.sourced_by ?? ctx.userId, source: fields.source ?? 'Sourced by recruiter', avatar_color: pick(), created_by: ctx.userId }, db);
      if (position_id) await insertRow('applications', { organization_id: ctx.orgId, candidate_id: cand.id, position_id, source: cand.source, recruiter_id: cand.sourced_by, status: 'reviewed', reviewed_at: new Date() }, db);
      return cand;
    });
    await activity(ctx, 'candidate', c.id, 'system', `Candidate created by ${ctx.user.name}`, dups.length ? `Created despite ${dups.length} possible duplicate(s)` : null);
    await emit(ctx.orgId, 'candidate.created', { candidate_id: c.id, candidate_name: fullName(c), source: c.source, recruiter_id: c.sourced_by, sourced_by: c.sourced_by });
    return candOut(ctx, c);
  });

  /* ── Detail with every tab's data ── */
  app.get('/api/v1/candidates/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'view');
    const c = await getOr404<any>('candidates', ctx, (req.params as any).id);
    const [sb, cb, applications, submissions, interviews, assessments, offers, documents, media, extraction, worker] = await Promise.all([
      c.sourced_by ? one<any>(`SELECT id, name, avatar_color FROM users WHERE id=$1`, [c.sourced_by]) : null,
      c.created_by ? one<any>(`SELECT name FROM users WHERE id=$1`, [c.created_by]) : null,
      q(`SELECT a.*, p.title position_title, co.name company_name, u.name recruiter_name, l.label link_label FROM applications a LEFT JOIN positions p ON p.id=a.position_id LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users u ON u.id=a.recruiter_id LEFT JOIN sourcing_links l ON l.id=a.sourcing_link_id WHERE a.candidate_id=$1 ORDER BY a.created_at DESC`, [c.id]),
      q(`SELECT s.*, p.title position_title, co.name company_name, u.name submitted_by_name FROM candidate_submissions s JOIN positions p ON p.id=s.position_id LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users u ON u.id=s.submitted_by WHERE s.candidate_id=$1 ORDER BY s.created_at DESC`, [c.id]),
      q(`SELECT i.*, p.title position_title, (SELECT json_agg(f ORDER BY f.created_at) FROM interview_feedback f WHERE f.interview_id=i.id) feedback FROM interviews i LEFT JOIN positions p ON p.id=i.position_id WHERE i.candidate_id=$1 ORDER BY i.scheduled_at DESC`, [c.id]),
      q(`SELECT a.*, t.name template_name, t.category, t.questions, p.title position_title FROM assessments a JOIN assessment_templates t ON t.id=a.template_id LEFT JOIN positions p ON p.id=a.position_id WHERE a.candidate_id=$1 ORDER BY a.sent_at DESC`, [c.id]),
      q(`SELECT o.*, p.title position_title, co.name company_name FROM offers o LEFT JOIN positions p ON p.id=o.position_id LEFT JOIN companies co ON co.id=p.company_id WHERE o.candidate_id=$1 ORDER BY o.created_at DESC`, [c.id]),
      q(`SELECT id, name, category, visibility, expires_at, verification, signature_status, created_at, file FROM documents WHERE organization_id=$1 AND entity_type='candidate' AND entity_id=$2 AND archived_at IS NULL ORDER BY created_at DESC`, [ctx.orgId, c.id]),
      q(`SELECT * FROM candidate_media WHERE candidate_id=$1 ORDER BY created_at DESC`, [c.id]),
      one(`SELECT e.*, u.name accepted_by_name FROM resume_extractions e LEFT JOIN users u ON u.id=e.accepted_by WHERE e.candidate_id=$1 ORDER BY e.created_at DESC LIMIT 1`, [c.id]),
      one<any>(`SELECT w.id, w.status FROM workers w WHERE w.candidate_id=$1`, [c.id]),
    ]);
    const canEdit = await canEditCandidate(ctx, c);
    return {
      ...candOut(ctx, c), sourced_by_name: sb?.name ?? null, sourced_by_color: sb?.avatar_color ?? null, created_by_name: cb?.name ?? null,
      applications, submissions, interviews, assessments: assessments.map((a: any) => ({ ...a, file_url: fileUrl(a.file) })), offers: offers.map((o: any) => stripOfferComp(ctx, o)),
      documents: (documents as any[]).map(d => ({ ...d, file_url: fileUrl(d.file), file: undefined })), media: (media as any[]).map(m => ({ ...m, file_url: fileUrl(m.file) })),
      extraction, worker,
      can_edit: canEdit, can_blacklist: can(ctx, 'candidates', 'approve') || can(ctx, 'candidates', 'delete'),
      allowed_status: allowedNext('candidate', c.status),
    };
  });

  app.patch('/api/v1/candidates/:id', async (req) => {
    const ctx = staff(req);
    const c = await getOr404<any>('candidates', ctx, (req.params as any).id);
    await assertEditCandidate(ctx, c);
    const b = candBody.partial().parse(req.body);
    if (b.sourced_by !== undefined && b.sourced_by !== c.sourced_by) {
      if (!can(ctx, 'candidates', 'approve')) throw forbidden('Only managers can change recruiter attribution');
      await audit(ctx, 'candidate.attribution_changed', { type: 'candidate', id: c.id, label: fullName(c) }, { sourced_by: c.sourced_by }, { sourced_by: b.sourced_by });
    }
    const upd = await updateRow<any>('candidates', ctx.orgId, c.id, { ...jsonCols(b), email: b.email !== undefined ? normalizeEmail(b.email) : undefined });
    const changed = Object.keys(b).filter(k => JSON.stringify((b as any)[k]) !== JSON.stringify(c[k]));
    if (changed.length) await activity(ctx, 'candidate', c.id, 'system', `Profile updated: ${changed.map(k => k.replace(/_cents$/, '').replace(/_/g, ' ')).join(', ')}`);
    return candOut(ctx, upd);
  });

  /* ── Lifecycle ── */
  async function changeStatus(ctx: any, c: any, to: string, reason?: string | null) {
    assertTransition('candidate', c.status, to);
    if (REASON_REQUIRED.includes(to) && !reason?.trim()) throw badRequest(`A reason is required to mark a candidate ${to.replace('_', ' ')}`);
    if (to === 'blacklisted' && !(can(ctx, 'candidates', 'approve') || can(ctx, 'candidates', 'delete'))) throw forbidden('Only managers can blacklist a candidate');
    if (to === 'interview' && !(await one(`SELECT 1 FROM interviews WHERE candidate_id=$1 AND status IN ('scheduled','requested','completed')`, [c.id]))) throw conflict('Schedule an interview to move this candidate to Interview', { needs: 'interview' });
    if (to === 'submitted' && !(await one(`SELECT 1 FROM candidate_submissions WHERE candidate_id=$1`, [c.id]))) throw conflict('Submit the candidate to a position to move them to Submitted', { needs: 'submission' });
    const upd = await updateRow<any>('candidates', ctx.orgId, c.id, { status: to, status_reason: reason ?? null });
    await activity(ctx, 'candidate', c.id, 'status_change', `Status changed from ${c.status.replace(/_/g, ' ')} to ${to.replace(/_/g, ' ')}`, reason ?? null, { from: c.status, to });
    if (['blacklisted', 'rejected'].includes(to)) await audit(ctx, `candidate.${to}`, { type: 'candidate', id: c.id, label: fullName(c) }, { status: c.status }, { status: to }, reason ?? undefined);
    await emit(ctx.orgId, 'candidate.status_changed', { candidate_id: c.id, candidate_name: fullName(c), from: c.status, to, recruiter_id: c.sourced_by });
    return upd;
  }
  app.post('/api/v1/candidates/:id/status', async (req) => {
    const ctx = staff(req);
    const c = await getOr404<any>('candidates', ctx, (req.params as any).id);
    await assertEditCandidate(ctx, c);
    const b = z.object({ status: z.string(), reason: z.string().max(2000).nullable().optional() }).parse(req.body);
    return candOut(ctx, await changeStatus(ctx, c, b.status, b.reason));
  });
  app.post('/api/v1/candidates/bulk', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'edit');
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), action: z.enum(['status', 'tag']), status: z.string().optional(), tag: z.string().max(40).optional(), reason: z.string().max(2000).optional() }).parse(req.body);
    const done: string[] = []; const skipped: { id: string; name: string; reason: string }[] = [];
    for (const id of b.ids) {
      const c = await one<any>(`SELECT * FROM candidates WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]);
      if (!c) continue;
      try {
        if (!(await canEditCandidate(ctx, c))) throw forbidden('Not in your scope');
        if (b.action === 'status') await changeStatus(ctx, c, b.status!, b.reason);
        else if (b.tag && !c.tags.includes(b.tag)) { await updateRow('candidates', ctx.orgId, id, { tags: [...c.tags, b.tag] }); await activity(ctx, 'candidate', id, 'system', `Tagged "${b.tag}"`); }
        done.push(id);
      } catch (e: any) { skipped.push({ id, name: fullName(c), reason: e.message }); }
    }
    return { updated: done.length, skipped };
  });

  /* ── Media uploads (multipart) ── */
  async function readUpload(req: any) {
    const f = await req.file();
    if (!f) throw badRequest('Choose a file to upload');
    const buf = await f.toBuffer();
    if (!buf.length) throw badRequest('The file is empty');
    return { buf, filename: f.filename as string, mime: f.mimetype as string, fields: f.fields };
  }
  app.post('/api/v1/candidates/:id/media/:kind', async (req) => {
    const ctx = staff(req);
    const { id, kind } = req.params as any;
    if (!['resume', 'video', 'portfolio'].includes(kind)) throw notFound();
    const c = await getOr404<any>('candidates', ctx, id);
    await assertEditCandidate(ctx, c);
    const up = await readUpload(req);
    return saveCandidateMedia(ctx, c, kind, up);
  });
  app.post('/api/v1/candidates/:id/portfolio-url', async (req) => {
    const ctx = staff(req);
    const c = await getOr404<any>('candidates', ctx, (req.params as any).id);
    await assertEditCandidate(ctx, c);
    const b = z.object({ url: z.string().url('Enter a full URL (https://…)').max(500) }).parse(req.body);
    await updateRow('candidates', ctx.orgId, c.id, { portfolio_url: b.url });
    await insertRow('candidate_media', { organization_id: ctx.orgId, candidate_id: c.id, kind: 'portfolio', url: b.url });
    await activity(ctx, 'candidate', c.id, 'system', 'Portfolio link added', b.url);
    return { ok: true };
  });

  /* ── Analyze Resume (the canonical AI action) ── */
  app.post('/api/v1/candidates/:id/analyze-resume', async (req) => {
    const ctx = staff(req);
    const c = await getOr404<any>('candidates', ctx, (req.params as any).id);
    await assertEditCandidate(ctx, c);
    await assertAiAvailable(ctx.orgId, 'Analyze Resume');
    if (!c.resume_text?.trim()) throw badRequest(c.resume_file ? 'No readable text in the uploaded resume — fill the fields manually.' : 'Upload a resume first');
    const ex = await analyzeResumeAI(ctx.orgId, c.resume_text);
    const row = await insertRow<any>('resume_extractions', { organization_id: ctx.orgId, candidate_id: c.id, model: ex.model, data: JSON.stringify(ex) });
    await logAi(ctx.orgId, 'analyze_resume', { candidate_id: c.id, model: ex.model });
    await activity(ctx, 'candidate', c.id, 'system', 'Analyze Resume ran — awaiting human review', `${Object.values(ex.fields).filter((f: any) => f.value && (!Array.isArray(f.value) || f.value.length)).length} fields extracted`, { extraction_id: row.id, model: ex.model });
    return row;
  });
  app.post('/api/v1/resume-extractions/:id/accept', async (req) => {
    const ctx = staff(req);
    const ex = await getOr404<any>('resume_extractions', ctx, (req.params as any).id);
    if (ex.status !== 'pending_review') throw conflict('This extraction was already reviewed');
    const c = await getOr404<any>('candidates', ctx, ex.candidate_id);
    await assertEditCandidate(ctx, c);
    const b = z.object({ fields: candBody.partial() }).parse(req.body);
    const accepted = Object.keys(b.fields);
    if (!accepted.length) throw badRequest('Select at least one field to accept');
    const upd = await updateRow<any>('candidates', ctx.orgId, c.id, { ...jsonCols(b.fields), email: b.fields.email !== undefined ? normalizeEmail(b.fields.email) : undefined });
    await q(`UPDATE resume_extractions SET status='accepted', accepted_by=$2, accepted_at=now(), data = data || jsonb_build_object('accepted_fields', $3::jsonb) WHERE id=$1`, [ex.id, ctx.userId, JSON.stringify(accepted)]);
    await activity(ctx, 'candidate', c.id, 'system', `Resume analysis reviewed by ${ctx.user.name}: accepted ${accepted.map(k => k.replace(/_/g, ' ')).join(', ')}`);
    return candOut(ctx, upd);
  });
  app.post('/api/v1/resume-extractions/:id/discard', async (req) => {
    const ctx = staff(req);
    const ex = await getOr404<any>('resume_extractions', ctx, (req.params as any).id);
    const c = await getOr404<any>('candidates', ctx, ex.candidate_id);
    await assertEditCandidate(ctx, c);
    await q(`UPDATE resume_extractions SET status='discarded', accepted_by=$2, accepted_at=now() WHERE id=$1`, [ex.id, ctx.userId]);
    await activity(ctx, 'candidate', c.id, 'system', 'Resume analysis discarded');
    return { ok: true };
  });

  /* ── AI utilities ── */
  app.post('/api/v1/ai/resume', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'create');
    await assertAiAvailable(ctx.orgId, 'Analyze Resume');
    const up = await readUpload(req);
    const t = extractTextFromFile(up.buf, up.filename, up.mime);
    await logAi(ctx.orgId, 'analyze_resume_upload', { filename: up.filename });
    return { extraction: await analyzeResumeAI(ctx.orgId, t.text, { fileNote: t.note, fileUncertain: t.uncertain }), text: t.text };
  });
  app.post('/api/v1/ai/parse-search', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'view');
    await assertAiAvailable(ctx.orgId, 'Natural-language search');
    const b = z.object({ q: z.string().trim().min(2).max(300) }).parse(req.body);
    const r = parseSearch(b.q);
    await logAi(ctx.orgId, 'parse_search', { q: b.q });
    return { ...r, model: AI_MODEL };
  });
  app.post('/api/v1/ai/draft', async (req) => {
    const ctx = staff(req);
    const b = z.object({ kind: z.enum(['candidate_summary', 'client_presentation', 'outreach_email', 'interview_questions', 'job_description']), candidate_id: z.string().uuid().optional(), position_id: z.string().uuid().optional(), include_rate: z.boolean().default(false) }).parse(req.body);
    await assertAiAvailable(ctx.orgId, 'Draft');
    let candidate: any = null, position: any = null, company: any = null;
    if (b.candidate_id) { need(ctx, 'candidates', 'view'); candidate = await getOr404('candidates', ctx, b.candidate_id); }
    if (b.position_id) { position = await viewablePosition(ctx, b.position_id); company = position.company_id ? await one(`SELECT name FROM companies WHERE id=$1`, [position.company_id]) : null; }
    if (['candidate_summary', 'client_presentation', 'outreach_email'].includes(b.kind) && !candidate) throw badRequest('Choose a candidate');
    if (b.kind === 'job_description' && !position) throw badRequest('Choose a position');
    const d = draft(b.kind as DraftKind, { candidate, position, company, org: ctx.org, sender: ctx.user, includeRate: b.include_rate });
    await logAi(ctx.orgId, `draft_${b.kind}`, { candidate_id: b.candidate_id, position_id: b.position_id });
    return { ...d, kind: b.kind, model: AI_MODEL, note: 'Draft only — nothing has been sent. Review and edit before using it.' };
  });

  /* ── Applications ── */
  app.get('/api/v1/applications', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'view');
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId];
    const where = ['a.organization_id = $1'];
    const add = (v: unknown, sql: (n: string) => string) => { params.push(v); where.push(sql(`$${params.length}`)); };
    if (f.status) add(f.status.split(','), n => `a.status = ANY(${n})`);
    if (f.position_id) add(f.position_id, n => `a.position_id = ${n}`);
    if (f.recruiter_id) add(f.recruiter_id === 'me' ? ctx.userId : f.recruiter_id, n => `a.recruiter_id = ${n}`);
    if (f.source) add(f.source, n => `a.source = ${n}`);
    if (f.from) add(f.from, n => `a.created_at >= ${n}::date`);
    if (f.to) add(f.to, n => `a.created_at < (${n}::date + 1)`);
    if (f.via_link === 'true') where.push('a.sourcing_link_id IS NOT NULL');
    if (f.stale) where.push(`a.status = 'new' AND a.created_at < now() - interval '48 hours'`);
    if (f.candidate_id) add(f.candidate_id, n => `a.candidate_id = ${n}`);
    if (f.mine_positions === 'true') { const s = positionViewScope(ctx); where.push(`a.position_id IN (SELECT p.id FROM positions p WHERE p.organization_id=$1 AND ${positionScopeSql(ctx, s === 'all' ? 'assigned' : s, 'p', params)})`); }
    return paged({
      select: `a.*, c.first_name, c.last_name, c.first_name || ' ' || coalesce(c.last_name,'') candidate_name, c.email, c.country, c.status candidate_status, c.avatar_color, c.headline, p.title position_title, co.name company_name, u.name recruiter_name, (c.resume_file IS NOT NULL OR coalesce(c.resume_text,'')<>'') has_resume, (c.video_file IS NOT NULL) has_video`,
      from: 'applications a JOIN candidates c ON c.id=a.candidate_id LEFT JOIN positions p ON p.id=a.position_id LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users u ON u.id=a.recruiter_id',
      where, params, lp, searchCols: ["(c.first_name || ' ' || coalesce(c.last_name,''))", 'c.email', 'p.title'],
      sortMap: { created_at: 'a.created_at', candidate_name: 'c.first_name', position_title: 'p.title', status: 'a.status', recruiter_name: 'u.name' }, defaultSort: 'a.created_at DESC',
    });
  });
  const APP_FLOW: Record<string, string[]> = { new: ['reviewed', 'advanced', 'rejected'], reviewed: ['advanced', 'rejected'], advanced: ['rejected'], rejected: ['reviewed'] };
  app.post('/api/v1/applications/:id/status', async (req) => {
    const ctx = staff(req);
    const a = await getOr404<any>('applications', ctx, (req.params as any).id);
    const c = await getOr404<any>('candidates', ctx, a.candidate_id);
    await assertEditCandidate(ctx, c);
    const b = z.object({ status: z.enum(['reviewed', 'advanced', 'rejected']), reason: z.string().max(1000).optional() }).parse(req.body);
    if (!APP_FLOW[a.status]?.includes(b.status)) throw conflict(`Cannot move application from ${a.status} to ${b.status}`, { allowed: APP_FLOW[a.status] ?? [] });
    if (b.status === 'rejected' && !b.reason?.trim()) throw badRequest('A reason is required to reject an application');
    const upd = await updateRow<any>('applications', ctx.orgId, a.id, { status: b.status, reviewed_at: a.reviewed_at ?? new Date() });
    const pos = a.position_id ? await one<any>(`SELECT title FROM positions WHERE id=$1`, [a.position_id]) : null;
    await activity(ctx, 'candidate', c.id, 'status_change', `Application${pos ? ` for ${pos.title}` : ''} marked ${b.status}`, b.reason ?? null, { application_id: a.id });
    if (b.status === 'advanced' && c.status === 'new_applicant') await changeStatus(ctx, c, 'screening', null);
    return upd;
  });
  app.post('/api/v1/applications', async (req) => {
    const ctx = staff(req);
    const b = z.object({ candidate_id: z.string().uuid(), position_id: z.string().uuid() }).parse(req.body);
    const c = await getOr404<any>('candidates', ctx, b.candidate_id);
    need(ctx, 'candidates', 'create');
    const p = await viewablePosition(ctx, b.position_id);
    if (await one(`SELECT 1 FROM applications WHERE candidate_id=$1 AND position_id=$2`, [c.id, p.id])) throw conflict('This candidate already has an application for this position');
    const a = await insertRow('applications', { organization_id: ctx.orgId, candidate_id: c.id, position_id: p.id, source: 'Added by recruiter', recruiter_id: c.sourced_by ?? ctx.userId, status: 'reviewed', reviewed_at: new Date() });
    await activity(ctx, 'candidate', c.id, 'system', `Added to ${p.title} by ${ctx.user.name}`);
    await emit(ctx.orgId, 'application.created', { application_id: (a as any).id, candidate_id: c.id, candidate_name: fullName(c), position_id: p.id, position_title: p.title, recruiter_id: c.sourced_by });
    return a;
  });
}

export async function saveCandidateMedia(ctx: { orgId: string; userId: string | null }, c: any, kind: string, up: { buf: Buffer; filename: string; mime: string }) {
  const lower = up.filename.toLowerCase();
  if (kind === 'video' && !/^video\//.test(up.mime) && !/\.(webm|mp4|mov)$/.test(lower)) throw badRequest('Upload a video file (webm, mp4 or mov)');
  if (kind === 'resume' && !/\.(pdf|txt|doc|docx|md)$/.test(lower)) throw badRequest('Upload a resume as PDF, DOCX, DOC or TXT');
  if (up.buf.length > 50 * 1024 * 1024) throw badRequest('File is larger than 50 MB');
  const name = kind === 'video' && !/\.\w+$/.test(lower) ? up.filename + '.webm' : up.filename;
  const rel = saveFile(`candidates/${c.id}`, name, up.buf);
  const patch: Record<string, unknown> = {};
  let note: string | null = null;
  if (kind === 'resume') {
    const t = extractTextFromFile(up.buf, up.filename, up.mime);
    patch.resume_file = rel; patch.resume_file_name = up.filename;
    if (t.text.trim()) patch.resume_text = t.text;
    note = t.note;
  } else if (kind === 'video') patch.video_file = rel; else patch.portfolio_file = rel;
  await updateRow('candidates', ctx.orgId, c.id, patch);
  await insertRow('candidate_media', { organization_id: ctx.orgId, candidate_id: c.id, kind, file: rel, mime: up.mime, file_name: up.filename });
  await activity(ctx, 'candidate', c.id, 'system', `${kind === 'resume' ? 'Resume' : kind === 'video' ? 'Intro video' : 'Portfolio file'} uploaded`, up.filename);
  return { ok: true, file: rel, url: fileUrl(rel), note, text_extracted: kind === 'resume' ? !!patch.resume_text : undefined };
}
const COLORS = ['#345CFF', '#7044FF', '#0EA5E9', '#14B8A6', '#F59E0B', '#EC4899', '#10B981', '#6366F1'];
function pick() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }
void notify;
