// FINANCE — Expenses: worker / staff expense claims with receipts, approval, payroll reimbursement and client re-billing.
// Integration:
//  • Approved + reimbursable worker expenses are pulled into the next payroll run as payroll_earnings kind 'reimbursement'
//    (see _finance/payroll.ts previewPayroll/createRun); when the worker's payout item is paid they become 'reimbursed'.
//  • Approved + billable expenses can be added to a DRAFT invoice of the same client as invoice_lines kind 'reimbursement'
//    (POST /api/v1/invoices/:id/expenses); they become 'invoiced'. Removing the line / voiding the draft releases them.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { z } from 'zod';
import { q, one, tx, pool, type Db } from '../core/db';
import { staff, auth, need, can, getOr404, type Ctx } from '../core/context';
import { badRequest, conflict, forbidden, notFound } from '../core/errors';
import { audit, activity } from '../core/audit';
import { notify } from '../core/notify';
import { listParams, paged } from '../core/list';
import { emit } from '../core/events';
import { saveFile, signedUrl } from '../core/storage';
import { onPayoutItemFinal } from '../adapters/payouts';
import { billableExpenses, addExpensesToInvoice } from './_finance/expenses';
import { financeUsers, fmt, orgToday, monthStart } from './_finance/common';

export const EXPENSE_CATEGORIES = ['software', 'equipment', 'internet', 'travel', 'training', 'other'] as const;
export const EXPENSE_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'reimbursed', 'invoiced'] as const;
const TRANSITIONS: Record<string, string[]> = { draft: ['submitted'], submitted: ['approved', 'rejected'], rejected: ['submitted'], approved: ['reimbursed', 'invoiced'], invoiced: ['reimbursed'], reimbursed: ['invoiced'] };
function assertExpenseTransition(from: string, to: string) {
  if (!(TRANSITIONS[from] ?? []).includes(to)) throw conflict(`Cannot move expense from ${from} to ${to}`, { allowed: TRANSITIONS[from] ?? [] });
}
const RECEIPT_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp']);
const MAX_RECEIPT = 10 * 1024 * 1024;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const boolish = z.union([z.boolean(), z.enum(['true', 'false', '1', '0', 'on', 'off'])]).transform(v => v === true || v === 'true' || v === '1' || v === 'on');
const amount = z.coerce.number({ invalid_type_error: 'Enter an amount' }).int('Amount must be in whole cents').positive('Amount must be greater than zero').max(10_000_000, 'Amount is too large');

// ── Permissions ──
const canView = (ctx: Ctx) => can(ctx, 'payroll', 'view') || can(ctx, 'invoices', 'view');
const canApprove = (ctx: Ctx) => can(ctx, 'payroll', 'approve') || can(ctx, 'invoices', 'approve');
const canCreate = (ctx: Ctx) => can(ctx, 'payroll', 'create') || can(ctx, 'invoices', 'create') || can(ctx, 'workers', 'edit');
function viewer(req: FastifyRequest) { const ctx = staff(req); if (!canView(ctx)) throw notFound(); return ctx; }
function approver(req: FastifyRequest) { const ctx = viewer(req); if (!canApprove(ctx)) throw forbidden('You need payroll or invoice approval permission to decide expenses'); return ctx; }
function workerCtx(req: FastifyRequest) { const ctx = auth(req); if (ctx.role.kind !== 'worker' || !ctx.workerId) throw notFound(); return ctx; }

const SELECT = `e.*, COALESCE(NULLIF(trim(cd.first_name || ' ' || COALESCE(cd.last_name,'')), ''), su.name) person_name, CASE WHEN e.worker_id IS NULL THEN 'staff' ELSE 'worker' END person_kind,
  w.employee_code, w.user_id worker_user_id, co.name company_name, p.title placement_title, sb.name submitted_by_name, db.name decided_by_name, i.number invoice_number, i.status invoice_status,
  r.id payroll_run_id, r.period_start payroll_period_start, r.period_end payroll_period_end, r.status payroll_run_status`;
