// Shared recruiting helpers: recruiter scope, comp redaction, serializers, file urls, ICS.
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Ctx } from '../../core/context';
import { need, scopeOf, canViewComp } from '../../core/context';
import { one, q } from '../../core/db';
import { forbidden, notFound } from '../../core/errors';
import { signedUrl, resolveSafe } from '../../core/storage';
import { IS_PROD } from '../../core/env';
import type { Resource, Action } from '@veyro/shared';

/*
 * Compensation policy (documented choice):
 *  - Candidate rate EXPECTATIONS (rate_min_cents / rate_target_cents) are recruiting data and are visible to anyone
 *    who can view the candidate (recruiters need them to qualify). They are NEVER shown to clients unless the
 *    submission marks the rate as shareable.
 *  - Position target pay range (pay_min/max) is visible to roles that can view the position (recruiters use it to
 *    screen). The client BILL budget (bill_budget_cents) is commercial and only returned with view_comp.
 *  - Offer pay/bill rates and placement pay rates are only returned with view_comp. A recruiter can draft an offer
 *    (write-only rate inputs) but cannot read the rates back; an approver with view_comp sees/approves them.
 */
export function stripPositionComp(ctx: Ctx, p: any) { if (!p || canViewComp(ctx, 'positions')) return p; return { ...p, bill_budget_cents: undefined, comp_restricted: true }; }
export function stripOfferComp(ctx: Ctx, o: any) { if (!o || canViewComp(ctx, 'offers')) return o; return { ...o, pay_rate_cents: undefined, bill_rate_cents: undefined, comp_restricted: true }; }

type Sc = 'all' | 'team' | 'assigned';
const rank: Record<string, number> = { all: 3, team: 2, assigned: 1, own: 1, none: 0 };
function narrow(a: string, b: string): Sc { const r = Math.min(rank[a] ?? 0, rank[b] ?? 0); return r >= 3 ? 'all' : r === 2 ? 'team' : 'assigned'; }

/** Position visibility scope: the membership's recruiting scope (All/Team/Assigned) once the role may view positions. */
export function positionViewScope(ctx: Ctx): Sc { need(ctx, 'positions', 'view'); return ctx.recruitingScope; }
export function editScope(ctx: Ctx, resource: Resource, action: Action = 'edit'): Sc | 'none' {
  const s = scopeOf(ctx, resource, action);
  if (s === 'none') return 'none';
  return narrow(s, ctx.recruitingScope);
}
/** SQL predicate restricting positions alias `a` to the given scope; pushes params. */
export function positionScopeSql(ctx: Ctx, scope: Sc, alias: string, params: unknown[]): string {
  if (scope === 'all') return 'TRUE';
  params.push(ctx.userId);
  const me = `$${params.length}`;
  if (scope === 'assigned') return `EXISTS (SELECT 1 FROM position_recruiter_assignments pa WHERE pa.position_id=${alias}.id AND pa.user_id=${me} AND pa.unassigned_at IS NULL)`;
  params.push(ctx.team ?? '__no_team__');
  return `EXISTS (SELECT 1 FROM position_recruiter_assignments pa JOIN organization_memberships om ON om.user_id=pa.user_id AND om.organization_id=${alias}.organization_id WHERE pa.position_id=${alias}.id AND pa.unassigned_at IS NULL AND (pa.user_id=${me} OR om.team=$${params.length}))`;
}
export async function positionInScope(ctx: Ctx, positionId: string | null | undefined, scope: Sc): Promise<boolean> {
  if (scope === 'all') return true;
  if (!positionId) return false;
  const params: unknown[] = [positionId, ctx.orgId];
  const pred = positionScopeSql(ctx, scope, 'p', params);
  return !!(await one(`SELECT 1 FROM positions p WHERE p.id=$1 AND p.organization_id=$2 AND ${pred}`, params));
}
/** Loads a position the user may view (404 otherwise). */
export async function viewablePosition(ctx: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const scope = positionViewScope(ctx);
  const params: unknown[] = [id, ctx.orgId];
  const pred = positionScopeSql(ctx, scope, 'p', params);
  const p = await one<any>(`SELECT p.* FROM positions p WHERE p.id=$1 AND p.organization_id=$2 AND ${pred}`, params);
  if (!p) throw notFound();
  return p;
}
/** Requires edit rights on the position (403 if visible but not editable, 404 if not visible). */
export async function editablePosition(ctx: Ctx, id: string) {
  const p = await viewablePosition(ctx, id);
  const s = editScope(ctx, 'positions');
  if (s === 'none' || !(await positionInScope(ctx, id, s))) throw forbidden('You can only edit positions you are assigned to');
  return p;
}
export async function canEditPosition(ctx: Ctx, id: string): Promise<boolean> {
  const s = editScope(ctx, 'positions');
  return s !== 'none' && positionInScope(ctx, id, s);
}

/** Candidate edit rights: All scope, or candidate sourced/created by me, or tied to a position in my scope. */
export async function canEditCandidate(ctx: Ctx, cand: { id: string; sourced_by: string | null; created_by: string | null }, resource: Resource = 'candidates'): Promise<boolean> {
  const s = editScope(ctx, resource);
  if (s === 'none') return false;
  if (s === 'all') return true;
  if (cand.sourced_by === ctx.userId || cand.created_by === ctx.userId) return true;
  const params: unknown[] = [cand.id, ctx.orgId];
  const pred = positionScopeSql(ctx, s, 'p', params);
  return !!(await one(`SELECT 1 FROM positions p WHERE p.organization_id=$2 AND ${pred} AND (EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=$1 AND a.position_id=p.id) OR EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=$1 AND s.position_id=p.id))`, params));
}
export async function assertEditCandidate(ctx: Ctx, cand: any, resource: Resource = 'candidates') {
  need(ctx, resource, 'edit');
  if (!(await canEditCandidate(ctx, cand, resource))) throw forbidden('You can only edit candidates you sourced or who are in your assigned positions');
}
/** Edit check for records tied to a position + candidate (submissions, interviews, offers, assessments). */
export async function assertEditLinked(ctx: Ctx, resource: Resource, positionId: string | null, cand: any) {
  const s = editScope(ctx, resource);
  if (s === 'none') throw forbidden(`Your role (${ctx.role.name}) cannot edit ${resource}`);
  if (s === 'all') return;
  if (positionId && (await positionInScope(ctx, positionId, s))) return;
  if (cand && (cand.sourced_by === ctx.userId || cand.created_by === ctx.userId)) return;
  throw forbidden('This record belongs to a position you are not assigned to');
}

