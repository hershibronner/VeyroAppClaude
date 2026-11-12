-- "Contact us" requests from the public landing page (/home). Platform admins are notified in-app and by email.
CREATE TABLE IF NOT EXISTS contact_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  company text,
  team_size text,
  interest text,
  message text,
  ip text,
  status text NOT NULL DEFAULT 'new', -- new | contacted | closed
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_requests_created ON contact_requests (created_at DESC);