const FROM = `expenses e LEFT JOIN workers w ON w.id=e.worker_id LEFT JOIN candidates cd ON cd.id=w.candidate_id LEFT JOIN users su ON su.id=e.staff_user_id
  LEFT JOIN companies co ON co.id=e.company_id LEFT JOIN placements p ON p.id=e.placement_id LEFT JOIN users sb ON sb.id=e.submitted_by LEFT JOIN users db ON db.id=e.decided_by
  LEFT JOIN invoices i ON i.id=e.invoice_id LEFT JOIN payroll_items pi ON pi.id=e.payroll_item_id LEFT JOIN payroll_runs r ON r.id=pi.run_id`;

/** Adds a short-lived signed receipt URL. Only call after the caller's permission / ownership check. */
function present(row: any) {
  if (!row) return row;
  const ext = path.extname(row.receipt_file ?? '');
  return { ...row, amount_cents: Number(row.amount_cents), receipt_url: row.receipt_file ? signedUrl(row.receipt_file, 900) : null, receipt_download_url: row.receipt_file ? signedUrl(row.receipt_file, 900, { download: row.receipt_name ?? `receipt${ext}` }) : null, receipt_file: undefined, payroll_earning_id: undefined };
}
async function loadOne(orgId: string, id: string, db: Db = pool) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const r = await one<any>(`SELECT ${SELECT} FROM ${FROM} WHERE e.id=$1 AND e.organization_id=$2`, [id, orgId], db);
  if (!r) throw notFound();
  return r;
}

/** Reads a multipart (or JSON) body: optional receipt file + fields. */
async function readBody(req: FastifyRequest): Promise<{ fields: Record<string, any>; file: { filename: string; buf: Buffer } | null }> {
  if (!req.isMultipart()) return { fields: (req.body ?? {}) as Record<string, any>, file: null };
  const fields: Record<string, any> = {}; let file: { filename: string; buf: Buffer } | null = null;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buf = await part.toBuffer();
      if (!buf.length) continue;
      if (buf.length > MAX_RECEIPT) throw badRequest('Receipt is larger than 10 MB', { receipt: 'Max 10 MB' });
      const ext = path.extname(part.filename).slice(1).toLowerCase();
      if (!RECEIPT_EXT.has(ext)) throw badRequest('Receipts must be a PDF or an image (PNG, JPG, WEBP)', { receipt: 'Use PDF, PNG, JPG or WEBP' });
      file = { filename: part.filename, buf };
    } else fields[part.fieldname] = String((part as any).value ?? '');
  }
  return { fields, file };
}
const blankToUndef = (v: unknown) => (v === '' || v === 'null' || v === null ? undefined : v);
const baseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES, { errorMap: () => ({ message: 'Choose a category' }) }),
  description: z.string().trim().min(3, 'Describe the expense').max(300),
  expense_date: date,
  amount_cents: amount,
  currency: z.preprocess(blankToUndef, z.string().length(3).toUpperCase().optional()),
  placement_id: z.preprocess(blankToUndef, z.string().uuid().optional()),
  status: z.preprocess(blankToUndef, z.enum(['draft', 'submitted']).optional()),
});
const staffSchema = baseSchema.extend({
  worker_id: z.preprocess(blankToUndef, z.string().uuid().optional()),
  staff_user_id: z.preprocess(blankToUndef, z.string().uuid().optional()),
  company_id: z.preprocess(blankToUndef, z.string().uuid().optional()),
  billable_to_client: z.preprocess(blankToUndef, boolish.optional()),
  reimbursable_to_worker: z.preprocess(blankToUndef, boolish.optional()),
});

async function personLabel(orgId: string, e: any) {
  if (e.worker_id) { const w = await one<any>(`SELECT cd.first_name || ' ' || COALESCE(cd.last_name,'') n FROM workers w JOIN candidates cd ON cd.id=w.candidate_id WHERE w.id=$1 AND w.organization_id=$2`, [e.worker_id, orgId]); return w?.n?.trim() ?? 'Worker'; }
  if (e.staff_user_id) return (await one<any>(`SELECT name FROM users WHERE id=$1`, [e.staff_user_id]))?.name ?? 'Staff';
  return 'Staff';
}

