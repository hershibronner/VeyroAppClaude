/** Renders {{a.b}} merge variables. Missing values render as empty strings, never "null". */
export function render(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    let v: unknown = vars;
    for (const k of key.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    return v === null || v === undefined ? '' : String(v);
  });
}
export function escapeHtml(s: string) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
export function textToHtml(s: string) { return escapeHtml(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br/>'); }
/** 'YYYY-MM-DD' (or Date) → 'Nov 5, 2026' for human-facing text (notifications, timelines, labels). */
export function humanDate(d: unknown): string {
  if (d === null || d === undefined || d === '') return '';
  const s = d instanceof Date ? d.toISOString() : String(d);
  const x = new Date(s.slice(0, 10) + 'T12:00:00Z');
  return Number.isNaN(x.getTime()) ? s : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
