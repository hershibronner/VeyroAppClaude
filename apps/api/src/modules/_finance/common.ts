// Shared FINANCE helpers. Every function takes an explicit `db` so it can run inside a transaction
// (and inside test transactions that are rolled back).
import type { Rate } from '@veyro/shared';
import { formatMoney, addDays } from '@veyro/shared';
import { q, one, type Db, pool } from '../../core/db';
import { usersWithRoles } from '../../core/notify';

export type { Db };

/** Effective-dated rates for many placements, keyed by placement id (shared Rate shape). */
export async function ratesFor(db: Db, orgId: string, placementIds: string[]): Promise<Map<string, Rate[]>> {
  const out = new Map<string, Rate[]>();
  if (!placementIds.length) return out;
  const rows = await q<any>(`SELECT * FROM placement_rates WHERE organization_id=$1 AND placement_id = ANY($2) ORDER BY effective_from`, [orgId, placementIds], db);
  for (const r of rows) {
    const list = out.get(r.placement_id) ?? [];
    list.push(toRate(r));
    out.set(r.placement_id, list);
  }
  return out;
}
export function toRate(r: any): Rate {
  return { id: r.id, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, payRateCents: Number(r.pay_rate_cents), billRateCents: Number(r.bill_rate_cents), currency: r.currency, unit: r.unit, otMultiplierBp: r.ot_multiplier_bp, otThresholdMinutes: r.ot_threshold_minutes };
}

export const fmt = (cents: number | null | undefined, currency = 'USD') => formatMoney(cents ?? 0, currency);

/** Today in the organization's timezone as YYYY-MM-DD. */
export async function orgToday(db: Db, orgId: string): Promise<string> {
  const r = await one<any>(`SELECT to_char(now() AT TIME ZONE COALESCE((SELECT timezone FROM organizations WHERE id=$1),'UTC'), 'YYYY-MM-DD') d`, [orgId], db);
  return r!.d;
}

export function monthStart(d: string) { return d.slice(0, 7) + '-01'; }
export function monthEnd(d: string) { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
export function addMonths(d: string, n: number) { const [y, m] = d.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1 + n, 1)); return x.toISOString().slice(0, 10); }
export function daysBetween(a: string, b: string) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
export function monthLabel(d: string) { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }); }
export function isoDate(d: string | Date | null | undefined): string | null { if (!d) return null; return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10); }
export function prettyDate(d: string | null | undefined) { if (!d) return '—'; return new Date(d.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }

/** Pay-period math for configurable payroll frequency. */
export type Frequency = 'weekly' | 'bi_weekly' | 'semi_monthly' | 'monthly';
export function periodFor(date: string, freq: Frequency, anchor = '2024-01-01'): { start: string; end: string } {
  if (freq === 'monthly') return { start: monthStart(date), end: monthEnd(date) };
  if (freq === 'semi_monthly') { const day = Number(date.slice(8, 10)); return day <= 15 ? { start: monthStart(date), end: date.slice(0, 8) + '15' } : { start: date.slice(0, 8) + '16', end: monthEnd(date) }; }
  const len = freq === 'weekly' ? 7 : 14;
  const diff = daysBetween(anchor, date);
  const k = Math.floor(diff / len);
  const start = addDays(anchor, k * len);
  return { start, end: addDays(start, len - 1) };
}
export function prevPeriod(p: { start: string }, freq: Frequency, anchor?: string) { return periodFor(addDays(p.start, -1), freq, anchor); }
export function nextPeriod(p: { end: string }, freq: Frequency, anchor?: string) { return periodFor(addDays(p.end, 1), freq, anchor); }

/** Integration status gate for adapters. */
export async function integration(db: Db, orgId: string, key: string) {
  return one<any>(`SELECT * FROM integrations WHERE organization_id=$1 AND key=$2`, [orgId, key], db);
}
export async function integrationLog(db: Db, orgId: string, key: string, level: 'info' | 'warn' | 'error', message: string, meta: Record<string, unknown> = {}) {
  await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,$2,$3,$4,$5)`, [orgId, key, level, message, JSON.stringify(meta)], db);
}

/** Finance team (+ owners/admins fallback when the org has no finance user). */
export async function financeUsers(orgId: string, db: Db = pool): Promise<string[]> {
  const f = await usersWithRoles(orgId, ['finance'], db);
  return f.length ? f : usersWithRoles(orgId, ['owner', 'admin'], db);
}

/** Next sequential number with a prefix, e.g. INV-1083. */
export async function nextNumber(db: Db, orgId: string, table: 'invoices' | 'credit_notes', prefix: string): Promise<string> {
  const col = table === 'invoices' ? 'number' : 'number';
  const r = await one<any>(`SELECT COALESCE(MAX(NULLIF(regexp_replace(${col}, '\\D', '', 'g'), '')::bigint), 1000) n FROM ${table} WHERE organization_id=$1 AND ${col} LIKE $2`, [orgId, `${prefix}-%`], db);
  return `${prefix}-${Number(r!.n) + 1}`;
}

/** Primary billing contact for a client (falls back to company email). */
export async function billingContact(db: Db, orgId: string, companyId: string): Promise<{ name: string; first_name: string; email: string | null } | null> {
  const c = await one<any>(`SELECT first_name, last_name, email FROM contacts WHERE organization_id=$1 AND company_id=$2 AND archived_at IS NULL AND email IS NOT NULL ORDER BY is_primary DESC, created_at LIMIT 1`, [orgId, companyId], db);
  if (c) return { name: [c.first_name, c.last_name].filter(Boolean).join(' '), first_name: c.first_name, email: c.email };
  const co = await one<any>(`SELECT name, email FROM companies WHERE id=$1 AND organization_id=$2`, [companyId, orgId], db);
  return co ? { name: co.name, first_name: co.name, email: co.email } : null;
}

export async function orgBranding(db: Db, orgId: string) {
  return (await one<any>(`SELECT o.id, o.name, o.slug, o.default_currency, COALESCE(b.logo_text, o.name) logo_text, COALESCE(b.primary_color,'#345CFF') primary_color, COALESCE(b.accent_color,'#7044FF') accent_color, b.support_email, b.support_phone, COALESCE(b.hide_powered_by,false) hide_powered_by FROM organizations o LEFT JOIN organization_branding b ON b.organization_id=o.id WHERE o.id=$1`, [orgId], db))!;
}

export const OPEN_INVOICE = ['sent', 'viewed', 'partially_paid', 'overdue'];