/** Validates and inserts an expense (shared by staff create and worker submit). */
async function insertExpense(ctx: Ctx, input: z.infer<typeof staffSchema>, file: { filename: string; buf: Buffer } | null, opts: { forWorker?: string }) {
  const today = await orgToday(pool, ctx.orgId);
  if (input.expense_date > today) throw badRequest('Expense date cannot be in the future', { expense_date: 'Cannot be in the future' });
  const workerId = opts.forWorker ?? input.worker_id ?? null;
  let staffUserId: string | null = null;
  if (workerId) await getOr404('workers', ctx, workerId);
  else {
    staffUserId = input.staff_user_id ?? ctx.userId;
    const m = await one<any>(`SELECT 1 FROM organization_memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='active' AND r.kind='agency'`, [ctx.orgId, staffUserId]);
    if (!m) throw badRequest('Choose a team member or worker', { staff_user_id: 'Not a member of this workspace' });
  }
  let placementId = input.placement_id ?? null; let companyId = input.company_id ?? null; let currency = input.currency ?? null;
  if (placementId) {
    const pl = await one<any>(`SELECT p.id, p.worker_id, p.company_id, (SELECT r.currency FROM placement_rates r WHERE r.placement_id=p.id ORDER BY r.effective_from DESC LIMIT 1) currency FROM placements p WHERE p.id=$1 AND p.organization_id=$2`, [placementId, ctx.orgId]);
    if (!pl || (workerId && pl.worker_id !== workerId)) throw badRequest('Choose one of this worker’s placements', { placement_id: 'Not a placement of this worker' });
    companyId = companyId ?? pl.company_id; currency = currency ?? pl.currency;
  } else if (workerId) {
    const pl = await one<any>(`SELECT p.id, p.company_id, (SELECT r.currency FROM placement_rates r WHERE r.placement_id=p.id ORDER BY r.effective_from DESC LIMIT 1) currency FROM placements p WHERE p.worker_id=$1 AND p.organization_id=$2 ORDER BY (p.status='active') DESC, p.start_date DESC LIMIT 1`, [workerId, ctx.orgId]);
    if (pl) { placementId = pl.id; companyId = companyId ?? pl.company_id; currency = currency ?? pl.currency; }
  }
  if (companyId) await getOr404('companies', ctx, companyId);
  const billable = input.billable_to_client ?? false;
  if (billable && !companyId) throw badRequest('Choose the client to bill', { company_id: 'Required for billable expenses' });
  const reimbursable = input.reimbursable_to_worker ?? true;
  if (!currency) currency = (await one<any>(`SELECT default_currency FROM organizations WHERE id=$1`, [ctx.orgId]))!.default_currency ?? 'USD';
  const status = input.status ?? 'submitted';
  const receipt = file ? saveFile(`uploads/receipts/${ctx.orgId}`, file.filename, file.buf) : null;
  const row = (await q<any>(`INSERT INTO expenses (organization_id, worker_id, placement_id, submitted_by, staff_user_id, company_id, category, description, expense_date, amount_cents, currency, receipt_file, receipt_name, billable_to_client, reimbursable_to_worker, status, submitted_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, CASE WHEN $16='submitted' THEN now() END) RETURNING *`,
    [ctx.orgId, workerId, placementId, ctx.userId, staffUserId, companyId, input.category, input.description, input.expense_date, input.amount_cents, currency, receipt, file?.filename ?? null, billable, reimbursable, status]))[0];
  const who = await personLabel(ctx.orgId, row);
  if (workerId) await activity(ctx, 'worker', workerId, 'system', `Expense ${status === 'draft' ? 'drafted' : 'submitted'}: ${fmt(Number(row.amount_cents), row.currency)} ${input.category} — ${input.description}`, null, { expense_id: row.id });
  if (status === 'submitted') await notifySubmitted(ctx, row, who);
  return row;
}

async function notifySubmitted(ctx: Ctx, row: any, who: string) {
  await notify(ctx.orgId, (await financeUsers(ctx.orgId)).filter(u => u !== ctx.userId), { event: 'expense.submitted', title: `Expense to review: ${who} · ${fmt(Number(row.amount_cents), row.currency)}`, body: `${row.category} — ${row.description}`, link: `/finance/expenses?status=submitted` });
  await emit(ctx.orgId, 'expense.submitted', { expense_id: row.id, worker_id: row.worker_id, worker_name: who, company_id: row.company_id, amount_cents: Number(row.amount_cents), currency: row.currency, category: row.category });
}

