// Small shared helpers for FINANCE pages (owned by FINANCE).
import type { ReactNode } from 'react';
import { money, date as fmtDate } from '../../lib/format';
import { StatusPill } from '../../components/ui';

export const INVOICE_STATUSES = ['draft', 'approved', 'sent', 'viewed', 'partially_paid', 'overdue', 'paid', 'written_off', 'void'] as const;
export const RUN_STATUSES = ['calculated', 'review', 'approved', 'payment_initiated', 'paid', 'failed'] as const;
export const PAY_ITEM_STATUSES = ['calculated', 'review', 'approved', 'pending', 'processing', 'retried', 'paid', 'failed'] as const;

/** Right-aligned money cell; never renders null. */
export function Money({ cents, currency = 'USD', strong, muted }: { cents: number | string | null | undefined; currency?: string; strong?: boolean; muted?: boolean }) {
  const v = cents === null || cents === undefined || cents === '' ? null : Number(cents);
  const s = money(v, currency);
  return <span className={`num ${muted ? 'muted' : ''}`} style={{ fontWeight: strong ? 600 : undefined }}>{s}</span>;
}
export const period = (a?: string | null, b?: string | null) => (a && b ? `${fmtDate(a, { month: 'short', day: 'numeric' })} – ${fmtDate(b)}` : '—');
export const hoursOf = (minutes: number | null | undefined) => (minutes === null || minutes === undefined ? '—' : `${(minutes / 60).toFixed(2)}h`);
export const pctOf = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(2)}%`);
export function monthISO(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
export function Stat({ label, children, sub }: { label: ReactNode; children: ReactNode; sub?: ReactNode }) {
  return <div style={{ minWidth: 0 }}><div className="muted small">{label}</div><div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{children}</div>{sub && <div className="small muted">{sub}</div>}</div>;
}

export const EXPENSE_CATEGORIES = ['software', 'equipment', 'internet', 'travel', 'training', 'other'] as const;
export const EXPENSE_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'reimbursed', 'invoiced'] as const;
const EXPENSE_TONE: Record<string, string> = { draft: 'gray', submitted: 'amber', approved: 'green', rejected: 'red', reimbursed: 'green', invoiced: 'blue' };
export const ExpenseStatus = ({ status }: { status: string }) => <StatusPill status={status} label={status === 'submitted' ? 'Pending approval' : undefined} tone={EXPENSE_TONE[status]} />;
