-- Real provider connections (Stripe Connect first). Tokens are AES-256-GCM encrypted with INTEGRATIONS_ENCRYPTION_KEY;
-- external_account_id (e.g. Stripe acct_…) is not secret and is kept in clear so incoming webhooks can find their workspace.
CREATE TABLE IF NOT EXISTS integration_credentials (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_key text NOT NULL,
  external_account_id text NOT NULL,
  account_name text,
  livemode boolean NOT NULL DEFAULT false,
  secret_enc text NOT NULL,
  connected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS integration_credentials_account ON integration_credentials (integration_key, external_account_id);

-- Stripe webhook events already handled (Stripe retries; each event is applied once).
CREATE TABLE IF NOT EXISTS stripe_events (
  id text PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

UPDATE integrations SET provider='Stripe' WHERE key='payments' AND provider='Stripe (simulated)';