/** Approve or reject one expense inside a transaction (row-locked). */
async function decide(ctx: Ctx, c: Db, id: string, to: 'approved' | 'rejected', note: string | null, flags: { billable_to_client?: boolean; reimbursable_to_worker?: boolean } = {}) {
  const e = await one<any>(`SELECT * FROM expenses WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, ctx.orgId], c);
  if (!e) throw notFound();
  assertExpenseTransition(e.status, to);
  const billable = flags.billable_to_client ?? e.billable_to_client;
  if (to === 'approved' && billable && !e.company_id) throw badRequest('This expense has no client to bill', { billable_to_client: 'No client on this expense' });
  const upd = (await q<any>(`UPDATE expenses SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4, billable_to_client=$5, reimbursable_to_worker=$6, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, to, ctx.userId, note, billable, flags.reimbursable_to_worker ?? e.reimbursable_to_worker], c))[0];
  const who = await personLabel(ctx.orgId, e);
  const label = `${who} · ${fmt(Number(e.amount_cents), e.currency)} ${e.category}`;
  if (e.worker_id) await activity(ctx, 'worker', e.worker_id, 'status', `Expense ${to}: ${fmt(Number(e.amount_cents), e.currency)} ${e.category} — ${e.description}`, note, { expense_id: id }, c);
  await audit(ctx, `expense.${to}`, { type: 'expense', id, label }, { status: e.status }, { status: to, amount_cents: Number(e.amount_cents), billable_to_client: upd.billable_to_client, reimbursable_to_worker: upd.reimbursable_to_worker }, note ?? undefined, c);
  return { before: e, after: upd, who };
}
async function afterDecision(ctx: Ctx, d: { after: any; who: string }) {
  const e = d.after;
  const worker = e.worker_id ? await one<any>(`SELECT user_id FROM workers WHERE id=$1`, [e.worker_id]) : null;
  const recipients = [...new Set([e.submitted_by, worker?.user_id, e.staff_user_id].filter(u => u && u !== ctx.userId))];
  const amt = fmt(Number(e.amount_cents), e.currency);
  const isWorkerLink = (u: string) => u === worker?.user_id;
  for (const u of recipients) {
    await notify(ctx.orgId, [u], e.status === 'approved'
      ? { event: 'expense.approved', title: `Expense approved: ${amt}`, body: `${e.description}${e.reimbursable_to_worker && e.worker_id ? ' — it will be reimbursed in your next payroll.' : ''}`, link: isWorkerLink(u) ? '/portal/worker/expenses' : '/finance/expenses' }
      : { event: 'expense.rejected', title: `Expense rejected: ${amt}`, body: `${e.description} — ${e.decision_note}`, link: isWorkerLink(u) ? '/portal/worker/expenses' : '/finance/expenses' });
  }
  await emit(ctx.orgId, `expense.${e.status}`, { expense_id: e.id, worker_id: e.worker_id, worker_name: d.who, company_id: e.company_id, amount_cents: Number(e.amount_cents), currency: e.currency, decided_by: ctx.userId, reason: e.decision_note });
}

