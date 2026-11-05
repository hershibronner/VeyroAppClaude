// Import Center entity definitions: target fields, row mapping/validation, duplicate detection, and apply (create/update).
import type { PoolClient } from '@veyro/db';
import { normalizeEmail, normalizePhone, domainOf, normalizeCompanyName, planRateInsert } from '@veyro/shared';
import { q, one, type Db } from '../../core/db';

export type FieldType = 'text' | 'email' | 'phone' | 'number' | 'money' | 'date' | 'enum' | 'list' | 'bool' | 'user';
export interface TargetField { key: string; label: string; type: FieldType; required?: boolean; options?: string[]; aliases?: string[]; hint?: string }
export interface EntityDef { key: string; label: string; fields: TargetField[]; dupeKeys: string; allowUpdate: boolean }

const LEGACY: TargetField = { key: 'legacy_id', label: 'Legacy / external ID', type: 'text', aliases: ['external id', 'external_id', 'legacy id', 'id', 'old id', 'source id'], hint: 'Preserved on the record; re-importing the same ID updates instead of duplicating' };
const COMPANY_FIELDS: TargetField[] = [
  { key: 'name', label: 'Company name', type: 'text', required: true, aliases: ['company', 'company name', 'account', 'organization', 'business'] },
  { key: 'website', label: 'Website', type: 'text', aliases: ['url', 'site', 'web'] },
  { key: 'domain', label: 'Domain', type: 'text' },
  { key: 'industry', label: 'Industry', type: 'text', aliases: ['sector', 'vertical'] },
  { key: 'size', label: 'Company size', type: 'text', aliases: ['employees', 'headcount'] },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'phone', aliases: ['telephone', 'main phone'] },
  { key: 'email', label: 'Email', type: 'email', aliases: ['main email', 'company email'] },
  { key: 'address', label: 'Address', type: 'text', aliases: ['street', 'location', 'city'] },
];
export const ENTITIES: Record<string, EntityDef> = {
  leads: { key: 'leads', label: 'Leads', dupeKeys: 'legacy ID, domain, company name', allowUpdate: true, fields: [...COMPANY_FIELDS,
    { key: 'lead_status', label: 'Lead status', type: 'enum', options: ['new', 'contacted', 'qualified', 'unqualified'], aliases: ['status', 'stage'] },
    { key: 'source', label: 'Source', type: 'text', aliases: ['lead source', 'channel'] }, { key: 'campaign', label: 'Campaign', type: 'text' },
    { key: 'est_workers', label: 'Estimated workers', type: 'number', aliases: ['seats', 'workers needed'] },
    { key: 'owner_email', label: 'Owner (staff email)', type: 'user', aliases: ['owner', 'sales rep', 'assigned to'] }, { key: 'notes', label: 'Notes', type: 'text' }, LEGACY] },
  clients: { key: 'clients', label: 'Clients', dupeKeys: 'legacy ID, domain, company name', allowUpdate: true, fields: [...COMPANY_FIELDS,
    { key: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', aliases: ['terms', 'net days'] },
    { key: 'timesheet_approval', label: 'Timesheet approval', type: 'enum', options: ['agency', 'client', 'both'] },
    { key: 'account_manager_email', label: 'Account manager (staff email)', type: 'user', aliases: ['account manager', 'am'] }, { key: 'notes', label: 'Notes', type: 'text' }, LEGACY] },
  contacts: { key: 'contacts', label: 'Contacts', dupeKeys: 'legacy ID, email, phone', allowUpdate: true, fields: [
    { key: 'first_name', label: 'First name', type: 'text', required: true, aliases: ['first', 'given name', 'firstname'] }, { key: 'last_name', label: 'Last name', type: 'text', aliases: ['last', 'surname', 'lastname', 'family name'] },
    { key: 'email', label: 'Email', type: 'email', aliases: ['email address', 'e-mail'] }, { key: 'phone', label: 'Phone', type: 'phone', aliases: ['mobile', 'cell', 'telephone'] },
    { key: 'title', label: 'Job title', type: 'text', aliases: ['position', 'role', 'job title'] },
    { key: 'company_name', label: 'Company name', type: 'text', aliases: ['company', 'account', 'organization'], hint: 'Matched to an existing lead/client by legacy ID, domain or name' },
    { key: 'company_legacy_id', label: 'Company legacy ID', type: 'text', aliases: ['company id', 'account id'] },
    { key: 'is_primary', label: 'Primary contact', type: 'bool', aliases: ['primary'] }, LEGACY] },
  candidates: { key: 'candidates', label: 'Candidates', dupeKeys: 'legacy ID, email, phone', allowUpdate: true, fields: [
    { key: 'first_name', label: 'First name', type: 'text', required: true, aliases: ['first', 'given name', 'firstname'] }, { key: 'last_name', label: 'Last name', type: 'text', aliases: ['last', 'surname', 'lastname'] },
    { key: 'email', label: 'Email', type: 'email', aliases: ['email address', 'e-mail'] }, { key: 'phone', label: 'Phone', type: 'phone', aliases: ['mobile', 'whatsapp', 'cell'] },
    { key: 'country', label: 'Country', type: 'text' }, { key: 'city', label: 'City', type: 'text' }, { key: 'timezone', label: 'Time zone', type: 'text', aliases: ['tz'] },
    { key: 'headline', label: 'Headline', type: 'text', aliases: ['title', 'current title', 'role'] }, { key: 'years_experience', label: 'Years of experience', type: 'number', aliases: ['experience', 'years'] },
    { key: 'skills', label: 'Skills (; separated)', type: 'list', aliases: ['skill set'] }, { key: 'languages', label: 'Languages (; separated)', type: 'list' },
    { key: 'rate_min', label: 'Minimum rate (USD/hour)', type: 'money', aliases: ['min rate', 'rate min'] }, { key: 'rate_target', label: 'Target rate (USD/hour)', type: 'money', aliases: ['rate', 'expected rate', 'target rate'] },
    { key: 'source', label: 'Source', type: 'text' }, { key: 'status', label: 'Status', type: 'enum', options: ['new_applicant', 'screening', 'qualified', 'talent_pool', 'on_hold', 'future'] }, LEGACY] },
  workers: { key: 'workers', label: 'Workers', dupeKeys: 'legacy ID, email', allowUpdate: true, fields: [
    { key: 'first_name', label: 'First name', type: 'text', required: true, aliases: ['first', 'firstname'] }, { key: 'last_name', label: 'Last name', type: 'text', aliases: ['last', 'surname', 'lastname'] },
    { key: 'email', label: 'Email', type: 'email', required: true, aliases: ['email address'] }, { key: 'phone', label: 'Phone', type: 'phone' }, { key: 'country', label: 'Country', type: 'text' },
    { key: 'status', label: 'Worker status', type: 'enum', options: ['pending', 'active', 'available', 'on_leave', 'inactive'] }, { key: 'employee_code', label: 'Employee code', type: 'text', aliases: ['employee id', 'code'] },
    { key: 'payout_method', label: 'Payout method', type: 'enum', options: ['wise', 'bank', 'paypal', 'payoneer'] }, { key: 'payout_account_label', label: 'Payout account label', type: 'text', hint: 'A label like "Wise •••• 4821" — never full account numbers' }, LEGACY] },
  placements: { key: 'placements', label: 'Placements', dupeKeys: 'legacy ID, worker + client + start date', allowUpdate: false, fields: [
    { key: 'worker_email', label: 'Worker email', type: 'email', aliases: ['worker', 'email'] }, { key: 'worker_legacy_id', label: 'Worker legacy ID', type: 'text' },
    { key: 'company_name', label: 'Client name', type: 'text', aliases: ['client', 'company'] }, { key: 'company_legacy_id', label: 'Client legacy ID', type: 'text' },
    { key: 'title', label: 'Role title', type: 'text', required: true, aliases: ['role', 'position', 'job title'] }, { key: 'start_date', label: 'Start date', type: 'date', required: true, aliases: ['start'] },
    { key: 'end_date', label: 'End date', type: 'date', aliases: ['end'] }, { key: 'status', label: 'Status', type: 'enum', options: ['onboarding', 'active', 'on_leave', 'ended'] },
    { key: 'weekly_hours', label: 'Weekly hours', type: 'number', aliases: ['hours'] }, { key: 'timezone', label: 'Time zone', type: 'text' },
    { key: 'pay_rate', label: 'Pay rate (per hour)', type: 'money', required: true, aliases: ['pay', 'pay rate'] }, { key: 'bill_rate', label: 'Bill rate (per hour)', type: 'money', required: true, aliases: ['bill', 'bill rate'] },
    { key: 'currency', label: 'Currency', type: 'text' }, LEGACY] },
  rates: { key: 'rates', label: 'Rates', dupeKeys: 'legacy ID, placement + effective date', allowUpdate: false, fields: [
    { key: 'placement_legacy_id', label: 'Placement legacy ID', type: 'text', aliases: ['placement id', 'placement'] }, { key: 'worker_email', label: 'Worker email', type: 'email', aliases: ['worker', 'email'] }, { key: 'company_name', label: 'Client name', type: 'text', aliases: ['client', 'company'] },
    { key: 'effective_from', label: 'Effective from', type: 'date', required: true, aliases: ['effective date', 'from', 'start'] },
    { key: 'pay_rate', label: 'Pay rate (per hour)', type: 'money', required: true, aliases: ['pay'] }, { key: 'bill_rate', label: 'Bill rate (per hour)', type: 'money', required: true, aliases: ['bill'] },
    { key: 'currency', label: 'Currency', type: 'text' }, { key: 'reason', label: 'Reason', type: 'text', aliases: ['note', 'notes'] }, LEGACY] },
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Suggests source column → target field by name/alias similarity. */
export function suggestMapping(entity: string, headers: string[]): Record<string, string> {
  const def = ENTITIES[entity]; const out: Record<string, string> = {}; const used = new Set<string>();
  for (const f of def.fields) {
    const cands = [f.key, f.label, ...(f.aliases ?? [])].map(norm);
    const h = headers.find(h => !used.has(h) && cands.includes(norm(h))) ?? headers.find(h => !used.has(h) && cands.some(c => c.length > 3 && norm(h).includes(c)));
    if (h) { out[f.key] = h; used.add(h); }
  }
  return out;
}

export interface Mapped { values: Record<string, any>; errors: string[]; warnings: string[] }
export async function mapRow(orgId: string, entity: string, raw: Record<string, string>, mapping: Record<string, string>, userCache: Map<string, string | null>, db: Db): Promise<Mapped> {
  const def = ENTITIES[entity]; const values: Record<string, any> = {}; const errors: string[] = []; const warnings: string[] = [];
  for (const f of def.fields) {
    const col = mapping[f.key];
    const v = (col ? raw[col] ?? '' : '').trim();
    if (!v) { if (f.required) errors.push(`${f.label} is required`); continue; }
    switch (f.type) {
      case 'email': { const e = normalizeEmail(v); if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) errors.push(`${f.label} "${v}" is not a valid email`); else values[f.key] = e; break; }
      case 'phone': { const p = normalizePhone(v); if (!p) warnings.push(`${f.label} "${v}" looks incomplete`); values[f.key] = v; break; }
      case 'number': { const n = Number(v.replace(/,/g, '')); if (!Number.isFinite(n)) errors.push(`${f.label} "${v}" is not a number`); else values[f.key] = Math.round(n); break; }
      case 'money': { const n = Number(v.replace(/[$,\s]|USD/gi, '')); if (!Number.isFinite(n) || n < 0) errors.push(`${f.label} "${v}" is not an amount`); else values[f.key] = Math.round(n * 100); break; }
      case 'date': {
        let d = v; const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (us) d = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(new Date(d + 'T00:00:00Z').getTime())) errors.push(`${f.label} "${v}" is not a date (use YYYY-MM-DD)`); else values[f.key] = d;
        break;
      }
      case 'enum': { const e = v.toLowerCase().replace(/[\s-]+/g, '_'); if (!f.options!.includes(e)) errors.push(`${f.label} "${v}" must be one of ${f.options!.join(', ')}`); else values[f.key] = e; break; }
      case 'list': values[f.key] = v.split(/[;|,]/).map(s => s.trim()).filter(Boolean); break;
      case 'bool': values[f.key] = ['true', 'yes', 'y', '1', 'x'].includes(v.toLowerCase()); break;
      case 'user': {
        const k = v.toLowerCase();
        if (!userCache.has(k)) userCache.set(k, (await one<any>(`SELECT u.id FROM users u JOIN organization_memberships m ON m.user_id=u.id JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.kind='agency' AND (lower(u.email)=$2 OR lower(u.name)=$2)`, [orgId, k], db))?.id ?? null);
        const id = userCache.get(k); if (!id) warnings.push(`${f.label} "${v}" is not a staff member — left unassigned`); else values[f.key] = id;
        break;
      }
      default: values[f.key] = v.slice(0, 2000);
    }
  }
  if (entity === 'leads' || entity === 'clients') values.domain = domainOf(values.domain ?? values.website) ?? undefined;
  if ((entity === 'contacts') && !values.email && !values.phone) warnings.push('No email or phone — duplicate detection is limited');
  if (entity === 'placements') {
    if (!values.worker_email && !values.worker_legacy_id) errors.push('Worker email or worker legacy ID is required');
    if (!values.company_name && !values.company_legacy_id) errors.push('Client name or client legacy ID is required');
    if (values.status === 'ended' && !values.end_date) errors.push('Ended placements need an end date');
    if (values.end_date && values.start_date && values.end_date < values.start_date) errors.push('End date is before start date');
    if (values.pay_rate !== undefined && values.bill_rate !== undefined && values.bill_rate < values.pay_rate) warnings.push('Bill rate is below pay rate (negative margin)');
  }
  if (entity === 'rates') {
    if (!values.placement_legacy_id && !(values.worker_email && values.company_name)) errors.push('Placement legacy ID, or worker email + client name, is required');
    if (values.pay_rate !== undefined && values.bill_rate !== undefined && values.bill_rate < values.pay_rate) warnings.push('Bill rate is below pay rate (negative margin)');
  }
  return { values, errors, warnings };
}

