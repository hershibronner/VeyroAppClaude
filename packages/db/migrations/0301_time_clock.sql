-- TIME: supervisor Clock In console — attribute on-behalf clock actions to the acting staff user.
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS ended_by uuid REFERENCES users(id);
ALTER TABLE breaks ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE breaks ADD COLUMN IF NOT EXISTS ended_by uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS activity_samples_org_bucket_idx ON activity_samples (organization_id, bucket_start);
CREATE INDEX IF NOT EXISTS screenshots_org_taken_idx ON screenshots (organization_id, taken_at);
