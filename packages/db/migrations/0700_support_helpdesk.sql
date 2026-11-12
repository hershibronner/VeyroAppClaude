-- Support helpdesk: ticket numbers, SLA timers, read state, tags, internal notes / events, saved replies.

CREATE SEQUENCE IF NOT EXISTS support_ticket_number_seq START 1001;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS number bigint;
UPDATE support_tickets SET number = nextval('support_ticket_number_seq') WHERE number IS NULL;
ALTER TABLE support_tickets ALTER COLUMN number SET DEFAULT nextval('support_ticket_number_seq');
ALTER TABLE support_tickets ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_number_idx ON support_tickets(number);

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sla_due_at timestamptz;          -- first-response target
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_response_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS last_reply_by text NOT NULL DEFAULT 'agency'; -- agency | staff
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS staff_read_at timestamptz;

-- reply = visible to the agency; note = internal (VeyroApp staff only); event = system line (status/assignee changes)
ALTER TABLE support_ticket_replies ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'reply';
ALTER TABLE support_ticket_replies ADD COLUMN IF NOT EXISTS meta jsonb;
CREATE INDEX IF NOT EXISTS support_ticket_replies_ticket_idx ON support_ticket_replies(ticket_id, created_at);

-- Backfill timers for existing tickets.
UPDATE support_tickets t SET
  first_response_at = (SELECT min(r.created_at) FROM support_ticket_replies r WHERE r.ticket_id=t.id AND r.is_staff),
  last_activity_at = GREATEST(t.updated_at, COALESCE((SELECT max(r.created_at) FROM support_ticket_replies r WHERE r.ticket_id=t.id), t.created_at)),
  last_reply_by = COALESCE((SELECT CASE WHEN r.is_staff THEN 'staff' ELSE 'agency' END FROM support_ticket_replies r WHERE r.ticket_id=t.id ORDER BY r.created_at DESC LIMIT 1), 'agency'),
  resolved_at = CASE WHEN t.status='resolved' THEN t.updated_at END,
  sla_due_at = t.created_at + (CASE t.priority WHEN 'urgent' THEN interval '1 hour' WHEN 'high' THEN interval '4 hours' WHEN 'normal' THEN interval '8 hours' ELSE interval '24 hours' END),
  staff_read_at = now();

CREATE TABLE IF NOT EXISTS support_macros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO support_macros (title, body)
SELECT * FROM (VALUES
  ('Acknowledge — looking into it', E'Hi {{first_name}},\n\nThanks for reaching out — I''m looking into this now and will update you shortly.\n\nVeyroApp Support'),
  ('Need more details', E'Hi {{first_name}},\n\nThanks for the report. Could you share a few more details so we can reproduce it?\n\n• The page you were on\n• What you clicked right before\n• A screenshot if possible\n\nVeyroApp Support'),
  ('Fixed — please confirm', E'Hi {{first_name}},\n\nGood news: this is fixed on our side. Could you refresh the page and confirm it''s working for {{agency}}?\n\nVeyroApp Support'),
  ('Feature request logged', E'Hi {{first_name}},\n\nGreat suggestion — I''ve logged it with our product team. We''ll let you know if it makes it onto the roadmap.\n\nVeyroApp Support'),
  ('Billing — invoice explained', E'Hi {{first_name}},\n\nYour invoice is based on the average number of active seats during the month. You can see the breakdown under Settings → Billing.\n\nVeyroApp Support')
) v(title, body)
WHERE NOT EXISTS (SELECT 1 FROM support_macros);
