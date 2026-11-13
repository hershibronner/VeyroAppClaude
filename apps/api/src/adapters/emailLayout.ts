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

  // Paragraphs; a lone "Hi X," opener is styled a touch larger.
  // Notifications repeat the subject as their first line; the headline already shows it.
  const paras = lines.join('\n').split(/\n{2,}/).map(p => p.trim()).filter(p => p && p !== subject?.trim());
  const body = paras.map((p, i) => {
    const greet = i === 0 && /^(hi|hello|hey)\b.{0,40},$/i.test(p);
    return `<p style="margin:0 0 16px;font-size:${greet ? 17 : 15.5}px;line-height:1.6;color:${greet ? INK : '#3A4050'};font-weight:${greet ? 600 : 400}">${inline(p).replace(/\n/g, '<br/>')}</p>`;
  }).join('');

  const eyebrow = (templateKey && EYEBROWS[templateKey]) || (code ? 'Your code' : manage ? 'Notification' : cta ? 'Action needed' : 'Update');
  const headline = (subject ?? '').replace(new RegExp(`^${code ?? '\\0'}\\s+(is\\s+)?`), '').replace(/^./, c => c.toUpperCase()) || fromName;

  const codeCard = code ? `
<tr><td style="padding:4px 40px 8px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};border-radius:6px"><tr><td align="center" style="padding:26px 12px 22px">
    <div style="font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8D94A8;margin-bottom:10px">One-time code</div>
    <div style="font-family:${MONO};font-size:40px;line-height:1;font-weight:700;letter-spacing:12px;color:#ffffff;padding-left:12px">${code}</div>
    <div style="font-family:${SANS};font-size:12.5px;color:#8D94A8;margin-top:14px">Never share this code with anyone.</div>
  </td></tr></table>
</td></tr>` : '';

  const c = cta as { label: string; url: string } | null;
  const button = c ? `
<tr><td style="padding:8px 40px 6px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${BLUE};border-radius:4px">
    <a href="${escapeHtml(c.url)}" style="display:inline-block;padding:15px 26px;font-family:${SANS};font-size:16px;font-weight:600;letter-spacing:-.2px;color:#ffffff;text-decoration:none">${escapeHtml(c.label)} &rarr;</a>
  </td></tr></table>
  <div style="font-family:${SANS};font-size:12px;line-height:1.5;color:#8A90A0;margin-top:14px">Button not working? Paste this link into your browser:<br/><a href="${escapeHtml(c.url)}" style="color:${BLUE};word-break:break-all">${escapeHtml(c.url)}</a></div>
</td></tr>` : '';

  const m = manage as string | null;
  const W = (process.env.WEB_URL || 'https://portal.voicechart.app').replace(/\/$/, '');
  const bars = (w: number, h: number, color: string) => `<div style="width:${w}px;height:${h}px;background:${color};border-radius:1px ${h}px ${h}px 1px;font-size:0;line-height:0">&nbsp;</div><div style="height:${Math.round(h / 3)}px;font-size:0;line-height:0">&nbsp;</div><div style="width:${w}px;height:${h}px;background:${color};border-radius:1px ${h}px ${h}px 1px;font-size:0;line-height:0">&nbsp;</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="light only"/><meta name="supported-color-schemes" content="light"/><title>${escapeHtml(subject ?? fromName)}</title></head>
<body style="margin:0;padding:0;background:#EEF1F6;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(code ? `Your code is ${code}` : (paras[1] ?? paras[0] ?? '').slice(0, 120))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F6"><tr><td align="center" style="padding:32px 12px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;border-radius:10px;overflow:hidden;box-shadow:0 20px 50px -20px rgba(11,13,18,.35)">
  <!-- announcement bar -->
  <tr><td align="center" style="background:${BLUE};padding:9px 16px;font-family:${MONO};font-size:11.5px;letter-spacing:1px;color:#ffffff;text-transform:uppercase">${escapeHtml(eyebrow)}</td></tr>
  <!-- hero -->
  <tr><td style="background:#000000;background-image:radial-gradient(circle at 85% -10%,rgba(30,110,243,.55),rgba(0,0,0,0) 55%);padding:30px 40px 40px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;width:36px">${bars(26, 8, BLUE)}</td>
      <td style="vertical-align:middle;font-family:${SANS};font-size:20px;font-weight:600;letter-spacing:-.6px;color:#ffffff">${escapeHtml(fromName)}</td>
      <td align="right" style="vertical-align:middle;font-family:${MONO};font-size:11px;color:#8D94A8">${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
    </tr></table>
    <div style="height:46px;font-size:0;line-height:0">&nbsp;</div>
    <div style="font-family:${MONO};font-size:13px;color:${BLUE};margin-bottom:14px">// ${escapeHtml(eyebrow.toLowerCase())}</div>
    <div style="font-family:${SANS};font-size:36px;line-height:1.08;font-weight:600;letter-spacing:-1.4px;color:#ffffff">${escapeHtml(headline)}</div>
  </td></tr>
  <!-- body -->
  <tr><td style="background:#ffffff">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:34px 40px 6px;font-family:${SANS}">${body}</td></tr>
      ${codeCard}${button}
      <tr><td style="padding:30px 40px 34px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;border-radius:6px;border-left:3px solid ${BLUE}"><tr><td style="padding:14px 18px;font-family:${SANS};font-size:13px;line-height:1.55;color:${MUTE}">
          <b style="color:${INK}">Didn't expect this?</b> You received it because of activity on your ${escapeHtml(fromName)} account. If it wasn't you, you can safely ignore it.
        </td></tr></table>
      </td></tr>
    </table>
  </td></tr>
  <!-- footer -->
  <tr><td style="background:#000000;padding:34px 40px 30px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:top">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle;padding-right:12px">${bars(40, 13, '#ffffff')}</td><td style="vertical-align:middle;font-family:${SANS};font-size:30px;font-weight:600;letter-spacing:-1.2px;color:#ffffff">VeyroApp</td></tr></table>
        <div style="font-family:${SANS};font-size:13px;line-height:1.5;color:#8D94A8;margin-top:12px">The operating system for staffing agencies.</div>
      </td>
    </tr></table>
    <div style="height:1px;background:${'rgba(255,255,255,.12)'};margin:24px 0 18px;font-size:0;line-height:0">&nbsp;</div>
    <div style="font-family:${MONO};font-size:11.5px;line-height:1.9;color:#8D94A8">
      <a href="${W}/home" style="color:#ffffff;text-decoration:none">Home</a> &nbsp;/&nbsp; <a href="${W}/login" style="color:#ffffff;text-decoration:none">Sign in</a>${m ? ` &nbsp;/&nbsp; <a href="${escapeHtml(m)}" style="color:#ffffff;text-decoration:none">Notification settings</a>` : ''}<br/>
      ${live ? `Sent with VeyroApp${fromName !== 'VeyroApp' ? ` on behalf of ${escapeHtml(fromName)}` : ''}` : 'VeyroApp · demo mode — not actually delivered'}
    </div>
  </td></tr>
</table></td></tr></table></body></html>`;
}
