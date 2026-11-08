// RECRUITING — Public, tenant-branded application (no login). Attribution is resolved server-side from the
// sourcing link token. Duplicate applicants (email/phone) get a new Application on the existing Candidate and keep
// their original recruiter attribution. Rate-limited.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { q, one, insertRow, updateRow, tx } from '../core/db';
import { badRequest, conflict, notFound } from '../core/errors';
import { activity } from '../core/audit';
import { notify, subscribers } from '../core/notify';
import { emit } from '../core/events';
import { rateLimit } from '../core/ratelimit';
import { saveFile, signedUrl, readFile } from '../core/storage';
import { sendTemplate } from '../adapters/messaging';
import { WEB_URL, getSetting } from '../core/settings';
import { createSession } from '../core/routes-auth';
import { normalizeEmail } from '@veyro/shared';
import { assertAiAvailable, logAi, analyzeResumeAI, extractTextFromFile } from '../adapters/ai';
import { findDuplicates } from './recruiting-candidates';
import { applicantToken, verifyApplicantToken, positionRecruiters, fullName } from './_recruiting/common';

const SECRET = process.env.FILE_SIGNING_SECRET ?? 'veyro-local-dev-signing-secret';
const signUpload = (orgId: string, rel: string) => Buffer.from(`${rel}|${crypto.createHmac('sha256', SECRET).update(`upload:${orgId}:${rel}`).digest('base64url').slice(0, 32)}`).toString('base64url');
function verifyUpload(orgId: string, token: string | null | undefined, prefix: string): string | null {
  if (!token) return null;
  const [rel, sig] = Buffer.from(token, 'base64url').toString().split('|');
  if (!rel || !sig || !rel.startsWith(prefix)) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(`upload:${orgId}:${rel}`).digest('base64url').slice(0, 32);
  return exp === sig ? rel : null;
}
const visitor = (req: FastifyRequest) => crypto.createHash('sha256').update(`${req.ip}|${req.headers['user-agent'] ?? ''}`).digest('hex').slice(0, 16);

async function orgBySlug(slug: string) {
  const o = await one<any>(`SELECT o.id, o.name, o.slug, o.status, b.logo_text, b.logo_file, b.primary_color, b.accent_color, b.support_email, b.hide_powered_by FROM organizations o LEFT JOIN organization_branding b ON b.organization_id=o.id WHERE o.slug=$1`, [slug]);
  if (!o || ['deleted', 'suspended'].includes(o.status)) throw notFound('This application page does not exist');
  return o;
}
async function resolveLink(orgId: string, kind: string | undefined, token: string | undefined) {
  if (!kind || !token) return null;
  if (!['r', 'p'].includes(kind)) return null;
  const l = await one<any>(`SELECT l.*, u.name user_name FROM sourcing_links l JOIN users u ON u.id=l.user_id WHERE l.organization_id=$1 AND l.token=$2 AND l.active`, [orgId, token]);
  if (!l) return null;
  if (kind === 'p' && !l.position_id) return null;
  return l;
}
const publicPosition = (p: any) => p && ({ id: p.id, title: p.title, employment_type: p.employment_type, schedule: p.schedule, timezone: p.timezone, weekly_hours: p.weekly_hours, skills: p.skills, software: p.software, languages: p.languages, description: p.description, company_name: null });