async function findCompany(orgId: string, v: { legacy?: string; name?: string; domain?: string | null }, db: Db) {
  if (v.legacy) { const r = await one<any>(`SELECT id, name FROM companies WHERE organization_id=$1 AND legacy_id=$2 AND archived_at IS NULL`, [orgId, v.legacy], db); if (r) return { ...r, by: 'legacy ID' }; }
  if (v.domain) { const r = await one<any>(`SELECT id, name FROM companies WHERE organization_id=$1 AND (domain=$2 OR lower(regexp_replace(website,'^https?://(www\\.)?','')) LIKE $2 || '%') AND archived_at IS NULL LIMIT 1`, [orgId, v.domain], db); if (r) return { ...r, by: 'domain' }; }
  if (v.name) {
    const n = normalizeCompanyName(v.name);
    const rows = await q<any>(`SELECT id, name FROM companies WHERE organization_id=$1 AND archived_at IS NULL AND lower(name) LIKE $2`, [orgId, `%${n.split(' ')[0] ?? ''}%`], db);
    const r = rows.find(x => normalizeCompanyName(x.name) === n); if (r) return { ...r, by: 'name' };
  }
  return null;
}
async function findCandidate(orgId: string, v: { legacy?: string; email?: string; phone?: string }, db: Db) {
  if (v.legacy) { const r = await one<any>(`SELECT id, first_name, last_name FROM candidates WHERE organization_id=$1 AND legacy_id=$2`, [orgId, v.legacy], db); if (r) return { ...r, by: 'legacy ID' }; }
  if (v.email) { const r = await one<any>(`SELECT id, first_name, last_name FROM candidates WHERE organization_id=$1 AND lower(email)=$2 LIMIT 1`, [orgId, v.email], db); if (r) return { ...r, by: 'email' }; }
  const p = normalizePhone(v.phone);
  if (p) { const r = await one<any>(`SELECT id, first_name, last_name FROM candidates WHERE organization_id=$1 AND regexp_replace(coalesce(phone,''),'[^0-9+]','','g')=$2 LIMIT 1`, [orgId, p], db); if (r) return { ...r, by: 'phone' }; }
  return null;
}
async function findWorker(orgId: string, v: { legacy?: string; email?: string }, db: Db) {
  if (v.legacy) { const r = await one<any>(`SELECT w.id, w.candidate_id, c.first_name, c.last_name FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.organization_id=$1 AND (w.legacy_id=$2 OR c.legacy_id=$2) LIMIT 1`, [orgId, v.legacy], db); if (r) return { ...r, by: 'legacy ID' }; }
  if (v.email) { const r = await one<any>(`SELECT w.id, w.candidate_id, c.first_name, c.last_name FROM workers w JOIN candidates c ON c.id=w.candidate_id WHERE w.organization_id=$1 AND lower(c.email)=$2 LIMIT 1`, [orgId, v.email], db); if (r) return { ...r, by: 'email' }; }
  return null;
}
async function findPlacement(orgId: string, v: Record<string, any>, db: Db) {
  if (v.placement_legacy_id) return one<any>(`SELECT p.id, p.title FROM placements p WHERE p.organization_id=$1 AND p.legacy_id=$2`, [orgId, v.placement_legacy_id], db);
  const w = await findWorker(orgId, { email: v.worker_email, legacy: v.worker_legacy_id }, db); const c = await findCompany(orgId, { name: v.company_name, legacy: v.company_legacy_id }, db);
  if (!w || !c) return null;
  return one<any>(`SELECT id, title FROM placements WHERE organization_id=$1 AND worker_id=$2 AND company_id=$3 ORDER BY (status='ended'), start_date DESC LIMIT 1`, [orgId, w.id, c.id], db);
}

