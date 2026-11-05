-- CRM area: task overdue notifications, reminder bookkeeping, lookup indexes.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS overdue_notified_at timestamptz;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (remind_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS companies_lead_status_idx ON companies (organization_id, lead_status);
CREATE INDEX IF NOT EXISTS tasks_related_idx ON tasks (organization_id, related_type, related_id);
CREATE INDEX IF NOT EXISTS opportunities_org_stage_idx ON opportunities (organization_id, stage);
CREATE INDEX IF NOT EXISTS contact_methods_contact_idx ON contact_methods (contact_id);
