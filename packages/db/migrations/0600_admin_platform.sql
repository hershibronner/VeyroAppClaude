-- ADMIN + PLATFORM area: training, import resume/dry-run columns, white-label domain verification,
-- SaaS billing simulation fields, platform settings, client portal settings. Additive only.

-- Worker training (worker portal "Training", managed under Settings → Onboarding / Training)
CREATE TABLE IF NOT EXISTS training_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  content text,
  kind text NOT NULL DEFAULT 'reading', -- reading | video | quiz | policy
  url text,
  required boolean NOT NULL DEFAULT false,
  duration_min int NOT NULL DEFAULT 10,
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS training_modules_org ON training_modules (organization_id, sort);

CREATE TABLE IF NOT EXISTS training_progress (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  module_id uuid NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'in_progress', -- in_progress | completed
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (module_id, worker_id)
);

-- Client portal settings (per client company)
CREATE TABLE IF NOT EXISTS client_portal_settings (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  timesheet_contact_user_id uuid REFERENCES users(id),
  invoice_email text,
  weekly_digest boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, company_id)
);

-- Platform-wide settings (VeyroApp staff)
CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Invitations: recruiting scope + team for staff invites, resend tracking
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS recruiting_scope text;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS team text;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS resent_count int NOT NULL DEFAULT 0;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- When an invitation is accepted, apply its recruiting scope / team to the new membership.
CREATE OR REPLACE FUNCTION invitations_apply_scope() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status <> 'accepted' AND (NEW.recruiting_scope IS NOT NULL OR NEW.team IS NOT NULL) THEN
    UPDATE organization_memberships m SET recruiting_scope = COALESCE(NEW.recruiting_scope, m.recruiting_scope), team = COALESCE(NEW.team, m.team), updated_at = now()
      FROM users u WHERE u.id = m.user_id AND lower(u.email) = lower(NEW.email) AND m.organization_id = NEW.organization_id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS invitations_apply_scope ON invitations;
CREATE TRIGGER invitations_apply_scope AFTER UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION invitations_apply_scope();

-- Roles: description for custom roles
ALTER TABLE roles ADD COLUMN IF NOT EXISTS description text;

-- White label: simulated DNS verification
ALTER TABLE organization_branding ADD COLUMN IF NOT EXISTS domain_token text;
ALTER TABLE organization_branding ADD COLUMN IF NOT EXISTS domain_requested_at timestamptz;
ALTER TABLE organization_branding ADD COLUMN IF NOT EXISTS domain_checked_at timestamptz;
ALTER TABLE organization_branding ADD COLUMN IF NOT EXISTS login_headline text;

-- SaaS billing simulation
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS card_brand text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS card_exp text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS card_fails boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_email text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS plan_key text;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS addon_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS lines jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS due_at date;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS failure_reason text;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS sort int NOT NULL DEFAULT 0;

-- Import Center: headers, options, resume heartbeat, per-row dry-run plan
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS headers text[] NOT NULL DEFAULT '{}';
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS runs int NOT NULL DEFAULT 0;
ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS planned_action text; -- create | update | skip_duplicate | error
ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS warning text;
ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS duplicate_of uuid;
ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS processed_at timestamptz;
CREATE INDEX IF NOT EXISTS import_rows_job_status ON import_rows (job_id, status, row_number);

-- Preserve legacy / external ids on imported workforce records
ALTER TABLE workers ADD COLUMN IF NOT EXISTS legacy_id text;
ALTER TABLE placements ADD COLUMN IF NOT EXISTS legacy_id text;
ALTER TABLE placement_rates ADD COLUMN IF NOT EXISTS legacy_id text;

-- Impersonation: remember the platform admin's own session so "End" restores it
ALTER TABLE impersonation_sessions ADD COLUMN IF NOT EXISTS restore_session_id text;

-- Support tickets: replies from VeyroApp staff vs agency, category
ALTER TABLE support_ticket_replies ADD COLUMN IF NOT EXISTS is_staff boolean NOT NULL DEFAULT false;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'general';

CREATE INDEX IF NOT EXISTS webhook_deliveries_org ON webhook_deliveries (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_action ON audit_events (organization_id, action);
CREATE INDEX IF NOT EXISTS integration_logs_org ON integration_logs (organization_id, integration_key, created_at DESC);
