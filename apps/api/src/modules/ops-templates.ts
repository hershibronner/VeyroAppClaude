// OPS: message templates (versioned, merge-variable preview, test send), notification preferences + notification feeds.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, one, tx } from '../core/db';
import { auth, staff, need, getOr404, type Ctx } from '../core/context';
import { conflict, notFound } from '../core/errors';
import { audit } from '../core/audit';
import { listParams, paged } from '../core/list';
import { render } from '../core/templates';
import { sendTemplate } from '../adapters/messaging';
import { WEB_URL } from '../core/settings';
import { enrich } from './_insights/automationEngine';

/** Sample data for previews; every merge variable used by the seeded templates resolves to a realistic value. */
export function sampleVars(ctx: Pick<Ctx, 'org' | 'user'>): Record<string, any> {
  return {
    org: { name: ctx.org.name }, user: { name: ctx.user.name }, sender: { name: ctx.user.name }, inviter: { name: ctx.user.name },
    invitee: { name: 'Jordan Lee' }, role: { name: 'Recruiter' }, link: `${WEB_URL}/example-link`, code: '482913',
    candidate: { firstName: 'Maria', name: 'Maria Santos' }, worker: { firstName: 'Jose', name: 'Jose Ramirez' }, person: { firstName: 'Jose', name: 'Jose Ramirez' },
    position: { title: 'Dental Front Desk VA', suffix: ' for Dental Front Desk VA' }, company: { name: 'Brightline Dental', terms: 15 }, contact: { firstName: 'Dana', name: 'Dana Fox' },
    interview: { when: 'Thu, Nov 6 at 10:00 AM', timezone: 'America/New_York', link: 'https://meet.veyro.local/abc-defg-hij' },
    offer: { startDate: 'Nov 10, 2026', payRate: '$7.00/hour' },
    invoice: { number: 'INV-1042', total: '$4,280.00', balance: '$4,280.00', dueDate: 'Nov 12, 2026' },
    payment: { receipt: 'RCPT-20931', amount: '$4,280.00' }, document: { title: 'Independent Contractor Agreement', name: 'Government ID', expiresAt: 'Nov 20, 2026' },
    signer: { name: 'Jose Ramirez' }, minutes: 18, period: 'Oct 16 – Oct 31', net: '$1,120.00', task: { title: 'Follow up with Brightline Dental', due: 'tomorrow' },
    report: { name: 'Revenue by client', table: 'Client | Revenue\nBrightline Dental | $12,400.00\nSummit Ridge Realty | $9,850.00' }, shift: { start: '9:00 AM' },
    placement: { title: 'Dental Front Desk VA', startDate: 'Nov 10, 2026' }, party: { name: 'Brightline Dental' }, today: new Date().toISOString().slice(0, 10),
  };
}
export const MERGE_VARIABLES: { key: string; label: string }[] = [
  { key: 'org.name', label: 'Agency name' }, { key: 'candidate.firstName', label: 'Candidate first name' }, { key: 'candidate.name', label: 'Candidate full name' },
  { key: 'worker.firstName', label: 'Worker first name' }, { key: 'worker.name', label: 'Worker full name' }, { key: 'company.name', label: 'Client name' },
  { key: 'contact.firstName', label: 'Client contact first name' }, { key: 'position.title', label: 'Position title' }, { key: 'placement.title', label: 'Placement title' },
  { key: 'placement.startDate', label: 'Placement start date' }, { key: 'interview.when', label: 'Interview date & time' }, { key: 'interview.link', label: 'Interview link' },
  { key: 'offer.startDate', label: 'Offer start date' }, { key: 'offer.payRate', label: 'Offer pay rate' }, { key: 'invoice.number', label: 'Invoice number' },
  { key: 'invoice.total', label: 'Invoice total' }, { key: 'invoice.balance', label: 'Invoice balance' }, { key: 'invoice.dueDate', label: 'Invoice due date' },
  { key: 'document.name', label: 'Document name' }, { key: 'document.expiresAt', label: 'Document expiry' }, { key: 'minutes', label: 'Minutes late' },
  { key: 'link', label: 'Action link' }, { key: 'sender.name', label: 'Sender name' }, { key: 'today', label: "Today's date" },
];
const CHANNELS = ['email', 'sms', 'whatsapp', 'offer', 'onboarding'] as const;

