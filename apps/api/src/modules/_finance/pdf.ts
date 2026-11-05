// Locally generated, tenant-branded PDFs (pdfkit): invoices and payslips.
import PDFDocument from 'pdfkit';
import { humanize } from '@veyro/shared';
import { q, one, type Db } from '../../core/db';
import { getSetting, WEB_URL } from '../../core/settings';
import { fmt, orgBranding, billingContact, prettyDate } from './common';

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
const INK = '#0A0E16', MUTED = '#6B7280', LINE = '#E5E7EB';
function safeColor(c: string | null | undefined) { return /^#[0-9a-f]{6}$/i.test(c ?? '') ? c! : '#345CFF'; }

function header(doc: PDFKit.PDFDocument, brand: any, title: string, sub: string[]) {
  const primary = safeColor(brand.primary_color);
  doc.rect(0, 0, doc.page.width, 6).fill(primary);
  doc.roundedRect(50, 40, 36, 36, 8).fill(primary);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(14).text(String(brand.logo_text ?? brand.name).split(/\s+/).map((w: string) => w[0]).join('').slice(0, 2).toUpperCase(), 50, 51, { width: 36, align: 'center' });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(brand.logo_text ?? brand.name, 96, 42);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text([brand.support_email, brand.support_phone].filter(Boolean).join(' · ') || brand.name, 96, 62);
  doc.font('Helvetica-Bold').fontSize(22).fillColor(primary).text(title, 300, 40, { width: 245, align: 'right' });
  doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  let y = 68;
  for (const s of sub) { doc.text(s, 300, y, { width: 245, align: 'right' }); y += 13; }
  return Math.max(y, 96) + 14;
}

function table(doc: PDFKit.PDFDocument, y: number, cols: { label: string; w: number; align?: 'left' | 'right' }[], rows: string[][], primary: string) {
  const x0 = 50;
  doc.rect(x0, y, 495, 22).fill('#F5F7FF');
  let x = x0 + 8;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(primary);
  for (const c of cols) { doc.text(c.label.toUpperCase(), x, y + 7, { width: c.w - 10, align: c.align ?? 'left' }); x += c.w; }
  y += 28;
  doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  for (const r of rows) {
    const h = Math.max(...r.map((v, i) => doc.heightOfString(v, { width: cols[i].w - 10 }))) + 8;
    if (y + h > doc.page.height - 120) { doc.addPage(); y = 60; }
    x = x0 + 8;
    r.forEach((v, i) => { doc.text(v, x, y, { width: cols[i].w - 10, align: cols[i].align ?? 'left' }); x += cols[i].w; });
    y += h;
    doc.moveTo(x0, y - 3).lineTo(x0 + 495, y - 3).lineWidth(0.5).strokeColor(LINE).stroke();
  }
  return y + 6;
}

function totalsBlock(doc: PDFKit.PDFDocument, y: number, rows: [string, string, boolean?][], primary: string) {
  for (const [k, v, strong] of rows) {
    if (strong) { doc.rect(330, y - 4, 215, 24).fill(primary); doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11); }
    else doc.fillColor(INK).font('Helvetica').fontSize(9.5);
    doc.text(k, 340, y + (strong ? 2 : 0), { width: 100 });
    doc.text(v, 430, y + (strong ? 2 : 0), { width: 105, align: 'right' });
    y += strong ? 28 : 16;
  }
  doc.fillColor(INK);
  return y;
}

