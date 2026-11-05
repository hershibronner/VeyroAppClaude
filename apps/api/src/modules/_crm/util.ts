// Shared CRM helpers (not auto-loaded: folder starts with "_").
import { z, ZodError } from 'zod';
import { q, one, type Db, pool } from '../../core/db';
import { scopeOf, type Ctx } from '../../core/context';
import { forbidden, notFound } from '../../core/errors';
import type { Resource } from '@veyro/shared';

export const LEAD_SOURCES = ['Website', 'Referral', 'LinkedIn', 'Cold Outreach', 'Event', 'Ads', 'Partner'] as const;
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'converted'] as const;
export const OPP_STAGES = ['new', 'discovery', 'proposal', 'negotiation', 'won', 'lost'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export const CLIENT_ROLE_KEYS = ['client_owner', 'client_manager', 'client_supervisor', 'client_finance', 'client_viewer'] as const;

/** Throws a 400 with an inline field error (rendered next to the field by FormDrawer). */
export function fieldError(field: string, message: string): never {
  throw new ZodError([{ code: 'custom', path: field.split('.'), message }]);
}

/** Optional string that turns "" into null. */
export const optStr = (max = 500) => z.preprocess(v => (v === '' ? null : v), z.string().trim().max(max).nullable().optional());
export const optEmail = z.preprocess(v => (v === '' ? null : v), z.string().trim().email('Enter a valid email').max(200).nullable().optional());
export const optDate = z.preprocess(v => (v === '' ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional());
export const optUuid = z.preprocess(v => (v === '' ? null : v), z.string().uuid().nullable().optional());
export const optInt = (min = 0, max = 1_000_000) => z.preprocess(v => (v === '' || v === undefined ? undefined : v === null ? null : Number(v)), z.number().int().min(min).max(max).nullable().optional());
export const optCents = z.preprocess(v => (v === '' || v === undefined ? undefined : v === null ? null : Number(v)), z.number().int().min(0).max(1_000_000_000_00).nullable().optional());

export function isUuid(s: unknown): s is string { return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s); }

/** Validates that a user id is an active staff member of this org (never trust ids from the browser). */
export async function assertMember(ctx: Ctx, userId: string | null | undefined, field = 'owner_id', db: Db = pool) {
  if (!userId) return;
  const m = await one(`SELECT 1 FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='active' AND r.kind='agency'`, [ctx.orgId, userId], db);
  if (!m) fieldError(field, 'Not a member of this workspace');
}
export async function assertMembers(ctx: Ctx, ids: string[], db: Db = pool) {
  if (!ids.length) return;
  const rows = await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.user_id = ANY($2) AND m.status='active' AND r.kind='agency'`, [ctx.orgId, ids], db);
  if (rows.length !== new Set(ids).size) fieldError('assignee_ids', 'Pick members of this workspace');
}

/** Loads a tenant company row or 404. */
export async function companyOr404(ctx: Ctx, id: string, db: Db = pool) {
  if (!isUuid(id)) throw notFound();
  const c = await one<any>(`SELECT * FROM companies WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId], db);
  if (!c) throw notFound();
  return c;
}
/** Lead pipeline vs client resource for permissions. */
export function companyResource(c: { stage: string }): Resource { return c.stage === 'lead' || c.stage === 'qualified' ? 'leads' : 'clients'; }

/** Enforces a delete/edit scope ('own' = the user owns or created the record). */
export function assertScope(ctx: Ctx, resource: Resource, action: 'delete' | 'edit' | 'view', row: { owner_id?: string | null; created_by?: string | null }, assigned = false) {
  const s = scopeOf(ctx, resource, action);
  if (s === 'none') throw action === 'view' ? notFound() : forbidden(`Your role (${ctx.role.name}) cannot ${action} ${resource}`);
  if (s === 'own' && row.owner_id !== ctx.userId && row.created_by !== ctx.userId && !assigned) throw forbidden(`You can only ${action} ${resource} you own`);
}
export const isOwnerAdmin = (ctx: Ctx) => ['owner', 'admin'].includes(ctx.role.key);