const submitBody = z.object({
  link_kind: z.enum(['r', 'p']).nullable().optional(), link_token: z.string().max(80).nullable().optional(),
  position_id: z.string().uuid().nullable().optional(),
  first_name: z.string().trim().min(1, 'First name is required').max(80), last_name: z.string().trim().min(1, 'Last name is required').max(80),
  email: z.string().trim().email('Enter a valid email').max(200), phone: z.string().trim().min(6, 'Enter your phone number').max(40),
  country: z.string().trim().min(2, 'Country is required').max(80), city: z.string().trim().max(80).nullable().optional(), timezone: z.string().max(80).nullable().optional(),
  headline: z.string().trim().max(200).nullable().optional(), years_experience: z.number().int().min(0).max(60).nullable().optional(),
  skills: z.array(z.string().max(80)).max(40).default([]), software: z.array(z.string().max(80)).max(40).default([]), languages: z.array(z.string().max(60)).max(15).default([]),
  education: z.array(z.object({ degree: z.string().max(200), school: z.string().max(200).nullable().optional(), year: z.number().int().nullable().optional() })).max(10).default([]),
  experience: z.array(z.object({ title: z.string().max(200), company: z.string().max(200).nullable().optional(), start: z.string().max(20).nullable().optional(), end: z.string().max(20).nullable().optional() })).max(15).default([]),
  availability_status: z.enum(['available', 'employed', 'not_available']).default('available'), earliest_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal('').transform(() => null)),
  weekly_hours: z.number().int().min(1).max(80).nullable().optional(), preferred_hours: z.string().max(200).nullable().optional(),
  rate_min_cents: z.number().int().min(0).nullable().optional(), rate_target_cents: z.number().int().min(0).nullable().optional(),
  rate_currency: z.string().length(3).default('USD'), rate_unit: z.enum(['hour', 'day', 'week', 'month']).default('hour'), rate_note: z.string().max(500).nullable().optional(),
  resume_upload: z.string().max(600).nullable().optional(), video_upload: z.string().max(600).nullable().optional(), portfolio_upload: z.string().max(600).nullable().optional(),
  portfolio_url: z.string().url('Enter a full URL (https://…)').max(500).nullable().optional().or(z.literal('').transform(() => null)),
  resume_prefilled: z.boolean().default(false), consent: z.literal(true, { errorMap: () => ({ message: 'Please confirm the information is accurate' }) }),
  website: z.string().max(0).optional(), // honeypot
});

