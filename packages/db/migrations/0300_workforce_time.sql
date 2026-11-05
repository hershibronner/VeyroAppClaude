-- WORKFORCE + TIME additions (additive only).

-- Onboarding checklist: who/when for required toggles and soft-removal of manual items (history preserved).
ALTER TABLE placement_onboarding_items ADD COLUMN IF NOT EXISTS required_changed_by uuid REFERENCES users(id);
ALTER TABLE placement_onboarding_items ADD COLUMN IF NOT EXISTS required_changed_at timestamptz;
ALTER TABLE placement_onboarding_items ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE placement_onboarding_items ADD COLUMN IF NOT EXISTS removed_by uuid REFERENCES users(id);
ALTER TABLE placement_onboarding_items ADD COLUMN IF NOT EXISTS note text;

-- Offline tracker sync: every queued client event is processed exactly once.
CREATE TABLE IF NOT EXISTS tracker_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  client_event_id text NOT NULL,
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  result jsonb,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (worker_id, client_event_id)
);

-- Screenshot flags: who flagged and when.
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS flagged_by uuid REFERENCES users(id);
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS flagged_at timestamptz;

-- Manual time requests: decision note.
ALTER TABLE manual_time_requests ADD COLUMN IF NOT EXISTS decision_note text;

-- Placement issue resolution metadata.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES users(id);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS replacement_placement_id uuid REFERENCES placements(id);

CREATE INDEX IF NOT EXISTS screenshots_entry_idx ON screenshots (time_entry_id);
CREATE INDEX IF NOT EXISTS attendance_worker_idx ON attendance_events (worker_id, work_date);
CREATE INDEX IF NOT EXISTS time_entries_open_idx ON time_entries (worker_id) WHERE ended_at IS NULL;
