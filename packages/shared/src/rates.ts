// Effective-dated rates. A rate applies to work dates inside [effectiveFrom, effectiveTo] (inclusive).
export interface Rate {
  id: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
  payRateCents: number;
  billRateCents: number;
  currency: string;
  unit: string;
  otMultiplierBp: number; // 15000 = 1.5x
  otThresholdMinutes: number; // per week
}

export function rateForDate<T extends Pick<Rate, 'effectiveFrom' | 'effectiveTo'>>(rates: T[], date: string): T | null {
  const matches = rates.filter(r => r.effectiveFrom <= date && (r.effectiveTo === null || r.effectiveTo === undefined || date <= r.effectiveTo));
  if (matches.length === 0) return null;
  // latest effectiveFrom wins if overlapping (should not happen; inserts close the prior row)
  return matches.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the ISO week containing date. */
export function weekStart(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

/**
 * Plan inserting a new rate effective `from`: returns the id of the prior open/overlapping
 * row to close and the date to close it at (from - 1). Past economics are never overwritten.
 */
export function planRateInsert(rates: Pick<Rate, 'id' | 'effectiveFrom' | 'effectiveTo'>[], from: string): { closeId: string | null; closeAt: string | null; newTo: string | null } {
  const prior = rateForDate(rates, from);
  const later = rates.filter(r => r.effectiveFrom > from).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))[0];
  const newTo = later ? addDays(later.effectiveFrom, -1) : null;
  if (prior && prior.effectiveFrom === from) throw new Error('A rate already starts on this date; add an adjustment with a different effective date');
  return { closeId: prior ? prior.id : null, closeAt: prior ? addDays(from, -1) : null, newTo };
}
