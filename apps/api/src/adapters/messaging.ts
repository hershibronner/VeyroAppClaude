// MessagingAdapter (simulated): email / SMS / WhatsApp / push land in the Dev Outbox (/dev/outbox).
import { one, q, type Db, pool } from '../core/db';
import { render, textToHtml } from '../core/templates';

export interface OutgoingMessage { orgId: string | null; channel: 'email' | 'sms' | 'whatsapp' | 'push'; to: string; subject?: string; text: string; related?: { type: string; id: string }; templateKey?: string; fromName?: string }

export async function sendMessage(m: OutgoingMessage, db: Db = pool) {
  let fromName = m.fromName;
  if (!fromName && m.orgId) fromName = (await one<any>(`SELECT COALESCE(b.email_sender_name, o.name) n FROM organizations o LEFT JOIN organization_branding b ON b.organization_id=o.id WHERE o.id=$1`, [m.orgId], db))?.n;
  const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0A0E16"><div style="font-weight:700;font-size:18px;margin-bottom:16px">${fromName ?? 'VeyroApp'}</div><div style="font-size:14px;line-height:1.6">${textToHtml(m.text)}</div><div style="margin-top:24px;font-size:12px;color:#6b7280">Sent via VeyroApp (demo mode — not actually delivered)</div></div>`;
  const r = await one<any>(`INSERT INTO outbox_messages (organization_id, channel, to_address, from_name, subject, body_html, body_text, related_type, related_id, template_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [m.orgId, m.channel, m.to, fromName ?? 'VeyroApp', m.subject ?? null, m.channel === 'email' ? html : null, m.text, m.related?.type ?? null, m.related?.id ?? null, m.templateKey ?? null], db);
  if (m.orgId && m.related) {
    await q(`INSERT INTO activities (organization_id, entity_type, entity_id, kind, title, body, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [m.orgId, m.related.type, m.related.id, m.channel === 'email' ? 'email' : 'message', `${m.channel.toUpperCase()} sent to ${m.to}${m.subject ? ': ' + m.subject : ''}`, m.text.slice(0, 500), JSON.stringify({ outbox_id: r.id })], db);
  }
  return r;
}

/** Renders an org template by key (latest version) and sends it. */
export async function sendTemplate(orgId: string | null, key: string, to: string, vars: Record<string, unknown>, opts: { channel?: OutgoingMessage['channel']; related?: { type: string; id: string } } = {}, db: Db = pool) {
  const t = orgId ? await one<any>(`SELECT t.channel, v.subject, v.body FROM templates t JOIN template_versions v ON v.template_id=t.id AND v.version=t.current_version WHERE t.organization_id=$1 AND t.key=$2 AND t.archived_at IS NULL`, [orgId, key], db) : null;
  const fallback = (await import('@veyro/db')).EMAIL_TEMPLATES.find(e => e.key === key);
  const subject = render(t?.subject ?? fallback?.subject ?? key, vars);
  const body = render(t?.body ?? fallback?.body ?? '', vars);
  const ch = opts.channel ?? (t?.channel === 'sms' || t?.channel === 'whatsapp' ? t.channel : 'email');
  return sendMessage({ orgId, channel: ch, to, subject, text: body, related: opts.related, templateKey: key }, db);
}
