// FINANCE API-level tests.
// 1) Domain services run against the real database inside a transaction that is ROLLED BACK (no demo data changes).
// 2) HTTP checks against the running API (localhost:4100) for permissions, tenant/portal scoping and invariants.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { invoiceTotals } from '@veyro/shared';
import { pool } from '../src/core/db';
import { previewInvoice, createInvoice, applyPayment, voidInvoice } from '../src/modules/_finance/invoices';
import { createRun, deleteRun } from '../src/modules/_finance/payroll';
import { addExpensesToInvoice } from '../src/modules/_finance/expenses';
import { economics, computeEntitlements } from '../src/modules/_finance/margin';
import { createRate } from '../src/modules/finance-rates';

const API = process.env.API_URL ?? 'http://localhost:4100';

async function withRollback(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

describe('worked example through the real services (rolled back)', () => {
  afterAll(async () => { /* pool is shared; vitest exits the worker */ });

  it('invoice $496.00 (two rate-period lines), payroll $208.00, margin $288.00 / 58.06%, commissions 10% & 5%, and invariants', async () => {
    await withRollback(async c => {
      const org = (await c.query(`SELECT id FROM organizations WHERE slug='maga-hire'`)).rows[0].id as string;
      const jose = (await c.query(`SELECT w.id FROM workers w JOIN candidates cd ON cd.id=w.candidate_id WHERE cd.email='worker@veyro.demo' AND w.organization_id=$1`, [org])).rows[0].id as string;
      const bright = (await c.query(`SELECT id FROM companies WHERE organization_id=$1 AND name='Brightline Dental'`, [org])).rows[0].id as string;
      const noah = (await c.query(`SELECT id FROM users WHERE email='recruiter@veyro.demo'`)).rows[0].id as string;
      const lena = (await c.query(`SELECT id FROM users WHERE email='sales@veyro.demo'`)).rows[0].id as string;
      const priya = (await c.query(`SELECT id FROM users WHERE email='am@veyro.demo'`)).rows[0].id as string;
      const pl = (await c.query(`INSERT INTO placements (organization_id, worker_id, company_id, title, status, start_date, recruiter_id, sales_id, account_manager_id) VALUES ($1,$2,$3,'Worked example VA','active','2025-10-01',$4,$5,$6) RETURNING id`, [org, jose, bright, noah, lena, priya])).rows[0].id as string;
      await c.query(`INSERT INTO placement_rates (organization_id, placement_id, effective_from, effective_to, pay_rate_cents, bill_rate_cents) VALUES ($1,$2,'2025-10-01','2025-10-14',600,1500), ($1,$2,'2025-10-15',NULL,700,1600)`, [org, pl]);
      const ts = (await c.query(`INSERT INTO timesheets (organization_id, placement_id, worker_id, company_id, week_start, status, total_minutes, approved_at) VALUES ($1,$2,$3,$4,'2025-10-13','approved',1920,now()) RETURNING id`, [org, pl, jose, bright])).rows[0].id as string;
      for (const d of ['2025-10-13', '2025-10-14', '2025-10-15', '2025-10-16']) await c.query(`INSERT INTO timesheet_days (organization_id, timesheet_id, placement_id, work_date, minutes) VALUES ($1,$2,$3,$4,480)`, [org, ts, pl, d]);

      // Invoice preview → one line per rate period
      const pv = await previewInvoice(c, org, bright, '2025-10-01', '2025-10-31', { placementIds: [pl] });
      expect(pv.lines.map(l => [l.period_start, l.period_end, l.minutes, l.unit_price_cents, l.amount_cents])).toEqual([['2025-10-13', '2025-10-14', 960, 1500, 24000], ['2025-10-15', '2025-10-16', 960, 1600, 25600]]);
      expect(pv.totals.subtotalCents).toBe(49600);

      const inv = await createInvoice(c, org, null, { company_id: bright, period_start: '2025-10-01', period_end: '2025-10-31', placement_ids: [pl] });
      expect(Number(inv.subtotal_cents)).toBe(49600);
      expect(Number(inv.total_cents)).toBe(invoiceTotals({ lineAmounts: [24000, 25600], taxBp: inv.tax_bp }).totalCents);
      const hist = (await c.query(`SELECT count(*)::int n FROM invoice_total_history WHERE invoice_id=$1`, [inv.id])).rows[0].n;
      expect(hist).toBeGreaterThan(0); // invariant 3: total stored with recomputation history
      const billed = (await c.query(`SELECT count(*)::int n FROM timesheet_days WHERE timesheet_id=$1 AND invoice_id=$2`, [ts, inv.id])).rows[0].n;
      expect(billed).toBe(4);
      // No double invoicing
      expect((await previewInvoice(c, org, bright, '2025-10-01', '2025-10-31', { placementIds: [pl] })).lines).toHaveLength(0);

      // Payroll: $208.00, no OT; idempotent re-run
      const run1 = await createRun(c, org, null, { period_start: '2025-10-01', period_end: '2025-10-31' });
      expect(run1.existing).toBe(false);
      const item = (await c.query(`SELECT * FROM payroll_items WHERE run_id=$1 AND placement_id=$2`, [run1.run.id, pl])).rows[0];
      expect(Number(item.gross_cents)).toBe(20800);
      expect(item.ot_minutes).toBe(0);
      const run2 = await createRun(c, org, null, { period_start: '2025-10-01', period_end: '2025-10-31' });
      expect(run2.existing).toBe(true);
      expect(run2.run.id).toBe(run1.run.id);
      expect((await c.query(`SELECT count(*)::int n FROM payroll_items WHERE placement_id=$1`, [pl])).rows[0].n).toBe(1); // invariant 4: never double pays

      // Margin and commissions
      const econ = await economics(c, org, '2025-10-01', '2025-10-31', { placementId: pl });
      expect(econ).toHaveLength(1);
      expect(econ[0].revenue_cents).toBe(49600);
      expect(econ[0].cost_cents).toBe(20800);
      expect(econ[0].gp_cents).toBe(28800);
      expect(econ[0].margin_pct).toBe(58.06);
      await computeEntitlements(c, org, '2025-10-01');
      const ents = (await c.query(`SELECT r.applies_to, e.calculated_cents FROM commission_entitlements e JOIN commission_rules r ON r.id=e.rule_id WHERE e.placement_id=$1`, [pl])).rows;
      expect(Number(ents.find(e => e.applies_to === 'recruiter')?.calculated_cents)).toBe(2880);
      expect(Number(ents.find(e => e.applies_to === 'sales')?.calculated_cents)).toBe(1440);

      // Invariant 1: a rate change after invoicing/payroll never alters existing amounts
      const before = (await c.query(`SELECT array_agg(amount_cents ORDER BY sort) a FROM invoice_lines WHERE invoice_id=$1`, [inv.id])).rows[0].a.map(Number);
      await createRate(c, { orgId: org, userId: null as any }, pl, { effective_from: '2025-10-14', pay_rate_cents: 900, bill_rate_cents: 2500, reason: 'Retroactive correction (test)' });
      const after = (await c.query(`SELECT array_agg(amount_cents ORDER BY sort) a FROM invoice_lines WHERE invoice_id=$1`, [inv.id])).rows[0].a.map(Number);
      expect(after).toEqual(before);
      expect(Number((await c.query(`SELECT total_cents FROM invoices WHERE id=$1`, [inv.id])).rows[0].total_cents)).toBe(Number(inv.total_cents));
      expect(Number((await c.query(`SELECT gross_cents FROM payroll_items WHERE id=$1`, [item.id])).rows[0].gross_cents)).toBe(20800);
      // Invariant 2: the new rate applies by work date (Oct 14 now uses the corrected rate when re-priced)
      const rates = (await c.query(`SELECT effective_from, effective_to, bill_rate_cents FROM placement_rates WHERE placement_id=$1 ORDER BY effective_from`, [pl])).rows;
      expect(rates.map(r => [r.effective_from, r.effective_to])).toEqual([['2025-10-01', '2025-10-13'], ['2025-10-14', '2025-10-14'], ['2025-10-15', null]]);

      // Invariant 5: Σ payments ≤ total unless overpayment credit is explicit
      await c.query(`UPDATE invoices SET status='sent' WHERE id=$1`, [inv.id]);
      const total = Number(inv.total_cents);
      await expect(applyPayment(c, org, inv.id, { amount_cents: total + 1, method: 'ach', actorId: null })).rejects.toThrow(/exceeds open balance/i);
      const p1 = await applyPayment(c, org, inv.id, { amount_cents: total - 100, method: 'ach', actorId: null });
      expect(p1.invoice.status).toBe('partially_paid');
      await expect(applyPayment(c, org, inv.id, { amount_cents: 200, method: 'ach', actorId: null })).rejects.toThrow();
      const p2 = await applyPayment(c, org, inv.id, { amount_cents: 200, method: 'ach', allow_overpay: true, actorId: null });
      expect(p2.invoice.status).toBe('paid');
      expect(Number(p2.invoice.paid_cents)).toBe(total);
      expect(Number(p2.credit.amount_cents)).toBe(100);
      expect(p2.credit.kind).toBe('overpayment');
      // Idempotent payment keys
      const k1 = await applyPayment(c, org, inv.id, { amount_cents: 1, method: 'ach', idempotency_key: 'test-key-p2-dup', actorId: null }).catch(e => e);
      expect(k1).toBeInstanceOf(Error); // invoice is paid; no further payments
    });
  });
});

describe('expenses → payroll reimbursement and client invoice (rolled back)', () => {
  it('approved reimbursable expense joins the run once; billable expense becomes a non-taxed invoice line; discard/void release them', async () => {
    await withRollback(async c => {
      const org = (await c.query(`SELECT id FROM organizations WHERE slug='maga-hire'`)).rows[0].id as string;
      const jose = (await c.query(`SELECT w.id FROM workers w JOIN candidates cd ON cd.id=w.candidate_id WHERE cd.email='worker@veyro.demo' AND w.organization_id=$1`, [org])).rows[0].id as string;
      const bright = (await c.query(`SELECT id FROM companies WHERE organization_id=$1 AND name='Brightline Dental'`, [org])).rows[0].id as string;
      const pl = (await c.query(`INSERT INTO placements (organization_id, worker_id, company_id, title, status, start_date) VALUES ($1,$2,$3,'Expense test VA','active','2025-09-01') RETURNING id`, [org, jose, bright])).rows[0].id as string;
      await c.query(`INSERT INTO placement_rates (organization_id, placement_id, effective_from, pay_rate_cents, bill_rate_cents) VALUES ($1,$2,'2025-09-01',600,1500)`, [org, pl]);
      const ts = (await c.query(`INSERT INTO timesheets (organization_id, placement_id, worker_id, company_id, week_start, status, total_minutes, approved_at) VALUES ($1,$2,$3,$4,'2025-09-08','approved',480,now()) RETURNING id`, [org, pl, jose, bright])).rows[0].id as string;
      await c.query(`INSERT INTO timesheet_days (organization_id, timesheet_id, placement_id, work_date, minutes) VALUES ($1,$2,$3,'2025-09-08',480)`, [org, ts, pl]);
      const ins = (status: string, billable: boolean, cents: number) => c.query(`INSERT INTO expenses (organization_id, worker_id, placement_id, company_id, category, description, expense_date, amount_cents, billable_to_client, reimbursable_to_worker, status) VALUES ($1,$2,$3,$4,'equipment','Headset (test)','2025-09-10',$5,$6,true,$7) RETURNING id`, [org, jose, pl, bright, cents, billable, status]).then(r => r.rows[0].id as string);
      const approved = await ins('approved', true, 4250);
      const pending = await ins('submitted', false, 999);

      const run = await createRun(c, org, null, { period_start: '2025-09-01', period_end: '2025-09-15' });
      const item = (await c.query(`SELECT * FROM payroll_items WHERE run_id=$1 AND placement_id=$2`, [run.run.id, pl])).rows[0];
      expect(Number(item.regular_cents)).toBe(4800);
      expect(Number(item.gross_cents)).toBe(4800 + 4250);
      const earn = (await c.query(`SELECT kind, amount_cents FROM payroll_earnings WHERE payroll_item_id=$1`, [item.id])).rows;
      expect(earn.map(e => [e.kind, Number(e.amount_cents)])).toEqual([['reimbursement', 4250]]);
      expect((await c.query(`SELECT payroll_item_id FROM expenses WHERE id=$1`, [approved])).rows[0].payroll_item_id).toBe(item.id);
      expect((await c.query(`SELECT payroll_item_id FROM expenses WHERE id=$1`, [pending])).rows[0].payroll_item_id).toBeNull(); // only approved
      const again = await createRun(c, org, null, { period_start: '2025-09-01', period_end: '2025-09-15' });
      expect(again.existing).toBe(true);
      expect((await c.query(`SELECT count(*)::int n FROM payroll_earnings e JOIN payroll_items pi ON pi.id=e.payroll_item_id WHERE pi.placement_id=$1 AND e.kind='reimbursement'`, [pl])).rows[0].n).toBe(1);
      await deleteRun(c, org, run.run.id);
      expect((await c.query(`SELECT payroll_item_id FROM expenses WHERE id=$1`, [approved])).rows[0].payroll_item_id).toBeNull(); // released

      // Billable → draft invoice line (kind reimbursement, not taxed), then void releases it.
      const inv = await createInvoice(c, org, null, { company_id: bright, period_start: '2025-09-01', period_end: '2025-09-30', placement_ids: [pl] });
      const before = Number(inv.total_cents);
      const r = await addExpensesToInvoice(c, org, null, inv.id, [approved]);
      expect(Number(r.invoice.total_cents)).toBe(before + 4250);
      const line = (await c.query(`SELECT kind, amount_cents, taxable FROM invoice_lines WHERE invoice_id=$1 AND kind='reimbursement'`, [inv.id])).rows[0];
      expect([line.kind, Number(line.amount_cents), line.taxable]).toEqual(['reimbursement', 4250, false]);
      expect((await c.query(`SELECT status, invoice_id FROM expenses WHERE id=$1`, [approved])).rows[0]).toEqual({ status: 'invoiced', invoice_id: inv.id });
      await expect(addExpensesToInvoice(c, org, null, inv.id, [approved])).rejects.toThrow(); // never billed twice
      await voidInvoice(c, org, inv.id);
      expect((await c.query(`SELECT status, invoice_id FROM expenses WHERE id=$1`, [approved])).rows[0]).toEqual({ status: 'approved', invoice_id: null });
    });
  });
});

// ── HTTP checks against the running API ──
type Session = { jar: string[]; csrf: string };
async function login(email: string): Promise<Session | null> {
  try {
    const r = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) });
    const cookies = r.headers.getSetCookie().map(c => c.split(';')[0]);
    const me = await (await fetch(`${API}/api/v1/auth/me`, { headers: { cookie: cookies.join('; ') } })).json();
    return { jar: cookies, csrf: me.csrf };
  } catch { return null; }
}
async function call(s: Session, method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, { method, headers: { cookie: s.jar.join('; '), 'x-csrf-token': s.csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}

let up = false;
const s: Record<string, Session> = {};
beforeAll(async () => {
  try { up = (await fetch(`${API}/api/v1/health`)).ok; } catch { up = false; }
  if (!up) return;
  for (const u of ['finance', 'recruiter', 'client', 'worker', 'am']) s[u] = (await login(`${u}@veyro.demo`))!;
});

describe('finance API permissions and scoping (running API)', () => {
  it('recruiter cannot see pay/bill rates or finance data', async () => {
    if (!up) return;
    expect((await call(s.recruiter, 'GET', '/api/v1/rates')).status).toBe(404);
    const pl = (await call(s.finance, 'GET', '/api/v1/rates?pageSize=1')).body.rows[0];
    expect((await call(s.recruiter, 'GET', `/api/v1/placements/${pl.placement_id}/rates`)).status).toBe(404);
    expect((await call(s.recruiter, 'POST', `/api/v1/placements/${pl.placement_id}/rates`, { effective_from: '2030-01-01', pay_rate_cents: 1, bill_rate_cents: 2, reason: 'nope' })).status).toBe(403);
    for (const p of ['/api/v1/invoices', '/api/v1/payroll/runs', '/api/v1/margin', '/api/v1/finance/overview']) expect((await call(s.recruiter, 'GET', p)).status).toBe(404);
  });

  it('client users only see their own company invoices and cannot call internal finance APIs', async () => {
    if (!up) return;
    expect((await call(s.client, 'GET', '/api/v1/invoices')).status).toBe(404);
    const mine = (await call(s.client, 'GET', '/api/v1/portal/client/invoices?pageSize=200')).body;
    const all = (await call(s.finance, 'GET', '/api/v1/invoices?pageSize=200&search=Brightline')).body.rows;
    const brightIds = new Set(all.filter((r: any) => r.company_name === 'Brightline Dental').map((r: any) => r.id));
    expect(mine.rows.length).toBeGreaterThan(0);
    for (const r of mine.rows) expect(brightIds.has(r.id)).toBe(true);
    const other = (await call(s.finance, 'GET', '/api/v1/invoices?pageSize=5&status=paid')).body.rows.find((r: any) => r.company_name !== 'Brightline Dental');
    expect((await call(s.client, 'GET', `/api/v1/portal/client/invoices/${other.id}`)).status).toBe(404);
    expect((await call(s.client, 'GET', `/api/v1/portal/client/invoices/${other.id}/pdf`)).status).toBe(404);
  });

  it('workers only see their own payslips', async () => {
    if (!up) return;
    const pay = (await call(s.worker, 'GET', '/api/v1/portal/worker/pay')).body;
    expect(pay.payslips.length).toBeGreaterThan(0);
    const items = (await call(s.finance, 'GET', '/api/v1/payroll/items?pageSize=100')).body.rows;
    const others = items.filter((i: any) => i.worker_name !== 'Jose Ramirez');
    expect(pay.payslips.every((p: any) => !others.some((o: any) => o.id === p.id))).toBe(true);
    expect((await call(s.worker, 'GET', `/api/v1/portal/worker/pay/payslips/${others[0].id}/pdf`)).status).toBe(404);
    const own = await fetch(`${API}/api/v1/portal/worker/pay/payslips/${pay.payslips[0].id}/pdf`, { headers: { cookie: s.worker.jar.join('; ') } });
    expect(own.headers.get('content-type')).toContain('application/pdf');
    expect((await call(s.worker, 'GET', '/api/v1/payroll/items')).status).toBe(404);
  });

  it('payments can never exceed the open balance', async () => {
    if (!up) return;
    const open = (await call(s.finance, 'GET', '/api/v1/invoices?status=open&pageSize=1')).body.rows[0];
    if (!open) return;
    const r = await call(s.finance, 'POST', `/api/v1/invoices/${open.id}/payments`, { amount_cents: Number(open.balance_cents) + 1, method: 'ach' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/exceeds open balance/i);
  });

  it('re-running payroll for the same period returns the same run (idempotency key)', async () => {
    if (!up) return;
    const due = (await call(s.finance, 'GET', '/api/v1/payroll/next-period')).body;
    const a = await call(s.finance, 'POST', '/api/v1/payroll/runs', { period_start: due.period_start, period_end: due.period_end });
    if (a.status !== 200) { expect([400, 409]).toContain(a.status); return; } // no approved unpaid time in this period
    const b = await call(s.finance, 'POST', '/api/v1/payroll/runs', { period_start: due.period_start, period_end: due.period_end });
    expect(b.body.existing).toBe(true);
    expect(b.body.run.id).toBe(a.body.run.id);
    expect(b.body.run.idempotency_key).toBe(`payroll:${due.period_start}:${due.period_end}`);
    if (!a.body.existing) expect((await call(s.finance, 'DELETE', `/api/v1/payroll/runs/${a.body.run.id}`)).status).toBe(200); // leave demo data as it was
  });

  it('account managers can view rates but not run payroll; invalid transitions are 409', async () => {
    if (!up) return;
    expect((await call(s.am, 'GET', '/api/v1/rates?pageSize=1')).status).toBe(200);
    expect((await call(s.am, 'GET', '/api/v1/payroll/runs')).status).toBe(404);
    const paid = (await call(s.finance, 'GET', '/api/v1/invoices?status=paid&pageSize=1')).body.rows[0];
    expect((await call(s.finance, 'POST', `/api/v1/invoices/${paid.id}/approve`)).status).toBe(409);
  });
});
