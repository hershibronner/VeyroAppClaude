-- Real VeyroApp subscription billing on the platform's own Stripe account: each agency is a Stripe Customer with a saved
-- card; monthly per-seat invoices are charged off-session. card_* columns stay as the display copy (brand / last 4 / exp).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_payment_method_id text;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS provider_ref text;
