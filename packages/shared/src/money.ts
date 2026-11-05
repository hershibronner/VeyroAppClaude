// All money is integer minor units (cents) with an explicit currency. Never floats.
export interface Money { cents: number; currency: string }

/** Integer division with half-up rounding (away from zero for .5). */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) throw new Error('divRoundHalfUp requires integers');
  if (denominator === 0) throw new Error('division by zero');
  const sign = (numerator < 0) !== (denominator < 0) ? -1 : 1;
  const n = Math.abs(numerator), d = Math.abs(denominator);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

/** Applies basis points (1bp = 0.01%) with half-up rounding. */
export function applyBp(cents: number, bp: number): number {
  return divRoundHalfUp(cents * bp, 10000);
}

export const UNIT_MINUTES: Record<string, number> = { hour: 60, day: 480, week: 2400, month: 10400 };

/** Amount for `minutes` of work at `rateCents` per `unit`, half-up at the line level. */
export function amountForMinutes(rateCents: number, minutes: number, unit = 'hour', multiplierBp = 10000): number {
  const um = UNIT_MINUTES[unit] ?? 60;
  return divRoundHalfUp(rateCents * minutes * multiplierBp, um * 10000);
}

export function formatMoney(cents: number | null | undefined, currency = 'USD', opts: { compact?: boolean; noCents?: boolean } = {}): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const v = cents / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency,
      notation: opts.compact ? 'compact' : 'standard',
      minimumFractionDigits: opts.noCents || opts.compact ? 0 : 2,
      maximumFractionDigits: opts.noCents ? 0 : opts.compact ? 1 : 2,
    }).format(v);
  } catch { return `${currency} ${v.toFixed(2)}`; }
}

export function sumCents(values: number[]): number { return values.reduce((a, b) => a + b, 0); }

/** Margin percentage with 2 decimals, as a number (e.g. 58.06). */
export function marginPct(revenueCents: number, profitCents: number): number {
  if (revenueCents === 0) return 0;
  return divRoundHalfUp(profitCents * 10000, revenueCents) / 100;
}
