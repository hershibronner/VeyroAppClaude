import type { FastifyReply } from 'fastify';

// Server-Sent Events hub: per user+org connections, plus org-wide broadcasts.
type Conn = { userId: string; orgId: string; reply: FastifyReply };
const conns = new Set<Conn>();

export function addConn(c: Conn) { conns.add(c); return () => conns.delete(c); }
function send(c: Conn, event: string, data: unknown) {
  try { c.reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { conns.delete(c); }
}
export function publishUser(userId: string, orgId: string | null, event: string, data: unknown) {
  for (const c of conns) if (c.userId === userId && (!orgId || c.orgId === orgId)) send(c, event, data);
}
export function publishOrg(orgId: string, event: string, data: unknown) {
  for (const c of conns) if (c.orgId === orgId) send(c, event, data);
}
setInterval(() => { for (const c of conns) send(c, 'ping', { t: Date.now() }); }, 25000).unref();
