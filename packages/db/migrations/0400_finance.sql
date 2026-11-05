-- FINANCE area additions (additive only).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_email text;
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS payment_id uuid REFERENCES payments(id);
ALTER TABLE commission_entitlements ADD COLUMN IF NOT EXISTS payout_item_id uuid REFERENCES payout_items(id);
ALTER TABLE commission_entitlements ADD COLUMN IF NOT EXISTS settled_via text;
ALTER TABLE commission_entitlements ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE commission_rules ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE payout_items ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
CREATE INDEX IF NOT EXISTS timesheet_days_org_date_idx ON timesheet_days (organization_id, work_date);
CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx ON invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS payroll_items_run_idx ON payroll_items (run_id);
CREATE INDEX IF NOT EXISTS payout_items_payout_idx ON payout_items (payout_id);
CREATE INDEX IF NOT EXISTS accounting_sync_log_entity_idx ON accounting_sync_log (organization_id, entity_type, entity_id);
