import { formatMoney, humanize } from '@veyro/shared';
export { humanize };

/** Money from integer cents. Missing → "—". */
export const money = (cents: number | null | undefined, currency = 'USD', opts: { compact?: boolean; noCents?: boolean } = {}) => formatMoney(cents, currency, opts);
export const num = (n: number | null | undefined, digits = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
export const hours = (minutes: number | null | undefined, digits = 1) => (minutes === null || minutes === undefined ? '—' : `${(minutes / 60).toFixed(digits)}h`);
export const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || Number.isNaN(n) ? '—' : `${n.toFixed(digits)}%`);
/** Display helper that never renders null/undefined. */
export const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

export function date(d: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!d) return '—';
  const x = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T12:00:00') : new Date(d);
  return Number.isNaN(x.getTime()) ? '—' : x.toLocaleDateString('en-US', opts);
}
export const shortDate = (d: string | Date | null | undefined) => date(d, { month: 'short', day: 'numeric' });
export function dateTime(d: string | Date | null | undefined) {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '—' : x.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function time(d: string | Date | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
export function relTime(d: string | Date | null | undefined) {
  if (!d) return '—';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  const f = (n: number, u: string) => `${Math.floor(n)} ${u}${Math.floor(n) === 1 ? '' : 's'}`;
  if (Math.abs(s) < 60) return 'just now';
  if (s < 0) { const a = -s; return a < 3600 ? `in ${f(a / 60, 'min')}` : a < 86400 ? `in ${f(a / 3600, 'hour')}` : `in ${f(a / 86400, 'day')}`; }
  if (s < 3600) return `${f(s / 60, 'min')} ago`;
  if (s < 86400) return `${f(s / 3600, 'hour')} ago`;
  if (s < 86400 * 30) return `${f(s / 86400, 'day')} ago`;
  return date(d);
}
export function duration(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
export const fullName = (r: { first_name?: string | null; last_name?: string | null } | null | undefined) => (r ? [r.first_name, r.last_name].filter(Boolean).join(' ') || '—' : '—');
export const initials = (name: string | null | undefined) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]!.toUpperCase()).join('') || '?';
export function delta(curr: number, prev: number) {
  if (!prev) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}
export function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function addDaysISO(iso: string, n: number) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
/** Download text as a file in the browser. */
export function downloadText(filename: string, text: string, mime = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function toCsv(rows: Record<string, unknown>[], cols: { key: string; label: string; value?: (r: any) => unknown }[]) {
  const esc = (v: unknown) => { if (v === null || v === undefined) return ''; const s = Array.isArray(v) ? v.join('; ') : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(c => esc(c.label)).join(','), ...rows.map(r => cols.map(c => esc(c.value ? c.value(r) : r[c.key])).join(','))].join('\n');
}
