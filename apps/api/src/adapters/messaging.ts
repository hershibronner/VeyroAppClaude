// MessagingAdapter: every message is recorded in outbox_messages (visible at /dev/outbox in development).
// Email is really delivered through Resend when RESEND_API_KEY + EMAIL_FROM are set; SMS / WhatsApp / push stay simulated.
// Reserved/demo domains (.demo, .test, example.com …) are never delivered, so seeded demo data can't email anyone.
import { one, q, type Db, pool } from '../core/db';
import { render, textToHtml } from '../core/templates';

export interface OutgoingMessage { orgId: string | null; channel: 'email' | 'sms' | 'whatsapp' | 'push'; to: string; subject?: string; text: string; related?: { type: string; id: string }; templateKey?: string; fromName?: string }

export async function sendMessage(m: OutgoingMessage, db: Db = pool) {
  let fromName = m.fromName;
  if (!fromName && m.orgId) fromName = (await one<any>(`SELECT COALESCE(b.email_sender_name, o.name) n FROM organizations o LEFT JOIN organization_branding b ON b.organization_id=o.id WHERE o.id=$1`, [m.orgId], db))?.n;
  const real = emailDelivery();
  const blocked = m.channel === 'email' && isReservedAddress(m.to);
  const live = m.channel === 'email' && !!real && !blocked;
  const html = emailHtml(fromName ?? 'VeyroApp', m.text, live);
  const r = await one<any>(`INSERT INTO outbox_messages (organization_id, channel, to_address, from_name, subject, body_html, body_text, related_type, related_id, template_key, delivery_status, provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [m.orgId, m.channel, m.to, fromName ?? 'VeyroApp', m.subject ?? null, m.channel === 'email' ? html : null, m.text, m.related?.type ?? null, m.related?.id ?? null, m.templateKey ?? null, live ? 'sending' : blocked && real ? 'blocked' : 'simulated', live ? 'resend' : null], db);
  if (live) {
    const res = await deliverEmail(real!, { fromName: fromName ?? 'VeyroApp', to: m.to, subject: m.subject ?? '(no subject)', html, text: m.text });
    await q(`UPDATE outbox_messages SET delivery_status=$2, provider_message_id=$3, delivery_error=$4 WHERE id=$1`, [r.id, res.ok ? 'sent' : 'failed', res.id ?? null, res.error ?? null], db).catch(() => {});
    r.delivery_status = res.ok ? 'sent' : 'failed'; r.delivery_error = res.error ?? null;
    if (!res.ok) console.error(`[email] delivery to ${m.to} failed: ${res.error}`);
  }
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

/* ───────────── Real email delivery (Resend) ───────────── */
const RESERVED = /(@|\.)(example\.(com|org|net)|[^@]*\.(demo|test|invalid|localhost|example))$/i;
export function isReservedAddress(to: string) { return RESERVED.test(to.trim()); }
export function emailDelivery() {
  const key = process.env.RESEND_API_KEY; const from = process.env.EMAIL_FROM;
  if (!key || !from || process.env.EMAIL_DELIVERY === 'off') return null;
  return { key, from, replyTo: process.env.EMAIL_REPLY_TO || undefined };
}
/** "VeyroApp <no-reply@veyroapp.com>" → keeps the address, swaps the display name per sender (agency name). */
function fromHeader(from: string, name: string) { const addr = from.match(/<([^>]+)>/)?.[1] ?? from; return `${name.replace(/["<>]/g, '')} <${addr}>`; }
async function deliverEmail(cfg: NonNullable<ReturnType<typeof emailDelivery>>, e: { fromName: string; to: string; subject: string; html: string; text: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromHeader(cfg.from, e.fromName), to: [e.to], subject: e.subject, html: e.html, text: e.text, ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}) }),
    });
    const body: any = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, id: body.id } : { ok: false, error: `${res.status} ${body.message ?? body.name ?? res.statusText}`.slice(0, 300) };
  } catch (err: any) { return { ok: false, error: String(err?.message ?? err).slice(0, 300) }; }
}
function escapeHtml(s: string) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]); }
/** Branded, email-client-safe HTML (tables + inline styles). Six-digit codes are rendered as a big code block. */
function emailHtml(fromName: string, text: string, live: boolean) {
  const code = text.match(/\b(\d{6})\b/)?.[1];
  const body = textToHtml(text).replace(/(https?:\/\/[^\s<"]+)/g, '<a href="$1" style="color:#345CFF">$1</a>');
  const codeBlock = code ? `<div style="margin:22px 0;padding:18px;border-radius:12px;background:#F2F4FF;text-align:center;font-size:32px;font-weight:700;letter-spacing:10px;color:#0B1020;font-family:Menlo,Consolas,monospace">${code}</div>` : '';
  return `<!doctype html><html><body style="margin:0;background:#F5F6FA;padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid #E4E7EC" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 32px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0B1020">
<div style="font-weight:700;font-size:18px;margin-bottom:18px">${escapeHtml(fromName)}</div>${codeBlock}
<div style="font-size:15px;line-height:1.6;color:#344054">${body}</div></td></tr></table>
<div style="font-family:Arial,sans-serif;font-size:12px;color:#98A2B3;margin-top:14px">${live ? 'Sent with VeyroApp' : 'Sent via VeyroApp (demo mode — not actually delivered)'}</div></td></tr></table></body></html>`;
}
