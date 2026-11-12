-- Per-user SMS delivery choice for each notification event (SMS sending is coming soon; the choice is stored now).
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS sms boolean NOT NULL DEFAULT false;
