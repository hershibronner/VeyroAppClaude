// RECRUITING — Positions: CRUD, status machine, recruiters (lead + history), requirements, pipeline,
// sourcing links + QR, AI job description draft and AI matches (persisted runs, stale on position change).
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { q, one, insertRow, updateRow, tx } from '../core/db';
import { staff, need, can, assertTransition } from '../core/context';
import { badRequest, forbidden, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { WEB_URL } from '../core/settings';
import { assertAiAvailable, logAi, draft, rankMatchesAI, AI_MODEL } from '../adapters/ai';
import { positionViewScope, positionScopeSql, viewablePosition, editablePosition, canEditPosition, editScope, stripPositionComp, fullName, candOut } from './_recruiting/common';

const posBody = z.object({
  title: z.string().trim().min(2, 'Title is required').max(160),
  company_id: z.string().uuid().nullable().optional(),
  openings: z.number().int().min(1).max(500).optional(),
  urgency: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  health: z.enum(['on_track', 'at_risk', 'critical']).optional(),
  employment_type: z.enum(['full_time', 'part_time', 'contract', 'project']).optional(),
  schedule: z.string().max(200).nullable().optional(),
  timezone: z.string().max(80).nullable().optional(),
  weekly_hours: z.number().int().min(1).max(80).nullable().optional(),
  skills: z.array(z.string().max(80)).max(40).optional(),
  software: z.array(z.string().max(80)).max(40).optional(),
  languages: z.array(z.string().max(60)).max(20).optional(),
  equipment: z.string().max(500).nullable().optional(),
  bill_budget_cents: z.number().int().min(0).nullable().optional(),
  pay_min_cents: z.number().int().min(0).nullable().optional(),
  pay_max_cents: z.number().int().min(0).nullable().optional(),
  currency: z.string().length(3).optional(),
  rate_unit: z.enum(['hour', 'day', 'week', 'month']).optional(),
  description: z.string().max(20000).nullable().optional(),
});
const MATCH_FIELDS = ['skills', 'software', 'languages', 'timezone', 'weekly_hours', 'pay_min_cents', 'pay_max_cents', 'bill_budget_cents', 'currency', 'title'];

export default async function (app: FastifyInstance) {
  const posSelect = `p.*, co.name company_name,
    (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'is_lead', pa.is_lead, 'avatar_color', u.avatar_color) ORDER BY pa.is_lead DESC, u.name) FROM position_recruiter_assignments pa JOIN users u ON u.id=pa.user_id WHERE pa.position_id=p.id AND pa.unassigned_at IS NULL) recruiters,
    (SELECT count(*)::int FROM candidate_submissions s WHERE s.position_id=p.id AND s.status NOT IN ('rejected','withdrawn','hired')) active_pipeline,
    (SELECT count(*)::int FROM candidate_submissions s WHERE s.position_id=p.id) submissions_count,
    (SELECT count(*)::int FROM applications a WHERE a.position_id=p.id) applications_count,
    (SELECT count(*)::int FROM placements pl WHERE pl.position_id=p.id AND pl.status <> 'ended') placed_count`;

  app.get('/api/v1/positions', async (req) => {
    const ctx = staff(req);
    const scope = positionViewScope(ctx);
    const lp = listParams(req);
    const params: unknown[] = [ctx.orgId];
    const where = ['p.organization_id = $1', 'p.archived_at IS NULL'];
    where.push(positionScopeSql(ctx, scope, 'p', params));
    const f = lp.filters;
    if (f.status) { if (f.status === 'active') where.push(`p.status IN ('open','on_hold','draft')`); else { params.push(f.status.split(',')); where.push(`p.status = ANY($${params.length})`); } }
    if (f.company_id) { params.push(f.company_id); where.push(`p.company_id = $${params.length}`); }
    if (f.urgency) { params.push(f.urgency); where.push(`p.urgency = $${params.length}`); }
    if (f.health) { params.push(f.health); where.push(`p.health = $${params.length}`); }
    if (f.recruiter_id || f.mine) { params.push(f.mine ? ctx.userId : f.recruiter_id); where.push(`EXISTS (SELECT 1 FROM position_recruiter_assignments x WHERE x.position_id=p.id AND x.user_id=$${params.length} AND x.unassigned_at IS NULL)`); }
    if (f.unassigned === 'true') where.push(`NOT EXISTS (SELECT 1 FROM position_recruiter_assignments x WHERE x.position_id=p.id AND x.unassigned_at IS NULL)`);
    const es = editScope(ctx, 'positions');
    const r = await paged({ select: posSelect, from: 'positions p LEFT JOIN companies co ON co.id=p.company_id', where, params, lp, searchCols: ['p.title', 'co.name', "array_to_string(p.skills,' ')"],
      sortMap: { title: 'p.title', company_name: 'co.name', status: 'p.status', urgency: `array_position(ARRAY['critical','high','normal','low'], p.urgency)`, openings: 'p.openings', active_pipeline: '(SELECT count(*) FROM candidate_submissions s WHERE s.position_id=p.id)', created_at: 'p.created_at' }, defaultSort: 'p.created_at DESC' });
    const editable = es === 'all' ? null : new Set(es === 'none' ? [] : (await q<any>(`SELECT position_id FROM position_recruiter_assignments WHERE user_id=$1 AND unassigned_at IS NULL AND organization_id=$2`, [ctx.userId, ctx.orgId])).map(x => x.position_id));
    r.rows = r.rows.map((p: any) => ({ ...stripPositionComp(ctx, p), can_edit: editable === null ? true : editable.has(p.id) }));
    return r;
  });

  app.get('/api/v1/positions/:id', async (req) => {
    const ctx = staff(req);
    const p = await viewablePosition(ctx, (req.params as any).id);
    const row = await one<any>(`SELECT ${posSelect}, co.account_manager_id, am.name account_manager_name, cb.name created_by_name FROM positions p LEFT JOIN companies co ON co.id=p.company_id LEFT JOIN users am ON am.id=co.account_manager_id LEFT JOIN users cb ON cb.id=p.created_by WHERE p.id=$1`, [p.id]);
    const history = await q<any>(`SELECT pa.*, u.name user_name, ab.name assigned_by_name FROM position_recruiter_assignments pa JOIN users u ON u.id=pa.user_id LEFT JOIN users ab ON ab.id=pa.assigned_by WHERE pa.position_id=$1 ORDER BY pa.assigned_at DESC`, [p.id]);
    const requirements = await q(`SELECT * FROM position_requirements WHERE position_id=$1 ORDER BY created_at`, [p.id]);
    const funnel = await q<any>(`SELECT status, count(*)::int n FROM candidate_submissions WHERE position_id=$1 GROUP BY status`, [p.id]);
    const lastRun = await one<any>(`SELECT id, created_at, position_version FROM match_runs WHERE position_id=$1 ORDER BY created_at DESC LIMIT 1`, [p.id]);
    const canEdit = await canEditPosition(ctx, p.id);
    return { ...stripPositionComp(ctx, row), recruiter_history: history, requirements, funnel: Object.fromEntries(funnel.map(f => [f.status, f.n])), last_match_run: lastRun ? { ...lastRun, stale: lastRun.position_version !== p.match_version } : null,
      can_edit: canEdit, can_assign: canEdit && editScope(ctx, 'positions') !== 'assigned', allowed_status: nextStatuses(p.status) };
  });

  app.post('/api/v1/positions', async (req) => {
    const ctx = staff(req);
    need(ctx, 'positions', 'create');
    const b = posBody.extend({ status: z.enum(['draft', 'open']).default('draft'), recruiters: z.array(z.object({ user_id: z.string().uuid(), is_lead: z.boolean().default(false) })).default([]) }).parse(req.body);
    if (b.company_id) await assertCompany(ctx.orgId, b.company_id);
    if (b.pay_min_cents && b.pay_max_cents && b.pay_min_cents > b.pay_max_cents) throw badRequest('Minimum pay cannot be higher than maximum pay');
    const { recruiters, ...fields } = b;
    const pos = await tx(async (c) => {
      const p = await insertRow<any>('positions', { organization_id: ctx.orgId, ...fields, created_by: ctx.userId }, c);
      const members = await validMembers(ctx.orgId, recruiters.map(r => r.user_id));
      const anyLead = recruiters.some(r => r.is_lead);
      for (const [i, r] of recruiters.filter(r => members.has(r.user_id)).entries()) await insertRow('position_recruiter_assignments', { organization_id: ctx.orgId, position_id: p.id, user_id: r.user_id, is_lead: anyLead ? r.is_lead : i === 0, assigned_by: ctx.userId }, c);
      return p;
    });
    await activity(ctx, 'position', pos.id, 'system', `Position created${pos.company_id ? '' : ' (no client yet)'}`, null, { status: pos.status });
    const rec = recruiters.map(r => r.user_id).filter(u => u !== ctx.userId);
    if (rec.length) await notify(ctx.orgId, rec, { event: 'position.new', title: `New position assigned: ${pos.title}`, body: `${ctx.user.name} assigned you to ${pos.title}.`, link: `/recruiting/positions/${pos.id}` });
    await emit(ctx.orgId, 'position.created', { position_id: pos.id, title: pos.title, company_id: pos.company_id });
    return stripPositionComp(ctx, pos);
  });

  app.patch('/api/v1/positions/:id', async (req) => {
    const ctx = staff(req);
    const p = await editablePosition(ctx, (req.params as any).id);
    const b = posBody.partial().parse(req.body);
    if (b.bill_budget_cents !== undefined && !can(ctx, 'rates', 'view_comp') && !can(ctx, 'positions', 'view_comp')) delete b.bill_budget_cents; // write-protected comp field
    if (b.company_id) await assertCompany(ctx.orgId, b.company_id);
    const changed = Object.keys(b).filter(k => JSON.stringify((b as any)[k]) !== JSON.stringify(p[k]));
    const bump = changed.some(k => MATCH_FIELDS.includes(k));
    const upd = await updateRow<any>('positions', ctx.orgId, p.id, { ...b, match_version: bump ? p.match_version + 1 : undefined });
    if (changed.length) await activity(ctx, 'position', p.id, 'system', `Updated ${changed.map(k => k.replace(/_cents$/, '').replace(/_/g, ' ')).join(', ')}`, bump ? 'Matching inputs changed — previous AI match runs are now stale.' : null, { changed });
    return stripPositionComp(ctx, upd);
  });

  app.post('/api/v1/positions/:id/status', async (req) => {
    const ctx = staff(req);
    const p = await editablePosition(ctx, (req.params as any).id);
    const b = z.object({ status: z.enum(['draft', 'open', 'on_hold', 'filled', 'closed']), reason: z.string().max(1000).optional() }).parse(req.body);
    assertTransition('position', p.status, b.status);
    if (b.status === 'closed' && !b.reason?.trim()) throw badRequest('A reason is required to close a position');
    const upd = await updateRow<any>('positions', ctx.orgId, p.id, { status: b.status });
    await activity(ctx, 'position', p.id, 'status_change', `Status changed from ${p.status.replace('_', ' ')} to ${b.status.replace('_', ' ')}`, b.reason ?? null, { from: p.status, to: b.status });
    await audit(ctx, 'position.status_changed', { type: 'position', id: p.id, label: p.title }, { status: p.status }, { status: b.status }, b.reason);
    if (b.status === 'open') {
      const recs = (await q<any>(`SELECT user_id FROM position_recruiter_assignments WHERE position_id=$1 AND unassigned_at IS NULL`, [p.id])).map(r => r.user_id).filter((u: string) => u !== ctx.userId);
      if (recs.length) await notify(ctx.orgId, recs, { event: 'position.new', title: `Position opened: ${p.title}`, body: 'Sourcing can start — your position link is ready.', link: `/recruiting/positions/${p.id}` });
    }
    await emit(ctx.orgId, 'position.status_changed', { position_id: p.id, title: p.title, from: p.status, to: b.status });
    return stripPositionComp(ctx, upd);
  });

  app.delete('/api/v1/positions/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'positions', 'delete');
    const p = await editablePosition(ctx, (req.params as any).id);
    await updateRow('positions', ctx.orgId, p.id, { archived_at: new Date() });
    await audit(ctx, 'position.archived', { type: 'position', id: p.id, label: p.title }, { status: p.status }, null);
    await activity(ctx, 'position', p.id, 'system', 'Position archived');
    return { ok: true };
  });

  /* ── Recruiters ── */
  app.post('/api/v1/positions/:id/recruiters', async (req) => {
    const ctx = staff(req);
    const p = await editablePosition(ctx, (req.params as any).id);
    if (editScope(ctx, 'positions') === 'assigned') throw forbidden('Only managers can change recruiter assignments');
    const b = z.object({ user_id: z.string().uuid(), is_lead: z.boolean().default(false) }).parse(req.body);
    if (!(await validMembers(ctx.orgId, [b.user_id])).has(b.user_id)) throw badRequest('That person is not an active team member');
    const existing = await one<any>(`SELECT * FROM position_recruiter_assignments WHERE position_id=$1 AND user_id=$2 AND unassigned_at IS NULL`, [p.id, b.user_id]);
    const user = await one<any>(`SELECT name FROM users WHERE id=$1`, [b.user_id]);
    await tx(async (c) => {
      if (b.is_lead) await c.query(`UPDATE position_recruiter_assignments SET is_lead=false WHERE position_id=$1 AND unassigned_at IS NULL`, [p.id]);
      if (existing) await c.query(`UPDATE position_recruiter_assignments SET is_lead=$2 WHERE id=$1`, [existing.id, b.is_lead || existing.is_lead]);
      else {
        const anyActive = await c.query(`SELECT 1 FROM position_recruiter_assignments WHERE position_id=$1 AND unassigned_at IS NULL`, [p.id]);
        await insertRow('position_recruiter_assignments', { organization_id: ctx.orgId, position_id: p.id, user_id: b.user_id, is_lead: b.is_lead || !anyActive.rowCount, assigned_by: ctx.userId }, c);
      }
    });
    await activity(ctx, 'position', p.id, 'system', existing ? `${user.name} set as lead recruiter` : `${user.name} assigned${b.is_lead ? ' as lead recruiter' : ''}`);
    await audit(ctx, 'position.recruiter_assigned', { type: 'position', id: p.id, label: p.title }, null, { user_id: b.user_id, user: user.name, is_lead: b.is_lead });
    if (!existing && b.user_id !== ctx.userId) await notify(ctx.orgId, [b.user_id], { event: 'position.new', title: `You were assigned to ${p.title}`, body: `${ctx.user.name} assigned you${b.is_lead ? ' as lead recruiter' : ''}. Copy your position link to start sourcing.`, link: `/recruiting/positions/${p.id}` });
    return { ok: true };
  });
  app.delete('/api/v1/positions/:id/recruiters/:userId', async (req) => {
    const ctx = staff(req);
    const { id, userId } = req.params as any;
    const p = await editablePosition(ctx, id);
    if (editScope(ctx, 'positions') === 'assigned') throw forbidden('Only managers can change recruiter assignments');
    const a = await one<any>(`UPDATE position_recruiter_assignments SET unassigned_at=now(), is_lead=false WHERE position_id=$1 AND user_id=$2 AND unassigned_at IS NULL AND organization_id=$3 RETURNING *`, [p.id, userId, ctx.orgId]);
    if (!a) throw notFound();
    if (a.is_lead) await q(`UPDATE position_recruiter_assignments SET is_lead=true WHERE id=(SELECT id FROM position_recruiter_assignments WHERE position_id=$1 AND unassigned_at IS NULL ORDER BY assigned_at LIMIT 1)`, [p.id]);
    const user = await one<any>(`SELECT name FROM users WHERE id=$1`, [userId]);
    await activity(ctx, 'position', p.id, 'system', `${user?.name ?? 'Recruiter'} unassigned`);
    await audit(ctx, 'position.recruiter_unassigned', { type: 'position', id: p.id, label: p.title }, { user_id: userId }, null);
    return { ok: true };
  });

  /* ── Requirements (feed placement onboarding) ── */
  app.post('/api/v1/positions/:id/requirements', async (req) => {
    const ctx = staff(req);
    const p = await editablePosition(ctx, (req.params as any).id);
    const b = z.object({ title: z.string().trim().min(2).max(200), required: z.boolean().default(true) }).parse(req.body);
    const r = await insertRow('position_requirements', { organization_id: ctx.orgId, position_id: p.id, ...b });
    await activity(ctx, 'position', p.id, 'system', `Onboarding requirement added: ${b.title}`, null, { required: b.required });
    return r;
  });
  app.patch('/api/v1/positions/:id/requirements/:rid', async (req) => {
    const ctx = staff(req);
    const { id, rid } = req.params as any;
    const p = await editablePosition(ctx, id);
    const b = z.object({ title: z.string().trim().min(2).max(200).optional(), required: z.boolean().optional() }).parse(req.body);
    const r = await one<any>(`UPDATE position_requirements SET title=COALESCE($3,title), required=COALESCE($4,required) WHERE id=$1 AND position_id=$2 AND organization_id=$5 RETURNING *`, [rid, p.id, b.title ?? null, b.required ?? null, ctx.orgId]);
    if (!r) throw notFound();
    await activity(ctx, 'position', p.id, 'system', `Requirement updated: ${r.title} (${r.required ? 'required' : 'optional'})`);
    return r;
  });
  app.delete('/api/v1/positions/:id/requirements/:rid', async (req) => {
    const ctx = staff(req);
    const { id, rid } = req.params as any;
    const p = await editablePosition(ctx, id);
    const r = await one<any>(`DELETE FROM position_requirements WHERE id=$1 AND position_id=$2 AND organization_id=$3 RETURNING *`, [rid, p.id, ctx.orgId]);
    if (!r) throw notFound();
    await activity(ctx, 'position', p.id, 'system', `Requirement removed: ${r.title}`);
    return { ok: true };
  });

  /* ── Pipeline (kanban of submissions) ── */
  app.get('/api/v1/positions/:id/pipeline', async (req) => {
    const ctx = staff(req);
    const p = await viewablePosition(ctx, (req.params as any).id);
    need(ctx, 'submissions', 'view');
    const rows = await q<any>(`SELECT s.id, s.status, s.created_at, s.updated_at, s.client_decision, s.client_feedback, c.id candidate_id, c.first_name, c.last_name, c.headline, c.country, c.avatar_color, c.years_experience, u.name submitted_by_name,
      (SELECT min(i.scheduled_at) FROM interviews i WHERE i.submission_id=s.id AND i.status IN ('scheduled','requested') AND i.scheduled_at > now()) next_interview
      FROM candidate_submissions s JOIN candidates c ON c.id=s.candidate_id LEFT JOIN users u ON u.id=s.submitted_by WHERE s.position_id=$1 AND s.organization_id=$2 ORDER BY s.updated_at DESC`, [p.id, ctx.orgId]);
    return { stages: ['submitted', 'client_review', 'client_interview', 'offer', 'hired', 'rejected', 'withdrawn'], rows: rows.map(r => ({ ...r, name: fullName(r) })), can_edit: await canEditPosition(ctx, p.id) || editScope(ctx, 'submissions') === 'all' };
  });

  /* ── Sourcing links ── */
  const linkStats = `l.*, u.name user_name, (SELECT count(*)::int FROM sourcing_clicks k WHERE k.link_id=l.id) clicks, (SELECT count(*)::int FROM applications a WHERE a.sourcing_link_id=l.id) applications,
    (SELECT count(DISTINCT a.candidate_id)::int FROM applications a JOIN candidates c ON c.id=a.candidate_id WHERE a.sourcing_link_id=l.id AND c.status IN ('qualified','talent_pool','submitted','hired')) qualified`;
  const linkOut = (l: any, slug: string) => { const url = `${WEB_URL}/apply/${slug}/${l.position_id ? 'p' : 'r'}/${l.token}`; return { ...l, url, qr_url: `/api/v1/qr?text=${encodeURIComponent(url)}` }; };
  app.get('/api/v1/positions/:id/sourcing', async (req) => {
    const ctx = staff(req);
    const p = await viewablePosition(ctx, (req.params as any).id);
    const rows = await q<any>(`SELECT ${linkStats} FROM sourcing_links l JOIN users u ON u.id=l.user_id WHERE l.position_id=$1 AND l.organization_id=$2 ORDER BY (l.user_id=$3) DESC, l.created_at`, [p.id, ctx.orgId, ctx.userId]);
    const mine = rows.find(r => r.user_id === ctx.userId && r.active) ?? null;
    return { mine: mine ? linkOut(mine, ctx.org.slug) : null, links: rows.map(r => linkOut(r, ctx.org.slug)), public_url: `${WEB_URL}/apply/${ctx.org.slug}` };
  });
  app.post('/api/v1/positions/:id/sourcing', async (req) => {
    const ctx = staff(req);
    const p = await viewablePosition(ctx, (req.params as any).id);
    need(ctx, 'candidates', 'create');
    let l = await one<any>(`SELECT * FROM sourcing_links WHERE position_id=$1 AND user_id=$2 AND active ORDER BY created_at LIMIT 1`, [p.id, ctx.userId]);
    if (!l) {
      l = await insertRow('sourcing_links', { organization_id: ctx.orgId, user_id: ctx.userId, position_id: p.id, token: crypto.randomBytes(8).toString('base64url'), label: p.title });
      await activity(ctx, 'position', p.id, 'system', `${ctx.user.name} created a position sourcing link`);
    }
    const full = await one<any>(`SELECT ${linkStats} FROM sourcing_links l JOIN users u ON u.id=l.user_id WHERE l.id=$1`, [l.id]);
    return linkOut(full, ctx.org.slug);
  });

  /* ── AI: job description draft (never auto-published) ── */
  app.post('/api/v1/positions/:id/ai/job-description', async (req) => {
    const ctx = staff(req);
    const p = await viewablePosition(ctx, (req.params as any).id);
    await assertAiAvailable(ctx.orgId, 'Write job description');
    const company = p.company_id ? await one(`SELECT name FROM companies WHERE id=$1`, [p.company_id]) : null;
    const d = draft('job_description', { position: p, company });
    await logAi(ctx.orgId, 'job_description', { position_id: p.id });
    await activity(ctx, 'position', p.id, 'system', 'AI drafted a job description (not published)', null, { model: AI_MODEL });
    return { ...d, model: AI_MODEL };
  });

  /* ── AI: Find Best Matches ── */
  app.post('/api/v1/positions/:id/matches', async (req) => {
    const ctx = staff(req);
    const p = await viewablePosition(ctx, (req.params as any).id);
    need(ctx, 'candidates', 'view');
    await assertAiAvailable(ctx.orgId, 'Find Best Matches');
    const b = z.object({ include_submitted: z.boolean().default(false), limit: z.number().int().min(5).max(100).default(25) }).parse(req.body ?? {});
    // Pool: every active candidate, plus hired people who are not currently on an active placement (bench).
    const onPlacement = `EXISTS (SELECT 1 FROM workers w JOIN placements pl ON pl.worker_id=w.id WHERE w.candidate_id=c.id AND pl.status IN ('onboarding','active','on_leave','notice'))`;
    const pool = await q<any>(`SELECT c.* FROM candidates c WHERE c.organization_id=$1 AND c.archived_at IS NULL AND c.status NOT IN ('blacklisted','rejected','withdrawn')
      AND (c.status <> 'hired' OR NOT ${onPlacement})
      ${b.include_submitted ? 'AND $2::uuid IS NOT NULL' : 'AND NOT EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id AND s.position_id=$2)'}`, [ctx.orgId, p.id]);
    let empty_reason: string | null = null;
    if (!pool.length) {
      const k = await one<any>(`SELECT count(*)::int total,
          count(*) FILTER (WHERE c.status IN ('blacklisted','rejected','withdrawn'))::int closed,
          count(*) FILTER (WHERE c.status='hired' AND ${onPlacement})::int placed,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM candidate_submissions s WHERE s.candidate_id=c.id AND s.position_id=$2))::int submitted
        FROM candidates c WHERE c.organization_id=$1 AND c.archived_at IS NULL`, [ctx.orgId, p.id]);
      const parts = [k.placed && `${k.placed} already placed with a client`, k.submitted && `${k.submitted} already submitted to this position`, k.closed && `${k.closed} rejected, withdrawn or blacklisted`].filter(Boolean);
      empty_reason = !k.total ? 'There are no candidates in this workspace yet. Add candidates or share your application link, then run matching again.'
        : `None of your ${k.total} candidate${k.total === 1 ? ' is' : 's are'} available to match${parts.length ? ` (${parts.join(', ')})` : ''}. Add more candidates or share your application link.`;
    }
    const company = p.company_id ? await one<any>(`SELECT name FROM companies WHERE id=$1`, [p.company_id]) : null;
    const ranked = await rankMatchesAI(ctx.orgId, { ...p, client: company?.name ?? null }, pool, b.limit);
    const scored = ranked.scored;
    const inputs = { skills: p.skills, software: p.software, languages: p.languages, timezone: p.timezone, weekly_hours: p.weekly_hours, pay_min_cents: p.pay_min_cents, pay_max_cents: p.pay_max_cents, currency: p.currency, pool_size: pool.length, empty_reason, note: ranked.note, weights: { skills: 35, software: 15, experience: 15, timezone: 10, availability: 10, language: 5, pay: 10 } };
    const run = await tx(async (c) => {
      const r = await insertRow<any>('match_runs', { organization_id: ctx.orgId, position_id: p.id, model: ranked.model, inputs: JSON.stringify(inputs), position_version: p.match_version, run_by: ctx.userId }, c);
      for (const s of scored) await insertRow('match_results', { organization_id: ctx.orgId, run_id: r.id, candidate_id: s.c.id, score: s.m.score, breakdown: JSON.stringify(s.m.breakdown), reasons: JSON.stringify(s.m.reasons), missing: JSON.stringify(s.m.missing) }, c);
      return r;
    });
    await logAi(ctx.orgId, 'find_best_matches', { position_id: p.id, pool: pool.length, model: ranked.model });
    await activity(ctx, 'position', p.id, 'system', `AI match run: ${scored.length} candidates ranked from a pool of ${pool.length}`, null, { run_id: run.id, model: ranked.model });
    return loadMatches(ctx, p, run.id);
  });
  app.get('/api/v1/positions/:id/matches', async (req) => {
    const ctx = staff(req);
    const p = await viewablePosition(ctx, (req.params as any).id);
    need(ctx, 'candidates', 'view');
    const run = await one<any>(`SELECT id FROM match_runs WHERE position_id=$1 ORDER BY created_at DESC LIMIT 1`, [p.id]);
    if (!run) return { run: null, results: [], stale: false, runs: [] };
    return loadMatches(ctx, p, run.id);
  });
  app.post('/api/v1/positions/:id/matches/:resultId/shortlist', async (req) => {
    const ctx = staff(req);
    const { id, resultId } = req.params as any;
    const p = await viewablePosition(ctx, id);
    const b = z.object({ shortlisted: z.boolean() }).parse(req.body);
    const r = await one<any>(`UPDATE match_results mr SET shortlisted=$3 FROM match_runs r WHERE mr.id=$1 AND mr.run_id=r.id AND r.position_id=$2 AND mr.organization_id=$4 RETURNING mr.*`, [resultId, p.id, b.shortlisted, ctx.orgId]);
    if (!r) throw notFound();
    const c = await one<any>(`SELECT first_name, last_name FROM candidates WHERE id=$1`, [r.candidate_id]);
    await activity(ctx, 'position', p.id, 'system', `${b.shortlisted ? 'Shortlisted' : 'Removed from shortlist'}: ${fullName(c)}`);
    return r;
  });

  async function loadMatches(ctx: any, p: any, runId: string) {
    const run = await one<any>(`SELECT r.*, u.name run_by_name FROM match_runs r LEFT JOIN users u ON u.id=r.run_by WHERE r.id=$1`, [runId]);
    const results = await q<any>(`SELECT mr.*, c.first_name, c.last_name, c.headline, c.country, c.city, c.timezone, c.years_experience, c.skills, c.software, c.languages, c.availability_status, c.earliest_start, c.rate_min_cents, c.rate_target_cents, c.rate_currency, c.rate_unit, c.status candidate_status, c.avatar_color, c.video_file, c.resume_file,
      (SELECT s.status FROM candidate_submissions s WHERE s.candidate_id=c.id AND s.position_id=$2) submission_status
      FROM match_results mr JOIN candidates c ON c.id=mr.candidate_id WHERE mr.run_id=$1 ORDER BY mr.score DESC`, [runId, p.id]);
    const runs = await q<any>(`SELECT r.id, r.created_at, r.position_version, u.name run_by_name, (SELECT count(*)::int FROM match_results x WHERE x.run_id=r.id) n FROM match_runs r LEFT JOIN users u ON u.id=r.run_by WHERE r.position_id=$1 ORDER BY r.created_at DESC LIMIT 10`, [p.id]);
    return { run, stale: run.position_version !== p.match_version, position_version: p.match_version, results: results.map(r => ({ ...candOut(ctx, r), name: fullName(r), candidate_id: r.candidate_id })), runs: runs.map(r => ({ ...r, stale: r.position_version !== p.match_version })) };
  }
}

function nextStatuses(s: string) { const M: Record<string, string[]> = { draft: ['open', 'closed'], open: ['on_hold', 'filled', 'closed'], on_hold: ['open', 'closed'], filled: ['open', 'closed'], closed: ['open'] }; return M[s] ?? []; }
async function assertCompany(orgId: string, id: string) { if (!(await one(`SELECT 1 FROM companies WHERE id=$1 AND organization_id=$2`, [id, orgId]))) throw badRequest('Client not found in this workspace'); }
async function validMembers(orgId: string, ids: string[]) { if (!ids.length) return new Set<string>(); return new Set((await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.user_id = ANY($2) AND m.status='active' AND r.kind='agency'`, [orgId, ids])).map(r => r.user_id)); }
