// Single shared EventSource for the signed-in workspace. Components subscribe with realtime.on().
type Fn = (data: any) => void;
const subs = new Map<string, Set<Fn>>();
let es: EventSource | null = null;
let currentOrg: string | null = null;
export const realtime = {
  connect(orgId: string) {
    if (es && currentOrg === orgId) return;
    es?.close();
    currentOrg = orgId;
    es = new EventSource('/api/v1/stream');
    for (const ev of ['notification', 'presence', 'job', 'screenshot', 'timesheet', 'payout', 'invoice']) es.addEventListener(ev, (e: MessageEvent) => { try { const d = JSON.parse(e.data); subs.get(ev)?.forEach(f => f(d)); } catch { /* ignore */ } });
  },
  disconnect() { es?.close(); es = null; currentOrg = null; },
  on(event: string, fn: Fn) { if (!subs.has(event)) subs.set(event, new Set()); subs.get(event)!.add(fn); return () => { subs.get(event)?.delete(fn); }; },
};