/* ── Files ── */
export function fileUrl(rel: string | null | undefined, ttl = 3600): string | null {
  if (!rel) return null;
  // Locally, skip seeded rows whose demo file was never written. In production the disk is a cache (see core/storage), so always sign.
  if (!IS_PROD) { try { if (!fs.existsSync(resolveSafe(rel))) return null; } catch { return null; } }
  return signedUrl(rel, ttl);
}
export function fullName(c: any) { return [c?.first_name, c?.last_name].filter(Boolean).join(' '); }

/** Candidate as returned to staff. */
export function candOut(_ctx: Ctx, c: any) {
  if (!c) return c;
  return { ...c, name: fullName(c), resume_url: fileUrl(c.resume_file), video_url: fileUrl(c.video_file), portfolio_file_url: fileUrl(c.portfolio_file) };
}

/** Client-safe profile for a submission: strips contact, private notes, and rate unless marked shareable. */
export function clientSafeProfile(c: any, sub: any) {
  const share = (sub?.shareable ?? {}) as { contact?: boolean; rate?: boolean; notes?: boolean };
  return {
    candidate_id: c.id,
    name: share.contact ? fullName(c) : `${c.first_name} ${c.last_name ? c.last_name[0] + '.' : ''}`.trim(),
    first_name: c.first_name, headline: c.headline, country: c.country, city: c.city, timezone: c.timezone, years_experience: c.years_experience,
    skills: c.skills, software: c.software, languages: c.languages,
    education: (c.education ?? []).map((e: any) => ({ degree: e.degree, school: e.school, year: e.year })),
    experience: (c.experience ?? []).map((e: any) => ({ title: e.title, company: e.company, start: e.start, end: e.end })),
    availability_status: c.availability_status, earliest_start: c.earliest_start, weekly_hours: c.weekly_hours, preferred_hours: c.preferred_hours,
    portfolio_url: c.portfolio_url, avatar_color: c.avatar_color,
    video_url: fileUrl(c.video_file),
    email: share.contact ? c.email : undefined, phone: share.contact ? c.phone : undefined,
    rate_target_cents: share.rate ? c.rate_target_cents : undefined, rate_currency: share.rate ? c.rate_currency : undefined, rate_unit: share.rate ? c.rate_unit : undefined,
    presentation: sub?.presentation ?? null,
    shareable: { contact: !!share.contact, rate: !!share.rate, notes: !!share.notes },
  };
}

/* ── Meeting links + ICS ── */
export function meetingUrl() { return `https://meet.veyro.local/${crypto.randomBytes(5).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 3)}-${crypto.randomBytes(4).toString('hex').slice(0, 4)}-${crypto.randomBytes(4).toString('hex').slice(0, 3)}`; }
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
export function buildIcs(i: { id: string; scheduled_at: Date | string; duration_min: number; title: string; description: string; url: string | null; organizer: string }) {
  const start = new Date(i.scheduled_at);
  const end = new Date(start.getTime() + i.duration_min * 60000);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VeyroApp//Interviews//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${i.id}@veyro.local`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEsc(i.title)}`, `DESCRIPTION:${icsEsc(i.description)}`, ...(i.url ? [`URL:${i.url}`, `LOCATION:${i.url}`] : []), `ORGANIZER;CN=${icsEsc(i.organizer)}:mailto:noreply@veyro.local`,
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:Interview reminder', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
export function fmtWhen(d: Date | string, tz: string) {
  try { return new Date(d).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return new Date(d).toISOString(); }
}

/** Active recruiters of a position. */
export async function positionRecruiters(positionId: string | null | undefined): Promise<string[]> {
  if (!positionId) return [];
  return (await q<any>(`SELECT user_id FROM position_recruiter_assignments WHERE position_id=$1 AND unassigned_at IS NULL`, [positionId])).map(r => r.user_id);
}
/** Signed token used to let a just-submitted applicant create an account (no login yet). */
const SECRET = process.env.FILE_SIGNING_SECRET ?? 'veyro-local-dev-signing-secret';
export function applicantToken(applicationId: string) { return applicationId + '.' + crypto.createHmac('sha256', SECRET).update('apply:' + applicationId).digest('base64url').slice(0, 24); }
export function verifyApplicantToken(t: string): string | null {
  const [id, sig] = String(t ?? '').split('.');
  if (!id || !sig) return null;
  const exp = crypto.createHmac('sha256', SECRET).update('apply:' + id).digest('base64url').slice(0, 24);
  return exp.length === sig.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(sig)) ? id : null;
}
export const CANDIDATE_STATUSES = ['new_applicant', 'screening', 'assessment', 'recruiter_review', 'interview', 'qualified', 'talent_pool', 'submitted', 'hired', 'on_hold', 'future', 'rejected', 'withdrawn', 'blacklisted'];
export const SUBMISSION_STATUSES = ['submitted', 'client_review', 'client_interview', 'offer', 'hired', 'rejected', 'withdrawn'];
