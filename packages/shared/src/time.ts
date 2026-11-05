// Timezone helpers (no external deps).
export function tzOffsetMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute, +m.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}
/** Converts a wall-clock date+time in `tz` to a UTC Date. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const guess = new Date(`${date}T${time.length === 5 ? time + ':00' : time}Z`);
  const off = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - off * 60000);
}
/** YYYY-MM-DD of `d` as seen in `tz`. */
export function dateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
/** ISO day of week (1=Mon..7=Sun) for a YYYY-MM-DD. */
export function isoDow(date: string): number { const d = new Date(date + 'T00:00:00Z').getUTCDay(); return d === 0 ? 7 : d; }
export function todayUtc(): string { return new Date().toISOString().slice(0, 10); }
export function minutesToHours(m: number | null | undefined, digits = 1): string { if (m === null || m === undefined) return '—'; return (m / 60).toFixed(digits); }
