// SaaS billing math: $29 per active worker seat per month, metered in seat-days from seat_usage (+ add-ons, discounts, tax).
import { divRoundHalfUp } from '@veyro/shared';
import { q, one, type Db, pool } from '../../core/db';
import { monthBounds, pad } from './common';

export const SEAT_PRICE_FALLBACK = 2900;

/** Seat-days for an org in [start, end] (inclusive dates): each seat counts every calendar day it was active. */
export async function seatDays(orgId: string, start: string, end: string, db: Db = pool) {
  const r = await one<any>(`SELECT COALESCE(sum(GREATEST(0, (LEAST(COALESCE(ended_at::date, $3::date), $3::date) - GREATEST(started_at::date, $2::date)) + 1)), 0)::int days,
      count(*) FILTER (WHERE started_at::date <= $3::date AND (ended_at IS NULL OR ended_at::date >= $2::date))::int seats
    FROM seat_usage WHERE organization_id=$1 AND started_at::date <= $3::date AND (ended_at IS NULL OR ended_at::date >= $2::date)`, [orgId, start, end], db);
  return { seatDays: r.days as number, seatsTouched: r.seats as number };
}

export async function activeSeats(orgId: string, db: Db = pool) {
  return (await one<any>(`SELECT count(*)::int n FROM seat_usage WHERE organization_id=$1 AND ended_at IS NULL`, [orgId], db)).n as number;
}

/** Computes (without saving) the SaaS invoice for a month. Partial current month is prorated to today. */
export async function quoteMonth(orgId: string, ym: string, db: Db = pool) {
  const { start, end, days } = monthBounds(ym);
  const today = new Date().toISOString().slice(0, 10);
  const effEnd = end > today && start <= today ? today : end;
  const sub = await one<any>(`SELECT s.*, p.name plan_name, p.price_per_seat_cents, p.features FROM subscriptions s JOIN plans p ON p.key=s.plan_key WHERE s.organization_id=$1`, [orgId], db);
  if (!sub) throw new Error('No subscription');
  const price = Number(sub.price_per_seat_cents ?? SEAT_PRICE_FALLBACK);
  const { seatDays: sd, seatsTouched } = await seatDays(orgId, start, effEnd, db);
  const seatCents = divRoundHalfUp(sd * price, days);
  const addonCents = sub.features?.addon_monthly_cents ? Number(sub.features.addon_monthly_cents) : 0;
  const subtotal = seatCents + addonCents;
  const trial = sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at) > new Date(end + 'T23:59:59Z');
  const discount = sub.comped || trial ? subtotal : divRoundHalfUp(subtotal * (sub.discount_pct ?? 0), 100);
  const tax = divRoundHalfUp((subtotal - discount) * (sub.tax_bp ?? 0), 10000);
  const total = subtotal - discount + tax;
  const lines = [
    { label: `Worker seats — ${sd} seat-days ÷ ${days} days × ${(price / 100).toFixed(2)} USD`, quantity: Number((sd / days).toFixed(2)), unit_cents: price, amount_cents: seatCents },
    ...(addonCents ? [{ label: `${sub.plan_name} add-on (white label)`, quantity: 1, unit_cents: addonCents, amount_cents: addonCents }] : []),
    ...(discount ? [{ label: sub.comped ? 'Comped account (seats still metered)' : trial ? 'Trial — no charge' : `Discount ${sub.discount_pct}%`, quantity: 1, unit_cents: -discount, amount_cents: -discount }] : []),
    ...(tax ? [{ label: `Tax ${(sub.tax_bp / 100).toFixed(2)}%`, quantity: 1, unit_cents: tax, amount_cents: tax }] : []),
  ];
  return { period_start: start, period_end: end, metered_to: effEnd, days, seat_days: sd, seats_touched: seatsTouched, avg_seats: Number((sd / days).toFixed(2)), price_per_seat_cents: price, seat_cents: seatCents, addon_cents: addonCents, subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, total_cents: total, lines, plan_key: sub.plan_key, comped: sub.comped, trial: !!trial };
}

