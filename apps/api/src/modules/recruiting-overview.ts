// RECRUITING — Overview funnel/KPIs, My Sourced metrics (per recruiter; admins see all), sourcing links with click tracking.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { q, one, insertRow, updateRow } from '../core/db';
import { staff, need, can, getOr404 } from '../core/context';
import { forbidden } from '../core/errors';
import { activity, audit } from '../core/audit';
import { WEB_URL } from '../core/settings';
import { positionViewScope, positionScopeSql, viewablePosition } from './_recruiting/common';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function range(qs: any) {
  const to = ISO.test(qs.to ?? '') ? qs.to : new Date().toISOString().slice(0, 10);
  const from = ISO.test(qs.from ?? '') ? qs.from : new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);
  const prevTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);
  const prevFrom = new Date(Date.parse(from) - days * 86400000).toISOString().slice(0, 10);
  return { from, to, prevFrom, prevTo };
}
const pctDelta = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);
export const isRecruitingAdmin = (ctx: any) => can(ctx, 'candidates', 'approve') || ['owner', 'admin', 'management'].includes(ctx.role.key);

export default async function (app: FastifyInstance) {
  app.get('/api/v1/recruiting/overview', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'view');
    const r = range(req.query);
    const months = Math.min(12, Math.max(3, Number((req.query as any).months) || 6));
    const scope = positionViewScope(ctx);
    const pp: unknown[] = [ctx.orgId];
    const pScope = positionScopeSql(ctx, scope, 'p', pp);
    const [cnt, prev, funnelRows, statusRows, sources, trend, positions, banner] = await Promise.all([
      one<any>(`SELECT
        (SELECT count(*)::int FROM candidates WHERE organization_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1) new_candidates,
        (SELECT count(*)::int FROM applications WHERE organization_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1) applications,
        (SELECT count(*)::int FROM interviews WHERE organization_id=$1 AND status IN ('scheduled','requested') AND scheduled_at >= now()) upcoming_interviews,
        (SELECT count(*)::int FROM interviews WHERE organization_id=$1 AND scheduled_at >= $2::date AND scheduled_at < $3::date + 1) interviews_in_range,
        (SELECT count(*)::int FROM offers WHERE organization_id=$1 AND status IN ('draft','approved','sent','viewed')) open_offers,
        (SELECT count(*)::int FROM offers WHERE organization_id=$1 AND status='accepted' AND responded_at >= $2::date AND responded_at < $3::date + 1) accepted_offers,
        (SELECT count(*)::int FROM candidate_submissions WHERE organization_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1) submissions,
        (SELECT count(*)::int FROM candidates WHERE organization_id=$1 AND status IN ('screening','assessment','recruiter_review','interview','qualified','submitted')) in_pipeline`, [ctx.orgId, r.from, r.to]),
      one<any>(`SELECT (SELECT count(*)::int FROM candidates WHERE organization_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1) new_candidates,
        (SELECT count(*)::int FROM applications WHERE organization_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1) applications,
        (SELECT count(*)::int FROM candidate_submissions WHERE organization_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1) submissions`, [ctx.orgId, r.prevFrom, r.prevTo]),
      one<any>(`SELECT count(*)::int applied,
        count(*) FILTER (WHERE c.status NOT IN ('new_applicant'))::int screened,
        count(*) FILTER (WHERE c.status IN ('qualified','talent_pool','submitted','hired') OR EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id))::int qualified,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id))::int submitted,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id AND s.status IN ('client_interview','offer','hired')))::int client_interview,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM offers o WHERE o.candidate_id=c.id))::int offer,
        count(*) FILTER (WHERE c.status='hired')::int hired
        FROM candidates c WHERE c.organization_id=$1 AND c.archived_at IS NULL AND c.created_at >= $2::date AND c.created_at < $3::date + 1`, [ctx.orgId, r.from, r.to]),
      q<any>(`SELECT status, count(*)::int n FROM candidates WHERE organization_id=$1 AND archived_at IS NULL GROUP BY status`, [ctx.orgId]),
      q<any>(`SELECT coalesce(source,'Unknown') label, count(*)::int value FROM candidates WHERE organization_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [ctx.orgId, r.from, r.to]),
      q<any>(`SELECT to_char(m, 'Mon') label, to_char(m,'YYYY-MM') ym, (SELECT count(*)::int FROM applications a WHERE a.organization_id=$1 AND date_trunc('month', a.created_at)=m) value,
        (SELECT count(*)::int FROM candidate_submissions s WHERE s.organization_id=$1 AND date_trunc('month', s.created_at)=m) submissions
        FROM generate_series(date_trunc('month', now()) - make_interval(months => $2::int - 1), date_trunc('month', now()), interval '1 month') m ORDER BY m`, [ctx.orgId, months]),
      q<any>(`SELECT p.id, p.title, p.status, p.urgency, p.health, p.openings, co.name company_name,
        (SELECT count(*)::int FROM candidate_submissions s WHERE s.position_id=p.id AND s.status NOT IN ('rejected','withdrawn','hired')) active_pipeline,
        (SELECT count(*)::int FROM applications a WHERE a.position_id=p.id AND a.status='new') new_applications
        FROM positions p LEFT JOIN companies co ON co.id=p.company_id WHERE p.organization_id=$1 AND p.status='open' AND p.archived_at IS NULL AND ${pScope}
        ORDER BY array_position(ARRAY['critical','high','normal','low'], p.urgency), (SELECT count(*) FROM candidate_submissions s WHERE s.position_id=p.id AND s.status NOT IN ('rejected','withdrawn','hired')) LIMIT 8`, pp),
      one<any>(`SELECT (SELECT count(*)::int FROM applications WHERE organization_id=$1 AND status='new' AND created_at < now() - interval '48 hours') stale_apps,
        (SELECT count(*)::int FROM interviews WHERE organization_id=$1 AND status='scheduled' AND scheduled_at::date = now()::date) today_interviews,
        (SELECT count(*)::int FROM interviews WHERE organization_id=$1 AND status='requested') requested_interviews,
        (SELECT count(*)::int FROM offers WHERE organization_id=$1 AND status='draft') drafts,
        (SELECT count(*)::int FROM offers WHERE organization_id=$1 AND status='accepted' AND placement_id IS NULL) accepted_unplaced`, [ctx.orgId]),
    ]);
    const openPositions = await one<any>(`SELECT count(*)::int n FROM positions p WHERE p.organization_id=$1 AND p.status='open' AND p.archived_at IS NULL AND ${pScope}`, pp);
    const st = Object.fromEntries(statusRows.map((s: any) => [s.status, s.n]));
    return {
      range: r,
      kpis: { open_positions: openPositions.n, in_pipeline: cnt.in_pipeline, applications: cnt.applications, applications_delta: pctDelta(cnt.applications, prev.applications), new_candidates: cnt.new_candidates, new_candidates_delta: pctDelta(cnt.new_candidates, prev.new_candidates), submissions: cnt.submissions, submissions_delta: pctDelta(cnt.submissions, prev.submissions), upcoming_interviews: cnt.upcoming_interviews, open_offers: cnt.open_offers, accepted_offers: cnt.accepted_offers },
      funnel: [
        { key: 'applied', label: 'Applied', value: funnelRows.applied }, { key: 'screened', label: 'Screened', value: funnelRows.screened }, { key: 'qualified', label: 'Qualified', value: funnelRows.qualified },
        { key: 'submitted', label: 'Submitted', value: funnelRows.submitted }, { key: 'client_interview', label: 'Client interview', value: funnelRows.client_interview }, { key: 'offer', label: 'Offer', value: funnelRows.offer }, { key: 'hired', label: 'Hired', value: funnelRows.hired },
      ],
      statuses: st, sources, trend, positions, banner,
    };
  });

  /* ── My Sourced ── */
  app.get('/api/v1/recruiting/my-sourced', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'view');
    const r = range(req.query);
    const admin = isRecruitingAdmin(ctx);
    const qs = req.query as any;
    const target = qs.recruiter_id && qs.recruiter_id !== 'me' ? qs.recruiter_id : ctx.userId;
    if (target !== ctx.userId && !admin) throw forbidden('Only admins can see other recruiters’ metrics');
    const metricSql = `count(*)::int sourced,
      count(*) FILTER (WHERE c.status='new_applicant' OR EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=c.id AND a.status='new'))::int needs_review,
      count(*) FILTER (WHERE c.status IN ('qualified','talent_pool','submitted','hired') OR EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id))::int qualified,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id))::int submitted,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id AND s.status IN ('client_interview','offer','hired')))::int client_interview,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM offers o WHERE o.candidate_id=c.id))::int offer,
      count(*) FILTER (WHERE c.status='hired')::int hired`;
    const conv = (m: any) => ({ ...m, conversion_pct: m.sourced ? Math.round((m.hired / m.sourced) * 1000) / 10 : null, submit_pct: m.sourced ? Math.round((m.submitted / m.sourced) * 1000) / 10 : null });
    const mine = conv(await one<any>(`SELECT ${metricSql} FROM candidates c WHERE c.organization_id=$1 AND c.sourced_by=$2 AND c.archived_at IS NULL AND c.created_at >= $3::date AND c.created_at < $4::date + 1`, [ctx.orgId, target, r.from, r.to]));
    const who = await one<any>(`SELECT id, name, avatar_color FROM users WHERE id=$1`, [target]);
    const bySource = await q<any>(`SELECT coalesce(c.source,'Unknown') label, count(*)::int value FROM candidates c WHERE c.organization_id=$1 AND c.sourced_by=$2 AND c.created_at >= $3::date AND c.created_at < $4::date + 1 GROUP BY 1 ORDER BY 2 DESC`, [ctx.orgId, target, r.from, r.to]);
    const links = await q<any>(`SELECT l.id, l.label, l.token, l.position_id, p.title position_title, l.active, (SELECT count(*)::int FROM sourcing_clicks k WHERE k.link_id=l.id AND k.created_at >= $3::date AND k.created_at < $4::date + 1) clicks,
      (SELECT count(*)::int FROM applications a WHERE a.sourcing_link_id=l.id AND a.created_at >= $3::date AND a.created_at < $4::date + 1) applications
      FROM sourcing_links l LEFT JOIN positions p ON p.id=l.position_id WHERE l.organization_id=$1 AND l.user_id=$2 ORDER BY l.position_id NULLS FIRST, l.created_at`, [ctx.orgId, target, r.from, r.to]);
    const recruiters = admin ? (await q<any>(`SELECT u.id, u.name, u.avatar_color, r.name role_name, ${metricSql.replace(/count\(\*\)/g, 'count(c.id)')}
      FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id
      LEFT JOIN candidates c ON c.sourced_by=u.id AND c.organization_id=m.organization_id AND c.archived_at IS NULL AND c.created_at >= $2::date AND c.created_at < $3::date + 1
      WHERE m.organization_id=$1 AND m.status='active' AND r.kind='agency' AND (r.key='recruiter' OR EXISTS (SELECT 1 FROM candidates x WHERE x.sourced_by=u.id AND x.organization_id=$1))
      GROUP BY u.id, u.name, u.avatar_color, r.name ORDER BY count(c.id) DESC`, [ctx.orgId, r.from, r.to])).map(conv) : null;
    return { range: r, recruiter: who, metrics: mine, by_source: bySource, links: links.map(l => ({ ...l, url: `${WEB_URL}/apply/${ctx.org.slug}/${l.position_id ? 'p' : 'r'}/${l.token}` })), recruiters, is_admin: admin };
  });

  /* ── Sourcing links ── */
  const statSql = `l.*, u.name user_name, p.title position_title, (SELECT count(*)::int FROM sourcing_clicks k WHERE k.link_id=l.id) clicks, (SELECT count(*)::int FROM applications a WHERE a.sourcing_link_id=l.id) applications,
    (SELECT max(k.created_at) FROM sourcing_clicks k WHERE k.link_id=l.id) last_click_at`;
  const out = (ctx: any, l: any) => { const url = `${WEB_URL}/apply/${ctx.org.slug}/${l.position_id ? 'p' : 'r'}/${l.token}`; return { ...l, url, qr_url: `/api/v1/qr?text=${encodeURIComponent(url)}` }; };
  app.get('/api/v1/sourcing/links', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'view');
    const all = (req.query as any).all === 'true' && isRecruitingAdmin(ctx);
    const rows = await q<any>(`SELECT ${statSql} FROM sourcing_links l JOIN users u ON u.id=l.user_id LEFT JOIN positions p ON p.id=l.position_id WHERE l.organization_id=$1 ${all ? '' : 'AND l.user_id=$2'} ORDER BY l.position_id NULLS FIRST, l.created_at DESC`, all ? [ctx.orgId] : [ctx.orgId, ctx.userId]);
    return { rows: rows.map(l => out(ctx, l)), total: rows.length, page: 1, pageSize: rows.length };
  });
  app.post('/api/v1/sourcing/links', async (req) => {
    const ctx = staff(req);
    need(ctx, 'candidates', 'create');
    const b = z.object({ position_id: z.string().uuid().nullable().optional(), label: z.string().trim().max(120).optional() }).parse(req.body);
    let title: string | null = null;
    if (b.position_id) title = (await viewablePosition(ctx, b.position_id)).title;
    const l = await insertRow<any>('sourcing_links', { organization_id: ctx.orgId, user_id: ctx.userId, position_id: b.position_id ?? null, token: crypto.randomBytes(8).toString('base64url'), label: b.label || title || 'Personal link' });
    if (b.position_id) await activity(ctx, 'position', b.position_id, 'system', `${ctx.user.name} created a sourcing link`);
    const full = await one<any>(`SELECT ${statSql} FROM sourcing_links l JOIN users u ON u.id=l.user_id LEFT JOIN positions p ON p.id=l.position_id WHERE l.id=$1`, [l.id]);
    return out(ctx, full);
  });
  app.post('/api/v1/sourcing/links/:id/active', async (req) => {
    const ctx = staff(req);
    const l = await getOr404<any>('sourcing_links', ctx, (req.params as any).id);
    if (l.user_id !== ctx.userId && !isRecruitingAdmin(ctx)) throw forbidden('You can only change your own links');
    const b = z.object({ active: z.boolean() }).parse(req.body);
    await updateRow('sourcing_links', ctx.orgId, l.id, { active: b.active });
    await audit(ctx, b.active ? 'sourcing_link.activated' : 'sourcing_link.deactivated', { type: 'sourcing_link', id: l.id, label: l.label ?? l.token });
    return { ok: true };
  });
  app.get('/api/v1/sourcing/links/:id/clicks', async (req) => {
    const ctx = staff(req);
    const l = await getOr404<any>('sourcing_links', ctx, (req.params as any).id);
    if (l.user_id !== ctx.userId && !isRecruitingAdmin(ctx)) throw forbidden();
    return q(`SELECT to_char(d, 'Mon DD') label, d::date day, (SELECT count(*)::int FROM sourcing_clicks k WHERE k.link_id=$1 AND k.created_at::date=d::date) value,
      (SELECT count(*)::int FROM applications a WHERE a.sourcing_link_id=$1 AND a.created_at::date=d::date) applications
      FROM generate_series(current_date - 29, current_date, interval '1 day') d ORDER BY d`, [l.id]);
  });
}
