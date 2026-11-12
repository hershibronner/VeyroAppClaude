-- Real email delivery (Resend) + email verification codes at sign-up.
ALTER TABLE outbox_messages ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'simulated'; -- simulated | sent | failed | blocked
ALTER TABLE outbox_messages ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE outbox_messages ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE outbox_messages ADD COLUMN IF NOT EXISTS delivery_error text;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL,
  token text,                       -- issued once the code is confirmed; required by /auth/register
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  used_at timestamptz,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_verifications_email ON email_verifications (lower(email), created_at DESC);
