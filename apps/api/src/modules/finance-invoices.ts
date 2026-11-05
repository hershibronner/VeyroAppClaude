// FINANCE — invoices: generator, drafts, totals history, status machine, send, credits, write-offs, PDF, overdue job.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { allowedNext } from '@veyro/shared';
import { q, one, tx, pool } from '../core/db';
import { staff, need, assertTransition, getOr404, can, type Ctx } from '../core/context';
import { badRequest, conflict } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { every } from '../jobs/queue';
import { sendTemplate } from '../adapters/messaging';
import { getSetting, WEB_URL } from '../core/settings';
import { publishOrg } from '../core/realtime';
import { syncEntity } from '../adapters/accounting';
import { previewInvoice, createInvoice, recompute, insertManualLine, applyPayment, creditInvoice, writeOff, voidInvoice, balanceOf, lockTimesheets, timesheetIdsForInvoice } from './_finance/invoices';
import { financeUsers, fmt, billingContact, orgToday, prettyDate, OPEN_INVOICE, daysBetween } from './_finance/common';
import { invoicePdf } from './_finance/pdf';
import { applyBp } from '@veyro/shared';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const manualLine = z.object({ kind: z.enum(['manual', 'reimbursement', 'adjustment']).default('manual'), description: z.string().trim().min(1, 'Description is required').max(300), quantity: z.number().refine(v => v !== 0, 'Quantity cannot be zero').default(1), unit_price_cents: z.number().int(), taxable: z.boolean().optional(), placement_id: z.string().uuid().nullable().optional() });

export async function invoicePayload(inv: any) {
  const co = await one<any>(`SELECT name, account_manager_id FROM companies WHERE id=$1`, [inv.company_id]);
  return { invoice_id: inv.id, invoice_number: inv.number, company_id: inv.company_id, company_name: co?.name, account_manager_id: co?.account_manager_id, total_cents: Number(inv.total_cents), paid_cents: Number(inv.paid_cents), balance_cents: balanceOf(inv), currency: inv.currency, due_date: inv.due_date, status: inv.status };
}

/** Shared by the agency send action and the overdue reminder. */
export async function emailInvoice(orgId: string, inv: any, template: 'invoice_sent' | 'invoice_reminder') {
  const contact = await billingContact(pool, orgId, inv.company_id);
  if (!contact?.email) throw conflict('This client has no billing contact email. Add a contact with an email first.');
  const org = await one<any>(`SELECT name FROM organizations WHERE id=$1`, [orgId]);
  await sendTemplate(orgId, template, contact.email, {
    contact: { firstName: contact.first_name, name: contact.name }, org: { name: org?.name },
    invoice: { number: inv.number, total: fmt(Number(inv.total_cents), inv.currency), balance: fmt(balanceOf(inv), inv.currency), dueDate: prettyDate(inv.due_date) },
    link: `${WEB_URL}/pay/${inv.pay_token}`,
  }, { related: { type: 'invoice', id: inv.id } });
  return contact;
}

