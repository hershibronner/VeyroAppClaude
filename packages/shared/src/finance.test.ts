import { describe, it, expect } from 'vitest';
import { linesByRate, computePayroll, invoiceTotals, validatePayment, computeCommission, grossMargin, Rate, rateForDate, planRateInsert, divRoundHalfUp, amountForMinutes, canTransition, scopeFor, AGENCY_ROLES, stripComp, normalizeEmail, normalizePhone, domainOf, normalizeCompanyName } from './index';

const rates: Rate[] = [
  { id: 'r1', effectiveFrom: '2025-10-01', effectiveTo: '2025-10-14', payRateCents: 600, billRateCents: 1500, currency: 'USD', unit: 'hour', otMultiplierBp: 15000, otThresholdMinutes: 2400 },
  { id: 'r2', effectiveFrom: '2025-10-15', effectiveTo: null, payRateCents: 700, billRateCents: 1600, currency: 'USD', unit: 'hour', otMultiplierBp: 15000, otThresholdMinutes: 2400 },
];
const days = ['2025-10-13', '2025-10-14', '2025-10-15', '2025-10-16'].map(date => ({ date, minutes: 480 }));

describe('worked example (Jose Ramirez → Brightline Dental)', () => {
  it('invoice is $496.00 with two rate-period lines', () => {
    const lines = linesByRate(days, rates, 'bill');
    expect(lines.map(l => l.amountCents)).toEqual([24000, 25600]);
    expect(invoiceTotals({ lineAmounts: lines.map(l => l.amountCents), taxBp: 0 }).totalCents).toBe(49600);
  });
  it('payroll is $208.00 with no overtime', () => {
    const p = computePayroll(days, rates);
    expect(p.otMinutes).toBe(0);
    expect(p.grossTimeCents).toBe(20800);
  });
  it('margin $288.00 (58.06%) and commissions', () => {
    const m = grossMargin(49600, 20800);
    expect(m.gpCents).toBe(28800);
    expect(m.marginPct).toBe(58.06);
    expect(computeCommission({ kind: 'pct_gp', pctBp: 1000 }, m.gpCents)).toBe(2880);
    expect(computeCommission({ kind: 'pct_gp', pctBp: 500 }, m.gpCents)).toBe(1440);
  });
});

describe('rates', () => {
  it('selects the rate whose range contains the date', () => {
    expect(rateForDate(rates, '2025-10-14')?.id).toBe('r1');
    expect(rateForDate(rates, '2025-10-15')?.id).toBe('r2');
    expect(rateForDate(rates, '2025-09-30')).toBeNull();
  });
  it('plans a new rate by closing the prior row instead of overwriting it', () => {
    const plan = planRateInsert(rates, '2025-11-01');
    expect(plan).toEqual({ closeId: 'r2', closeAt: '2025-10-31', newTo: null });
    expect(() => planRateInsert(rates, '2025-10-15')).toThrow();
  });
  it('rate change does not alter already-computed lines (lines are snapshots)', () => {
    const before = linesByRate(days, rates, 'bill');
    const changed = rates.map(r => r.id === 'r2' ? { ...r, billRateCents: 9900 } : r);
    expect(before[1].amountCents).toBe(25600);
    expect(linesByRate(days, changed, 'bill')[1].amountCents).toBe(158400);
  });
});

describe('payroll overtime', () => {
  it('pays minutes beyond 40h/week at 1.5x', () => {
    const wk = ['2025-10-20', '2025-10-21', '2025-10-22', '2025-10-23', '2025-10-24'].map(date => ({ date, minutes: 600 })); // 50h
    const p = computePayroll(wk, rates);
    expect(p.regularMinutes).toBe(2400);
    expect(p.otMinutes).toBe(600);
    expect(p.regularCents).toBe(28000);
    expect(p.otCents).toBe(10500);
  });
});

describe('money rounding', () => {
  it('rounds half-up at the line level', () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
    expect(amountForMinutes(1000, 1)).toBe(17); // 16.67 → 17
    expect(amountForMinutes(1500, 30)).toBe(750);
  });
  it('invoice totals include tax, discounts, credits, fees, previous balance', () => {
    const t = invoiceTotals({ lineAmounts: [10000, 5000], taxBp: 825, discountCents: 1000, creditCents: 500, lateFeeCents: 2500, previousBalanceCents: 3000 });
    expect(t.taxCents).toBe(1155);
    expect(t.totalCents).toBe(15000 + 1155 - 1000 - 500 + 2500 + 3000);
  });
  it('payments cannot exceed balance unless overpayment credit is explicit', () => {
    expect(validatePayment(10000, 6000, 5000).ok).toBe(false);
    const ok = validatePayment(10000, 6000, 5000, true);
    expect(ok.ok && ok.overpaidCents).toBe(1000);
  });
});

describe('commission rules', () => {
  it('tiered and time-limited', () => {
    const tiered = { kind: 'tiered' as const, tiers: [{ upToCents: 100000, pctBp: 500 }, { upToCents: null, pctBp: 1000 }] };
    expect(computeCommission(tiered, 150000)).toBe(5000 + 5000);
    expect(computeCommission({ kind: 'pct_gp', pctBp: 1000, monthsLimit: 6 }, 10000, { monthsSinceStart: 6 })).toBe(0);
    expect(computeCommission({ kind: 'fixed', fixedCents: 25000 }, 0, { isFirstPeriod: true })).toBe(25000);
  });
});

describe('state machines', () => {
  it('allows valid and rejects invalid transitions', () => {
    expect(canTransition('timesheet', 'submitted', 'approved')).toBe(true);
    expect(canTransition('timesheet', 'open', 'approved')).toBe(false);
    expect(canTransition('invoice', 'paid', 'draft')).toBe(false);
    expect(canTransition('candidate', 'blacklisted', 'screening')).toBe(false);
    expect(canTransition('payroll_run', 'review', 'approved')).toBe(true);
  });
});

describe('permissions', () => {
  const role = (k: string) => AGENCY_ROLES.find(r => r.key === k)!.matrix;
  it('recruiter edits only assigned positions and cannot view comp', () => {
    expect(scopeFor(role('recruiter'), 'positions', 'edit')).toBe('assigned');
    expect(scopeFor(role('recruiter'), 'rates', 'view')).toBe('none');
    expect(scopeFor(role('finance'), 'payroll', 'approve')).toBe('all');
    expect(stripComp({ name: 'x', pay_rate_cents: 600 }, false).pay_rate_cents).toBeUndefined();
  });
});

describe('duplicate detection', () => {
  it('normalizes identities', () => {
    expect(normalizeEmail(' Maria@X.com ')).toBe('maria@x.com');
    expect(normalizePhone('+63 (917) 555-0101')).toBe('+639175550101');
    expect(domainOf('https://www.brightline.example/about')).toBe('brightline.example');
    expect(normalizeCompanyName('Brightline Dental, LLC')).toBe('brightline dental');
  });
});