/** Real-record merge data for previews (worker / candidate / company / placement / invoice). */
async function recordVars(ctx: Ctx, type?: string, id?: string) {
  if (!type || !id) return null;
  const key = ({ worker: 'worker_id', candidate: 'candidate_id', company: 'company_id', placement: 'placement_id', invoice: 'invoice_id' } as Record<string, string>)[type];
  if (!key) return null;
  const table = ({ worker: 'workers', candidate: 'candidates', company: 'companies', placement: 'placements', invoice: 'invoices' } as Record<string, string>)[type];
  await getOr404(table, ctx, id);
  const v = await enrich(ctx.orgId, { [key]: id });
  return { ...sampleVars(ctx), ...v, sender: { name: ctx.user.name } };
}

// Notification events users can configure (§8.13). Any other event that has reached the user is added dynamically.
export const NOTIFICATION_EVENTS: { event: string; label: string; group: string }[] = [
  { event: 'application.new', label: 'New public application', group: 'Recruiting' }, { event: 'application.created', label: 'New application on my positions', group: 'Recruiting' },
  { event: 'candidate.assigned', label: 'Candidate assigned to me', group: 'Recruiting' }, { event: 'mention', label: '@mentioned in a note', group: 'General' },
  { event: 'task.assigned', label: 'Task assigned to me', group: 'Tasks' }, { event: 'task.due', label: 'Task due', group: 'Tasks' }, { event: 'task.overdue', label: 'Task overdue', group: 'Tasks' },
  { event: 'interview.upcoming', label: 'Interview upcoming', group: 'Recruiting' }, { event: 'interview.changed', label: 'Interview changed', group: 'Recruiting' },
  { event: 'position.new', label: 'New position for me', group: 'Recruiting' }, { event: 'client.feedback', label: 'Client feedback on a submission', group: 'Recruiting' },
  { event: 'placement.started', label: 'Placement started', group: 'Workforce' }, { event: 'activation.blocker', label: 'Activation blocked', group: 'Workforce' },
  { event: 'onboarding.missing', label: 'Missing onboarding items', group: 'Workforce' }, { event: 'attendance.late', label: 'Worker late', group: 'Workforce' }, { event: 'attendance.absent', label: 'Worker absent', group: 'Workforce' },
  { event: 'timesheet.submitted', label: 'Timesheet submitted', group: 'Time' }, { event: 'timesheet.approved', label: 'Timesheet approved', group: 'Time' }, { event: 'timesheet.rejected', label: 'Timesheet rejected', group: 'Time' },
  { event: 'invoice.sent', label: 'Invoice sent', group: 'Finance' }, { event: 'invoice.paid', label: 'Invoice paid', group: 'Finance' }, { event: 'invoice.overdue', label: 'Invoice overdue', group: 'Finance' },
  { event: 'payout.failed', label: 'Payout failed', group: 'Finance' }, { event: 'document.expiring', label: 'Document expiring', group: 'Documents' }, { event: 'document.signed', label: 'Document signed', group: 'Documents' },
  { event: 'signature.requested', label: 'Signature requested from me', group: 'Documents' }, { event: 'message', label: 'New message', group: 'General' },
  { event: 'automation.approval', label: 'Automation waiting for approval', group: 'General' }, { event: 'integration.error', label: 'Integration error', group: 'General' },
];
const PORTAL_EVENTS = new Set(['message', 'task.assigned', 'timesheet.approved', 'timesheet.rejected', 'invoice.sent', 'document.expiring', 'signature.requested', 'document.signed', 'interview.upcoming']);

