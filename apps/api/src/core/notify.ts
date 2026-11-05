import { q, type Db, pool } from './db';
import { publishUser } from './realtime';
import { sendMessage } from '../adapters/messaging';

export interface NotifyInput { event: string; title: string; body?: string | null; link?: string | null }

/**
 * Sends an in-app notification (live via SSE) to each user, honouring per-user preferences
 * (in_app / email / push). Zero-recipient events are logged for admins.
 */
export async function notify(orgId: string, userIds: (string | null | undefined)[], n: NotifyInput, db: Db = pool) {
  const ids = [...new Set(userIds.filter(Boolean) as string[])];
  if (!ids.length) {
    await q(`INSERT INTO integration_logs (organization_id, integration_key, level, message, meta) VALUES ($1,'notifications','warn',$2,$3)`, [orgId, `Event "${n.event}" had zero recipients`, JSON.stringify(n)], db);
    return [];
  }
  const prefs = await q<any>(`SELECT user_id, in_app, email, push FROM notification_preferences WHERE organization_id=$1 AND event=$2 AND user_id = ANY($3)`, [orgId, n.event, ids], db);
  const out = [];
  for (const uid of ids) {
    const p = prefs.find(x => x.user_id === uid) ?? { in_app: true, email: false, push: false };
    if (p.in_app) {
      const r = await q<any>(`INSERT INTO notifications (organization_id, user_id, event, title, body, link) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [orgId, uid, n.event, n.title, n.body ?? null, n.link ?? null], db);
      publishUser(uid, orgId, 'notification', r[0]);
      out.push(r[0]);
    }
    if (p.email || p.push) {
      const u = (await q<any>(`SELECT email FROM users WHERE id=$1`, [uid], db))[0];
      if (u && p.email) await sendMessage({ orgId, channel: 'email', to: u.email, subject: n.title, text: `${n.title}\n\n${n.body ?? ''}${n.link ? `\n\nOpen: http://localhost:3100${n.link}` : ''}` }, db);
      if (u && p.push) await sendMessage({ orgId, channel: 'push', to: u.email, subject: n.title, text: n.body ?? n.title }, db);
    }
  }
  return out;
}

/** Users in an org holding any of the given role keys (e.g. ['owner','admin']). */
export async function usersWithRoles(orgId: string, roleKeys: string[], db: Db = pool): Promise<string[]> {
  return (await q<any>(`SELECT m.user_id FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.status='active' AND r.key = ANY($2)`, [orgId, roleKeys], db)).map(r => r.user_id);
}
/** Admins who subscribed to an event in notification preferences. */
export async function subscribers(orgId: string, event: string, db: Db = pool): Promise<string[]> {
  return (await q<any>(`SELECT user_id FROM notification_preferences WHERE organization_id=$1 AND event=$2 AND subscribed`, [orgId, event], db)).map(r => r.user_id);
}
