-- FINANCE: worker / staff expenses (additive only).
-- Approved reimbursable expenses are pulled into the next payroll run (payroll_earnings kind 'reimbursement');
-- approved billable expenses can be added to a draft invoice for the client (invoice_lines kind 'reimbursement').
CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id uuid REFERENCES workers(id),
  placement_id uuid REFERENCES placements(id),
  submitted_by uuid REFERENCES users(id),
  staff_user_id uuid REFERENCES users(id), -- internal (staff) expense owner; NULL for worker expenses
  company_id uuid REFERENCES companies(id),
  category text NOT NULL DEFAULT 'other' CHECK (category IN ('software','equipment','internet','travel','training','other')),
  description text NOT NULL,
  expense_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'USD',
  receipt_file text,
  receipt_name text,
  billable_to_client boolean NOT NULL DEFAULT false,
  reimbursable_to_worker boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','approved','rejected','reimbursed','invoiced')),
  submitted_at timestamptz,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  payroll_item_id uuid REFERENCES payroll_items(id) ON DELETE SET NULL, -- discarding a run releases the expense
  payroll_earning_id uuid, -- the payroll_earnings row created for it (no FK: removing the row releases the expense in code)
  reimbursed_at timestamptz,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  invoice_line_id uuid REFERENCES invoice_lines(id) ON DELETE SET NULL,
  invoiced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_org_status_idx ON expenses (organization_id, status);
CREATE INDEX IF NOT EXISTS expenses_org_worker_idx ON expenses (organization_id, worker_id);
CREATE INDEX IF NOT EXISTS expenses_org_company_idx ON expenses (organization_id, company_id);
CREATE INDEX IF NOT EXISTS expenses_payroll_item_idx ON expenses (payroll_item_id);
CREATE INDEX IF NOT EXISTS expenses_invoice_idx ON expenses (invoice_id);
