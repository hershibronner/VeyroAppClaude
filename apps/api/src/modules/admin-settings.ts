// Agency Settings: General & Branding, white label, policy settings (portals/AI/time/payroll/invoice/security),
// onboarding templates, equipment templates, monitoring policies, training modules, admin event subscriptions, custom fields.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one, tx } from '../core/db';
import { staff, need, can, type Ctx } from '../core/context';
import { badRequest, conflict, notFound, forbidden } from '../core/errors';
import { audit } from '../core/audit';
import { getSetting, setSetting } from '../core/settings';
import { saveFile, signedUrl, deleteFile } from '../core/storage';
import { EVENT_CATALOG, isUuid, randomToken } from './_admin/common';
import { fieldError } from './_admin/common';
import type { Resource } from '@veyro/shared';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #345CFF');
const TZ = z.string().min(3).max(60).refine(tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone');

const SETTING_SCHEMAS: Record<string, z.ZodTypeAny> = {
  portals: z.object({ client_enabled: z.boolean(), worker_enabled: z.boolean(), candidate_enabled: z.boolean(), client_can_invite_users: z.boolean().optional(), client_can_request_workers: z.boolean().optional(), worker_can_request_time_off: z.boolean().optional(), welcome_message: z.string().max(500).optional() }).partial(),
  ai: z.object({ enabled: z.boolean(), simulate_failure: z.boolean(), model: z.string().max(60), require_human_review: z.boolean(), match_threshold: z.number().int().min(0).max(100) }).partial(),
  time_tracking: z.object({ late_grace_minutes: z.number().int().min(0).max(120), absent_after_minutes: z.number().int().min(15).max(600), retention_days: z.number().int().min(7).max(730), allow_manual_time: z.boolean(), require_policy_acceptance: z.boolean(), max_shift_hours: z.number().int().min(1).max(24) }).partial(),
  payroll: z.object({ frequency: z.enum(['weekly', 'biweekly', 'semi_monthly', 'monthly']), pay_day_offset: z.number().int().min(0).max(30), default_ot_multiplier_bp: z.number().int().min(10000).max(30000), ot_threshold_minutes: z.number().int().min(0).max(6000), currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(20) }).partial(),
  invoice: z.object({ prefix: z.string().min(1).max(12).regex(/^[A-Za-z0-9-]+$/, 'Letters, numbers and dashes only'), terms_days: z.number().int().min(0).max(120), tax_bp: z.number().int().min(0).max(5000), footer: z.string().max(500), late_fee_bp: z.number().int().min(0).max(2000), next_number: z.number().int().min(1).optional() }).partial(),
  security: z.object({ mfa_required: z.boolean(), session_days: z.number().int().min(1).max(90), export_requires_reason: z.boolean() }).partial(),
};

export async function whiteLabelAllowed(orgId: string) {
  const r = await one<any>(`SELECT s.plan_key, p.features, (SELECT enabled FROM feature_flags f WHERE f.organization_id=$1 AND f.key='white_label') flag FROM subscriptions s JOIN plans p ON p.key=s.plan_key WHERE s.organization_id=$1`, [orgId]);
  return !!r && (r.plan_key === 'white_label' || r.features?.white_label === true || r.flag === true);
}

const ENTITY_MAP: Record<string, { table: string; resources: Resource[]; label: string }> = {
  candidate: { table: 'candidates', resources: ['candidates'], label: 'Candidates' },
  company: { table: 'companies', resources: ['clients', 'leads'], label: 'Clients & leads' },
  contact: { table: 'contacts', resources: ['contacts'], label: 'Contacts' },
  position: { table: 'positions', resources: ['positions'], label: 'Positions' },
  worker: { table: 'workers', resources: ['workers'], label: 'Workers' },
  placement: { table: 'placements', resources: ['placements'], label: 'Placements' },
  opportunity: { table: 'opportunities', resources: ['opportunities'], label: 'Opportunities' },
};

function settingsEdit(ctx: Ctx) { need(ctx, 'settings', 'edit'); }
function settingsView(ctx: Ctx) { need(ctx, 'settings', 'view'); }
const idParam = (req: any, k = 'id') => { const v = req.params[k]; if (!isUuid(v)) throw notFound(); return v as string; };

export default async function (app: FastifyInstance) {
  // ── General & Branding ──
  app.get('/api/v1/settings/general', async (req) => {
    const ctx = staff(req); settingsView(ctx);
    const org = await one<any>(`SELECT id, name, slug, status, default_currency, timezone, created_at FROM organizations WHERE id=$1`, [ctx.orgId]);
    const b = await one<any>(`SELECT * FROM organization_branding WHERE organization_id=$1`, [ctx.orgId]);
    const sub = await one<any>(`SELECT s.plan_key, p.name plan_name FROM subscriptions s JOIN plans p ON p.key=s.plan_key WHERE s.organization_id=$1`, [ctx.orgId]);
    return { org, branding: b ? { ...b, logo_url: signedUrl(b.logo_file, 86400), domain_token: b.domain_token } : null, plan: sub, white_label_allowed: await whiteLabelAllowed(ctx.orgId), editable: can(ctx, 'settings', 'edit') };
  });
  app.patch('/api/v1/settings/general', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const b = z.object({ name: z.string().min(2).max(80).optional(), timezone: TZ.optional(), default_currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      logo_text: z.string().max(40).nullable().optional(), primary_color: hex.optional(), accent_color: hex.optional(), email_sender_name: z.string().max(80).nullable().optional(),
      terminology: z.record(z.string().max(30), z.string().max(40)).optional() }).parse(req.body);
    const beforeOrg = await one<any>(`SELECT name, timezone, default_currency FROM organizations WHERE id=$1`, [ctx.orgId]);
    const beforeB = await one<any>(`SELECT logo_text, primary_color, accent_color, email_sender_name, terminology FROM organization_branding WHERE organization_id=$1`, [ctx.orgId]);
    await tx(async (c) => {
      await c.query(`UPDATE organizations SET name=COALESCE($2,name), timezone=COALESCE($3,timezone), default_currency=COALESCE($4,default_currency), updated_at=now() WHERE id=$1`, [ctx.orgId, b.name ?? null, b.timezone ?? null, b.default_currency ?? null]);
      await c.query(`INSERT INTO organization_branding (organization_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ctx.orgId]);
      await c.query(`UPDATE organization_branding SET logo_text=CASE WHEN $2::boolean THEN $3 ELSE logo_text END, primary_color=COALESCE($4,primary_color), accent_color=COALESCE($5,accent_color),
        email_sender_name=CASE WHEN $6::boolean THEN $7 ELSE email_sender_name END, terminology=COALESCE($8,terminology), updated_at=now() WHERE organization_id=$1`,
        [ctx.orgId, b.logo_text !== undefined, b.logo_text ?? null, b.primary_color ?? null, b.accent_color ?? null, b.email_sender_name !== undefined, b.email_sender_name ?? null, b.terminology ? JSON.stringify(b.terminology) : null]);
      await audit(ctx, 'settings.branding_updated', { type: 'organization', id: ctx.orgId, label: b.name ?? ctx.org.name }, { ...beforeOrg, ...beforeB }, b, undefined, c);
    });
    return { ok: true };
  });
  app.post('/api/v1/settings/branding/logo', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const f = await req.file();
    if (!f) throw badRequest('Choose an image to upload');
    const ext = (f.filename.split('.').pop() ?? '').toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'svg', 'webp'].includes(ext)) throw badRequest('Logo must be a PNG, JPG, SVG or WebP image');
    const buf = await f.toBuffer();
    if (buf.length > 2 * 1024 * 1024) throw badRequest('Logo must be smaller than 2 MB');
    if (ext === 'svg' && /<script|on\w+=/i.test(buf.toString('utf8'))) throw badRequest('SVG logos cannot contain scripts');
    const prev = await one<any>(`SELECT logo_file FROM organization_branding WHERE organization_id=$1`, [ctx.orgId]);
    const rel = saveFile(`branding/${ctx.orgId}`, `logo.${ext}`, buf);
    await q(`UPDATE organization_branding SET logo_file=$2, updated_at=now() WHERE organization_id=$1`, [ctx.orgId, rel]);
    if (prev?.logo_file) deleteFile(prev.logo_file);
    await audit(ctx, 'settings.logo_uploaded', { type: 'organization', id: ctx.orgId, label: ctx.org.name }, { logo_file: prev?.logo_file ?? null }, { logo_file: rel });
    return { logo_url: signedUrl(rel, 86400) };
  });
  app.delete('/api/v1/settings/branding/logo', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const prev = await one<any>(`SELECT logo_file FROM organization_branding WHERE organization_id=$1`, [ctx.orgId]);
    await q(`UPDATE organization_branding SET logo_file=NULL, updated_at=now() WHERE organization_id=$1`, [ctx.orgId]);
    if (prev?.logo_file) deleteFile(prev.logo_file);
    await audit(ctx, 'settings.logo_removed', { type: 'organization', id: ctx.orgId, label: ctx.org.name });
    return { ok: true };
  });

  // ── White label (premium plan) ──
  app.patch('/api/v1/settings/white-label', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    if (!(await whiteLabelAllowed(ctx.orgId))) throw forbidden('White label is part of the White Label plan. Upgrade in Settings → Billing.');
    const b = z.object({ custom_domain: z.string().max(120).regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/i, 'Enter a domain like portal.youragency.com').nullable().optional(),
      hide_powered_by: z.boolean().optional(), support_email: z.string().email().nullable().optional(), support_phone: z.string().max(40).nullable().optional(), login_headline: z.string().max(120).nullable().optional() }).parse(req.body);
    const before = await one<any>(`SELECT custom_domain, domain_verified, hide_powered_by, support_email, support_phone, login_headline FROM organization_branding WHERE organization_id=$1`, [ctx.orgId]);
    const domainChanged = b.custom_domain !== undefined && (b.custom_domain ?? null) !== before?.custom_domain;
    await q(`UPDATE organization_branding SET
      custom_domain=CASE WHEN $2::boolean THEN lower($3) ELSE custom_domain END,
      domain_verified=CASE WHEN $4::boolean THEN false ELSE domain_verified END,
      domain_token=CASE WHEN $4::boolean THEN $5 ELSE domain_token END,
      domain_requested_at=CASE WHEN $4::boolean THEN now() ELSE domain_requested_at END,
      domain_checked_at=CASE WHEN $4::boolean THEN NULL ELSE domain_checked_at END,
      hide_powered_by=COALESCE($6, hide_powered_by),
      support_email=CASE WHEN $7::boolean THEN $8 ELSE support_email END, support_phone=CASE WHEN $9::boolean THEN $10 ELSE support_phone END,
      login_headline=CASE WHEN $11::boolean THEN $12 ELSE login_headline END, updated_at=now() WHERE organization_id=$1`,
      [ctx.orgId, b.custom_domain !== undefined, b.custom_domain ?? null, domainChanged, b.custom_domain ? `veyro-verify=${randomToken(12)}` : null, b.hide_powered_by ?? null,
        b.support_email !== undefined, b.support_email ?? null, b.support_phone !== undefined, b.support_phone ?? null, b.login_headline !== undefined, b.login_headline ?? null]);
    await audit(ctx, 'settings.white_label_updated', { type: 'organization', id: ctx.orgId, label: ctx.org.name }, before, b);
    return { ok: true };
  });
  // Simulated DNS check: the TXT record "propagates" ~20 seconds after the domain was saved.
  app.post('/api/v1/settings/white-label/verify-domain', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    if (!(await whiteLabelAllowed(ctx.orgId))) throw forbidden('White label is part of the White Label plan.');
    const b = await one<any>(`SELECT custom_domain, domain_token, domain_requested_at, domain_verified FROM organization_branding WHERE organization_id=$1`, [ctx.orgId]);
    if (!b?.custom_domain) throw badRequest('Save a custom domain first');
    if (b.domain_verified) return { verified: true, message: `${b.custom_domain} is verified` };
    const age = (Date.now() - new Date(b.domain_requested_at).getTime()) / 1000;
    await q(`UPDATE organization_branding SET domain_checked_at=now() WHERE organization_id=$1`, [ctx.orgId]);
    if (age < 20) {
      await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,'dns','warn',$2,$3)`, [ctx.orgId, `TXT record not found for _veyro.${b.custom_domain} yet`, JSON.stringify({ expected: b.domain_token })]);
      return { verified: false, message: `We could not find the TXT record on _veyro.${b.custom_domain} yet. DNS changes can take a few minutes — try again shortly.`, retry_in_sec: Math.ceil(20 - age) };
    }
    await q(`UPDATE organization_branding SET domain_verified=true WHERE organization_id=$1`, [ctx.orgId]);
    await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message) VALUES ($1,'dns','info',$2)`, [ctx.orgId, `Verified ${b.custom_domain}`]);
    await audit(ctx, 'settings.domain_verified', { type: 'organization', id: ctx.orgId, label: b.custom_domain });
    return { verified: true, message: `${b.custom_domain} is verified. Portals and emails will use this domain.` };
  });

  // ── Policy settings (portals, ai, time_tracking, payroll, invoice, security) ──
  app.get('/api/v1/settings/values/:key', async (req) => {
    const ctx = staff(req); settingsView(ctx);
    const { key } = req.params as any;
    if (!SETTING_SCHEMAS[key]) throw notFound();
    const value = await getSetting(ctx.orgId, key);
    const extra: Record<string, unknown> = {};
    if (key === 'ai') extra.integration = await one(`SELECT status, last_error, last_sync_at FROM integrations WHERE organization_id=$1 AND key='ai'`, [ctx.orgId]);
    if (key === 'invoice') extra.last_number = (await one<any>(`SELECT number FROM invoices WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1`, [ctx.orgId]).catch(() => null))?.number ?? null;
    if (key === 'payroll') extra.last_run = await one(`SELECT period_start, period_end, status FROM payroll_runs WHERE organization_id=$1 ORDER BY period_end DESC LIMIT 1`, [ctx.orgId]).catch(() => null);
    return { key, value, editable: can(ctx, 'settings', 'edit'), ...extra };
  });
  app.put('/api/v1/settings/values/:key', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const { key } = req.params as any;
    const schema = SETTING_SCHEMAS[key];
    if (!schema) throw notFound();
    const patch = schema.parse(req.body) as Record<string, unknown>;
    const before = await getSetting(ctx.orgId, key);
    const after = { ...before, ...patch };
    await setSetting(ctx.orgId, key, after);
    const changed = Object.keys(patch).filter(k => JSON.stringify((before as any)[k]) !== JSON.stringify(patch[k]));
    if (changed.length) await audit(ctx, `settings.${key}_updated`, { type: 'settings', id: key, label: key.replace('_', ' ') }, Object.fromEntries(changed.map(k => [k, (before as any)[k]])), Object.fromEntries(changed.map(k => [k, patch[k]])));
    if (key === 'ai' && 'simulate_failure' in patch) {
      await q(`UPDATE integrations SET status=$2, last_error=$3, updated_at=now() WHERE organization_id=$1 AND key='ai'`, [ctx.orgId, patch.simulate_failure ? 'error' : 'connected', patch.simulate_failure ? 'Simulated provider outage (Settings → AI)' : null]);
      await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message) VALUES ($1,'ai',$2,$3)`, [ctx.orgId, patch.simulate_failure ? 'error' : 'info', patch.simulate_failure ? 'Provider failure simulation turned on' : 'Provider failure simulation turned off — AI available']);
    }
    return { key, value: after };
  });

  // ── Onboarding templates ──
  app.get('/api/v1/settings/onboarding-templates', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'settings', 'view') && !can(ctx, 'onboarding', 'view')) throw notFound();
    const tpls = await q<any>(`SELECT t.*, c.name company_name FROM onboarding_templates t LEFT JOIN companies c ON c.id=t.company_id WHERE t.organization_id=$1 ORDER BY t.is_default DESC, t.scope, t.name`, [ctx.orgId]);
    const items = await q<any>(`SELECT * FROM onboarding_template_items WHERE organization_id=$1 ORDER BY sort, title`, [ctx.orgId]);
    return { rows: tpls.map(t => ({ ...t, items: items.filter(i => i.template_id === t.id) })), editable: can(ctx, 'settings', 'edit') };
  });
  app.post('/api/v1/settings/onboarding-templates', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const b = z.object({ name: z.string().min(2).max(100), scope: z.enum(['agency', 'client']).default('agency'), company_id: z.string().uuid().nullable().optional(), copy_from: z.string().uuid().optional() }).parse(req.body);
    if (b.scope === 'client') {
      if (!b.company_id) throw fieldError({ company_id: 'Choose the client' });
      if (!(await one(`SELECT 1 FROM companies WHERE id=$1 AND organization_id=$2`, [b.company_id, ctx.orgId]))) throw badRequest('Client not found');
    }
    const t = await tx(async (c) => {
      const t = (await c.query(`INSERT INTO onboarding_templates (organization_id, name, scope, company_id, is_default) VALUES ($1,$2,$3,$4,false) RETURNING *`, [ctx.orgId, b.name, b.scope, b.scope === 'client' ? b.company_id : null])).rows[0];
      if (b.copy_from) await c.query(`INSERT INTO onboarding_template_items (organization_id, template_id, title, required, owner, sort) SELECT organization_id, $3, title, required, owner, sort FROM onboarding_template_items WHERE template_id=$1 AND organization_id=$2`, [b.copy_from, ctx.orgId, t.id]);
      await audit(ctx, 'onboarding_template.created', { type: 'onboarding_template', id: t.id, label: t.name }, null, b, undefined, c);
      return t;
    });
    return t;
  });
  app.patch('/api/v1/settings/onboarding-templates/:id', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const t = await one<any>(`SELECT * FROM onboarding_templates WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!t) throw notFound();
    const b = z.object({ name: z.string().min(2).max(100).optional(), is_default: z.boolean().optional() }).parse(req.body);
    await tx(async (c) => {
      if (b.is_default) { if (t.scope !== 'agency') throw conflict('Only agency templates can be the default'); await c.query(`UPDATE onboarding_templates SET is_default=false WHERE organization_id=$1 AND scope='agency'`, [ctx.orgId]); }
      await c.query(`UPDATE onboarding_templates SET name=COALESCE($3,name), is_default=COALESCE($4,is_default) WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId, b.name ?? null, b.is_default ?? null]);
      await audit(ctx, 'onboarding_template.updated', { type: 'onboarding_template', id, label: b.name ?? t.name }, { name: t.name, is_default: t.is_default }, b, undefined, c);
    });
    return { ok: true };
  });
  app.delete('/api/v1/settings/onboarding-templates/:id', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const t = await one<any>(`SELECT * FROM onboarding_templates WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!t) throw notFound();
    if (t.is_default) throw conflict('Make another template the default before deleting this one');
    await q(`DELETE FROM onboarding_templates WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]);
    await audit(ctx, 'onboarding_template.deleted', { type: 'onboarding_template', id, label: t.name });
    return { ok: true };
  });
  app.post('/api/v1/settings/onboarding-templates/:id/items', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    if (!(await one(`SELECT 1 FROM onboarding_templates WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]))) throw notFound();
    const b = z.object({ title: z.string().min(2).max(200), required: z.boolean().default(true), owner: z.enum(['agency', 'worker', 'client']).default('agency') }).parse(req.body);
    const it = await one<any>(`INSERT INTO onboarding_template_items (organization_id, template_id, title, required, owner, sort) VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(max(sort),0)+1 FROM onboarding_template_items WHERE template_id=$2)) RETURNING *`, [ctx.orgId, id, b.title, b.required, b.owner]);
    await audit(ctx, 'onboarding_template.item_added', { type: 'onboarding_template', id, label: b.title }, null, b);
    return it;
  });
  app.patch('/api/v1/settings/onboarding-items/:id', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const b = z.object({ title: z.string().min(2).max(200).optional(), required: z.boolean().optional(), owner: z.enum(['agency', 'worker', 'client']).optional(), sort: z.number().int().optional() }).parse(req.body);
    const before = await one<any>(`SELECT * FROM onboarding_template_items WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!before) throw notFound();
    const it = await one<any>(`UPDATE onboarding_template_items SET title=COALESCE($3,title), required=COALESCE($4,required), owner=COALESCE($5,owner), sort=COALESCE($6,sort) WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, ctx.orgId, b.title ?? null, b.required ?? null, b.owner ?? null, b.sort ?? null]);
    await audit(ctx, 'onboarding_template.item_updated', { type: 'onboarding_template', id: before.template_id, label: it.title }, { title: before.title, required: before.required, owner: before.owner }, b);
    return it;
  });
  app.delete('/api/v1/settings/onboarding-items/:id', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const it = await one<any>(`DELETE FROM onboarding_template_items WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, ctx.orgId]); if (!it) throw notFound();
    await audit(ctx, 'onboarding_template.item_removed', { type: 'onboarding_template', id: it.template_id, label: it.title });
    return { ok: true };
  });

  // ── Equipment templates (settings-side CRUD; WORKFORCE reads the same table) ──
  app.get('/api/v1/settings/equipment', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'settings', 'view') && !can(ctx, 'placements', 'view')) throw notFound();
    const rows = await q<any>(`SELECT * FROM equipment_templates WHERE organization_id=$1 ORDER BY name`, [ctx.orgId]);
    return { rows, editable: can(ctx, 'settings', 'edit') };
  });
  const equipBody = z.object({ name: z.string().min(2).max(100), items: z.array(z.string().min(1).max(200)).min(1, 'Add at least one item').max(50) });
  app.post('/api/v1/settings/equipment', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const b = equipBody.parse(req.body);
    const r = await one<any>(`INSERT INTO equipment_templates (organization_id, name, items) VALUES ($1,$2,$3) RETURNING *`, [ctx.orgId, b.name, JSON.stringify(b.items)]);
    await audit(ctx, 'equipment_template.created', { type: 'equipment_template', id: r.id, label: r.name }, null, b);
    return r;
  });
  app.patch('/api/v1/settings/equipment/:id', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const before = await one<any>(`SELECT * FROM equipment_templates WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!before) throw notFound();
    const b = equipBody.partial().parse(req.body);
    const r = await one<any>(`UPDATE equipment_templates SET name=COALESCE($3,name), items=COALESCE($4,items) WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, ctx.orgId, b.name ?? null, b.items ? JSON.stringify(b.items) : null]);
    await audit(ctx, 'equipment_template.updated', { type: 'equipment_template', id, label: r.name }, { name: before.name, items: before.items }, b);
    return r;
  });
  app.delete('/api/v1/settings/equipment/:id', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const r = await one<any>(`DELETE FROM equipment_templates WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, ctx.orgId]); if (!r) throw notFound();
    await audit(ctx, 'equipment_template.deleted', { type: 'equipment_template', id, label: r.name }, { items: r.items }, null);
    return { ok: true };
  });

  // ── Monitoring policies ──
  app.get('/api/v1/settings/monitoring-policies', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'settings', 'view') && !can(ctx, 'placements', 'view')) throw notFound();
    const rows = await q<any>(`SELECT mp.*, (SELECT count(*)::int FROM placements p WHERE p.monitoring_policy_id=mp.id AND p.status <> 'ended') placements FROM monitoring_policies mp WHERE mp.organization_id=$1 ORDER BY mp.is_default DESC, mp.name`, [ctx.orgId]);
    return { rows, editable: can(ctx, 'settings', 'edit') };
  });
  const policyBody = z.object({ name: z.string().min(2).max(80), screenshots_enabled: z.boolean(), screenshot_interval_min: z.number().int().min(1).max(120), blur: z.boolean(), activity_tracking: z.boolean(), idle_minutes: z.number().int().min(1).max(120), retention_days: z.number().int().min(1).max(730), worker_delete_window_min: z.number().int().min(0).max(120), client_can_view: z.boolean() });
  app.post('/api/v1/settings/monitoring-policies', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const b = policyBody.parse(req.body);
    const r = await one<any>(`INSERT INTO monitoring_policies (organization_id, name, screenshots_enabled, screenshot_interval_min, blur, activity_tracking, idle_minutes, retention_days, worker_delete_window_min, client_can_view) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ctx.orgId, b.name, b.screenshots_enabled, b.screenshot_interval_min, b.blur, b.activity_tracking, b.idle_minutes, b.retention_days, b.worker_delete_window_min, b.client_can_view]);
    await audit(ctx, 'monitoring_policy.created', { type: 'monitoring_policy', id: r.id, label: r.name }, null, b);
    return r;
  });
  app.patch('/api/v1/settings/monitoring-policies/:id', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const before = await one<any>(`SELECT * FROM monitoring_policies WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!before) throw notFound();
    const b = policyBody.partial().parse(req.body);
    const cols = Object.keys(b);
    if (cols.length) await q(`UPDATE monitoring_policies SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId, ...cols.map(k => (b as any)[k])]);
    await audit(ctx, 'monitoring_policy.updated', { type: 'monitoring_policy', id, label: b.name ?? before.name }, Object.fromEntries(cols.map(k => [k, before[k]])), b);
    return one(`SELECT * FROM monitoring_policies WHERE id=$1`, [id]);
  });
  app.post('/api/v1/settings/monitoring-policies/:id/default', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const p = await one<any>(`SELECT * FROM monitoring_policies WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!p) throw notFound();
    await tx(async (c) => {
      await c.query(`UPDATE monitoring_policies SET is_default=(id=$2) WHERE organization_id=$1`, [ctx.orgId, id]);
      await audit(ctx, 'monitoring_policy.default_set', { type: 'monitoring_policy', id, label: p.name }, undefined, undefined, undefined, c);
    });
    return { ok: true };
  });
  app.delete('/api/v1/settings/monitoring-policies/:id', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const p = await one<any>(`SELECT mp.*, (SELECT count(*)::int FROM placements x WHERE x.monitoring_policy_id=mp.id) used FROM monitoring_policies mp WHERE mp.id=$1 AND mp.organization_id=$2`, [id, ctx.orgId]); if (!p) throw notFound();
    if (p.is_default) throw conflict('The default policy cannot be deleted');
    if (p.used) throw conflict(`${p.used} placement(s) use this policy. Move them to another policy first.`);
    await q(`DELETE FROM monitoring_policies WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]);
    await audit(ctx, 'monitoring_policy.deleted', { type: 'monitoring_policy', id, label: p.name });
    return { ok: true };
  });

  // ── Training modules (worker portal "Training") ──
  app.get('/api/v1/settings/training', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'settings', 'view') && !can(ctx, 'onboarding', 'view')) throw notFound();
    const active = await one<any>(`SELECT count(*)::int n FROM workers WHERE organization_id=$1 AND status IN ('active','on_leave','pending')`, [ctx.orgId]);
    const rows = await q<any>(`SELECT m.*, u.name created_by_name, (SELECT count(*)::int FROM training_progress p WHERE p.module_id=m.id AND p.status='completed') completed, (SELECT count(*)::int FROM training_progress p WHERE p.module_id=m.id AND p.status='in_progress') in_progress
      FROM training_modules m LEFT JOIN users u ON u.id=m.created_by WHERE m.organization_id=$1 ORDER BY m.sort, m.created_at`, [ctx.orgId]);
    return { rows, workers: active.n, editable: can(ctx, 'settings', 'edit') || can(ctx, 'onboarding', 'edit') };
  });
  app.get('/api/v1/settings/training/:id/progress', async (req) => {
    const ctx = staff(req);
    if (!can(ctx, 'settings', 'view') && !can(ctx, 'onboarding', 'view')) throw notFound();
    const id = idParam(req);
    if (!(await one(`SELECT 1 FROM training_modules WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]))) throw notFound();
    return q(`SELECT w.id worker_id, c.first_name, c.last_name, w.status worker_status, p.status, p.started_at, p.completed_at FROM workers w JOIN candidates c ON c.id=w.candidate_id
      LEFT JOIN training_progress p ON p.worker_id=w.id AND p.module_id=$2 WHERE w.organization_id=$1 AND w.status IN ('active','on_leave','pending') ORDER BY p.completed_at DESC NULLS LAST, c.first_name`, [ctx.orgId, id]);
  });
  const trainingBody = z.object({ title: z.string().min(2).max(140), description: z.string().max(500).nullable().optional(), content: z.string().max(20000).nullable().optional(), kind: z.enum(['reading', 'video', 'quiz', 'policy']).default('reading'), url: z.string().url().nullable().optional().or(z.literal('')), required: z.boolean().default(false), duration_min: z.number().int().min(1).max(600).default(10), active: z.boolean().default(true) });
  const trainingEdit = (ctx: Ctx) => { if (!can(ctx, 'settings', 'edit') && !can(ctx, 'onboarding', 'edit')) throw forbidden(`Your role (${ctx.role.name}) cannot manage training`); };
  app.post('/api/v1/settings/training', async (req) => {
    const ctx = staff(req); trainingEdit(ctx);
    const b = trainingBody.parse(req.body);
    const r = await one<any>(`INSERT INTO training_modules (organization_id, title, description, content, kind, url, required, duration_min, active, created_by, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT COALESCE(max(sort),0)+1 FROM training_modules WHERE organization_id=$1)) RETURNING *`,
      [ctx.orgId, b.title, b.description ?? null, b.content ?? null, b.kind, b.url || null, b.required, b.duration_min, b.active, ctx.userId]);
    await audit(ctx, 'training.created', { type: 'training_module', id: r.id, label: r.title }, null, { required: b.required, kind: b.kind });
    return r;
  });
  app.patch('/api/v1/settings/training/:id', async (req) => {
    const ctx = staff(req); trainingEdit(ctx);
    const id = idParam(req);
    const before = await one<any>(`SELECT * FROM training_modules WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!before) throw notFound();
    const b = trainingBody.partial().extend({ sort: z.number().int().optional() }).parse(req.body);
    const cols = Object.keys(b);
    if (cols.length) await q(`UPDATE training_modules SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')}, updated_at=now() WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId, ...cols.map(k => (k === 'url' ? ((b as any)[k] || null) : (b as any)[k]))]);
    await audit(ctx, 'training.updated', { type: 'training_module', id, label: b.title ?? before.title }, Object.fromEntries(cols.filter(k => k !== 'content').map(k => [k, before[k]])), Object.fromEntries(cols.filter(k => k !== 'content').map(k => [k, (b as any)[k]])));
    return one(`SELECT * FROM training_modules WHERE id=$1`, [id]);
  });
  app.delete('/api/v1/settings/training/:id', async (req) => {
    const ctx = staff(req); trainingEdit(ctx);
    const id = idParam(req);
    const r = await one<any>(`DELETE FROM training_modules WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, ctx.orgId]); if (!r) throw notFound();
    await audit(ctx, 'training.deleted', { type: 'training_module', id, label: r.title });
    return { ok: true };
  });

  // ── Notifications: admin event subscriptions (notification_preferences.subscribed) ──
  app.get('/api/v1/settings/notifications', async (req) => {
    const ctx = staff(req); settingsView(ctx);
    const members = await q<any>(`SELECT u.id, u.name, u.email, r.name role_name, r.key role_key FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.kind='agency' ORDER BY (r.key IN ('owner','admin')) DESC, u.name`, [ctx.orgId]);
    const subs = await q<any>(`SELECT user_id, event FROM notification_preferences WHERE organization_id=$1 AND subscribed`, [ctx.orgId]);
    const zero = await q<any>(`SELECT message, meta, created_at FROM integration_logs WHERE organization_id=$1 AND integration_key='notifications' ORDER BY created_at DESC LIMIT 20`, [ctx.orgId]);
    const counts = await q<any>(`SELECT event, count(*)::int n FROM notifications WHERE organization_id=$1 AND created_at > now() - interval '30 days' GROUP BY event`, [ctx.orgId]);
    return { events: EVENT_CATALOG, members, subscriptions: subs.map(s => `${s.user_id}:${s.event}`), zero_recipient: zero, counts_30d: Object.fromEntries(counts.map(c => [c.event, c.n])), editable: can(ctx, 'settings', 'edit') };
  });
  app.put('/api/v1/settings/notifications', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const b = z.object({ changes: z.array(z.object({ user_id: z.string().uuid(), event: z.string().max(60), subscribed: z.boolean() })).min(1).max(500) }).parse(req.body);
    const valid = new Set((await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.kind='agency'`, [ctx.orgId])).map(r => r.user_id));
    const events = new Set(EVENT_CATALOG.map(e => e.key));
    let n = 0;
    await tx(async (c) => {
      for (const ch of b.changes) {
        if (!valid.has(ch.user_id) || !events.has(ch.event)) continue;
        await c.query(`INSERT INTO notification_preferences (user_id, organization_id, event, subscribed) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, organization_id, event) DO UPDATE SET subscribed=EXCLUDED.subscribed`, [ch.user_id, ctx.orgId, ch.event, ch.subscribed]);
        n++;
      }
      await audit(ctx, 'settings.notification_subscriptions_updated', { type: 'settings', id: 'notifications', label: `${n} subscription change(s)` }, null, b.changes.slice(0, 50), undefined, c);
    });
    return { ok: true, changed: n };
  });

  // ── Custom fields (definitions + values) ──
  app.get('/api/v1/custom-fields', async (req) => {
    const ctx = staff(req);
    const { entity } = req.query as any;
    const params: unknown[] = [ctx.orgId];
    let w = '';
    if (entity) { params.push(entity); w = `AND d.entity=$2`; }
    const rows = await q<any>(`SELECT d.*, (SELECT count(*)::int FROM custom_field_values v WHERE v.field_id=d.id AND v.value IS NOT NULL AND v.value <> '') used FROM custom_field_definitions d WHERE d.organization_id=$1 ${w} ORDER BY d.entity, d.sort, d.created_at`, params);
    return { rows, entities: Object.entries(ENTITY_MAP).map(([key, v]) => ({ key, label: v.label })), editable: can(ctx, 'settings', 'edit') };
  });
  const cfBody = z.object({ entity: z.enum(Object.keys(ENTITY_MAP) as [string, ...string[]]), label: z.string().min(1).max(60), key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Lowercase letters, numbers and underscores').optional(),
    type: z.enum(['text', 'number', 'date', 'select', 'boolean']), options: z.array(z.string().min(1).max(60)).max(50).default([]), required: z.boolean().default(false), filterable: z.boolean().default(true) });
  app.post('/api/v1/custom-fields', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const b = cfBody.parse(req.body);
    if (b.type === 'select' && b.options.length < 2) throw fieldError({ options: 'Add at least two options' });
    const key = b.key ?? b.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40);
    if (await one(`SELECT 1 FROM custom_field_definitions WHERE organization_id=$1 AND entity=$2 AND key=$3`, [ctx.orgId, b.entity, key])) throw conflict(`A ${b.entity} field with key "${key}" already exists`);
    const r = await one<any>(`INSERT INTO custom_field_definitions (organization_id, entity, key, label, type, options, required, filterable, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT COALESCE(max(sort),0)+1 FROM custom_field_definitions WHERE organization_id=$1 AND entity=$2)) RETURNING *`,
      [ctx.orgId, b.entity, key, b.label, b.type, b.type === 'select' ? b.options : [], b.required, b.filterable]);
    await audit(ctx, 'custom_field.created', { type: 'custom_field', id: r.id, label: `${b.entity}.${key}` }, null, b);
    return r;
  });
  app.patch('/api/v1/custom-fields/:id', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const before = await one<any>(`SELECT * FROM custom_field_definitions WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]); if (!before) throw notFound();
    const b = z.object({ label: z.string().min(1).max(60).optional(), options: z.array(z.string().min(1).max(60)).max(50).optional(), required: z.boolean().optional(), filterable: z.boolean().optional(), sort: z.number().int().optional() }).parse(req.body);
    if (b.options && before.type === 'select' && b.options.length < 2) throw fieldError({ options: 'Add at least two options' });
    const r = await one<any>(`UPDATE custom_field_definitions SET label=COALESCE($3,label), options=COALESCE($4,options), required=COALESCE($5,required), filterable=COALESCE($6,filterable), sort=COALESCE($7,sort) WHERE id=$1 AND organization_id=$2 RETURNING *`,
      [id, ctx.orgId, b.label ?? null, before.type === 'select' ? b.options ?? null : null, b.required ?? null, b.filterable ?? null, b.sort ?? null]);
    await audit(ctx, 'custom_field.updated', { type: 'custom_field', id, label: `${before.entity}.${before.key}` }, { label: before.label, options: before.options, required: before.required, filterable: before.filterable }, b);
    return r;
  });
  app.delete('/api/v1/custom-fields/:id', async (req) => {
    const ctx = staff(req); settingsEdit(ctx);
    const id = idParam(req);
    const d = await one<any>(`SELECT d.*, (SELECT count(*)::int FROM custom_field_values v WHERE v.field_id=d.id) n FROM custom_field_definitions d WHERE d.id=$1 AND d.organization_id=$2`, [id, ctx.orgId]); if (!d) throw notFound();
    await q(`DELETE FROM custom_field_definitions WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]);
    await audit(ctx, 'custom_field.deleted', { type: 'custom_field', id, label: `${d.entity}.${d.key}` }, { label: d.label, values_deleted: d.n }, null);
    return { ok: true, values_deleted: d.n };
  });

  async function entityGuard(ctx: Ctx, entity: string, id: string, action: 'view' | 'edit') {
    const m = ENTITY_MAP[entity]; if (!m || !isUuid(id)) throw notFound();
    if (!m.resources.some(r => can(ctx, r, action))) { if (action === 'view') throw notFound(); throw forbidden(`Your role (${ctx.role.name}) cannot edit ${m.label.toLowerCase()}`); }
    if (!(await one(`SELECT 1 FROM ${m.table} WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId]))) throw notFound();
  }
  app.get('/api/v1/custom-fields/values/:entity/:id', async (req) => {
    const ctx = staff(req);
    const { entity, id } = req.params as any;
    await entityGuard(ctx, entity, id, 'view');
    const defs = await q<any>(`SELECT d.id, d.key, d.label, d.type, d.options, d.required, d.filterable, v.value FROM custom_field_definitions d LEFT JOIN custom_field_values v ON v.field_id=d.id AND v.entity_id=$3 WHERE d.organization_id=$1 AND d.entity=$2 ORDER BY d.sort, d.created_at`, [ctx.orgId, entity, id]);
    const m = ENTITY_MAP[entity];
    return { fields: defs, editable: m.resources.some(r => can(ctx, r, 'edit')) };
  });
  app.put('/api/v1/custom-fields/values/:entity/:id', async (req) => {
    const ctx = staff(req);
    const { entity, id } = req.params as any;
    await entityGuard(ctx, entity, id, 'edit');
    const b = z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).parse(req.body);
    const defs = await q<any>(`SELECT d.*, v.value current FROM custom_field_definitions d LEFT JOIN custom_field_values v ON v.field_id=d.id AND v.entity_id=$3 WHERE d.organization_id=$1 AND d.entity=$2`, [ctx.orgId, entity, id]);
    const fields: Record<string, string> = {};
    const writes: { d: any; v: string | null }[] = [];
    for (const d of defs) {
      if (!(d.id in b.values) && !(d.key in b.values)) { if (d.required && (d.current === null || d.current === undefined || d.current === '')) fields[d.key] = `${d.label} is required`; continue; }
      const raw = d.id in b.values ? b.values[d.id] : b.values[d.key];
      let v: string | null = raw === null || raw === undefined || raw === '' ? null : String(raw);
      if (v === null) { if (d.required) fields[d.key] = `${d.label} is required`; }
      else if (d.type === 'number' && !Number.isFinite(Number(v))) fields[d.key] = 'Enter a number';
      else if (d.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) fields[d.key] = 'Enter a date (YYYY-MM-DD)';
      else if (d.type === 'boolean') v = ['true', '1', 'yes'].includes(v.toLowerCase()) ? 'true' : 'false';
      else if (d.type === 'select' && !d.options.includes(v)) fields[d.key] = `Choose one of: ${d.options.join(', ')}`;
      writes.push({ d, v });
    }
    if (Object.keys(fields).length) throw fieldError(fields);
    const changed = writes.filter(w => (w.d.current ?? null) !== w.v);
    await tx(async (c) => {
      for (const w of changed) await c.query(`INSERT INTO custom_field_values (organization_id, field_id, entity_id, value) VALUES ($1,$2,$3,$4) ON CONFLICT (field_id, entity_id) DO UPDATE SET value=EXCLUDED.value`, [ctx.orgId, w.d.id, id, w.v]);
      if (changed.length) await c.query(`INSERT INTO activities (organization_id, entity_type, entity_id, kind, title, body, actor_id) VALUES ($1,$2,$3,'update','Updated custom fields',$4,$5)`, [ctx.orgId, entity, id, changed.map(w => `${w.d.label}: ${w.v ?? '—'}`).join('\n'), ctx.userId]);
    });
    return { ok: true, changed: changed.length };
  });
  // For list filters: ids of records whose custom field equals a value.
  app.get('/api/v1/custom-fields/match', async (req) => {
    const ctx = staff(req);
    const { entity, key, value } = req.query as any;
    const m = ENTITY_MAP[entity]; if (!m || !key) throw notFound();
    if (!m.resources.some(r => can(ctx, r, 'view'))) throw notFound();
    const rows = await q<any>(`SELECT v.entity_id FROM custom_field_values v JOIN custom_field_definitions d ON d.id=v.field_id WHERE d.organization_id=$1 AND d.entity=$2 AND d.key=$3 AND v.value=$4`, [ctx.orgId, entity, key, String(value ?? '')]);
    return { ids: rows.map(r => r.entity_id) };
  });
}