export default async function (app: FastifyInstance) {
  // Paid payout item → its expense reimbursements are reimbursed.
  onPayoutItemFinal(async (orgId, item, payout) => {
    if (payout.kind !== 'payroll' || item.status !== 'paid' || !item.payroll_item_id) return;
    const rows = await q<any>(`UPDATE expenses SET status='reimbursed', reimbursed_at=now(), updated_at=now() WHERE organization_id=$1 AND payroll_item_id=$2 AND reimbursed_at IS NULL AND status IN ('approved','invoiced') RETURNING *`, [orgId, item.payroll_item_id]);
    if (!rows.length) return;
    const w = await one<any>(`SELECT user_id FROM workers WHERE id=$1`, [rows[0].worker_id]);
    const total = rows.reduce((a, r) => a + Number(r.amount_cents), 0);
    for (const r of rows) await activity({ orgId, userId: null }, 'worker', r.worker_id, 'system', `Expense reimbursed in payroll: ${fmt(Number(r.amount_cents), r.currency)} — ${r.description}`, null, { expense_id: r.id, payroll_item_id: item.payroll_item_id });
    if (w?.user_id) await notify(orgId, [w.user_id], { event: 'expense.reimbursed', title: `${rows.length} expense${rows.length === 1 ? '' : 's'} reimbursed`, body: `${fmt(total, rows[0].currency)} was included in your pay.`, link: '/portal/worker/expenses' });
  });

  // ── Staff: list ──
  app.get('/api/v1/finance/expenses', async (req) => {
    const ctx = viewer(req);
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId]; const where = ['e.organization_id=$1'];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (f.status === 'pending') where.push(`e.status='submitted'`);
    else if (f.status === 'open') where.push(`e.status IN ('draft','submitted')`);
    else if (f.status) add('e.status=?', f.status);
    if (f.category) add('e.category=?', f.category);
    if (f.worker_id) add('e.worker_id=?', f.worker_id);
    if (f.company_id) add('e.company_id=?', f.company_id);
    if (f.from) add('e.expense_date>=?', f.from);
    if (f.to) add('e.expense_date<=?', f.to);
    if (f.kind === 'worker') where.push('e.worker_id IS NOT NULL'); else if (f.kind === 'staff') where.push('e.worker_id IS NULL');
    if (f.billable === 'true') where.push('e.billable_to_client');
    if (f.billable === 'uninvoiced') where.push(`e.billable_to_client AND e.status IN ('approved','reimbursed') AND e.invoice_id IS NULL`);
    if (f.reimbursable === 'pending') where.push(`e.reimbursable_to_worker AND e.status IN ('approved','invoiced') AND e.reimbursed_at IS NULL`);
    if (f.decided === 'this_month') { add(`e.decided_at::date >= ?::date AND e.status IN ('approved','reimbursed','invoiced')`, monthStart(await orgToday(pool, ctx.orgId))); }
    if (f.reimbursed === 'this_month') add('e.reimbursed_at::date >= ?::date', monthStart(await orgToday(pool, ctx.orgId)));
    const res = await paged({ select: SELECT, from: FROM, where, params, lp,
      searchCols: ['e.description', 'cd.first_name', 'cd.last_name', 'su.name', 'co.name', 'e.category'],
      sortMap: { expense_date: 'e.expense_date', amount_cents: 'e.amount_cents', person_name: 'person_name', company_name: 'co.name', status: 'e.status', category: 'e.category', created_at: 'e.created_at' },
      defaultSort: `CASE e.status WHEN 'submitted' THEN 0 ELSE 1 END, e.expense_date DESC, e.created_at DESC` });
    return { ...res, rows: res.rows.map(present) };
  });

  app.get('/api/v1/finance/expenses/summary', async (req) => {
    const ctx = viewer(req);
    const today = await orgToday(pool, ctx.orgId);
    const ms = monthStart(today);
    const s = await one<any>(`SELECT
        count(*) FILTER (WHERE status='submitted')::int pending_count, COALESCE(sum(amount_cents) FILTER (WHERE status='submitted'),0)::bigint pending_cents,
        min(submitted_at) FILTER (WHERE status='submitted') oldest_pending_at,
        count(*) FILTER (WHERE decided_at::date >= $2::date AND status IN ('approved','reimbursed','invoiced'))::int approved_month_count,
        COALESCE(sum(amount_cents) FILTER (WHERE decided_at::date >= $2::date AND status IN ('approved','reimbursed','invoiced')),0)::bigint approved_month_cents,
        count(*) FILTER (WHERE reimbursed_at::date >= $2::date)::int reimbursed_mtd_count, COALESCE(sum(amount_cents) FILTER (WHERE reimbursed_at::date >= $2::date),0)::bigint reimbursed_mtd_cents,
        count(*) FILTER (WHERE billable_to_client AND status IN ('approved','reimbursed') AND invoice_id IS NULL)::int billable_count,
        COALESCE(sum(amount_cents) FILTER (WHERE billable_to_client AND status IN ('approved','reimbursed') AND invoice_id IS NULL),0)::bigint billable_cents,
        count(DISTINCT company_id) FILTER (WHERE billable_to_client AND status IN ('approved','reimbursed') AND invoice_id IS NULL)::int billable_clients,
        count(*) FILTER (WHERE reimbursable_to_worker AND worker_id IS NOT NULL AND status IN ('approved','invoiced') AND payroll_item_id IS NULL)::int awaiting_payroll_count,
        COALESCE(sum(amount_cents) FILTER (WHERE reimbursable_to_worker AND worker_id IS NOT NULL AND status IN ('approved','invoiced') AND payroll_item_id IS NULL),0)::bigint awaiting_payroll_cents,
        count(*) FILTER (WHERE status='submitted' AND receipt_file IS NULL)::int pending_without_receipt
      FROM expenses WHERE organization_id=$1`, [ctx.orgId, ms]);
    const cur = (await one<any>(`SELECT default_currency FROM organizations WHERE id=$1`, [ctx.orgId]))!.default_currency ?? 'USD';
    const n = (k: string) => Number(s![k]);
    return {
      currency: cur, month_start: ms, today,
      pending: { count: s!.pending_count, cents: n('pending_cents'), oldest_at: s!.oldest_pending_at, without_receipt: s!.pending_without_receipt },
      approved_this_month: { count: s!.approved_month_count, cents: n('approved_month_cents') },
      reimbursed_mtd: { count: s!.reimbursed_mtd_count, cents: n('reimbursed_mtd_cents') },
      billable_uninvoiced: { count: s!.billable_count, cents: n('billable_cents'), clients: s!.billable_clients },
      awaiting_payroll: { count: s!.awaiting_payroll_count, cents: n('awaiting_payroll_cents') },
      can: { approve: canApprove(ctx), create: canCreate(ctx) },
    };
  });

  app.get('/api/v1/finance/expenses/:id', async (req) => {
    const ctx = viewer(req);
    return { expense: present(await loadOne(ctx.orgId, (req.params as any).id)), can: { approve: canApprove(ctx) } };
  });

  // ── Staff: create (on behalf of a worker, or an internal staff expense). Multipart with optional `receipt` file, or JSON. ──
  app.post('/api/v1/finance/expenses', async (req) => {
    const ctx = viewer(req);
    if (!canCreate(ctx)) throw forbidden('You do not have permission to add expenses');
    const { fields, file } = await readBody(req);
    const input = staffSchema.parse(fields);
    const row = await insertExpense(ctx, input, file, {});
    await audit(ctx, 'expense.created', { type: 'expense', id: row.id, label: `${await personLabel(ctx.orgId, row)} · ${fmt(Number(row.amount_cents), row.currency)}` }, undefined, { amount_cents: Number(row.amount_cents), category: row.category, status: row.status, worker_id: row.worker_id });
    return { expense: present(await loadOne(ctx.orgId, row.id)) };
  });

  app.post('/api/v1/finance/expenses/:id/submit', async (req) => {
    const ctx = viewer(req);
    if (!canCreate(ctx)) throw forbidden();
    const { id } = req.params as { id: string };
    const e = await getOr404<any>('expenses', ctx, id);
    assertExpenseTransition(e.status, 'submitted');
    const row = (await q<any>(`UPDATE expenses SET status='submitted', submitted_at=now(), decided_by=NULL, decided_at=NULL, decision_note=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [id]))[0];
    await notifySubmitted(ctx, row, await personLabel(ctx.orgId, row));
    return { expense: present(await loadOne(ctx.orgId, id)) };
  });

  const flagsSchema = z.object({ note: z.string().trim().max(500).optional(), billable_to_client: z.boolean().optional(), reimbursable_to_worker: z.boolean().optional() });
  app.post('/api/v1/finance/expenses/:id/approve', async (req) => {
    const ctx = approver(req);
    const { id } = req.params as { id: string };
    await getOr404('expenses', ctx, id);
    const b = flagsSchema.parse(req.body ?? {});
    const d = await tx(c => decide(ctx, c, id, 'approved', b.note || null, b));
    await afterDecision(ctx, d);
    return { expense: present(await loadOne(ctx.orgId, id)) };
  });

  app.post('/api/v1/finance/expenses/:id/reject', async (req) => {
    const ctx = approver(req);
    const { id } = req.params as { id: string };
    await getOr404('expenses', ctx, id);
    const { reason } = z.object({ reason: z.string({ required_error: 'A reason is required' }).trim().min(3, 'A reason is required').max(500) }).parse(req.body ?? {});
    const d = await tx(c => decide(ctx, c, id, 'rejected', reason));
    await afterDecision(ctx, d);
    return { expense: present(await loadOne(ctx.orgId, id)) };
  });

  app.post('/api/v1/finance/expenses/bulk-approve', async (req) => {
    const ctx = approver(req);
    const { ids, note } = z.object({ ids: z.array(z.string().uuid()).min(1, 'Select at least one expense').max(500), note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    const rows = await q<any>(`SELECT id, status FROM expenses WHERE organization_id=$1 AND id = ANY($2)`, [ctx.orgId, ids]);
    if (rows.length !== new Set(ids).size) throw notFound();
    const eligible = rows.filter(r => r.status === 'submitted').map(r => r.id);
    const skipped = rows.length - eligible.length;
    const decided = await tx(async c => { const out = []; for (const id of eligible) out.push(await decide(ctx, c, id, 'approved', note || null)); return out; });
    for (const d of decided) await afterDecision(ctx, d);
    if (decided.length) await audit(ctx, 'expense.bulk_approved', { type: 'expense', label: `${decided.length} expenses` }, undefined, { ids: eligible, total_cents: decided.reduce((a, d) => a + Number(d.after.amount_cents), 0) }, note);
    return { approved: decided.length, skipped };
  });

  // Internal (staff) expenses are not paid through payroll — mark them reimbursed manually once paid.
  app.post('/api/v1/finance/expenses/:id/mark-reimbursed', async (req) => {
    const ctx = approver(req);
    const { id } = req.params as { id: string };
    const e = await getOr404<any>('expenses', ctx, id);
    if (e.worker_id) throw conflict('Worker expenses are reimbursed automatically through payroll');
    if (!e.reimbursable_to_worker) throw conflict('This expense is not reimbursable');
    if (e.reimbursed_at) throw conflict('Already reimbursed');
    assertExpenseTransition(e.status, 'reimbursed');
    await q(`UPDATE expenses SET status='reimbursed', reimbursed_at=now(), updated_at=now() WHERE id=$1`, [id]);
    await audit(ctx, 'expense.reimbursed', { type: 'expense', id, label: `${await personLabel(ctx.orgId, e)} · ${fmt(Number(e.amount_cents), e.currency)}` }, { status: e.status }, { status: 'reimbursed' });
    if (e.staff_user_id && e.staff_user_id !== ctx.userId) await notify(ctx.orgId, [e.staff_user_id], { event: 'expense.reimbursed', title: `Expense reimbursed: ${fmt(Number(e.amount_cents), e.currency)}`, body: e.description, link: '/finance/expenses' });
    return { expense: present(await loadOne(ctx.orgId, id)) };
  });

  // ── Invoices: approved billable expenses for a draft invoice's client ──
  app.get('/api/v1/invoices/:id/billable-expenses', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'view');
    const inv = await getOr404<any>('invoices', ctx, (req.params as any).id);
    const rows = await billableExpenses(pool, ctx.orgId, inv);
    return { rows: rows.map(present), total_cents: rows.reduce((a, r) => a + Number(r.amount_cents), 0), currency: inv.currency, can_add: inv.status === 'draft' && can(ctx, 'invoices', 'edit') };
  });

  app.post('/api/v1/invoices/:id/expenses', async (req) => {
    const ctx = staff(req); need(ctx, 'invoices', 'edit');
    const { id } = req.params as { id: string };
    await getOr404<any>('invoices', ctx, id);
    const { expense_ids } = z.object({ expense_ids: z.array(z.string().uuid()).max(500).optional() }).parse(req.body ?? {});
    return tx(async c => {
      const r = await addExpensesToInvoice(c, ctx.orgId, ctx.userId, id, expense_ids ?? null);
      const n = r.expenses.length; const ids = r.expenses.map(e => e.id);
      await activity(ctx, 'invoice', id, 'system', `Added ${n} approved expense${n === 1 ? '' : 's'} as reimbursement lines (${fmt(r.total_cents, r.invoice.currency)})`, null, { expense_ids: ids }, c);
      await audit(ctx, 'invoice.expenses_added', { type: 'invoice', id, label: r.before.number }, { total_cents: r.before.total_cents }, { total_cents: r.invoice.total_cents, expense_ids: ids }, undefined, c);
      return { invoice: r.invoice, added: n, total_cents: r.total_cents };
    });
  });

  // ── Worker portal ──
  app.get('/api/v1/portal/worker/expenses', async (req) => {
    const ctx = workerCtx(req);
    const lp = listParams(req); const f = lp.filters;
    const params: unknown[] = [ctx.orgId, ctx.workerId]; const where = ['e.organization_id=$1', 'e.worker_id=$2'];
    if (f.status) { params.push(f.status); where.push(`e.status=$${params.length}`); }
    const res = await paged({ select: `e.id, e.category, e.description, e.expense_date, e.amount_cents, e.currency, e.status, e.receipt_file, e.receipt_name, e.reimbursable_to_worker, e.submitted_at, e.decided_at, e.decision_note, e.reimbursed_at, e.created_at, co.name company_name, p.title placement_title, r.pay_date payroll_pay_date, r.period_start payroll_period_start, r.period_end payroll_period_end`,
      from: `expenses e LEFT JOIN companies co ON co.id=e.company_id LEFT JOIN placements p ON p.id=e.placement_id LEFT JOIN payroll_items pi ON pi.id=e.payroll_item_id LEFT JOIN payroll_runs r ON r.id=pi.run_id`,
      where, params, lp, searchCols: ['e.description', 'e.category'], sortMap: { expense_date: 'e.expense_date', amount_cents: 'e.amount_cents', status: 'e.status' }, defaultSort: 'e.expense_date DESC, e.created_at DESC' });
    const year = (await orgToday(pool, ctx.orgId)).slice(0, 4);
    const s = await one<any>(`SELECT COALESCE(sum(amount_cents) FILTER (WHERE status='submitted'),0)::bigint pending_cents, count(*) FILTER (WHERE status='submitted')::int pending_count,
        COALESCE(sum(amount_cents) FILTER (WHERE status IN ('approved','invoiced') AND reimbursable_to_worker AND reimbursed_at IS NULL),0)::bigint approved_unpaid_cents,
        COALESCE(sum(amount_cents) FILTER (WHERE reimbursed_at IS NOT NULL AND to_char(reimbursed_at,'YYYY')=$3),0)::bigint reimbursed_ytd_cents
      FROM expenses WHERE organization_id=$1 AND worker_id=$2`, [ctx.orgId, ctx.workerId, year]);
    const placements = await q<any>(`SELECT p.id, p.title, co.name company_name, p.status FROM placements p JOIN companies co ON co.id=p.company_id WHERE p.organization_id=$1 AND p.worker_id=$2 AND p.status IN ('active','onboarding','ended') ORDER BY (p.status='active') DESC, p.start_date DESC`, [ctx.orgId, ctx.workerId]);
    const cur = (await one<any>(`SELECT default_currency FROM organizations WHERE id=$1`, [ctx.orgId]))!.default_currency ?? 'USD';
    return { ...res, rows: res.rows.map(present), summary: { currency: cur, pending_cents: Number(s!.pending_cents), pending_count: s!.pending_count, approved_unpaid_cents: Number(s!.approved_unpaid_cents), reimbursed_ytd_cents: Number(s!.reimbursed_ytd_cents), year }, placements, categories: EXPENSE_CATEGORIES };
  });

  app.post('/api/v1/portal/worker/expenses', async (req) => {
    const ctx = workerCtx(req);
    const { fields, file } = await readBody(req);
    const input = baseSchema.parse(fields);
    if (!file) throw badRequest('Attach a receipt (PDF or photo)', { receipt: 'A receipt is required' });
    const row = await insertExpense(ctx, { ...input, status: 'submitted', billable_to_client: false, reimbursable_to_worker: true }, file, { forWorker: ctx.workerId! });
    const out = await one<any>(`SELECT e.*, co.name company_name, p.title placement_title FROM expenses e LEFT JOIN companies co ON co.id=e.company_id LEFT JOIN placements p ON p.id=e.placement_id WHERE e.id=$1`, [row.id]);
    return { expense: present(out) };
  });
}
