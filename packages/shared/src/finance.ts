import { amountForMinutes, applyBp, divRoundHalfUp, sumCents, marginPct } from './money';
import { Rate, rateForDate, weekStart } from './rates';

export interface WorkDay { date: string; minutes: number }

export interface RatePeriodLine {
  rateId: string;
  from: string;
  to: string;
  minutes: number;
  rateCents: number;
  unit: string;
  currency: string;
  amountCents: number;
}

/** Groups work days by the rate effective on each date; one line per rate period. */
export function linesByRate(days: WorkDay[], rates: Rate[], side: 'bill' | 'pay'): RatePeriodLine[] {
  const sorted = [...days].filter(d => d.minutes > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  const groups = new Map<string, { rate: Rate; from: string; to: string; minutes: number }>();
  for (const d of sorted) {
    const r = rateForDate(rates, d.date);
    if (!r) throw new Error(`No rate effective on ${d.date}`);
    const g = groups.get(r.id);
    if (g) { g.minutes += d.minutes; g.to = d.date; } else groups.set(r.id, { rate: r, from: d.date, to: d.date, minutes: d.minutes });
  }
  return [...groups.values()].map(g => {
    const rateCents = side === 'bill' ? g.rate.billRateCents : g.rate.payRateCents;
    return { rateId: g.rate.id, from: g.from, to: g.to, minutes: g.minutes, rateCents, unit: g.rate.unit, currency: g.rate.currency, amountCents: amountForMinutes(rateCents, g.minutes, g.rate.unit) };
  });
}

export interface PayrollCalcLine { rateId: string; from: string; to: string; regularMinutes: number; otMinutes: number; rateCents: number; otMultiplierBp: number; regularCents: number; otCents: number; currency: string; unit: string }
export interface PayrollCalc { regularMinutes: number; otMinutes: number; regularCents: number; otCents: number; grossTimeCents: number; lines: PayrollCalcLine[] }

/**
 * Pay for approved days. Overtime = minutes beyond the weekly threshold (per ISO week),
 * priced at the pay rate effective on that date × that rate's OT multiplier.
 */
export function computePayroll(days: WorkDay[], rates: Rate[]): PayrollCalc {
  const sorted = [...days].filter(d => d.minutes > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  const weekTotals = new Map<string, number>();
  const groups = new Map<string, PayrollCalcLine>();
  for (const d of sorted) {
    const r = rateForDate(rates, d.date);
    if (!r) throw new Error(`No rate effective on ${d.date}`);
    const wk = weekStart(d.date);
    const before = weekTotals.get(wk) ?? 0;
    const threshold = r.otThresholdMinutes;
    const regular = Math.max(0, Math.min(d.minutes, threshold - before));
    const ot = d.minutes - regular;
    weekTotals.set(wk, before + d.minutes);
    const g = groups.get(r.id) ?? { rateId: r.id, from: d.date, to: d.date, regularMinutes: 0, otMinutes: 0, rateCents: r.payRateCents, otMultiplierBp: r.otMultiplierBp, regularCents: 0, otCents: 0, currency: r.currency, unit: r.unit };
    g.regularMinutes += regular; g.otMinutes += ot; g.to = d.date;
    groups.set(r.id, g);
  }
  const lines = [...groups.values()].map(g => ({ ...g, regularCents: amountForMinutes(g.rateCents, g.regularMinutes, g.unit), otCents: amountForMinutes(g.rateCents, g.otMinutes, g.unit, g.otMultiplierBp) }));
  const regularCents = sumCents(lines.map(l => l.regularCents));
  const otCents = sumCents(lines.map(l => l.otCents));
  return { regularMinutes: sumCents(lines.map(l => l.regularMinutes)), otMinutes: sumCents(lines.map(l => l.otMinutes)), regularCents, otCents, grossTimeCents: regularCents + otCents, lines };
}

export interface InvoiceTotalsInput { lineAmounts: number[]; taxBp: number; discountCents?: number; creditCents?: number; lateFeeCents?: number; previousBalanceCents?: number }
export interface InvoiceTotals { subtotalCents: number; taxCents: number; discountCents: number; creditCents: number; lateFeeCents: number; previousBalanceCents: number; totalCents: number }

/** total = Σ lines + tax − discounts − credits + late fees + previous balance. Tax applies to (subtotal − discount). */
export function invoiceTotals(i: InvoiceTotalsInput): InvoiceTotals {
  const subtotalCents = sumCents(i.lineAmounts);
  const discountCents = i.discountCents ?? 0;
  const creditCents = i.creditCents ?? 0;
  const lateFeeCents = i.lateFeeCents ?? 0;
  const previousBalanceCents = i.previousBalanceCents ?? 0;
  const taxCents = applyBp(Math.max(0, subtotalCents - discountCents), i.taxBp);
  const totalCents = subtotalCents + taxCents - discountCents - creditCents + lateFeeCents + previousBalanceCents;
  return { subtotalCents, taxCents, discountCents, creditCents, lateFeeCents, previousBalanceCents, totalCents };
}

/** Validates a payment against the open balance. Overpayment requires an explicit credit. */
export function validatePayment(totalCents: number, paidCents: number, amountCents: number, allowOverpayWithCredit = false): { ok: true; overpaidCents: number } | { ok: false; error: string } {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: 'Payment amount must be a positive amount' };
  const balance = totalCents - paidCents;
  if (amountCents > balance && !allowOverpayWithCredit) return { ok: false, error: `Payment exceeds open balance of ${(balance / 100).toFixed(2)}` };
  return { ok: true, overpaidCents: Math.max(0, amountCents - balance) };
}

export function invoiceStatusAfterPayment(totalCents: number, paidCents: number): 'paid' | 'partially_paid' {
  return paidCents >= totalCents ? 'paid' : 'partially_paid';
}

export interface CommissionRule { kind: 'pct_gp' | 'fixed' | 'tiered'; pctBp?: number; fixedCents?: number; monthsLimit?: number | null; tiers?: { upToCents: number | null; pctBp: number }[] }

/** Commission for one period's gross profit. Time-limited rules return 0 outside the window. */
export function computeCommission(rule: CommissionRule, gpCents: number, opts: { monthsSinceStart?: number; isFirstPeriod?: boolean } = {}): number {
  if (rule.monthsLimit && (opts.monthsSinceStart ?? 0) >= rule.monthsLimit) return 0;
  if (rule.kind === 'fixed') return opts.isFirstPeriod ? (rule.fixedCents ?? 0) : 0;
  if (gpCents <= 0) return 0;
  if (rule.kind === 'pct_gp') return applyBp(gpCents, rule.pctBp ?? 0);
  // tiered: marginal tiers over GP
  let remaining = gpCents, prevCap = 0, total = 0;
  for (const t of rule.tiers ?? []) {
    const cap = t.upToCents ?? Infinity;
    const slice = Math.max(0, Math.min(remaining, cap - prevCap));
    total += applyBp(slice, t.pctBp);
    remaining -= slice; prevCap = cap;
    if (remaining <= 0) break;
  }
  return total;
}

export function grossMargin(billedCents: number, costCents: number) {
  const gp = billedCents - costCents;
  return { gpCents: gp, marginPct: marginPct(billedCents, gp) };
}

export { divRoundHalfUp };
