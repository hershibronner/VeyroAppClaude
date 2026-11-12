-- Self-serve agency sign-up: new agencies wait for a VeyroApp platform admin to approve them.
-- Existing / seeded agencies stay approved.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved'; -- pending | approved | rejected

CREATE TABLE IF NOT EXISTS agency_applications (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  applicant_user_id uuid REFERENCES users(id),
  phone text,
  website text,
  country text,
  team_size text,
  active_workers text,
  industries text[] NOT NULL DEFAULT '{}',
  previous_software text,
  heard_from text,
  legal_name text,
  registration_number text,
  logo_file text,
  registration_file text,
  registration_file_name text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  rejection_reason text,
  checklist_dismissed_at timestamptz
);
CREATE INDEX IF NOT EXISTS agency_applications_pending ON agency_applications (submitted_at) WHERE reviewed_at IS NULL;

-- Positions can now be imported; legacy_id lets a re-import update instead of duplicating.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS legacy_id text;