async function detail(ctx: Ctx, id: string) {
  const inv = await one<any>(`SELECT i.*, co.name company_name, co.account_manager_id, am.name account_manager_name, cu.name created_by_name, au.name approved_by_name,
      (SELECT row_to_json(s) FROM (SELECT status, external_id, error, attempts, created_at FROM accounting_sync_log WHERE entity_type='invoice' AND entity_id=i.id ORDER BY created_at DESC LIMIT 1) s) sync
    FROM invoices i JOIN companies co ON co.id=i.company_id LEFT JOIN users am ON am.id=co.account_manager_id LEFT JOIN users cu ON cu.id=i.created_by LEFT JOIN users au ON au.id=i.approved_by
    WHERE i.id=$1 AND i.organization_id=$2`, [id, ctx.orgId]);
  if (!inv) return null;
  const [lines, history, payments, credits] = await Promise.all([
    q<any>(`SELECT l.*, c.first_name || ' ' || COALESCE(c.last_name,'') worker_name FROM invoice_lines l LEFT JOIN workers w ON w.id=l.worker_id LEFT JOIN candidates c ON c.id=w.candidate_id WHERE l.invoice_id=$1 ORDER BY l.sort, l.period_start NULLS LAST`, [id]),
    q<any>(`SELECT h.*, u.name actor_name FROM invoice_total_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.invoice_id=$1 ORDER BY h.created_at DESC`, [id]),
    q<any>(`SELECT p.*, u.name created_by_name, (SELECT status FROM accounting_sync_log s WHERE s.entity_type='payment' AND s.entity_id=p.id ORDER BY created_at DESC LIMIT 1) sync_status FROM payments p LEFT JOIN users u ON u.id=p.created_by WHERE p.invoice_id=$1 ORDER BY p.received_at DESC`, [id]),
    q<any>(`SELECT n.*, u.name created_by_name FROM credit_notes n LEFT JOIN users u ON u.id=n.created_by WHERE n.organization_id=$1 AND (n.invoice_id=$2 OR n.applied_invoice_id=$2) ORDER BY n.created_at DESC`, [ctx.orgId, id]),
  ]);
  const contact = await billingContact(pool, ctx.orgId, inv.company_id);
  const today = await orgToday(pool, ctx.orgId);
  return { invoice: { ...inv, balance_cents: balanceOf(inv), days_overdue: OPEN_INVOICE.includes(inv.status) && inv.due_date < today ? daysBetween(inv.due_date, today) : 0, pay_url: inv.pay_token ? `${WEB_URL}/pay/${inv.pay_token}` : null }, contact, lines, history, payments, credit_notes: credits, allowed: allowedNext('invoice', inv.status),
    can: { edit: can(ctx, 'invoices', 'edit'), approve: can(ctx, 'invoices', 'approve'), pay: can(ctx, 'payments', 'create'), refund: can(ctx, 'payments', 'edit') } };
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/invoices', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'view');
    const lp = listParams(req); const f = lp.filters;
    const today = await orgToday(pool, ctx.orgId);
    const params: unknown[] = [ctx.orgId, today]; const where = ['i.organization_id=$1', '$2::date IS NOT NULL'];
    if (f.status === 'open') where.push(`i.status IN ('sent','viewed','partially_paid','overdue')`);
    else if (f.status === 'unpaid') where.push(`i.status IN ('draft','approved','sent','viewed','partially_paid','overdue')`);
    else if (f.status) { params.push(f.status); where.push(`i.status=$${params.length}`); }
    else where.push(`i.status <> 'void'`);
    if (f.company_id) { params.push(f.company_id); where.push(`i.company_id=$${params.length}`); }
    if (f.from) { params.push(f.from); where.push(`i.issue_date >= $${params.length}`); }
    if (f.to) { params.push(f.to); where.push(`i.issue_date <= $${params.length}`); }
    if (f.paid_from) { params.push(f.paid_from); where.push(`i.paid_at >= $${params.length}::date`); }
    if (f.paid_to) { params.push(f.paid_to); where.push(`i.paid_at < $${params.length}::date + 1`); }
    if (f.aging) {
      const b: Record<string, string> = { current: `i.due_date >= $2`, '1_30': `$2 - i.due_date BETWEEN 1 AND 30`, '31_60': `$2 - i.due_date BETWEEN 31 AND 60`, '61_90': `$2 - i.due_date BETWEEN 61 AND 90`, '90_plus': `$2 - i.due_date > 90` };
      if (b[f.aging]) where.push(`i.status IN ('sent','viewed','partially_paid','overdue') AND ${b[f.aging]}`);
    }
    if (f.sync === 'failed') where.push(`(SELECT status FROM accounting_sync_log s WHERE s.entity_type='invoice' AND s.entity_id=i.id ORDER BY created_at DESC LIMIT 1)='failed'`);
    if (f.sync === 'unsynced') where.push(`NOT EXISTS (SELECT 1 FROM accounting_sync_log s WHERE s.entity_type='invoice' AND s.entity_id=i.id AND s.status='synced') AND i.status NOT IN ('draft','void')`);
    return paged({
      select: `i.id, i.number, i.status, i.issue_date, i.due_date, i.period_start, i.period_end, i.currency, i.subtotal_cents, i.tax_cents, i.total_cents, i.paid_cents, (i.total_cents - i.paid_cents) balance_cents, i.sent_at, i.paid_at, i.company_id, co.name company_name,
        CASE WHEN i.status IN ('sent','viewed','partially_paid','overdue') AND i.due_date < $2 THEN $2 - i.due_date ELSE 0 END days_overdue,
        (SELECT count(*)::int FROM invoice_lines l WHERE l.invoice_id=i.id) line_count,
        (SELECT status FROM accounting_sync_log s WHERE s.entity_type='invoice' AND s.entity_id=i.id ORDER BY created_at DESC LIMIT 1) sync_status`,
      from: `invoices i JOIN companies co ON co.id=i.company_id`, where, params, lp, searchCols: ['i.number', 'co.name'],
      sortMap: { number: 'i.number', issue_date: 'i.issue_date', due_date: 'i.due_date', total_cents: 'i.total_cents', balance_cents: '(i.total_cents - i.paid_cents)', company_name: 'co.name', status: 'i.status' }, defaultSort: 'i.issue_date DESC, i.number DESC',
    });
  });

  app.get('/api/v1/invoices/stats', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'view');
    const today = await orgToday(pool, ctx.orgId);
    const r = await one<any>(`SELECT
        count(*) FILTER (WHERE status='draft')::int drafts, count(*) FILTER (WHERE status='approved')::int approved,
        count(*) FILTER (WHERE status IN ('sent','viewed','partially_paid','overdue'))::int open, COALESCE(sum(total_cents-paid_cents) FILTER (WHERE status IN ('sent','viewed','partially_paid','overdue')),0)::bigint open_cents,
        count(*) FILTER (WHERE status='overdue')::int overdue, COALESCE(sum(total_cents-paid_cents) FILTER (WHERE status='overdue'),0)::bigint overdue_cents,
        COALESCE(sum(total_cents) FILTER (WHERE issue_date >= date_trunc('month',$2::date) AND status NOT IN ('void','draft')),0)::bigint invoiced_this_month,
        COALESCE(sum(total_cents) FILTER (WHERE issue_date >= date_trunc('month',$2::date) - interval '1 month' AND issue_date < date_trunc('month',$2::date) AND status NOT IN ('void','draft')),0)::bigint invoiced_last_month
      FROM invoices WHERE organization_id=$1`, [ctx.orgId, today]);
    const collected = await one<any>(`SELECT COALESCE(sum(amount_cents - refunded_cents) FILTER (WHERE received_at >= date_trunc('month',$2::date)),0)::bigint this_month, COALESCE(sum(amount_cents - refunded_cents) FILTER (WHERE received_at >= date_trunc('month',$2::date) - interval '1 month' AND received_at < date_trunc('month',$2::date)),0)::bigint last_month FROM payments WHERE organization_id=$1 AND status IN ('succeeded','refunded')`, [ctx.orgId, today]);
    const unbilled = await unbilledByClient(ctx.orgId);
    return { ...r, collected_this_month: collected!.this_month, collected_last_month: collected!.last_month, unbilled_minutes: unbilled.reduce((a, u) => a + u.minutes, 0), unbilled_cents: unbilled.reduce((a, u) => a + u.estimated_cents, 0), unbilled_clients: unbilled.length, month_start: today.slice(0, 8) + '01' };
  });

  async function unbilledByClient(orgId: string, companyId?: string) {
    const rows = await q<any>(`SELECT p.company_id, co.name company_name, count(DISTINCT p.id)::int placements, sum(d.minutes)::int minutes, min(d.work_date) first_date, max(d.work_date) last_date,
        sum(d.minutes * (SELECT r.bill_rate_cents FROM placement_rates r WHERE r.placement_id=d.placement_id AND r.effective_from <= d.work_date AND (r.effective_to IS NULL OR r.effective_to >= d.work_date) ORDER BY r.effective_from DESC LIMIT 1) / 60.0)::bigint estimated_cents
      FROM timesheet_days d JOIN timesheets t ON t.id=d.timesheet_id JOIN placements p ON p.id=d.placement_id JOIN companies co ON co.id=p.company_id
      WHERE d.organization_id=$1 AND d.invoice_id IS NULL AND t.status IN ('approved','locked') AND d.minutes > 0 ${companyId ? 'AND p.company_id=$2' : ''}
      GROUP BY p.company_id, co.name ORDER BY co.name`, companyId ? [orgId, companyId] : [orgId]);
    return rows.map(r => ({ ...r, id: r.company_id, estimated_cents: Number(r.estimated_cents) }));
  }

  // Clients with approved, un-invoiced time (generator step 1).
  app.get('/api/v1/invoices/unbilled', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'view');
    const { company_id } = req.query as { company_id?: string };
    return { rows: await unbilledByClient(ctx.orgId, company_id) };
  });

  const previewBody = z.object({ company_id: z.string().uuid('Pick a client'), period_start: date, period_end: date, placement_ids: z.array(z.string().uuid()).optional() });
  app.post('/api/v1/invoices/preview', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'create');
    const b = previewBody.parse(req.body);
    await getOr404('companies', ctx, b.company_id);
    return previewInvoice(pool, ctx.orgId, b.company_id, b.period_start, b.period_end, { placementIds: b.placement_ids });
  });

  const createBody = previewBody.extend({ due_date: date.nullable().optional(), notes: z.string().max(2000).nullable().optional(), manual_lines: z.array(manualLine).optional(), discount_cents: z.number().int().min(0).optional(), previous_balance_cents: z.number().int().min(0).optional(), include_time: z.boolean().optional() });
  app.post('/api/v1/invoices', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'create');
    const b = createBody.parse(req.body);
    await getOr404('companies', ctx, b.company_id);
    const inv = await tx(async c => {
      const inv = await createInvoice(c, ctx.orgId, ctx.userId, b);
      await activity(ctx, 'invoice', inv.id, 'system', `Draft invoice ${inv.number} created`, `${fmt(Number(inv.total_cents), inv.currency)} for ${b.period_start} – ${b.period_end}`, {}, c);
      await audit(ctx, 'invoice.created', { type: 'invoice', id: inv.id, label: inv.number }, undefined, { total_cents: inv.total_cents, period_start: b.period_start, period_end: b.period_end }, undefined, c);
      return inv;
    });
    publishOrg(ctx.orgId, 'invoice', { id: inv.id, status: inv.status });
    return { invoice: inv };
  });

  app.get('/api/v1/invoices/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'view');
    const { id } = req.params as { id: string };
    await getOr404('invoices', ctx, id);
    return detail(ctx, id);
  });

  app.get('/api/v1/invoices/:id/pdf', async (req, reply) => {
    const ctx = staff(req); need(ctx, 'invoices', 'view');
    const { id } = req.params as { id: string };
    await getOr404('invoices', ctx, id);
    const pdf = await invoicePdf(pool, ctx.orgId, id);
    const dl = (req.query as any).download ? 'attachment' : 'inline';
    return reply.type('application/pdf').header('content-disposition', `${dl}; filename="${pdf.filename}"`).send(pdf.buffer);
  });

  async function draftOnly(ctx: Ctx, id: string) {
    const inv = await getOr404<any>('invoices', ctx, id);
    if (inv.status !== 'draft') throw conflict('Only draft invoices can be edited. Use a credit note for issued invoices.');
    return inv;
  }

  const patchBody = z.object({ tax_bp: z.number().int().min(0).max(5000).optional(), discount_cents: z.number().int().min(0).optional(), previous_balance_cents: z.number().int().min(0).optional(), notes: z.string().max(2000).nullable().optional(), due_date: date.optional() });
  app.patch('/api/v1/invoices/:id', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const { id } = req.params as { id: string };
    const inv = await draftOnly(ctx, id);
    const b = patchBody.parse(req.body);
    const changed = Object.entries(b).filter(([k, v]) => v !== undefined && String(v) !== String(inv[k] ?? '')).map(([k]) => k);
    if (!changed.length) return { invoice: inv };
    const upd = await tx(async c => {
      await q(`UPDATE invoices SET tax_bp=COALESCE($2,tax_bp), discount_cents=COALESCE($3,discount_cents), previous_balance_cents=COALESCE($4,previous_balance_cents), notes=CASE WHEN $5::boolean THEN $6 ELSE notes END, due_date=COALESCE($7,due_date) WHERE id=$1`, [id, b.tax_bp ?? null, b.discount_cents ?? null, b.previous_balance_cents ?? null, b.notes !== undefined, b.notes ?? null, b.due_date ?? null], c);
      const r = await recompute(c, ctx.orgId, id, `Edited ${changed.map(x => x.replace(/_cents|_bp/, '').replace('_', ' ')).join(', ')}`, ctx.userId);
      await activity(ctx, 'invoice', id, 'system', `Invoice updated (${changed.join(', ').replace(/_cents|_bp/g, '')})`, null, {}, c);
      return r;
    });
    return { invoice: upd };
  });

  app.post('/api/v1/invoices/:id/lines', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const { id } = req.params as { id: string };
    await draftOnly(ctx, id);
    const b = manualLine.parse(req.body);
    const r = await tx(async c => {
      const line = await insertManualLine(c, ctx.orgId, id, b);
      const inv = await recompute(c, ctx.orgId, id, `Added ${b.kind} line: ${b.description}`, ctx.userId);
      await activity(ctx, 'invoice', id, 'system', `Added ${b.kind} line "${b.description}" (${fmt(Number(line.amount_cents))})`, null, {}, c);
      return { line, invoice: inv };
    });
    return r;
  });

  app.delete('/api/v1/invoices/:id/lines/:lineId', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const { id, lineId } = req.params as { id: string; lineId: string };
    await draftOnly(ctx, id);
    return tx(async c => {
      // Release billable expenses on this line (back to approved / reimbursed) so they can be billed again.
      await q(`UPDATE expenses SET invoice_id=NULL, invoice_line_id=NULL, invoiced_at=NULL, status=CASE WHEN status='invoiced' THEN (CASE WHEN reimbursed_at IS NOT NULL THEN 'reimbursed' ELSE 'approved' END) ELSE status END, updated_at=now() WHERE invoice_line_id=$1 AND invoice_id=$2 AND organization_id=$3`, [lineId, id, ctx.orgId], c);
      const line = await one<any>(`DELETE FROM invoice_lines WHERE id=$1 AND invoice_id=$2 AND organization_id=$3 RETURNING *`, [lineId, id, ctx.orgId], c);
      if (!line) throw badRequest('Line not found');
      if (line.kind === 'time' || line.kind === 'adjustment') {
        // Release the underlying approved days so they can be billed again.
        await q(`UPDATE timesheet_days SET invoice_id=NULL WHERE invoice_id=$1 AND placement_id=$2 AND work_date BETWEEN $3 AND $4`, [id, line.placement_id, line.period_start, line.period_end], c);
        await q(`UPDATE timesheet_adjustments SET applied_invoice_id=NULL WHERE applied_invoice_id=$1 AND placement_id=$2 AND work_date BETWEEN $3 AND $4`, [id, line.placement_id, line.period_start, line.period_end], c);
      }
      const inv = await recompute(c, ctx.orgId, id, `Removed line: ${line.description}`, ctx.userId);
      await activity(ctx, 'invoice', id, 'system', `Removed line "${line.description}"`, null, {}, c);
      return { invoice: inv };
    });
  });

  // Status transitions
  app.post('/api/v1/invoices/:id/approve', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'approve');
    const { id } = req.params as { id: string };
    const inv = await getOr404<any>('invoices', ctx, id);
    assertTransition('invoice', inv.status, 'approved');
    if (Number(inv.total_cents) <= 0) throw conflict('An invoice must have a positive total to be approved');
    const upd = await tx(async c => {
      const r = await one<any>(`UPDATE invoices SET status='approved', approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [id, ctx.userId], c);
      await activity(ctx, 'invoice', id, 'status', `Invoice ${inv.number} approved`, null, {}, c);
      await audit(ctx, 'invoice.approved', { type: 'invoice', id, label: inv.number }, { status: inv.status }, { status: 'approved', total_cents: inv.total_cents }, undefined, c);
      return r;
    });
    publishOrg(ctx.orgId, 'invoice', { id, status: 'approved' });
    return { invoice: upd };
  });

  app.post('/api/v1/invoices/:id/revert', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'approve');
    const { id } = req.params as { id: string };
    const inv = await getOr404<any>('invoices', ctx, id);
    assertTransition('invoice', inv.status, 'draft');
    const upd = await one<any>(`UPDATE invoices SET status='draft', approved_by=NULL, approved_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [id]);
    await activity(ctx, 'invoice', id, 'status', `Invoice ${inv.number} returned to draft`);
    return { invoice: upd };
  });

  app.post('/api/v1/invoices/:id/send', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const { id } = req.params as { id: string };
    const inv = await getOr404<any>('invoices', ctx, id);
    assertTransition('invoice', inv.status, 'sent');
    const contact = await emailInvoice(ctx.orgId, inv, 'invoice_sent');
    const upd = await one<any>(`UPDATE invoices SET status='sent', sent_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [id]);
    await activity(ctx, 'invoice', id, 'status', `Invoice ${inv.number} sent to ${contact.name} <${contact.email}>`);
    const payload = await invoicePayload(upd);
    await emit(ctx.orgId, 'invoice.sent', { ...payload, contact_email: contact.email });
    await notify(ctx.orgId, [payload.account_manager_id].filter(u => u !== ctx.userId), { event: 'invoice.sent', title: `Invoice ${inv.number} sent to ${payload.company_name}`, body: `${fmt(Number(inv.total_cents), inv.currency)} due ${prettyDate(inv.due_date)}`, link: `/finance/invoices/${id}` });
    publishOrg(ctx.orgId, 'invoice', { id, status: 'sent' });
    return { invoice: upd, sent_to: contact.email };
  });

  app.post('/api/v1/invoices/:id/remind', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const { id } = req.params as { id: string };
    const inv = await getOr404<any>('invoices', ctx, id);
    if (!OPEN_INVOICE.includes(inv.status)) throw conflict('Reminders can only be sent for open invoices');
    const contact = await emailInvoice(ctx.orgId, inv, inv.status === 'overdue' ? 'invoice_reminder' : 'invoice_sent');
    await activity(ctx, 'invoice', id, 'email', `Payment reminder sent to ${contact.email}`);
    return { ok: true, sent_to: contact.email };
  });

  app.post('/api/v1/invoices/:id/void', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().trim().min(3, 'A reason is required') }).parse(req.body);
    const inv = await getOr404<any>('invoices', ctx, id);
    const upd = await tx(async c => {
      const r = await voidInvoice(c, ctx.orgId, id);
      await activity(ctx, 'invoice', id, 'status', `Draft ${inv.number} voided`, reason, {}, c);
      await audit(ctx, 'invoice.voided', { type: 'invoice', id, label: inv.number }, { status: inv.status, total_cents: inv.total_cents }, { status: 'void' }, reason, c);
      return r;
    });
    return { invoice: upd };
  });

  app.post('/api/v1/invoices/:id/late-fee', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const { id } = req.params as { id: string };
    const b = z.object({ amount_cents: z.number().int().positive().optional() }).parse(req.body ?? {});
    const inv = await getOr404<any>('invoices', ctx, id);
    if (inv.status !== 'overdue' && inv.status !== 'draft') throw conflict('Late fees can be added to overdue invoices (or drafts)');
    const settings = await getSetting<any>(ctx.orgId, 'invoice');
    const fee = b.amount_cents ?? applyBp(balanceOf(inv), Number(settings.late_fee_bp ?? 150));
    if (fee <= 0) throw badRequest('Late fee must be positive');
    const upd = await tx(async c => {
      await q(`UPDATE invoices SET late_fee_cents=late_fee_cents+$2 WHERE id=$1`, [id, fee], c);
      const r = await recompute(c, ctx.orgId, id, `Late fee ${fmt(fee, inv.currency)} applied`, ctx.userId);
      await activity(ctx, 'invoice', id, 'system', `Late fee of ${fmt(fee, inv.currency)} applied`, null, {}, c);
      await audit(ctx, 'invoice.late_fee', { type: 'invoice', id, label: inv.number }, { total_cents: inv.total_cents }, { total_cents: r.total_cents, late_fee_cents: r.late_fee_cents }, undefined, c);
      return r;
    });
    return { invoice: upd };
  });

  app.post('/api/v1/invoices/:id/credit-notes', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'approve');
    const { id } = req.params as { id: string };
    const b = z.object({ amount_cents: z.number().int().positive('Amount must be positive'), reason: z.string().trim().min(3, 'A reason is required') }).parse(req.body);
    const inv = await getOr404<any>('invoices', ctx, id);
    const r = await tx(async c => {
      const res = await creditInvoice(c, ctx.orgId, id, b.amount_cents, b.reason, ctx.userId);
      await activity(ctx, 'invoice', id, 'system', `Credit note ${res.credit.number} for ${fmt(b.amount_cents, inv.currency)}`, b.reason, {}, c);
      await audit(ctx, 'invoice.credited', { type: 'invoice', id, label: inv.number }, { total_cents: inv.total_cents }, { total_cents: res.invoice.total_cents, credit_note: res.credit.number }, b.reason, c);
      return res;
    });
    if (r.invoice.status === 'paid' && inv.status !== 'paid') await onPaid(ctx, r.invoice);
    return r;
  });

  app.post('/api/v1/invoices/:id/write-off', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'approve');
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().trim().min(3, 'A reason is required') }).parse(req.body);
    const r = await tx(async c => {
      const res = await writeOff(c, ctx.orgId, id, reason, ctx.userId);
      await activity(ctx, 'invoice', id, 'status', `Invoice ${res.invoice.number} written off (${fmt(Number(res.credit.amount_cents), res.invoice.currency)})`, reason, {}, c);
      await audit(ctx, 'invoice.written_off', { type: 'invoice', id, label: res.invoice.number }, { status: res.before.status, balance_cents: balanceOf(res.before) }, { status: 'written_off', credit_note: res.credit.number }, reason, c);
      return res;
    });
    await lockTimesheets(pool, ctx.orgId, await timesheetIdsForInvoice(pool, id));
    return { invoice: r.invoice, credit: r.credit };
  });

  // Manual payment (ACH / wire / check / cash)
  app.post('/api/v1/invoices/:id/payments', async (req) => {
    const ctx = staff(req); need(ctx, 'payments', 'create');
    const { id } = req.params as { id: string };
    const b = z.object({ amount_cents: z.number().int().positive('Amount must be positive'), method: z.enum(['ach', 'wire', 'check', 'cash', 'card', 'manual']).default('ach'), reference: z.string().max(120).nullable().optional(), received_at: date.nullable().optional(), allow_overpay: z.boolean().optional(), idempotency_key: z.string().max(120).optional() }).parse(req.body);
    const inv = await getOr404<any>('invoices', ctx, id);
    const r = await tx(async c => {
      const res = await applyPayment(c, ctx.orgId, id, { amount_cents: b.amount_cents, method: b.method === 'card' ? 'manual' : b.method, provider: 'manual', provider_ref: b.reference ?? null, received_at: b.received_at ?? null, allow_overpay: b.allow_overpay, idempotency_key: b.idempotency_key ?? null, actorId: ctx.userId });
      if (!res.duplicate) {
        await activity(ctx, 'invoice', id, 'payment', `Payment of ${fmt(b.amount_cents, inv.currency)} recorded (${b.method.toUpperCase()}${b.reference ? ' ' + b.reference : ''})`, res.credit ? `Overpayment credit ${res.credit.number} created` : null, { payment_id: res.payment.id }, c);
        await audit(ctx, 'payment.recorded', { type: 'invoice', id, label: inv.number }, { paid_cents: inv.paid_cents, status: inv.status }, { paid_cents: res.invoice.paid_cents, status: res.invoice.status, amount_cents: b.amount_cents }, undefined, c);
      }
      return res;
    });
    if (!r.duplicate) await afterPayment(ctx.orgId, r.invoice, r.payment, inv.status);
    return r;
  });

  app.post('/api/v1/invoices/:id/sync', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const { id } = req.params as { id: string };
    const inv = await getOr404<any>('invoices', ctx, id);
    if (['draft', 'void'].includes(inv.status)) throw conflict('Approve the invoice before syncing it to accounting');
    const r = await syncEntity(ctx.orgId, 'invoice', id);
    await activity(ctx, 'invoice', id, 'system', r.log.status === 'synced' ? `Synced to QuickBooks (${r.log.external_id})` : `QuickBooks sync failed: ${r.log.error}`);
    return r;
  });

  app.get('/api/v1/credit-notes', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'view');
    const lp = listParams(req);
    const params: unknown[] = [ctx.orgId]; const where = ['n.organization_id=$1'];
    if (lp.filters.kind) { params.push(lp.filters.kind); where.push(`n.kind=$${params.length}`); }
    if (lp.filters.company_id) { params.push(lp.filters.company_id); where.push(`n.company_id=$${params.length}`); }
    return paged({ select: `n.*, co.name company_name, i.number invoice_number, u.name created_by_name`, from: `credit_notes n JOIN companies co ON co.id=n.company_id LEFT JOIN invoices i ON i.id=n.invoice_id LEFT JOIN users u ON u.id=n.created_by`, where, params, lp, searchCols: ['n.number', 'co.name', 'n.reason', 'i.number'], sortMap: { created_at: 'n.created_at', amount_cents: 'n.amount_cents' }, defaultSort: 'n.created_at DESC' });
  });

  // Daily overdue job (runs at boot, then hourly; transitions are idempotent).
  every('finance.invoices.overdue', 60 * 60 * 1000, async () => {
    const orgs = await q<any>(`SELECT id FROM organizations WHERE status <> 'deleted'`);
    for (const o of orgs) {
      const today = await orgToday(pool, o.id);
      const due = await q<any>(`UPDATE invoices SET status='overdue', overdue_at=now(), updated_at=now() WHERE organization_id=$1 AND status IN ('sent','viewed','partially_paid') AND due_date < $2 RETURNING *`, [o.id, today]);
      for (const inv of due) {
        await activity({ orgId: o.id, userId: null }, 'invoice', inv.id, 'status', `Invoice ${inv.number} is overdue`, `${fmt(balanceOf(inv), inv.currency)} outstanding, due ${prettyDate(inv.due_date)}`);
        const payload = await invoicePayload(inv);
        await emit(o.id, 'invoice.overdue', { ...payload, days_overdue: daysBetween(inv.due_date, today) });
        await notify(o.id, [...await financeUsers(o.id), payload.account_manager_id], { event: 'invoice.overdue', title: `Invoice ${inv.number} is overdue`, body: `${payload.company_name} — ${fmt(balanceOf(inv), inv.currency)} outstanding since ${prettyDate(inv.due_date)}`, link: `/finance/invoices/${inv.id}` });
        publishOrg(o.id, 'invoice', { id: inv.id, status: 'overdue' });
      }
    }
  });
}

/** Shared post-payment side effects (agency manual payments + public checkout). */
export async function afterPayment(orgId: string, invoice: any, payment: any, fromStatus: string) {
  const payload = await invoicePayload(invoice);
  const contact = await billingContact(pool, orgId, invoice.company_id);
  const to = payment.payer_email || contact?.email;
  if (to && payment.status === 'succeeded') await sendTemplate(orgId, 'payment_receipt', to, { payment: { receipt: payment.receipt_number, amount: fmt(Number(payment.amount_cents), payment.currency) }, invoice: { number: invoice.number }, contact: { firstName: contact?.first_name } }, { related: { type: 'invoice', id: invoice.id } });
  publishOrg(orgId, 'invoice', { id: invoice.id, status: invoice.status });
  if (invoice.status === 'paid' && fromStatus !== 'paid') await onPaid({ orgId, userId: payment.created_by } as any, invoice);
  else await notify(orgId, [...await financeUsers(orgId), payload.account_manager_id], { event: 'invoice.paid', title: `Partial payment on ${invoice.number}`, body: `${payload.company_name} paid ${fmt(Number(payment.amount_cents), payment.currency)} — ${fmt(balanceOf(invoice), invoice.currency)} still open`, link: `/finance/invoices/${invoice.id}` });
}

async function onPaid(ctx: Pick<Ctx, 'orgId' | 'userId'>, invoice: any) {
  const payload = await invoicePayload(invoice);
  await emit(ctx.orgId, 'invoice.paid', payload);
  await notify(ctx.orgId, [...await financeUsers(ctx.orgId), payload.account_manager_id], { event: 'invoice.paid', title: `Invoice ${invoice.number} paid in full`, body: `${payload.company_name} — ${fmt(Number(invoice.total_cents), invoice.currency)}`, link: `/finance/invoices/${invoice.id}` });
  await audit({ orgId: ctx.orgId, userId: ctx.userId ?? null, user: { name: ctx.userId ? undefined : 'System' }, impersonatorId: null, ip: '' } as any, 'invoice.paid', { type: 'invoice', id: invoice.id, label: invoice.number }, undefined, { total_cents: invoice.total_cents, paid_cents: invoice.paid_cents });
  await lockTimesheets(pool, ctx.orgId, await timesheetIdsForInvoice(pool, invoice.id));
}