export function domainOf(url: string | null | undefined) {
  if (!url) return null;
  const s = url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return s || null;
}
export function normalizeWebsite(url: string | null | undefined) {
  if (!url) return null;
  const t = url.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

/** Display label + web link for any related record type (tasks, activities). */
export const RELATED_TYPES = ['company', 'contact', 'opportunity', 'position', 'candidate', 'placement', 'invoice', 'worker'] as const;
export const relatedLabelSql = (typeCol: string, idCol: string) => `CASE ${typeCol}
  WHEN 'company' THEN (SELECT name FROM companies WHERE id=${idCol})
  WHEN 'contact' THEN (SELECT concat_ws(' ', first_name, last_name) FROM contacts WHERE id=${idCol})
  WHEN 'opportunity' THEN (SELECT name FROM opportunities WHERE id=${idCol})
  WHEN 'position' THEN (SELECT title FROM positions WHERE id=${idCol})
  WHEN 'candidate' THEN (SELECT concat_ws(' ', first_name, last_name) FROM candidates WHERE id=${idCol})
  WHEN 'placement' THEN (SELECT concat_ws(' — ', concat_ws(' ', ca.first_name, ca.last_name), p.title) FROM placements p JOIN workers w ON w.id=p.worker_id JOIN candidates ca ON ca.id=w.candidate_id WHERE p.id=${idCol})
  WHEN 'worker' THEN (SELECT concat_ws(' ', ca.first_name, ca.last_name) FROM workers w JOIN candidates ca ON ca.id=w.candidate_id WHERE w.id=${idCol})
  WHEN 'invoice' THEN (SELECT 'Invoice ' || number FROM invoices WHERE id=${idCol})
  WHEN 'task' THEN (SELECT title FROM tasks WHERE id=${idCol})
  WHEN 'interview' THEN (SELECT 'Interview' FROM interviews WHERE id=${idCol})
  WHEN 'offer' THEN (SELECT 'Offer' FROM offers WHERE id=${idCol})
  WHEN 'timesheet' THEN (SELECT 'Timesheet week of ' || to_char(week_start, 'Mon DD') FROM timesheets WHERE id=${idCol})
  WHEN 'payroll_run' THEN (SELECT 'Payroll run ' || to_char(period_start, 'Mon DD') FROM payroll_runs WHERE id=${idCol})
  WHEN 'document' THEN (SELECT name FROM documents WHERE id=${idCol})
  WHEN 'submission' THEN (SELECT 'Submission' FROM candidate_submissions WHERE id=${idCol})
  ELSE NULL END`;
export const relatedStageSql = (typeCol: string, idCol: string) => `CASE WHEN ${typeCol}='company' THEN (SELECT stage FROM companies WHERE id=${idCol}) END`;

/** Which permission resource governs visibility of an activity/task's related entity. */
export const ENTITY_RESOURCE: Record<string, Resource> = {
  company: 'clients', contact: 'contacts', opportunity: 'opportunities', position: 'positions', candidate: 'candidates', placement: 'placements', worker: 'workers',
  invoice: 'invoices', task: 'tasks', payroll_run: 'payroll', offer: 'offers', interview: 'interviews', submission: 'submissions', timesheet: 'timesheets', document: 'documents',
};
/** Validates that a related record exists in this org. */
const REL_TABLE: Record<string, string> = { company: 'companies', contact: 'contacts', opportunity: 'opportunities', position: 'positions', candidate: 'candidates', placement: 'placements', invoice: 'invoices', worker: 'workers' };
export async function assertRelated(ctx: Ctx, type: string | null | undefined, id: string | null | undefined, db: Db = pool) {
  if (!type && !id) return;
  if (!type || !id || !REL_TABLE[type]) fieldError('related_id', 'Pick a related record');
  const r = await one(`SELECT 1 FROM ${REL_TABLE[type]} WHERE id=$1 AND organization_id=$2`, [id, ctx.orgId], db);
  if (!r) fieldError('related_id', 'Not found in this workspace');
}

/** Keeps contacts.email/phone in sync with their primary contact methods. */
export async function syncContactPrimary(contactId: string, db: Db = pool) {
  await q(`UPDATE contacts c SET
    email = (SELECT value FROM contact_methods WHERE contact_id=c.id AND kind='email' ORDER BY is_primary DESC, created_at LIMIT 1),
    phone = (SELECT value FROM contact_methods WHERE contact_id=c.id AND kind IN ('phone','whatsapp') ORDER BY (kind='phone') DESC, is_primary DESC, created_at LIMIT 1),
    updated_at = now() WHERE c.id=$1`, [contactId], db);
}

/** Inserts a contact with its methods and company link. */
export async function insertContact(ctx: Ctx, c: { company_id?: string | null; first_name: string; last_name?: string | null; title?: string | null; email?: string | null; phone?: string | null; is_primary?: boolean; notes?: string | null; methods?: { kind: string; value: string; label?: string | null; is_primary?: boolean }[] }, db: Db) {
  const row = (await db.query(`INSERT INTO contacts (organization_id, company_id, first_name, last_name, title, email, phone, is_primary, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ctx.orgId, c.company_id ?? null, c.first_name, c.last_name ?? null, c.title ?? null, c.email ?? null, c.phone ?? null, !!c.is_primary, c.notes ?? null, ctx.userId])).rows[0];
  const methods = [...(c.methods ?? [])];
  if (c.email && !methods.some(m => m.kind === 'email' && m.value.toLowerCase() === c.email!.toLowerCase())) methods.unshift({ kind: 'email', value: c.email, label: 'Work', is_primary: true });
  if (c.phone && !methods.some(m => m.kind !== 'email' && m.value === c.phone)) methods.push({ kind: 'phone', value: c.phone, label: 'Work', is_primary: true });
  const seenPrimary = new Set<string>();
  for (const m of methods) {
    const k = m.kind === 'email' ? 'email' : 'phone';
    const prim = !!m.is_primary && !seenPrimary.has(k);
    if (prim) seenPrimary.add(k);
    await db.query(`INSERT INTO contact_methods (organization_id, contact_id, kind, value, label, is_primary) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.orgId, row.id, m.kind, m.value.trim(), m.label ?? null, prim]);
  }
  if (c.company_id) {
    await db.query(`INSERT INTO company_contacts (organization_id, company_id, contact_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [ctx.orgId, c.company_id, row.id, c.title ?? null]);
    if (c.is_primary) await db.query(`UPDATE contacts SET is_primary=false WHERE company_id=$1 AND id<>$2 AND organization_id=$3`, [c.company_id, row.id, ctx.orgId]);
  }
  await syncContactPrimary(row.id, db);
  return row;
}

/** Recent month buckets (labels like "Jun") ending this month. */
export function monthBuckets(n: number) {
  const out: { key: string; label: string }[] = [];
  const d = new Date(); d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ key: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`, label: x.toLocaleString('en-US', { month: 'short' }) });
  }
  return out;
}
export function pctDelta(curr: number, prev: number) { return prev ? Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10 : null; }