/** Creates the SaaS invoice for a (completed) month. Idempotent per org + month. */
export async function generateInvoice(orgId: string, ym: string, db: Db = pool) {
  const { start, end } = monthBounds(ym);
  const existing = await one<any>(`SELECT * FROM saas_invoices WHERE organization_id=$1 AND period_start=$2 AND status <> 'void'`, [orgId, start], db);
  if (existing) return { invoice: existing, existing: true };
  const qt = await quoteMonth(orgId, ym, db);
  const prefix = `VEY-${ym.replace('-', '')}-`;
  const n = (await one<any>(`SELECT count(*)::int n FROM saas_invoices WHERE number LIKE $1`, [prefix + '%'], db)).n + 1;
  const status = qt.total_cents === 0 ? (qt.comped || qt.trial ? 'comped' : 'paid') : 'open';
  const inv = await one<any>(`INSERT INTO saas_invoices (organization_id, number, period_start, period_end, seat_days, avg_seats, subtotal_cents, discount_cents, tax_cents, total_cents, status, plan_key, addon_cents, lines, due_at, paid_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, $4::date + 14, CASE WHEN $11='paid' THEN now() END) RETURNING *`,
    [orgId, prefix + pad(n), start, end, qt.seat_days, qt.avg_seats, qt.subtotal_cents, qt.discount_cents, qt.tax_cents, qt.total_cents, status, qt.plan_key, qt.addon_cents, JSON.stringify(qt.lines)], db);
  return { invoice: inv, existing: false };
}

/** Monthly seat history (avg seats per month from seat-days) for charts. */
export async function seatHistory(orgId: string | null, months = 6, db: Db = pool) {
  const out: { month: string; label: string; seat_days: number; avg_seats: number; seats_end: number }[] = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const ym = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}`;
    const { start, end, days } = monthBounds(ym);
    const today = now.toISOString().slice(0, 10);
    const effEnd = end > today ? today : end;
    const elapsed = Math.round((new Date(effEnd + 'T00:00:00Z').getTime() - new Date(start + 'T00:00:00Z').getTime()) / 86400000) + 1;
    const r = await one<any>(`SELECT COALESCE(sum(GREATEST(0, (LEAST(COALESCE(ended_at::date, $3::date), $3::date) - GREATEST(started_at::date, $2::date)) + 1)), 0)::int days,
        count(*) FILTER (WHERE started_at::date <= $3::date AND (ended_at IS NULL OR ended_at::date > $3::date))::int seats_end
      FROM seat_usage WHERE ($1::uuid IS NULL OR organization_id=$1) AND started_at::date <= $3::date AND (ended_at IS NULL OR ended_at::date >= $2::date)`, [orgId, start, effEnd], db);
    out.push({ month: ym, label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), seat_days: r.days, avg_seats: Number((r.days / Math.max(1, elapsed)).toFixed(1)), seats_end: r.seats_end });
    void days;
  }
  return out;
}

export async function mrrFor(orgId: string, db: Db = pool) {
  const sub = await one<any>(`SELECT s.*, p.price_per_seat_cents, p.features FROM subscriptions s JOIN plans p ON p.key=s.plan_key WHERE s.organization_id=$1`, [orgId], db);
  if (!sub) return { gross: 0, net: 0 };
  const seats = await activeSeats(orgId, db);
  const gross = seats * Number(sub.price_per_seat_cents) + (sub.features?.addon_monthly_cents ? Number(sub.features.addon_monthly_cents) : 0);
  const net = sub.comped || sub.status === 'trialing' || sub.status === 'suspended' || sub.status === 'cancelled' ? 0 : gross - divRoundHalfUp(gross * (sub.discount_pct ?? 0), 100);
  return { gross, net, seats };
}
export { q };
