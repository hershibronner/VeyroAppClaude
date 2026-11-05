// Expenses domain service (explicit db so it runs inside transactions / rolled-back tests).
// Billable, approved expenses → invoice_lines kind 'reimbursement' (non-taxable) on a DRAFT invoice of the same client.
// (Payroll pickup of reimbursable expenses lives in ./payroll.ts.)
import { q, one, type Db } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { insertManualLine, recompute } from './invoices';
import { fmt, prettyDate } from './common';

/** Approved billable expenses for the invoice's client, same currency, not yet on any invoice. */
export function billableExpenses(db: Db, orgId: string, inv: { company_id: string; currency: string }, ids: string[] | null = null, lock = false) {
  return q<any>(`SELECT e.*, COALESCE(NULLIF(trim(cd.first_name || ' ' || COALESCE(cd.last_name,'')), ''), su.name) person_name
      FROM expenses e LEFT JOIN workers w ON w.id=e.worker_id LEFT JOIN candidates cd ON cd.id=w.candidate_id LEFT JOIN users su ON su.id=e.staff_user_id
      WHERE e.organization_id=$1 AND e.company_id=$2 AND e.billable_to_client AND e.status IN ('approved','reimbursed') AND e.invoice_id IS NULL AND e.currency=$3 ${ids ? 'AND e.id = ANY($4)' : ''}
      ORDER BY e.expense_date, e.created_at ${lock ? 'FOR UPDATE OF e' : ''}`, ids ? [orgId, inv.company_id, inv.currency, ids] : [orgId, inv.company_id, inv.currency], db);
}

/** Adds approved billable expenses (all, or the given ids) to a draft invoice and marks them invoiced. */
export async function addExpensesToInvoice(db: Db, orgId: string, actorId: string | null, invoiceId: string, ids: string[] | null) {
  const inv = await one<any>(`SELECT * FROM invoices WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [invoiceId, orgId], db);
  if (!inv) throw notFound();
  if (inv.status !== 'draft') throw conflict('Expenses can only be added to draft invoices');
  const rows = await billableExpenses(db, orgId, inv, ids?.length ? ids : null, true);
  if (!rows.length) throw badRequest('There are no approved billable expenses for this client that are not already invoiced');
  if (ids?.length && rows.length !== new Set(ids).size) throw conflict('Some selected expenses are no longer available to bill — refresh and try again');
  for (const e of rows) {
    const line = await insertManualLine(db, orgId, invoiceId, { kind: 'reimbursement', description: `Expense — ${e.person_name ?? 'Staff'}: ${e.description} (${e.category}, ${prettyDate(e.expense_date)})`.slice(0, 300), quantity: 1, unit_price_cents: Number(e.amount_cents), placement_id: e.placement_id });
    await q(`UPDATE invoice_lines SET worker_id=$2, period_start=$3, period_end=$3 WHERE id=$1`, [line.id, e.worker_id, e.expense_date], db);
    await q(`UPDATE expenses SET invoice_id=$2, invoice_line_id=$3, invoiced_at=now(), status='invoiced', updated_at=now() WHERE id=$1`, [e.id, invoiceId, line.id], db);
  }
  const total = rows.reduce((a, e) => a + Number(e.amount_cents), 0);
  const updated = await recompute(db, orgId, invoiceId, `Added ${rows.length} approved expense${rows.length === 1 ? '' : 's'} (${fmt(total, inv.currency)})`, actorId);
  return { before: inv, invoice: updated, expenses: rows, total_cents: total };
}