export default async function (app: FastifyInstance) {
  app.get('/api/v1/public/apply/:slug', { config: { public: true } }, async (req) => {
    const { slug } = req.params as any;
    const o = await orgBySlug(slug);
    const portals = await getSetting<any>(o.id, 'portals');
    const positions = await q<any>(`SELECT id, title, employment_type, schedule, timezone, weekly_hours, skills, software, languages FROM positions WHERE organization_id=$1 AND status='open' AND archived_at IS NULL ORDER BY created_at DESC LIMIT 50`, [o.id]);
    return { org: { name: o.name, slug: o.slug, logo_text: o.logo_text ?? o.name, logo_url: signedUrl(o.logo_file, 86400), primary_color: o.primary_color ?? '#345CFF', accent_color: o.accent_color ?? '#7044FF', support_email: o.support_email, hide_powered_by: !!o.hide_powered_by }, positions, accounts_enabled: portals.candidate_enabled !== false };
  });

  // Resolves a recruiter (/r/) or position (/p/) link and records the click.
  app.get('/api/v1/public/apply/:slug/link/:kind/:token', { config: { public: true } }, async (req) => {
    const { slug, kind, token } = req.params as any;
    const o = await orgBySlug(slug);
    const l = await resolveLink(o.id, kind, token);
    if (!l) throw notFound('This link is no longer active — you can still apply on the main page.');
    const v = visitor(req);
    await rateLimit(`click:${l.id}:${v}`, 30, 3600).catch(() => null);
    const recent = await one(`SELECT 1 FROM sourcing_clicks WHERE link_id=$1 AND visitor_hash=$2 AND created_at > now() - interval '30 minutes'`, [l.id, v]);
    if (!recent) await insertRow('sourcing_clicks', { organization_id: o.id, link_id: l.id, visitor_hash: v, referrer: String(req.headers.referer ?? '').slice(0, 300) || null });
    const p = l.position_id ? await one<any>(`SELECT * FROM positions WHERE id=$1 AND status IN ('open','on_hold')`, [l.position_id]) : null;
    return { kind, recruiter_first_name: String(l.user_name).split(' ')[0], position: publicPosition(p), position_closed: !!l.position_id && !p };
  });

  // Optional resume upload: stores the file and (if AI is available) returns extracted fields + snippets to pre-fill.
  app.post('/api/v1/public/apply/:slug/upload/:kind', { config: { public: true } }, async (req) => {
    const { slug, kind } = req.params as any;
    if (!['resume', 'video', 'portfolio'].includes(kind)) throw notFound();
    const o = await orgBySlug(slug);
    await rateLimit(`apply-upload:${o.id}:${req.ip}`, 40, 3600);
    const f = await (req as any).file();
    if (!f) throw badRequest('Choose a file to upload');
    const buf: Buffer = await f.toBuffer();
    const name = String(f.filename || `${kind}.bin`);
    const lower = name.toLowerCase();
    if (!buf.length) throw badRequest('The file is empty');
    if (kind === 'resume' && !/\.(pdf|txt|doc|docx|md)$/.test(lower)) throw badRequest('Upload your resume as PDF, DOCX, DOC or TXT');
    if (kind === 'video' && !/^video\//.test(f.mimetype) && !/\.(webm|mp4|mov)$/.test(lower)) throw badRequest('Upload a video (webm, mp4 or mov)');
    if (buf.length > (kind === 'video' ? 60 : 15) * 1024 * 1024) throw badRequest(`File is too large (max ${kind === 'video' ? 60 : 15} MB)`);
    const rel = saveFile(`applications/${o.id}/${kind}`, kind === 'video' && !/\.\w+$/.test(lower) ? name + '.webm' : name, buf);
    const res: any = { upload: signUpload(o.id, rel), filename: name, size: buf.length };
    if (kind === 'resume') {
      const t = extractTextFromFile(buf, name, f.mimetype);
      try {
        await assertAiAvailable(o.id, 'Analyze Resume (public application)');
        res.extraction = await analyzeResumeAI(o.id, t.text, { fileNote: t.note, fileUncertain: t.uncertain });
        await logAi(o.id, 'analyze_resume_public', { filename: name, model: res.extraction.model });
      } catch (e: any) { res.ai_error = e?.message ?? 'AI is unavailable right now — please fill the fields manually.'; }
    }
    return res;
  });

  app.post('/api/v1/public/apply/:slug/submit', { config: { public: true } }, async (req) => {
    const { slug } = req.params as any;
    const o = await orgBySlug(slug);
    await rateLimit(`apply-submit:${o.id}:${req.ip}`, 12, 3600);
    const b = submitBody.parse(req.body);
    const link = await resolveLink(o.id, b.link_kind ?? undefined, b.link_token ?? undefined);
    let positionId: string | null = link?.position_id ?? null;
    if (!positionId && b.position_id && (await one(`SELECT 1 FROM positions WHERE id=$1 AND organization_id=$2 AND status='open'`, [b.position_id, o.id]))) positionId = b.position_id;
    const resumeRel = verifyUpload(o.id, b.resume_upload, `applications/${o.id}/resume/`);
    const videoRel = verifyUpload(o.id, b.video_upload, `applications/${o.id}/video/`);
    const portRel = verifyUpload(o.id, b.portfolio_upload, `applications/${o.id}/portfolio/`);
    const dups = await findDuplicates(o.id, b.email, b.phone);
    const existing = dups.find(d => normalizeEmail(d.email) === normalizeEmail(b.email)) ?? dups[0] ?? null;
    if (existing && positionId && (await one(`SELECT 1 FROM applications WHERE candidate_id=$1 AND position_id=$2 AND created_at > now() - interval '10 minutes'`, [existing.id, positionId]))) throw conflict('We already received this application a moment ago.');
    const source = link ? (link.position_id ? 'Position link' : 'Recruiter link') : 'Website';
    const result = await tx(async (c) => {
      let cand: any;
      const media: Record<string, unknown> = {};
      if (resumeRel) { media.resume_file = resumeRel; }
      if (videoRel) media.video_file = videoRel;
      if (portRel) media.portfolio_file = portRel;
      if (existing) {
        cand = (await c.query(`SELECT * FROM candidates WHERE id=$1`, [existing.id])).rows[0];
        // Keep attribution (sourced_by/source) and status; only fill blanks and refresh media + availability.
        const fill: Record<string, unknown> = { ...media };
        for (const k of ['last_name', 'phone', 'country', 'city', 'timezone', 'headline', 'years_experience', 'portfolio_url', 'rate_min_cents', 'rate_target_cents', 'rate_note'] as const) if ((cand[k] === null || cand[k] === '') && (b as any)[k] !== undefined && (b as any)[k] !== null) fill[k] = (b as any)[k];
        for (const k of ['skills', 'software', 'languages'] as const) { const merged = [...new Set([...(cand[k] ?? []), ...b[k]])]; if (merged.length !== (cand[k] ?? []).length) fill[k] = merged; }
        Object.assign(fill, { availability_status: b.availability_status, earliest_start: b.earliest_start ?? cand.earliest_start, weekly_hours: b.weekly_hours ?? cand.weekly_hours, preferred_hours: b.preferred_hours ?? cand.preferred_hours });
        if (['rejected', 'withdrawn', 'future'].includes(cand.status)) fill.status = 'new_applicant';
        cand = await updateRow<any>('candidates', o.id, cand.id, fill, c);
      } else {
        cand = await insertRow<any>('candidates', {
          organization_id: o.id, first_name: b.first_name, last_name: b.last_name, email: normalizeEmail(b.email), phone: b.phone, country: b.country, city: b.city ?? null, timezone: b.timezone ?? null,
          headline: b.headline ?? null, years_experience: b.years_experience ?? null, skills: b.skills, software: b.software, languages: b.languages,
          education: JSON.stringify(b.education), experience: JSON.stringify(b.experience), rate_min_cents: b.rate_min_cents ?? null, rate_target_cents: b.rate_target_cents ?? null,
          rate_currency: b.rate_currency, rate_unit: b.rate_unit, rate_note: b.rate_note ?? null, availability_status: b.availability_status, earliest_start: b.earliest_start ?? null,
          weekly_hours: b.weekly_hours ?? null, preferred_hours: b.preferred_hours ?? null, portfolio_url: b.portfolio_url ?? null, source, sourced_by: link?.user_id ?? null, status: 'new_applicant',
          avatar_color: ['#345CFF', '#7044FF', '#0EA5E9', '#14B8A6', '#F59E0B', '#EC4899'][Math.floor(Math.random() * 6)], ...media,
        }, c);
      }
      for (const [kind, rel] of [['resume', resumeRel], ['video', videoRel], ['portfolio', portRel]] as const) if (rel) await insertRow('candidate_media', { organization_id: o.id, candidate_id: cand.id, kind, file: rel, file_name: rel.split('/').pop()!.slice(37) }, c);
      if (b.portfolio_url && existing) await insertRow('candidate_media', { organization_id: o.id, candidate_id: cand.id, kind: 'portfolio', url: b.portfolio_url }, c);
      const appRow = await insertRow<any>('applications', { organization_id: o.id, candidate_id: cand.id, position_id: positionId, source, recruiter_id: cand.sourced_by ?? link?.user_id ?? null, sourcing_link_id: link?.id ?? null, status: 'new', answers: JSON.stringify({ rate_note: b.rate_note ?? null, preferred_hours: b.preferred_hours ?? null, resume_prefilled: b.resume_prefilled, duplicate_of_existing: !!existing, link_owner: link?.user_name ?? null }) }, c);
      return { cand, appRow };
    });
    const { cand, appRow } = result;
    // Resume text for later Analyze Resume.
    if (resumeRel) {
      try {
        const t = extractTextFromFile(readFile(resumeRel), resumeRel, undefined);
        if (t.text.trim()) await q(`UPDATE candidates SET resume_text=$2, resume_file_name=$3 WHERE id=$1`, [cand.id, t.text, resumeRel.split('/').pop()!.slice(37)]);
      } catch { /* best effort */ }
    }
    const pos = positionId ? await one<any>(`SELECT id, title FROM positions WHERE id=$1`, [positionId]) : null;
    const sys = { orgId: o.id, userId: null };
    await activity(sys, 'candidate', cand.id, 'system', existing ? `Applied again${pos ? ` — ${pos.title}` : ''} (existing candidate, attribution kept)` : `Application received${pos ? ` — ${pos.title}` : ''}`, `Source: ${source}${link ? ` (${link.user_name}'s link)` : ''}`, { application_id: appRow.id });
    if (pos) await activity(sys, 'position', pos.id, 'system', `New application: ${fullName(cand)}`, null, { application_id: appRow.id });
    const recipients = [cand.sourced_by, link?.user_id, ...(await positionRecruiters(positionId)), ...(await subscribers(o.id, 'application.new'))];
    await notify(o.id, recipients, { event: 'application.new', title: `New application: ${fullName(cand)}`, body: `${pos ? pos.title + ' · ' : ''}${source}${existing ? ' · returning candidate' : ''}`, link: `/recruiting/candidates/${cand.id}` });
    await sendTemplate(o.id, 'application_received', b.email, { candidate: { firstName: b.first_name }, org: { name: o.name }, position: { suffix: pos ? ` for ${pos.title}` : '' }, link: `${WEB_URL}/portal/candidate/applications` }, { related: { type: 'candidate', id: cand.id } });
    if (!existing) await emit(o.id, 'candidate.created', { candidate_id: cand.id, candidate_name: fullName(cand), source, recruiter_id: cand.sourced_by, sourced_by: cand.sourced_by });
    await emit(o.id, 'application.created', { application_id: appRow.id, candidate_id: cand.id, candidate_name: fullName(cand), position_id: positionId, position_title: pos?.title ?? null, recruiter_id: cand.sourced_by ?? link?.user_id ?? null, source, duplicate: !!existing });
    const hasAccount = !!(await one(`SELECT 1 FROM organization_memberships WHERE organization_id=$1 AND candidate_id=$2 AND status='active'`, [o.id, cand.id]));
    const userExists = !!(await one(`SELECT 1 FROM users WHERE lower(email)=lower($1)`, [b.email]));
    return { ok: true, application_id: appRow.id, applicant_token: applicantToken(appRow.id), first_name: cand.first_name, position_title: pos?.title ?? null, returning: !!existing, has_account: hasAccount, email_has_login: userExists };
  });

  // Optional account creation after submitting: direct (new email + password) or invitation (email already has a login).
  app.post('/api/v1/public/apply/:slug/account', { config: { public: true } }, async (req, reply) => {
    const { slug } = req.params as any;
    const o = await orgBySlug(slug);
    await rateLimit(`apply-account:${req.ip}`, 10, 3600);
    const b = z.object({ applicant_token: z.string().max(200), password: z.string().min(8, 'Use at least 8 characters').max(200).optional() }).parse(req.body);
    const appId = verifyApplicantToken(b.applicant_token);
    const a = appId ? await one<any>(`SELECT a.*, c.email, c.first_name, c.last_name FROM applications a JOIN candidates c ON c.id=a.candidate_id WHERE a.id=$1 AND a.organization_id=$2`, [appId, o.id]) : null;
    if (!a || Date.now() - new Date(a.created_at).getTime() > 2 * 86400000) throw badRequest('This link expired — check your email for the application confirmation.');
    if (await one(`SELECT 1 FROM organization_memberships WHERE organization_id=$1 AND candidate_id=$2 AND status='active'`, [o.id, a.candidate_id])) return { ok: true, mode: 'exists', message: 'You already have an account — sign in to track your application.' };
    const role = await one<any>(`SELECT id FROM roles WHERE organization_id=$1 AND key='candidate'`, [o.id]);
    const user = await one<any>(`SELECT id FROM users WHERE lower(email)=lower($1)`, [a.email]);
    if (user || !b.password) {
      const token = crypto.randomBytes(18).toString('base64url');
      await insertRow('invitations', { organization_id: o.id, email: a.email, name: fullName(a), role_id: role.id, token, candidate_id: a.candidate_id, expires_at: new Date(Date.now() + 7 * 86400000) });
      await sendTemplate(o.id, 'invite_staff', a.email, { invitee: { name: a.first_name }, inviter: { name: o.name }, org: { name: o.name }, role: { name: 'Candidate' }, link: `${WEB_URL}/invite/${token}` }, { related: { type: 'candidate', id: a.candidate_id } });
      await activity({ orgId: o.id, userId: null }, 'candidate', a.candidate_id, 'system', 'Candidate requested a portal account (invitation emailed)');
      return { ok: true, mode: 'invited', message: `We emailed ${a.email} a link to activate your account.` };
    }
    const uid = await tx(async (c) => {
      const u = (await c.query(`INSERT INTO users (email, name, password_hash, avatar_color) VALUES ($1,$2,$3,'#7044FF') RETURNING id`, [String(a.email).toLowerCase(), fullName(a), await bcrypt.hash(b.password!, 10)])).rows[0];
      await c.query(`INSERT INTO organization_memberships (organization_id, user_id, role_id, candidate_id) VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id, user_id) DO NOTHING`, [o.id, u.id, role.id, a.candidate_id]);
      await c.query(`UPDATE candidates SET user_id=$1 WHERE id=$2`, [u.id, a.candidate_id]);
      return u.id as string;
    });
    await createSession(reply, req, uid, o.id);
    await activity({ orgId: o.id, userId: uid }, 'candidate', a.candidate_id, 'system', 'Candidate created a portal account');
    return { ok: true, mode: 'created', redirect: '/portal/candidate/applications' };
  });
}
