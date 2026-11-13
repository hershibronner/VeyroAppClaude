// Branded email layout matching the public landing page (black + electric blue, grotesk type, mono accents).
// Email-client safe: tables + inline styles only. Every outgoing email (templates, notifications, ad-hoc) renders through here,
// so the plain-text body stays the source of truth and the layout is derived from it:
//   • a six-digit code becomes a big code card
//   • the first "Label: https://…" line becomes the primary button (label taken from the text)
//   • a trailing "…Settings → Notifications: link" line moves to the footer
import { escapeHtml } from '../core/templates';

const BLUE = '#1E6EF3', INK = '#0B0D12', MUTE = '#5B6273', LINE = '#E6E8EE';
const SANS = `'Inter Tight',Inter,'Segoe UI',Helvetica,Arial,sans-serif`;
const MONO = `'JetBrains Mono',Menlo,Consolas,monospace`;

/** Short mono eyebrow above the headline, by template key (falls back to the kind of content). */
const EYEBROWS: Record<string, string> = {
  signup_verify_code: 'Verify your email', mfa_code: 'Sign-in code', password_reset: 'Password reset',
  invite_staff: 'Team invitation', invite_client_portal: 'Client portal', invite_worker_portal: 'Worker portal',
  agency_application_received: 'Application received', agency_approved: 'Account active', agency_rejected: 'Application update',
  payslip_ready: 'Payslip', payment_receipt: 'Receipt', signature_request: 'Signature requested', document_expiring: 'Document expiring',
  interview_scheduled: 'Interview', offer_sent: 'Offer', application_received: 'Application', task_reminder: 'Reminder', scheduled_report: 'Report',
};

export interface EmailLayoutInput { fromName: string; subject?: string; text: string; templateKey?: string; live: boolean; notification?: boolean }

function inline(s: string) {
  return escapeHtml(s).replace(/(https?:\/\/[^\s<"]+)/g, `<a href="$1" style="color:${BLUE};text-decoration:underline;word-break:break-all">$1</a>`);
}

export function emailHtml({ fromName, subject, text, templateKey, live }: EmailLayoutInput) {
  let lines = text.replace(/\r/g, '').split('\n');
  const code = text.match(/\b(\d{6})\b/)?.[1];

  // Footer "manage notifications" line.
  let manage: string | null = null;
  lines = lines.filter(l => { const m = l.match(/^(.*Settings\s*→\s*Notifications):\s*(https?:\/\/\S+)\s*$/); if (m) { manage = m[2]; return false; } return true; });

  // Primary call to action: first line shaped "Label: https://…".
  let cta: { label: string; url: string } | null = null;
  lines = lines.filter(l => {
    if (cta) return true;
    const m = l.match(/^\s*([^:]{2,60}?):\s*(https?:\/\/\S+)\s*$/);
    if (!m) return true;
    cta = { label: m[1].replace(/\s+here$/i, '').trim(), url: m[2] }; return false;
  });
  // The code gets its own card, so drop the line that is only the code.
  if (code) lines = lines.filter(l => l.trim() !== code);

  // Notifications repeat the subject as their first line; the headline already shows it.
  const paras = lines.join('\n').split(/\n{2,}/).map(p => p.trim()).filter(p => p && p !== subject?.trim());
  const body = paras.map(p => `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#3A4050">${inline(p).replace(/\n/g, '<br/>')}</p>`).join('');

  const eyebrow = (templateKey && EYEBROWS[templateKey]) || (code ? 'Your code' : manage ? 'Notification' : cta ? 'Action needed' : 'Update');
  const headline = (subject ?? '').replace(new RegExp(`^${code ?? '\\0'}\\s+(is\\s+)?`), '').replace(/^./, c => c.toUpperCase()) || fromName;
  const W = (process.env.WEB_URL || 'https://portal.voicechart.app').replace(/\/$/, '');
  const label = (t: string) => `<div style="font-size:12px;color:#8A90A0;margin:6px 0 8px">${t}</div>`;

  // Code and link both render as the reference's "pill row": a light grey pill with a black pill button on the right.
  const codeRow = code ? `${label('Your one-time code:')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F3F5;border-radius:999px"><tr>
  <td style="padding:12px 18px;font-family:${MONO};font-size:22px;font-weight:700;letter-spacing:8px;color:${INK}">${code}</td>
  <td align="right" style="padding:6px 6px 6px 0"><span style="display:inline-block;background:${INK};color:#ffffff;border-radius:999px;padding:8px 14px;font-size:12px;font-weight:600">10 min</span></td>
</tr></table>
<div style="font-size:11.5px;color:#8A90A0;margin-top:8px">Never share this code with anyone.</div>` : '';

  const c = cta as { label: string; url: string } | null;
  const shortUrl = c ? c.url.replace(/^https?:\/\//, '').replace(/\?.*$/, '').slice(0, 34) + (c.url.replace(/^https?:\/\//, '').length > 34 ? '…' : '') : '';
  const linkRow = c ? `${label('Your link:')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F3F5;border-radius:999px"><tr>
  <td style="padding:10px 16px;font-size:12.5px;color:#3A4050;white-space:nowrap;overflow:hidden">&#128279;&nbsp; <a href="${escapeHtml(c.url)}" style="color:#3A4050;text-decoration:none">${escapeHtml(shortUrl)}</a></td>
  <td align="right" style="padding:5px 5px 5px 0;white-space:nowrap"><a href="${escapeHtml(c.url)}" style="display:inline-block;background:${INK};color:#ffffff;border-radius:999px;padding:9px 16px;font-size:12.5px;font-weight:600;text-decoration:none">${escapeHtml(c.label)}</a></td>
</tr></table>` : '';

  const m = manage as string | null;
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="light only"/><title>${escapeHtml(subject ?? fromName)}</title></head>
<body style="margin:0;padding:0;background:#ECEDEF">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(code ? `Your code is ${code}` : (paras[1] ?? paras[0] ?? '').slice(0, 120))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ECEDEF"><tr><td align="center" style="padding:40px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border-radius:20px;font-family:${SANS}">
  <tr><td style="padding:10px 10px 0"><img src="${W}/email/hero.jpg" width="440" alt="" style="display:block;width:100%;height:auto;border-radius:14px;background:#DCE6FB"/></td></tr>
  <tr><td style="padding:22px 26px 26px">
    <div style="font-family:${MONO};font-size:11px;color:${BLUE};margin-bottom:8px">${escapeHtml(fromName)} · ${escapeHtml(eyebrow)}</div>
    <div style="font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-.6px;color:${INK};margin-bottom:14px">${escapeHtml(headline)}</div>
    ${body}
    ${codeRow}${linkRow}
  </td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px"><tr><td align="center" style="padding:18px 10px 0;font-family:${SANS};font-size:11.5px;line-height:1.7;color:#8A90A0">
  <span style="display:inline-block;width:12px;height:4px;background:${BLUE};border-radius:0 4px 4px 0;vertical-align:middle"></span> <b style="color:${INK}">VeyroApp</b>${fromName !== 'VeyroApp' ? ` for ${escapeHtml(fromName)}` : ''}${live ? '' : ' · demo mode'}<br/>
  Didn't expect this? You can safely ignore it.${m ? ` · <a href="${escapeHtml(m)}" style="color:#8A90A0">Notification settings</a>` : ''}
</td></tr></table>
</td></tr></table></body></html>`;
}
