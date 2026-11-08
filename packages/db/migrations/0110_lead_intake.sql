-- Shareable client sign-up links (Leads → Generate link) and the submissions they produce.
CREATE TABLE lead_intake_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),           -- owner: new leads are assigned to them
  token text NOT NULL UNIQUE,
  label text,
  source text NOT NULL DEFAULT 'Website',
  campaign text,
  active boolean NOT NULL DEFAULT true,
  clicks int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON lead_intake_links (organization_id, user_id);

CREATE TABLE lead_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  link_id uuid REFERENCES lead_intake_links(id) ON DELETE SET NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  answers jsonb NOT NULL,
  duplicate_of_existing boolean NOT NULL DEFAULT false,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON lead_intakes (organization_id, created_at DESC);
