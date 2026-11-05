// Duplicate detection helpers (warn, don't block).
export function normalizeEmail(e: string | null | undefined) { return (e ?? '').trim().toLowerCase() || null; }
export function normalizePhone(p: string | null | undefined) { const d = (p ?? '').replace(/[^\d+]/g, ''); return d.length >= 7 ? d : null; }
export function domainOf(url: string | null | undefined) {
  if (!url) return null;
  const s = url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return s || null;
}
export function normalizeCompanyName(n: string | null | undefined) {
  return (n ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(inc|llc|ltd|co|corp|corporation|company|group)\b/g, '').replace(/\s+/g, ' ').trim();
}