export async function invoicePdf(db: Db, orgId: string, invoiceId: string): Promise<{ buffer: Buffer; filename: string }> {
  const inv = await one<any>(`SELECT i.*, c.name company_name, c.address company_address, c.email company_email FROM invoices i JOIN companies c ON c.id=i.company_id WHERE i.id=$1 AND i.organization_id=$2`, [invoiceId, orgId], db);
  if (!inv) throw new Error('Invoice not found');
  const lines = await q<any>(`SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY sort, period_start NULLS LAST`, [invoiceId], db);
  const brand = await orgBranding(db, orgId);
  const settings = await getSetting<any>(orgId, 'invoice');
  const contact = await billingContact(db, orgId, inv.company_id);
  const primary = safeColor(brand.primary_color);
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${inv.number}`, Author: brand.name } });
  let y = header(doc, brand, 'INVOICE', [`No. ${inv.number}`, `Issued ${prettyDate(inv.issue_date)}`, `Due ${prettyDate(inv.due_date)}`, inv.period_start ? `Service period ${prettyDate(inv.period_start)} – ${prettyDate(inv.period_end)}` : '']);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('BILL TO', 50, y);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(inv.company_name, 50, y + 13);
  doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  let by = y + 28;
  for (const s of [contact?.name !== inv.company_name ? contact?.name : null, contact?.email ?? inv.company_email, inv.company_address].filter(Boolean)) { doc.text(String(s), 50, by); by += 13; }
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('STATUS', 400, y, { width: 145, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(inv.status === 'paid' ? '#16A34A' : inv.status === 'overdue' ? '#DC2626' : INK).text(humanize(inv.status), 400, y + 13, { width: 145, align: 'right' });
  y = Math.max(by, y + 40) + 16;
  const rows = lines.map(l => [l.description, l.minutes != null ? `${(l.minutes / 60).toFixed(2)} h` : String(Number(l.quantity)), l.minutes != null ? `${fmt(Number(l.unit_price_cents), inv.currency)}/h` : fmt(Number(l.unit_price_cents), inv.currency), fmt(Number(l.amount_cents), inv.currency)]);
  y = table(doc, y, [{ label: 'Description', w: 255 }, { label: 'Hours / Qty', w: 75, align: 'right' }, { label: 'Rate', w: 80, align: 'right' }, { label: 'Amount', w: 85, align: 'right' }], rows.length ? rows : [['No lines', '', '', '']], primary);
  if (y > doc.page.height - 260) { doc.addPage(); y = 60; }
  const t: [string, string, boolean?][] = [['Subtotal', fmt(Number(inv.subtotal_cents), inv.currency)]];
  if (Number(inv.discount_cents)) t.push(['Discount', '-' + fmt(Number(inv.discount_cents), inv.currency)]);
  t.push([`Tax (${(inv.tax_bp / 100).toFixed(2)}%)`, fmt(Number(inv.tax_cents), inv.currency)]);
  if (Number(inv.credit_cents)) t.push(['Credits', '-' + fmt(Number(inv.credit_cents), inv.currency)]);
  if (Number(inv.late_fee_cents)) t.push(['Late fee', fmt(Number(inv.late_fee_cents), inv.currency)]);
  if (Number(inv.previous_balance_cents)) t.push(['Previous balance', fmt(Number(inv.previous_balance_cents), inv.currency)]);
  t.push(['Total', fmt(Number(inv.total_cents), inv.currency), true]);
  if (Number(inv.paid_cents)) t.push(['Paid', '-' + fmt(Number(inv.paid_cents), inv.currency)]);
  t.push(['Balance due', fmt(Number(inv.total_cents) - Number(inv.paid_cents), inv.currency)]);
  const ty = totalsBlock(doc, y + 6, t, primary);
  if (inv.pay_token && !['paid', 'void', 'written_off', 'draft'].includes(inv.status)) {
    const link = `${WEB_URL}/pay/${inv.pay_token}`;
    doc.roundedRect(50, y + 6, 260, 64, 8).lineWidth(1).strokeColor(primary).stroke();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(primary).text('Pay online', 62, y + 16);
    doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(link, 62, y + 32, { width: 236, link, underline: true });
  }
  if (inv.notes) { doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('NOTES', 50, Math.max(ty, y + 84) + 8); doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(inv.notes, 50, Math.max(ty, y + 84) + 21, { width: 495 }); }
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(`${settings.footer ?? 'Thank you for your business.'}  ·  Payment terms: due ${prettyDate(inv.due_date)}${brand.hide_powered_by ? '' : '  ·  Generated by VeyroApp'}`, 50, doc.page.height - 70, { width: 495, align: 'center' });
  return { buffer: await toBuffer(doc), filename: `${inv.number}.pdf` };
}

export async function payslipPdf(db: Db, orgId: string, itemId: string): Promise<{ buffer: Buffer; filename: string }> {
  const it = await one<any>(`SELECT pi.*, r.period_start, r.period_end, r.pay_date, r.status run_status, c.first_name, c.last_name, c.email, w.employee_code, w.payout_method, w.payout_account_label, co.name company_name, p.title,
      (SELECT status FROM payout_items x WHERE x.payroll_item_id=pi.id ORDER BY updated_at DESC LIMIT 1) payout_status,
      (SELECT provider_ref FROM payout_items x WHERE x.payroll_item_id=pi.id ORDER BY updated_at DESC LIMIT 1) payout_ref
    FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id JOIN workers w ON w.id=pi.worker_id JOIN candidates c ON c.id=w.candidate_id LEFT JOIN companies co ON co.id=pi.company_id LEFT JOIN placements p ON p.id=pi.placement_id
    WHERE pi.id=$1 AND pi.organization_id=$2`, [itemId, orgId], db);
  if (!it) throw new Error('Payslip not found');
  const earnings = await q<any>(`SELECT * FROM payroll_earnings WHERE payroll_item_id=$1`, [itemId], db);
  const deductions = await q<any>(`SELECT * FROM payroll_deductions WHERE payroll_item_id=$1`, [itemId], db);
  const ytd = await one<any>(`SELECT COALESCE(sum(pi.gross_cents),0)::bigint gross, COALESCE(sum(pi.net_cents),0)::bigint net FROM payroll_items pi JOIN payroll_runs r ON r.id=pi.run_id WHERE pi.worker_id=$1 AND r.organization_id=$2 AND date_part('year', r.period_start)=date_part('year', $3::date) AND r.period_start <= $3 AND r.status IN ('approved','payment_initiated','paid','failed')`, [it.worker_id, orgId, it.period_start], db);
  const brand = await orgBranding(db, orgId);
  const primary = safeColor(brand.primary_color);
  const cur = it.currency;
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Payslip ${it.payslip_number ?? ''}`, Author: brand.name } });
  let y = header(doc, brand, 'PAYSLIP', [it.payslip_number ? `No. ${it.payslip_number}` : '', `Pay period ${prettyDate(it.period_start)} – ${prettyDate(it.period_end)}`, `Pay date ${prettyDate(it.pay_date)}`]);
  const name = [it.first_name, it.last_name].filter(Boolean).join(' ');
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('EMPLOYEE', 50, y);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(name, 50, y + 13);
  doc.font('Helvetica').fontSize(9.5).text([it.employee_code, it.email].filter(Boolean).join(' · '), 50, y + 28);
  doc.text(`${it.title ?? ''}${it.company_name ? ' — ' + it.company_name : ''}`, 50, y + 41);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('PAYMENT', 330, y, { width: 215, align: 'right' });
  doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(it.payout_account_label || humanize(it.payout_method ?? 'wise'), 330, y + 13, { width: 215, align: 'right' });
  doc.text(`Status: ${humanize(it.payout_status ?? it.run_status)}${it.payout_ref ? ` (${it.payout_ref})` : ''}`, 330, y + 28, { width: 215, align: 'right' });
  y += 66;
  const lines: any[] = Array.isArray(it.lines) ? it.lines : [];
  const er: string[][] = [];
  for (const l of lines) {
    if (l.regularMinutes) er.push([`Regular hours (${prettyDate(l.from)} – ${prettyDate(l.to)})`, `${(l.regularMinutes / 60).toFixed(2)} h`, `${fmt(l.rateCents, cur)}/h`, fmt(l.regularCents, cur)]);
    if (l.otMinutes) er.push([`Overtime ×${(l.otMultiplierBp / 10000).toFixed(2)} (${prettyDate(l.from)} – ${prettyDate(l.to)})`, `${(l.otMinutes / 60).toFixed(2)} h`, `${fmt(l.rateCents, cur)}/h`, fmt(l.otCents, cur)]);
  }
  if (!lines.length && (Number(it.regular_cents) || Number(it.ot_cents))) er.push(['Hours worked', `${((it.regular_minutes + it.ot_minutes) / 60).toFixed(2)} h`, '', fmt(Number(it.regular_cents) + Number(it.ot_cents), cur)]);
  for (const e of earnings) er.push([`${humanize(e.kind)}${e.description ? ' — ' + e.description : ''}`, '', '', fmt(Number(e.amount_cents), cur)]);
  y = table(doc, y, [{ label: 'Earnings', w: 255 }, { label: 'Hours', w: 75, align: 'right' }, { label: 'Rate', w: 80, align: 'right' }, { label: 'Amount', w: 85, align: 'right' }], er.length ? er : [['No earnings', '', '', fmt(0, cur)]], primary);
  if (deductions.length) y = table(doc, y + 4, [{ label: 'Deductions', w: 410 }, { label: 'Amount', w: 85, align: 'right' }], deductions.map(d => [`${humanize(d.kind)}${d.description ? ' — ' + d.description : ''}`, '-' + fmt(Number(d.amount_cents), cur)]), primary);
  if (y > doc.page.height - 220) { doc.addPage(); y = 60; }
  totalsBlock(doc, y + 6, [['Gross pay', fmt(Number(it.gross_cents), cur)], ['Deductions', '-' + fmt(Number(it.deductions_cents), cur)], ['Net pay', fmt(Number(it.net_cents), cur), true], ['YTD gross', fmt(Number(ytd!.gross), cur)], ['YTD net', fmt(Number(ytd!.net), cur)]], primary);
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(`Hours are taken from approved timesheets only. Questions? ${brand.support_email ?? 'Contact your account manager.'}${brand.hide_powered_by ? '' : '  ·  Generated by VeyroApp'}`, 50, doc.page.height - 70, { width: 495, align: 'center' });
  return { buffer: await toBuffer(doc), filename: `payslip-${it.payslip_number ?? itemId.slice(0, 8)}.pdf` };
}