/** Finds an existing record this row duplicates. Returns { id, label, by } or null. Also returns resolution errors for references. */
export { findCompany };
export async function findExisting(orgId: string, entity: string, v: Record<string, any>, db: Db): Promise<{ dup: { id: string; label: string; by: string } | null; refError?: string }> {
  switch (entity) {
    case 'leads': case 'clients': { const c = await findCompany(orgId, { legacy: v.legacy_id, domain: v.domain, name: v.name }, db); return { dup: c ? { id: c.id, label: c.name, by: c.by } : null }; }
    case 'contacts': {
      if (v.legacy_id) { const r = await one<any>(`SELECT id, first_name, last_name FROM contacts WHERE organization_id=$1 AND legacy_id=$2`, [orgId, v.legacy_id], db); if (r) return { dup: { id: r.id, label: `${r.first_name} ${r.last_name ?? ''}`.trim(), by: 'legacy ID' } }; }
      if (v.email) { const r = await one<any>(`SELECT id, first_name, last_name FROM contacts WHERE organization_id=$1 AND lower(email)=$2 AND archived_at IS NULL LIMIT 1`, [orgId, v.email], db); if (r) return { dup: { id: r.id, label: `${r.first_name} ${r.last_name ?? ''}`.trim(), by: 'email' } }; }
      const p = normalizePhone(v.phone);
      if (p) { const r = await one<any>(`SELECT id, first_name, last_name FROM contacts WHERE organization_id=$1 AND regexp_replace(coalesce(phone,''),'[^0-9+]','','g')=$2 AND archived_at IS NULL LIMIT 1`, [orgId, p], db); if (r) return { dup: { id: r.id, label: `${r.first_name} ${r.last_name ?? ''}`.trim(), by: 'phone' } }; }
      return { dup: null };
    }
    case 'candidates': { const c = await findCandidate(orgId, { legacy: v.legacy_id, email: v.email, phone: v.phone }, db); return { dup: c ? { id: c.id, label: `${c.first_name} ${c.last_name ?? ''}`.trim(), by: c.by } : null }; }
    case 'workers': { const w = await findWorker(orgId, { legacy: v.legacy_id, email: v.email }, db); return { dup: w ? { id: w.id, label: `${w.first_name} ${w.last_name ?? ''}`.trim(), by: w.by } : null }; }
    case 'placements': {
      if (v.legacy_id) { const r = await one<any>(`SELECT id, title FROM placements WHERE organization_id=$1 AND legacy_id=$2`, [orgId, v.legacy_id], db); if (r) return { dup: { id: r.id, label: r.title, by: 'legacy ID' } }; }
      const w = await findWorker(orgId, { email: v.worker_email, legacy: v.worker_legacy_id }, db);
      if (!w) return { dup: null, refError: `Worker ${v.worker_email ?? v.worker_legacy_id} not found — import workers first` };
      const c = await findCompany(orgId, { name: v.company_name, legacy: v.company_legacy_id }, db);
      if (!c) return { dup: null, refError: `Client "${v.company_name ?? v.company_legacy_id}" not found — import clients first` };
      if (v.start_date) { const r = await one<any>(`SELECT id, title FROM placements WHERE organization_id=$1 AND worker_id=$2 AND company_id=$3 AND start_date=$4`, [orgId, w.id, c.id, v.start_date], db); if (r) return { dup: { id: r.id, label: r.title, by: 'worker + client + start date' } }; }
      return { dup: null };
    }
    case 'rates': {
      if (v.legacy_id) { const r = await one<any>(`SELECT id FROM placement_rates WHERE organization_id=$1 AND legacy_id=$2`, [orgId, v.legacy_id], db); if (r) return { dup: { id: r.id, label: `Rate ${v.legacy_id}`, by: 'legacy ID' } }; }
      const p = await findPlacement(orgId, v, db);
      if (!p) return { dup: null, refError: 'Placement not found — import placements first' };
      if (v.effective_from) { const r = await one<any>(`SELECT id FROM placement_rates WHERE placement_id=$1 AND effective_from=$2`, [p.id, v.effective_from], db); if (r) return { dup: { id: r.id, label: `${p.title} from ${v.effective_from}`, by: 'placement + effective date' } }; }
      return { dup: null };
    }
  }
  return { dup: null };
}

