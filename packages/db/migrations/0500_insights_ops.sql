-- INSIGHTS + OPS: document template versions, richer signature requests, scheduled report bookkeeping.
CREATE TABLE IF NOT EXISTS document_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  version int NOT NULL,
  body text NOT NULL,
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
-- Backfill v1 for existing templates.
INSERT INTO document_template_versions (organization_id, template_id, version, body)
SELECT organization_id, id, version, body FROM document_templates
ON CONFLICT DO NOTHING;

ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS message text;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS viewed_at timestamptz;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS declined_reason text;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS template_version int;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE scheduled_reports ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE scheduled_reports ADD COLUMN IF NOT EXISTS last_status text;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_document_id uuid REFERENCES documents(id);

CREATE INDEX IF NOT EXISTS documents_org_entity_idx ON documents (organization_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS documents_org_expiry_idx ON documents (organization_id, expires_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS automation_runs_org_created_idx ON automation_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS thread_participants_user_idx ON thread_participants (user_id);
CREATE INDEX IF NOT EXISTS signature_requests_org_idx ON signature_requests (organization_id, created_at DESC);
