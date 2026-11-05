-- RECRUITING additions (additive only).
-- Client-requested interviews: status 'requested' until a recruiter confirms the time.
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES users(id);
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS request_note text;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS cancel_reason text;
-- Sourcing link click tracking metadata.
ALTER TABLE sourcing_clicks ADD COLUMN IF NOT EXISTS referrer text;
ALTER TABLE sourcing_clicks ADD COLUMN IF NOT EXISTS visitor_hash text;
-- Assessments: who scored.
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS scored_by uuid REFERENCES users(id);
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS file_name text;
-- Candidate media: original filename.
ALTER TABLE candidate_media ADD COLUMN IF NOT EXISTS file_name text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS resume_file_name text;
-- Submissions: who decided on the client side.
ALTER TABLE candidate_submissions ADD COLUMN IF NOT EXISTS client_decided_by uuid REFERENCES users(id);
ALTER TABLE candidate_submissions ADD COLUMN IF NOT EXISTS client_decided_at timestamptz;
CREATE INDEX IF NOT EXISTS applications_candidate_idx ON applications (candidate_id);
CREATE INDEX IF NOT EXISTS submissions_position_idx ON candidate_submissions (organization_id, position_id);
CREATE INDEX IF NOT EXISTS interviews_sched_idx ON interviews (organization_id, scheduled_at);
CREATE INDEX IF NOT EXISTS sourcing_clicks_link_idx ON sourcing_clicks (link_id, created_at);
CREATE INDEX IF NOT EXISTS pra_user_idx ON position_recruiter_assignments (user_id, position_id) WHERE unassigned_at IS NULL;