/** In-file duplicate keys for a mapped row. */
export function fileKeys(entity: string, v: Record<string, any>): string[] {
  const k: string[] = [];
  if (v.legacy_id) k.push(`legacy:${v.legacy_id}`);
  if (entity === 'leads' || entity === 'clients') { if (v.domain) k.push(`domain:${v.domain}`); if (v.name) k.push(`name:${normalizeCompanyName(v.name)}`); }
  else if (['contacts', 'candidates', 'workers'].includes(entity)) { if (v.email) k.push(`email:${v.email}`); const p = normalizePhone(v.phone); if (p) k.push(`phone:${p}`); }
  else if (entity === 'placements') k.push(`pl:${v.worker_email ?? v.worker_legacy_id}:${v.company_name ?? v.company_legacy_id}:${v.start_date}`);
  else if (entity === 'rates') k.push(`rate:${v.placement_legacy_id ?? `${v.worker_email}:${v.company_name}`}:${v.effective_from}`);
  return k;
}

const nn = (v: unknown) => (v === undefined || v === '' ? null : v);
/** Creates or updates the record for one row inside transaction `c`. Returns { id, action }. */
export async function applyRow(c: PoolClient, orgId: string, userId: string, entity: string, v: Record<string, any>, existingId: string | null, jobLabel: string): Promise<{ id: string; action: 'created' | 'updated' }> {
  const act = async (type: string, id: string, title: string) => c.query(`INSERT INTO activities (organization_id, entity_type, entity_id, kind, title, body, meta, actor_id) VALUES ($1,$2,$3,'import',$4,$5,$6,$7)`, [orgId, type, id, title, `Imported from ${jobLabel}`, JSON.stringify({ legacy_id: v.legacy_id ?? null }), userId]);
  if (entity === 'leads' || entity === 'clients') {
    const isClient = entity === 'clients';
    if (existingId) {
      await c.query(`UPDATE companies SET name=COALESCE($3,name), website=COALESCE($4,website), domain=COALESCE($5,domain), industry=COALESCE($6,industry), size=COALESCE($7,size), country=COALESCE($8,country), phone=COALESCE($9,phone), email=COALESCE($10,email), address=COALESCE($11,address),
        source=COALESCE($12,source), campaign=COALESCE($13,campaign), est_workers=COALESCE($14,est_workers), notes=COALESCE($15,notes), legacy_id=COALESCE(legacy_id,$16), payment_terms_days=COALESCE($17,payment_terms_days), timesheet_approval=COALESCE($18,timesheet_approval),
        owner_id=COALESCE($19,owner_id), account_manager_id=COALESCE($20,account_manager_id), updated_at=now() WHERE id=$1 AND organization_id=$2`,
        [existingId, orgId, nn(v.name), nn(v.website), nn(v.domain), nn(v.industry), nn(v.size), nn(v.country), nn(v.phone), nn(v.email), nn(v.address), nn(v.source), nn(v.campaign), nn(v.est_workers), nn(v.notes), nn(v.legacy_id), nn(v.payment_terms_days), nn(v.timesheet_approval), nn(v.owner_email), nn(v.account_manager_email)]);
      await act('company', existingId, 'Updated by import');
      return { id: existingId, action: 'updated' };
    }
    const r = await c.query(`INSERT INTO companies (organization_id, name, website, domain, industry, size, country, phone, email, address, stage, lead_status, source, campaign, est_workers, notes, legacy_id, payment_terms_days, timesheet_approval, owner_id, account_manager_id, converted_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18,15),COALESCE($19,'client'),$20,$21,$22,$23) RETURNING id`,
      [orgId, v.name, nn(v.website), nn(v.domain), nn(v.industry), nn(v.size), nn(v.country), nn(v.phone), nn(v.email), nn(v.address), isClient ? 'client' : (v.lead_status === 'qualified' ? 'qualified' : 'lead'), isClient ? 'converted' : v.lead_status ?? 'new',
        nn(v.source) ?? 'Import', nn(v.campaign), nn(v.est_workers), nn(v.notes), nn(v.legacy_id), nn(v.payment_terms_days), nn(v.timesheet_approval), nn(v.owner_email) ?? userId, nn(v.account_manager_email), isClient ? new Date() : null, userId]);
    await act('company', r.rows[0].id, isClient ? 'Client imported' : 'Lead imported');
    return { id: r.rows[0].id, action: 'created' };
  }
  if (entity === 'contacts') {
    const co = v.company_name || v.company_legacy_id ? await findCompany(orgId, { name: v.company_name, legacy: v.company_legacy_id }, c) : null;
    if (existingId) {
      await c.query(`UPDATE contacts SET first_name=COALESCE($3,first_name), last_name=COALESCE($4,last_name), email=COALESCE($5,email), phone=COALESCE($6,phone), title=COALESCE($7,title), company_id=COALESCE($8,company_id), legacy_id=COALESCE(legacy_id,$9), updated_at=now() WHERE id=$1 AND organization_id=$2`,
        [existingId, orgId, nn(v.first_name), nn(v.last_name), nn(v.email), nn(v.phone), nn(v.title), co?.id ?? null, nn(v.legacy_id)]);
      await act('contact', existingId, 'Updated by import');
      return { id: existingId, action: 'updated' };
    }
    const r = await c.query(`INSERT INTO contacts (organization_id, company_id, first_name, last_name, title, email, phone, is_primary, legacy_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [orgId, co?.id ?? null, v.first_name, nn(v.last_name), nn(v.title), nn(v.email), nn(v.phone), !!v.is_primary, nn(v.legacy_id), userId]);
    if (co) await c.query(`INSERT INTO company_contacts (organization_id, company_id, contact_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [orgId, co.id, r.rows[0].id, nn(v.title)]);
    await act('contact', r.rows[0].id, 'Contact imported');
    return { id: r.rows[0].id, action: 'created' };
  }
  if (entity === 'candidates') {
    if (existingId) {
      await c.query(`UPDATE candidates SET first_name=COALESCE($3,first_name), last_name=COALESCE($4,last_name), email=COALESCE($5,email), phone=COALESCE($6,phone), country=COALESCE($7,country), city=COALESCE($8,city), timezone=COALESCE($9,timezone), headline=COALESCE($10,headline),
        years_experience=COALESCE($11,years_experience), skills=CASE WHEN $12::text[] IS NULL THEN skills ELSE (SELECT array_agg(DISTINCT x) FROM unnest(skills || $12::text[]) x) END, languages=COALESCE($13,languages), rate_min_cents=COALESCE($14,rate_min_cents), rate_target_cents=COALESCE($15,rate_target_cents),
        legacy_id=COALESCE(legacy_id,$16), updated_at=now() WHERE id=$1 AND organization_id=$2`,
        [existingId, orgId, nn(v.first_name), nn(v.last_name), nn(v.email), nn(v.phone), nn(v.country), nn(v.city), nn(v.timezone), nn(v.headline), nn(v.years_experience), v.skills ?? null, v.languages ?? null, nn(v.rate_min), nn(v.rate_target), nn(v.legacy_id)]);
      await act('candidate', existingId, 'Updated by import');
      return { id: existingId, action: 'updated' };
    }
    const r = await c.query(`INSERT INTO candidates (organization_id, first_name, last_name, email, phone, country, city, timezone, headline, years_experience, skills, languages, rate_min_cents, rate_target_cents, source, status, legacy_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [orgId, v.first_name, nn(v.last_name), nn(v.email), nn(v.phone), nn(v.country), nn(v.city), nn(v.timezone), nn(v.headline), nn(v.years_experience), v.skills ?? [], v.languages ?? [], nn(v.rate_min), nn(v.rate_target), nn(v.source) ?? 'Import', v.status ?? 'new_applicant', nn(v.legacy_id), userId]);
    await act('candidate', r.rows[0].id, 'Candidate imported');
    return { id: r.rows[0].id, action: 'created' };
  }
  if (entity === 'workers') {
    if (existingId) {
      const w = (await c.query(`SELECT candidate_id FROM workers WHERE id=$1 AND organization_id=$2`, [existingId, orgId])).rows[0];
      await c.query(`UPDATE candidates SET first_name=COALESCE($3,first_name), last_name=COALESCE($4,last_name), phone=COALESCE($5,phone), country=COALESCE($6,country), updated_at=now() WHERE id=$1 AND organization_id=$2`, [w.candidate_id, orgId, nn(v.first_name), nn(v.last_name), nn(v.phone), nn(v.country)]);
      await c.query(`UPDATE workers SET status=COALESCE($3,status), employee_code=COALESCE($4,employee_code), payout_method=COALESCE($5,payout_method), payout_account_label=COALESCE($6,payout_account_label), legacy_id=COALESCE(legacy_id,$7), updated_at=now() WHERE id=$1 AND organization_id=$2`,
        [existingId, orgId, nn(v.status), nn(v.employee_code), nn(v.payout_method), nn(v.payout_account_label), nn(v.legacy_id)]);
      await act('worker', existingId, 'Updated by import');
      return { id: existingId, action: 'updated' };
    }
    let cand = await findCandidate(orgId, { email: v.email }, c);
    if (!cand) cand = (await c.query(`INSERT INTO candidates (organization_id, first_name, last_name, email, phone, country, source, status, legacy_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,'Import','hired',$7,$8) RETURNING id, first_name, last_name`, [orgId, v.first_name, nn(v.last_name), v.email, nn(v.phone), nn(v.country), nn(v.legacy_id), userId])).rows[0];
    const r = await c.query(`INSERT INTO workers (organization_id, candidate_id, status, employee_code, payout_method, payout_account_label, legacy_id) VALUES ($1,$2,$3,$4,COALESCE($5,'wise'),$6,$7) RETURNING id`, [orgId, cand!.id, v.status ?? 'available', nn(v.employee_code), nn(v.payout_method), nn(v.payout_account_label), nn(v.legacy_id)]);
    await act('worker', r.rows[0].id, 'Worker imported');
    return { id: r.rows[0].id, action: 'created' };
  }
  if (entity === 'placements') {
    const w = await findWorker(orgId, { email: v.worker_email, legacy: v.worker_legacy_id }, c);
    const co = await findCompany(orgId, { name: v.company_name, legacy: v.company_legacy_id }, c);
    if (!w) throw new Error(`Worker ${v.worker_email ?? v.worker_legacy_id} not found`);
    if (!co) throw new Error(`Client "${v.company_name ?? v.company_legacy_id}" not found`);
    const status = v.status ?? (v.end_date && v.end_date < new Date().toISOString().slice(0, 10) ? 'ended' : 'active');
    const policy = (await c.query(`SELECT id FROM monitoring_policies WHERE organization_id=$1 ORDER BY is_default DESC LIMIT 1`, [orgId])).rows[0];
    const am = (await c.query(`SELECT account_manager_id FROM companies WHERE id=$1`, [co.id])).rows[0]?.account_manager_id ?? null;
    const p = (await c.query(`INSERT INTO placements (organization_id, worker_id, company_id, title, status, start_date, end_date, timezone, weekly_hours, account_manager_id, monitoring_policy_id, legacy_id, activated_at, ended_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'America/New_York'),COALESCE($9,40),$10,$11,$12,$13,$14,$15) RETURNING id`,
      [orgId, w.id, co.id, v.title, status, v.start_date, nn(v.end_date), nn(v.timezone), nn(v.weekly_hours), am, policy?.id ?? null, nn(v.legacy_id), status !== 'onboarding' ? new Date(v.start_date + 'T12:00:00Z') : null, status === 'ended' ? new Date((v.end_date ?? v.start_date) + 'T18:00:00Z') : null, userId])).rows[0];
    await c.query(`INSERT INTO placement_rates (organization_id, placement_id, effective_from, pay_rate_cents, bill_rate_cents, currency, reason, created_by, legacy_id) VALUES ($1,$2,$3,$4,$5,COALESCE($6,'USD'),'Initial rate (import)',$7,NULL)`, [orgId, p.id, v.start_date, v.pay_rate, v.bill_rate, nn(v.currency), userId]);
    if (status !== 'onboarding') {
      await c.query(`INSERT INTO seat_usage (organization_id, worker_id, placement_id, started_at, ended_at, started_by) VALUES ($1,$2,$3,$4,$5,$6)`, [orgId, w.id, p.id, new Date(v.start_date + 'T12:00:00Z'), status === 'ended' ? new Date((v.end_date ?? v.start_date) + 'T18:00:00Z') : null, userId]);
      if (status === 'active') await c.query(`UPDATE workers SET status='active', updated_at=now() WHERE id=$1 AND status <> 'active'`, [w.id]);
    }
    await act('placement', p.id, 'Placement imported');
    return { id: p.id, action: 'created' };
  }
  if (entity === 'rates') {
    const p = await findPlacement(orgId, v, c);
    if (!p) throw new Error('Placement not found');
    const rates = (await c.query(`SELECT id, effective_from, effective_to FROM placement_rates WHERE placement_id=$1 ORDER BY effective_from`, [p.id])).rows;
    const plan = planRateInsert(rates.map((r: any) => ({ id: r.id, effectiveFrom: r.effective_from, effectiveTo: r.effective_to })), v.effective_from);
    if (plan.closeId) await c.query(`UPDATE placement_rates SET effective_to=$2 WHERE id=$1`, [plan.closeId, plan.closeAt]);
    const r = (await c.query(`INSERT INTO placement_rates (organization_id, placement_id, effective_from, effective_to, pay_rate_cents, bill_rate_cents, currency, reason, created_by, legacy_id) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'USD'),$8,$9,$10) RETURNING id`,
      [orgId, p.id, v.effective_from, plan.newTo, v.pay_rate, v.bill_rate, nn(v.currency), nn(v.reason) ?? 'Imported rate', userId, nn(v.legacy_id)])).rows[0];
    await c.query(`INSERT INTO audit_events (organization_id, actor_id, actor_label, action, entity_type, entity_id, entity_label, after, reason) VALUES ($1,$2,(SELECT name FROM users WHERE id=$2),'rate.created','placement',$3,$4,$5,'Import')`, [orgId, userId, p.id, p.title, JSON.stringify({ effective_from: v.effective_from, pay_rate_cents: v.pay_rate, bill_rate_cents: v.bill_rate })]);
    await act('placement', p.id, `Rate imported effective ${v.effective_from}`);
    return { id: r.id, action: 'created' };
  }
  throw new Error(`Unsupported entity ${entity}`);
}