async function feed(req: FastifyRequest, ctx: Ctx) {
  const lp = listParams(req);
  const where = ['n.organization_id=$1', 'n.user_id=$2']; const params: unknown[] = [ctx.orgId, ctx.userId];
  if (lp.filters.unread === 'true' || lp.filters.unread === '1') where.push('n.read_at IS NULL');
  if (lp.filters.event) { params.push(lp.filters.event); where.push(`n.event=$${params.length}`); }
  const r = await paged({ select: 'n.*', from: 'notifications n', where, params, lp, searchCols: ['n.title', 'n.body'], sortMap: { created_at: 'n.created_at' }, defaultSort: 'n.created_at DESC' });
  const c = await one<any>(`SELECT count(*) FILTER (WHERE read_at IS NULL)::int unread, count(*)::int total FROM notifications WHERE organization_id=$1 AND user_id=$2`, [ctx.orgId, ctx.userId]);
  const events = await q<any>(`SELECT event, count(*)::int n FROM notifications WHERE organization_id=$1 AND user_id=$2 GROUP BY 1 ORDER BY 2 DESC`, [ctx.orgId, ctx.userId]);
  return { ...r, unread: c.unread, all: c.total, events };
}

export default async function (app: FastifyInstance) {
  // ── Templates ──
  app.get('/api/v1/templates', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'view');
    const lp = listParams(req);
    const where = ['t.organization_id=$1']; const params: unknown[] = [ctx.orgId];
    if (lp.filters.channel) { params.push(lp.filters.channel); where.push(`t.channel=$${params.length}`); }
    where.push(lp.filters.archived === 'true' ? 't.archived_at IS NOT NULL' : 't.archived_at IS NULL');
    return paged({ select: `t.*, v.subject, left(v.body, 180) preview, v.created_at version_at, u.name version_by, (SELECT count(*) FROM template_versions x WHERE x.template_id=t.id)::int versions`,
      from: 'templates t LEFT JOIN template_versions v ON v.template_id=t.id AND v.version=t.current_version LEFT JOIN users u ON u.id=v.created_by', where, params, lp,
      searchCols: ['t.name', 't.key', 'v.subject', 'v.body'], sortMap: { name: 't.name', channel: 't.channel', updated_at: 't.updated_at' }, defaultSort: 't.name ASC' });
  });
  app.get('/api/v1/templates/variables', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'view');
    const s = sampleVars(ctx);
    return MERGE_VARIABLES.map(v => ({ ...v, sample: render(`{{${v.key}}}`, s) }));
  });
  app.post('/api/v1/templates/preview', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'view');
    const b = z.object({ subject: z.string().max(500).nullish(), body: z.string().max(20000), entity_type: z.string().optional(), entity_id: z.string().uuid().optional() }).parse(req.body);
    const vars = (await recordVars(ctx, b.entity_type, b.entity_id)) ?? sampleVars(ctx);
    const used = [...new Set([...(b.subject ?? '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g), ...b.body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map(m => m[1]))];
    const missing = used.filter(k => render(`{{${k}}}`, vars) === '');
    return { subject: render(b.subject ?? '', vars), body: render(b.body, vars), variables: used, missing, source: b.entity_id ? 'record' : 'sample' };
  });
  app.get('/api/v1/templates/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'view');
    const t = await getOr404<any>('templates', ctx, (req.params as any).id);
    const versions = await q(`SELECT v.*, u.name created_by_name FROM template_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.template_id=$1 AND v.organization_id=$2 ORDER BY v.version DESC`, [t.id, ctx.orgId]);
    const sent = await one<any>(`SELECT count(*)::int n, max(created_at) last FROM outbox_messages WHERE organization_id=$1 AND template_key=$2`, [ctx.orgId, t.key]);
    return { ...t, current: versions.find((v: any) => v.version === t.current_version) ?? null, versions, usage: { sent: sent?.n ?? 0, last_sent_at: sent?.last ?? null } };
  });
  app.post('/api/v1/templates', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'create');
    const b = z.object({ name: z.string().min(1).max(120), key: z.string().regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores').max(60).optional(), channel: z.enum(CHANNELS), subject: z.string().max(500).nullish(), body: z.string().min(1).max(20000) }).parse(req.body);
    const key = b.key ?? b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50);
    if (await one(`SELECT 1 FROM templates WHERE organization_id=$1 AND key=$2`, [ctx.orgId, key])) throw conflict(`A template with key "${key}" already exists`);
    const t = await tx(async c => {
      const tt = (await c.query(`INSERT INTO templates (organization_id, key, name, channel, current_version) VALUES ($1,$2,$3,$4,1) RETURNING *`, [ctx.orgId, key, b.name, b.channel])).rows[0];
      await c.query(`INSERT INTO template_versions (organization_id, template_id, version, subject, body, created_by) VALUES ($1,$2,1,$3,$4,$5)`, [ctx.orgId, tt.id, b.subject ?? null, b.body, ctx.userId]);
      return tt;
    });
    await audit(ctx, 'template.created', { type: 'template', id: t.id, label: t.name });
    return t;
  });
  app.patch('/api/v1/templates/:id', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'edit');
    const t = await getOr404<any>('templates', ctx, (req.params as any).id);
    const b = z.object({ name: z.string().min(1).max(120).optional(), channel: z.enum(CHANNELS).optional() }).parse(req.body);
    return one(`UPDATE templates SET name=COALESCE($3,name), channel=COALESCE($4,channel), updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [t.id, ctx.orgId, b.name ?? null, b.channel ?? null]);
  });
  // Saving content always creates a new version; earlier versions are kept for history and restore.
  app.post('/api/v1/templates/:id/versions', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'edit');
    const t = await getOr404<any>('templates', ctx, (req.params as any).id);
    const b = z.object({ subject: z.string().max(500).nullish(), body: z.string().min(1).max(20000) }).parse(req.body);
    const cur = await one<any>(`SELECT subject, body FROM template_versions WHERE template_id=$1 AND version=$2`, [t.id, t.current_version]);
    if (cur && cur.body === b.body && (cur.subject ?? '') === (b.subject ?? '')) throw conflict('No changes to save');
    const v = await tx(async c => {
      const next = (await c.query(`SELECT COALESCE(max(version),0)+1 n FROM template_versions WHERE template_id=$1`, [t.id])).rows[0].n;
      const row = (await c.query(`INSERT INTO template_versions (organization_id, template_id, version, subject, body, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ctx.orgId, t.id, next, b.subject ?? null, b.body, ctx.userId])).rows[0];
      await c.query(`UPDATE templates SET current_version=$2, updated_at=now() WHERE id=$1`, [t.id, next]);
      return row;
    });
    await audit(ctx, 'template.version_created', { type: 'template', id: t.id, label: t.name }, { version: t.current_version }, { version: v.version });
    return v;
  });
  app.post('/api/v1/templates/:id/restore', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'edit');
    const t = await getOr404<any>('templates', ctx, (req.params as any).id);
    const b = z.object({ version: z.number().int().min(1) }).parse(req.body);
    const old = await one<any>(`SELECT * FROM template_versions WHERE template_id=$1 AND version=$2`, [t.id, b.version]);
    if (!old) throw notFound();
    const v = await tx(async c => {
      const next = (await c.query(`SELECT COALESCE(max(version),0)+1 n FROM template_versions WHERE template_id=$1`, [t.id])).rows[0].n;
      const row = (await c.query(`INSERT INTO template_versions (organization_id, template_id, version, subject, body, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ctx.orgId, t.id, next, old.subject, old.body, ctx.userId])).rows[0];
      await c.query(`UPDATE templates SET current_version=$2, updated_at=now() WHERE id=$1`, [t.id, next]);
      return row;
    });
    await audit(ctx, 'template.restored', { type: 'template', id: t.id, label: t.name }, null, { from_version: b.version, new_version: v.version });
    return v;
  });
  app.post('/api/v1/templates/:id/archive', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'edit');
    const t = await getOr404<any>('templates', ctx, (req.params as any).id);
    await q(`UPDATE templates SET archived_at=now(), updated_at=now() WHERE id=$1`, [t.id]);
    await audit(ctx, 'template.archived', { type: 'template', id: t.id, label: t.name });
    return { ok: true };
  });
  app.post('/api/v1/templates/:id/unarchive', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'edit');
    const t = await getOr404<any>('templates', ctx, (req.params as any).id);
    await q(`UPDATE templates SET archived_at=NULL, updated_at=now() WHERE id=$1`, [t.id]);
    return { ok: true };
  });
  app.post('/api/v1/templates/:id/send-test', async (req) => {
    const ctx = staff(req);
    need(ctx, 'templates', 'view');
    const t = await getOr404<any>('templates', ctx, (req.params as any).id);
    const b = z.object({ to: z.string().max(200).optional(), entity_type: z.string().optional(), entity_id: z.string().uuid().optional() }).parse(req.body ?? {});
    const vars = (await recordVars(ctx, b.entity_type, b.entity_id)) ?? sampleVars(ctx);
    const to = b.to || ctx.user.email;
    const m = await sendTemplate(ctx.orgId, t.key, to, vars, { channel: t.channel === 'sms' || t.channel === 'whatsapp' ? t.channel : 'email' });
    return { ok: true, outbox_id: m.id, to };
  });

  // ── Notification preferences (any signed-in user, incl. portal users) ──
  app.get('/api/v1/notification-preferences', async (req) => {
    const ctx = auth(req);
    const prefs = await q<any>(`SELECT event, in_app, email, push, subscribed FROM notification_preferences WHERE organization_id=$1 AND user_id=$2`, [ctx.orgId, ctx.userId]);
    const seen = await q<any>(`SELECT DISTINCT event FROM notifications WHERE organization_id=$1 AND user_id=$2`, [ctx.orgId, ctx.userId]);
    const base = ctx.role.kind === 'agency' ? NOTIFICATION_EVENTS : NOTIFICATION_EVENTS.filter(e => PORTAL_EVENTS.has(e.event));
    const all = [...base, ...seen.filter(s => !base.some(e => e.event === s.event)).map(s => ({ event: s.event, label: s.event.replace(/[._]/g, ' ').replace(/^\w/, (c: string) => c.toUpperCase()), group: 'Other' }))];
    return { events: all.map(e => { const p = prefs.find(x => x.event === e.event); return { ...e, in_app: p?.in_app ?? true, email: p?.email ?? false, push: p?.push ?? false }; }) };
  });
  app.put('/api/v1/notification-preferences', async (req) => {
    const ctx = auth(req);
    const b = z.object({ prefs: z.array(z.object({ event: z.string().min(1).max(80), in_app: z.boolean(), email: z.boolean(), push: z.boolean() })).max(200) }).parse(req.body);
    for (const p of b.prefs) await q(`INSERT INTO notification_preferences (user_id, organization_id, event, in_app, email, push) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, organization_id, event) DO UPDATE SET in_app=$4, email=$5, push=$6`, [ctx.userId, ctx.orgId, p.event, p.in_app, p.email, p.push]);
    return { ok: true, saved: b.prefs.length };
  });
  app.get('/api/v1/notification-preferences/feed', async (req) => { const ctx = staff(req); return feed(req, ctx); });
  app.get('/api/v1/portal/worker/notifications', async (req) => {
    const ctx = auth(req);
    if (ctx.role.kind !== 'worker') throw notFound();
    return feed(req, ctx);
  });
}
