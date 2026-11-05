-- VeyroApp core schema. Every tenant table carries organization_id; money is integer cents + currency.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────── Identity & tenancy ─────────────
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  default_currency text NOT NULL DEFAULT 'USD',
  timezone text NOT NULL DEFAULT 'America/New_York',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_branding (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  logo_text text,
  logo_file text,
  primary_color text NOT NULL DEFAULT '#345CFF',
  accent_color text NOT NULL DEFAULT '#7044FF',
  email_sender_name text,
  custom_domain text,
  domain_verified boolean NOT NULL DEFAULT false,
  hide_powered_by boolean NOT NULL DEFAULT false,
  support_email text,
  support_phone text,
  terminology jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_settings (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text,
  phone text,
  avatar_color text,
  avatar_file text,
  mfa_enabled boolean NOT NULL DEFAULT false,
  personal_link_token text UNIQUE,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'agency', -- agency | client | worker | candidate
  is_system boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  resource text NOT NULL,
  action text NOT NULL,
  scope text NOT NULL,
  PRIMARY KEY (role_id, resource, action)
);

CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id),
  recruiting_scope text NOT NULL DEFAULT 'all', -- all | team | assigned
  team text,
  status text NOT NULL DEFAULT 'active', -- active | invited | suspended | removed
  company_id uuid, -- client users
  worker_id uuid,  -- worker users
  candidate_id uuid, -- candidate users
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_organization_id uuid REFERENCES organizations(id),
  csrf_token text NOT NULL,
  mfa_pending boolean NOT NULL DEFAULT false,
  impersonator_user_id uuid REFERENCES users(id),
  impersonation_reason text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE mfa_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE password_resets (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  role_id uuid NOT NULL REFERENCES roles(id),
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending', -- pending | accepted | revoked | expired
  company_id uuid,
  worker_id uuid,
  candidate_id uuid,
  invited_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_admins (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  invited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- ───────────── CRM ─────────────
CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  website text,
  domain text,
  industry text,
  size text,
  country text,
  phone text,
  email text,
  address text,
  stage text NOT NULL DEFAULT 'lead', -- lead | qualified | client | inactive
  lead_status text DEFAULT 'new', -- new | contacted | qualified | unqualified | converted
  source text,
  campaign text,
  owner_id uuid REFERENCES users(id),
  account_manager_id uuid REFERENCES users(id),
  lead_score int NOT NULL DEFAULT 0,
  est_workers int,
  est_monthly_value_cents bigint,
  currency text NOT NULL DEFAULT 'USD',
  notes text,
  next_follow_up date,
  disqualify_reason text,
  converted_at timestamptz,
  timesheet_approval text NOT NULL DEFAULT 'client', -- agency | client | both
  portal_screenshots boolean NOT NULL DEFAULT true,
  payment_terms_days int NOT NULL DEFAULT 15,
  tax_bp int NOT NULL DEFAULT 0,
  legacy_id text,
  archived_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON companies (organization_id, stage);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id),
  first_name text NOT NULL,
  last_name text,
  title text,
  email text,
  phone text,
  is_primary boolean NOT NULL DEFAULT false,
  notes text,
  legacy_id text,
  archived_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON contacts (organization_id, company_id);

CREATE TABLE contact_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL, -- email | phone | whatsapp
  value text NOT NULL,
  label text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company_contacts (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role text,
  PRIMARY KEY (company_id, contact_id)
);

CREATE TABLE opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id),
  contact_id uuid REFERENCES contacts(id),
  name text NOT NULL,
  stage text NOT NULL DEFAULT 'new',
  owner_id uuid REFERENCES users(id),
  est_workers int,
  value_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  expected_close date,
  probability int NOT NULL DEFAULT 10,
  source text,
  campaign text,
  lost_reason text,
  closed_at timestamptz,
  archived_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead_score_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  delta int NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open', -- open | in_progress | done | cancelled
  priority text NOT NULL DEFAULT 'medium', -- low | medium | high | urgent
  due_date date,
  due_time time,
  related_type text,
  related_id uuid,
  completed_at timestamptz,
  archived_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tasks (organization_id, status, due_date);

CREATE TABLE task_assignees (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  related_type text,
  related_id uuid,
  remind_at timestamptz NOT NULL,
  channels text[] NOT NULL DEFAULT '{in_app,email}',
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  kind text NOT NULL, -- call | email | meeting | note | message | status_change | system
  title text NOT NULL,
  body text,
  visibility text NOT NULL DEFAULT 'internal',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON activities (organization_id, entity_type, entity_id, created_at DESC);
CREATE INDEX ON activities (organization_id, created_at DESC);

CREATE TABLE mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Recruiting ─────────────
CREATE TABLE positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id),
  opportunity_id uuid REFERENCES opportunities(id),
  title text NOT NULL,
  openings int NOT NULL DEFAULT 1,
  filled int NOT NULL DEFAULT 0,
  urgency text NOT NULL DEFAULT 'normal', -- low | normal | high | critical
  health text NOT NULL DEFAULT 'on_track', -- on_track | at_risk | critical
  employment_type text NOT NULL DEFAULT 'full_time',
  schedule text,
  timezone text,
  weekly_hours int,
  skills text[] NOT NULL DEFAULT '{}',
  software text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{}',
  equipment text,
  bill_budget_cents bigint,
  pay_min_cents bigint,
  pay_max_cents bigint,
  currency text NOT NULL DEFAULT 'USD',
  rate_unit text NOT NULL DEFAULT 'hour',
  description text,
  status text NOT NULL DEFAULT 'draft',
  match_version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON positions (organization_id, status);

CREATE TABLE position_recruiter_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  is_lead boolean NOT NULL DEFAULT false,
  assigned_by uuid REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz
);

CREATE TABLE position_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  title text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name text NOT NULL,
  last_name text,
  email text,
  phone text,
  country text,
  city text,
  timezone text,
  headline text,
  years_experience int,
  skills text[] NOT NULL DEFAULT '{}',
  software text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{}',
  education jsonb NOT NULL DEFAULT '[]'::jsonb,
  experience jsonb NOT NULL DEFAULT '[]'::jsonb,
  rate_min_cents bigint,
  rate_target_cents bigint,
  rate_currency text NOT NULL DEFAULT 'USD',
  rate_unit text NOT NULL DEFAULT 'hour',
  rate_note text,
  availability_status text NOT NULL DEFAULT 'available', -- available | employed | not_available
  earliest_start date,
  weekly_hours int,
  preferred_hours text,
  resume_text text,
  resume_file text,
  video_file text,
  portfolio_url text,
  portfolio_file text,
  source text,
  sourced_by uuid REFERENCES users(id),
  tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'new_applicant',
  status_reason text,
  avatar_color text,
  user_id uuid REFERENCES users(id),
  legacy_id text,
  archived_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON candidates (organization_id, status);
CREATE INDEX ON candidates (organization_id, lower(email));

CREATE TABLE candidate_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  kind text NOT NULL, -- resume | video | portfolio
  file text,
  url text,
  mime text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sourcing_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  position_id uuid REFERENCES positions(id),
  token text NOT NULL UNIQUE,
  label text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sourcing_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES sourcing_links(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  position_id uuid REFERENCES positions(id),
  source text,
  recruiter_id uuid REFERENCES users(id),
  sourcing_link_id uuid REFERENCES sourcing_links(id),
  status text NOT NULL DEFAULT 'new', -- new | reviewed | advanced | rejected
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON applications (organization_id, created_at DESC);

CREATE TABLE candidate_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'submitted',
  submitted_by uuid REFERENCES users(id),
  shareable jsonb NOT NULL DEFAULT '{}'::jsonb, -- {contact:false, rate:false, notes:false}
  presentation text,
  client_feedback text,
  client_decision text, -- approve | reject | interview
  status_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, position_id)
);

CREATE TABLE interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  position_id uuid REFERENCES positions(id),
  submission_id uuid REFERENCES candidate_submissions(id),
  kind text NOT NULL DEFAULT 'internal', -- internal | client
  scheduled_at timestamptz NOT NULL,
  duration_min int NOT NULL DEFAULT 30,
  timezone text NOT NULL DEFAULT 'America/New_York',
  meeting_url text,
  interviewers text,
  interviewer_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'scheduled',
  outcome text, -- advance | hold | reject
  reminded_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interview_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  author_label text,
  scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  overall int,
  recommendation text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assessment_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text,
  instructions text,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  allow_file boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES assessment_templates(id),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  position_id uuid REFERENCES positions(id),
  status text NOT NULL DEFAULT 'sent',
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  file text,
  score int,
  scorer_notes text,
  sent_by uuid REFERENCES users(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  scored_at timestamptz
);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  position_id uuid REFERENCES positions(id),
  submission_id uuid REFERENCES candidate_submissions(id),
  pay_rate_cents bigint NOT NULL,
  bill_rate_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  rate_unit text NOT NULL DEFAULT 'hour',
  weekly_hours int,
  start_date date,
  expires_at date,
  terms text,
  status text NOT NULL DEFAULT 'draft',
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  sent_at timestamptz,
  viewed_at timestamptz,
  responded_at timestamptz,
  signature_name text,
  signature_data text,
  signed_at timestamptz,
  signed_ip text,
  decline_reason text,
  placement_id uuid,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  model text NOT NULL,
  inputs jsonb NOT NULL,
  position_version int NOT NULL,
  run_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  score int NOT NULL,
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  shortlisted boolean NOT NULL DEFAULT false
);

CREATE TABLE resume_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES candidates(id) ON DELETE CASCADE,
  model text NOT NULL,
  data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending_review', -- pending_review | accepted | discarded
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Workforce ─────────────
CREATE TABLE workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL UNIQUE REFERENCES candidates(id),
  user_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending', -- pending | active | available | on_leave | inactive
  employee_code text,
  payout_method text NOT NULL DEFAULT 'wise',
  payout_account_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE monitoring_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  screenshots_enabled boolean NOT NULL DEFAULT true,
  screenshot_interval_min int NOT NULL DEFAULT 10,
  blur boolean NOT NULL DEFAULT false,
  activity_tracking boolean NOT NULL DEFAULT true,
  idle_minutes int NOT NULL DEFAULT 5,
  retention_days int NOT NULL DEFAULT 90,
  worker_delete_window_min int NOT NULL DEFAULT 10,
  client_can_view boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  position_id uuid REFERENCES positions(id),
  offer_id uuid REFERENCES offers(id),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'onboarding', -- onboarding | active | on_leave | notice | ended
  start_date date NOT NULL,
  end_date date,
  end_reason text,
  schedule_days int[] NOT NULL DEFAULT '{1,2,3,4,5}', -- ISO dow 1=Mon
  schedule_start time NOT NULL DEFAULT '09:00',
  schedule_end time NOT NULL DEFAULT '17:00',
  timezone text NOT NULL DEFAULT 'America/New_York',
  weekly_hours int NOT NULL DEFAULT 40,
  account_manager_id uuid REFERENCES users(id),
  recruiter_id uuid REFERENCES users(id),
  sales_id uuid REFERENCES users(id),
  monitoring_policy_id uuid REFERENCES monitoring_policies(id),
  policy_accepted_at timestamptz,
  replaces_placement_id uuid REFERENCES placements(id),
  contract_document_id uuid,
  equipment jsonb NOT NULL DEFAULT '[]'::jsonb,
  activated_at timestamptz,
  activated_by uuid REFERENCES users(id),
  activation_override_reason text,
  ended_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON placements (organization_id, status);

CREATE TABLE placement_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  placement_id uuid NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  effective_to date,
  pay_rate_cents bigint NOT NULL,
  bill_rate_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  unit text NOT NULL DEFAULT 'hour',
  ot_multiplier_bp int NOT NULL DEFAULT 15000,
  ot_threshold_minutes int NOT NULL DEFAULT 2400,
  reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON placement_rates (placement_id, effective_from);

CREATE TABLE onboarding_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  scope text NOT NULL DEFAULT 'agency', -- agency | client
  company_id uuid REFERENCES companies(id),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE onboarding_template_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES onboarding_templates(id) ON DELETE CASCADE,
  title text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  owner text NOT NULL DEFAULT 'agency', -- agency | worker | client
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE placement_onboarding_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  placement_id uuid NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  title text NOT NULL,
  source text NOT NULL, -- agency | client | position | manual
  required boolean NOT NULL DEFAULT true,
  owner text NOT NULL DEFAULT 'agency',
  done_at timestamptz,
  done_by uuid REFERENCES users(id),
  sort int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE equipment_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  placement_id uuid REFERENCES placements(id),
  worker_id uuid REFERENCES workers(id),
  kind text NOT NULL, -- performance | attendance | client_complaint | conduct | other
  severity text NOT NULL DEFAULT 'medium',
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open', -- open | investigating | resolved | replacement
  resolution text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE time_off_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  placement_id uuid REFERENCES placements(id),
  kind text NOT NULL DEFAULT 'vacation', -- vacation | sick | personal | unpaid | holiday
  start_date date NOT NULL,
  end_date date NOT NULL,
  note text,
  status text NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Time & monitoring ─────────────
CREATE TABLE time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  placement_id uuid NOT NULL REFERENCES placements(id),
  worker_id uuid NOT NULL REFERENCES workers(id),
  work_date date NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  memo text,
  source text NOT NULL DEFAULT 'tracker', -- tracker | manual | simulated | correction
  break_seconds int NOT NULL DEFAULT 0,
  idle_seconds int NOT NULL DEFAULT 0,
  discarded_idle_seconds int NOT NULL DEFAULT 0,
  client_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (worker_id, client_event_id)
);
CREATE INDEX ON time_entries (organization_id, placement_id, work_date);
CREATE INDEX ON time_entries (worker_id, started_at DESC);

CREATE TABLE breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  time_entry_id uuid NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz
);

CREATE TABLE worker_presence (
  worker_id uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  placement_id uuid REFERENCES placements(id),
  time_entry_id uuid REFERENCES time_entries(id),
  state text NOT NULL DEFAULT 'offline', -- working | idle | on_break | offline
  session_started_at timestamptz,
  last_heartbeat_at timestamptz,
  activity_pct int,
  screen_share text, -- granted | declined | unsupported
  simulated boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE manual_time_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  placement_id uuid NOT NULL REFERENCES placements(id),
  work_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  time_entry_id uuid REFERENCES time_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE timesheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  placement_id uuid NOT NULL REFERENCES placements(id),
  worker_id uuid NOT NULL REFERENCES workers(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  week_start date NOT NULL,
  status text NOT NULL DEFAULT 'open',
  total_minutes int NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  agency_approved_at timestamptz,
  agency_approved_by uuid REFERENCES users(id),
  client_approved_at timestamptz,
  client_approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  rejected_reason text,
  locked_at timestamptz,
  invoice_id uuid,
  payroll_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (placement_id, week_start)
);
CREATE INDEX ON timesheets (organization_id, status);

-- Immutable snapshot of approved minutes per day (the financial bridge).
CREATE TABLE timesheet_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  timesheet_id uuid NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  placement_id uuid NOT NULL REFERENCES placements(id),
  work_date date NOT NULL,
  minutes int NOT NULL,
  invoice_id uuid,       -- set when billed (prevents double invoicing)
  payroll_item_id uuid,  -- set when paid (prevents double pay)
  UNIQUE (timesheet_id, work_date)
);

CREATE TABLE timesheet_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  timesheet_id uuid NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  party text NOT NULL, -- agency | client
  decision text NOT NULL, -- approved | rejected | submitted
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE timesheet_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  timesheet_id uuid NOT NULL REFERENCES timesheets(id),
  placement_id uuid NOT NULL REFERENCES placements(id),
  work_date date NOT NULL,
  minutes_delta int NOT NULL,
  reason text NOT NULL,
  applied_invoice_id uuid,
  applied_payroll_run_id uuid,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  placement_id uuid REFERENCES placements(id),
  work_date date NOT NULL,
  kind text NOT NULL, -- on_time | late | absent | early_leave | screen_declined | time_off
  minutes int,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON attendance_events (organization_id, work_date);

CREATE TABLE screenshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  placement_id uuid REFERENCES placements(id),
  time_entry_id uuid REFERENCES time_entries(id),
  taken_at timestamptz NOT NULL,
  file text NOT NULL,
  kind text NOT NULL DEFAULT 'mock', -- real | mock
  app_label text,
  url_label text,
  activity_pct int,
  blurred boolean NOT NULL DEFAULT false,
  flagged boolean NOT NULL DEFAULT false,
  flag_note text,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON screenshots (organization_id, worker_id, taken_at DESC);

CREATE TABLE activity_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  placement_id uuid REFERENCES placements(id),
  time_entry_id uuid REFERENCES time_entries(id),
  bucket_start timestamptz NOT NULL,
  bucket_seconds int NOT NULL DEFAULT 600,
  key_count int NOT NULL DEFAULT 0,
  mouse_count int NOT NULL DEFAULT 0,
  active_seconds int NOT NULL DEFAULT 0,
  idle_seconds int NOT NULL DEFAULT 0,
  activity_pct int NOT NULL DEFAULT 0,
  app_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON activity_samples (organization_id, worker_id, bucket_start);

CREATE TABLE idle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  time_entry_id uuid REFERENCES time_entries(id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  seconds int,
  decision text, -- keep | discard
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Finance ─────────────
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id),
  number text NOT NULL,
  period_start date,
  period_end date,
  issue_date date NOT NULL DEFAULT current_date,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL DEFAULT 'USD',
  subtotal_cents bigint NOT NULL DEFAULT 0,
  tax_bp int NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0,
  discount_cents bigint NOT NULL DEFAULT 0,
  credit_cents bigint NOT NULL DEFAULT 0,
  late_fee_cents bigint NOT NULL DEFAULT 0,
  previous_balance_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  paid_cents bigint NOT NULL DEFAULT 0,
  notes text,
  pay_token text UNIQUE,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  sent_at timestamptz,
  viewed_at timestamptz,
  paid_at timestamptz,
  overdue_at timestamptz,
  written_off_at timestamptz,
  accounting_external_id text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);
CREATE INDEX ON invoices (organization_id, status);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'time', -- time | manual | reimbursement | late_fee | adjustment
  placement_id uuid REFERENCES placements(id),
  worker_id uuid REFERENCES workers(id),
  rate_id uuid REFERENCES placement_rates(id),
  description text NOT NULL,
  period_start date,
  period_end date,
  minutes int,
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  unit_price_cents bigint NOT NULL,
  amount_cents bigint NOT NULL,
  taxable boolean NOT NULL DEFAULT true,
  timesheet_ids uuid[] NOT NULL DEFAULT '{}',
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE invoice_total_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  subtotal_cents bigint NOT NULL,
  tax_cents bigint NOT NULL,
  total_cents bigint NOT NULL,
  reason text NOT NULL,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  company_id uuid REFERENCES companies(id),
  amount_cents bigint NOT NULL,
  currency text NOT NULL,
  method text NOT NULL DEFAULT 'card', -- card | ach | wire | manual
  status text NOT NULL DEFAULT 'succeeded', -- succeeded | failed | refunded
  card_brand text,
  card_last4 text,
  provider text NOT NULL DEFAULT 'stripe-sim',
  provider_ref text,
  failure_reason text,
  idempotency_key text UNIQUE,
  receipt_number text,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id),
  invoice_id uuid REFERENCES invoices(id),
  number text NOT NULL,
  kind text NOT NULL, -- credit | refund | write_off | overpayment
  amount_cents bigint NOT NULL,
  currency text NOT NULL,
  reason text NOT NULL,
  applied_invoice_id uuid REFERENCES invoices(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  frequency text NOT NULL DEFAULT 'semi_monthly',
  pay_date date NOT NULL,
  status text NOT NULL DEFAULT 'calculated',
  idempotency_key text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  total_gross_cents bigint NOT NULL DEFAULT 0,
  total_net_cents bigint NOT NULL DEFAULT 0,
  worker_count int NOT NULL DEFAULT 0,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  paid_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE payroll_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  placement_id uuid REFERENCES placements(id),
  company_id uuid REFERENCES companies(id),
  regular_minutes int NOT NULL DEFAULT 0,
  ot_minutes int NOT NULL DEFAULT 0,
  regular_cents bigint NOT NULL DEFAULT 0,
  ot_cents bigint NOT NULL DEFAULT 0,
  earnings_cents bigint NOT NULL DEFAULT 0,
  deductions_cents bigint NOT NULL DEFAULT 0,
  gross_cents bigint NOT NULL DEFAULT 0,
  net_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  timesheet_ids uuid[] NOT NULL DEFAULT '{}',
  payslip_number text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payroll_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payroll_item_id uuid NOT NULL REFERENCES payroll_items(id) ON DELETE CASCADE,
  kind text NOT NULL, -- bonus | commission | reimbursement | leave_pay
  description text,
  amount_cents bigint NOT NULL
);

CREATE TABLE payroll_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payroll_item_id uuid NOT NULL REFERENCES payroll_items(id) ON DELETE CASCADE,
  kind text NOT NULL, -- advance | equipment | other
  description text,
  amount_cents bigint NOT NULL
);

CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid REFERENCES payroll_runs(id),
  kind text NOT NULL DEFAULT 'payroll', -- payroll | commission
  status text NOT NULL DEFAULT 'initiated', -- initiated | processing | paid | partially_failed | failed
  provider text NOT NULL DEFAULT 'wise-sim',
  idempotency_key text NOT NULL UNIQUE,
  total_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  initiated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE payout_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payout_id uuid NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  payroll_item_id uuid REFERENCES payroll_items(id),
  worker_id uuid REFERENCES workers(id),
  user_id uuid REFERENCES users(id),
  amount_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  provider_ref text,
  failure_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  applies_to text NOT NULL, -- recruiter | sales | account_manager
  kind text NOT NULL, -- pct_gp | fixed | tiered
  pct_bp int,
  fixed_cents bigint,
  months_limit int,
  tiers jsonb,
  user_id uuid REFERENCES users(id), -- optional specific person
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commission_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES commission_rules(id),
  user_id uuid NOT NULL REFERENCES users(id),
  placement_id uuid REFERENCES placements(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  revenue_cents bigint NOT NULL DEFAULT 0,
  cost_cents bigint NOT NULL DEFAULT 0,
  gp_cents bigint NOT NULL DEFAULT 0,
  calculated_cents bigint NOT NULL DEFAULT 0,
  approved_cents bigint,
  settled_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'calculated', -- calculated | approved | settled | rejected
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, user_id, placement_id, period_start)
);

CREATE TABLE accounting_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  status text NOT NULL, -- synced | failed | pending
  external_id text,
  error text,
  attempts int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Communications & documents ─────────────
CREATE TABLE message_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject text NOT NULL,
  kind text NOT NULL DEFAULT 'internal', -- internal | client | worker | candidate
  related_type text,
  related_id uuid,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE thread_participants (
  thread_id uuid NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz,
  PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  body text NOT NULL,
  channel text NOT NULL DEFAULT 'in_app',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, organization_id, created_at DESC);

CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event text NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT false,
  push boolean NOT NULL DEFAULT false,
  subscribed boolean NOT NULL DEFAULT false, -- admin event subscription
  PRIMARY KEY (user_id, organization_id, event)
);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text,
  name text NOT NULL,
  channel text NOT NULL DEFAULT 'email', -- email | sms | whatsapp | offer | onboarding
  current_version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version int NOT NULL,
  subject text,
  body text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  channel text NOT NULL, -- email | sms | whatsapp | push
  to_address text NOT NULL,
  from_name text,
  subject text,
  body_html text,
  body_text text,
  related_type text,
  related_id uuid,
  template_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON outbox_messages (created_at DESC);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type text,
  entity_id uuid,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'general', -- contract | nda | offer_letter | policy | id | compliance | resume | invoice | payslip | general
  file text,
  mime text,
  size_bytes int,
  visibility text NOT NULL DEFAULT 'internal', -- internal | client | worker | candidate
  issue_date date,
  expires_at date,
  verification text NOT NULL DEFAULT 'unverified', -- unverified | verified | rejected
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  signature_status text, -- pending | signed
  archived_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON documents (organization_id, entity_type, entity_id);

CREATE TABLE document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'contract',
  version int NOT NULL DEFAULT 1,
  body text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE signature_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id),
  template_id uuid REFERENCES document_templates(id),
  entity_type text,
  entity_id uuid,
  title text NOT NULL,
  rendered_body text NOT NULL,
  signer_name text NOT NULL,
  signer_email text NOT NULL,
  signer_user_id uuid REFERENCES users(id),
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'sent', -- sent | viewed | signed | declined | expired
  signed_name text,
  signature_data text,
  signed_at timestamptz,
  signed_ip text,
  certificate jsonb,
  signed_document_id uuid REFERENCES documents(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Platform ─────────────
CREATE TABLE plans (
  key text PRIMARY KEY,
  name text NOT NULL,
  price_per_seat_cents bigint NOT NULL,
  trial_days int NOT NULL DEFAULT 0,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE subscriptions (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_key text NOT NULL REFERENCES plans(key),
  status text NOT NULL DEFAULT 'trialing', -- trialing | active | past_due | grace | suspended | cancelled
  comped boolean NOT NULL DEFAULT false,
  discount_pct int NOT NULL DEFAULT 0,
  tax_bp int NOT NULL DEFAULT 0,
  addons jsonb NOT NULL DEFAULT '[]'::jsonb,
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  current_period_start date NOT NULL DEFAULT date_trunc('month', now())::date,
  card_last4 text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seat_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  placement_id uuid REFERENCES placements(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  started_by uuid REFERENCES users(id),
  ended_by uuid REFERENCES users(id)
);

CREATE TABLE saas_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number text NOT NULL UNIQUE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  seat_days int NOT NULL DEFAULT 0,
  avg_seats numeric(10,2) NOT NULL DEFAULT 0,
  subtotal_cents bigint NOT NULL,
  discount_cents bigint NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'open', -- open | paid | failed | comped | void
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE TABLE feature_flags (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL, -- payments | payouts | accounting | email | sms | whatsapp | calendar | esign | ai | job_boards | background_checks | storage
  category text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'connected', -- connected | disconnected | error
  scopes text[] NOT NULL DEFAULT '{}',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE integration_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_key text NOT NULL,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  signature text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- pending | delivered | failed | retrying
  attempts int NOT NULL DEFAULT 0,
  response_code int,
  response_body text,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE TABLE webhook_receiver_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path text NOT NULL,
  headers jsonb NOT NULL,
  body jsonb,
  signature_valid boolean,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity text NOT NULL,
  name text NOT NULL,
  mapping jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity text NOT NULL,
  filename text NOT NULL,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'uploaded', -- uploaded | mapped | validated | dry_run | running | completed | failed | interrupted
  dry_run_result jsonb,
  total_rows int NOT NULL DEFAULT 0,
  processed_rows int NOT NULL DEFAULT 0,
  created_rows int NOT NULL DEFAULT 0,
  updated_rows int NOT NULL DEFAULT 0,
  error_rows int NOT NULL DEFAULT 0,
  duplicate_rows int NOT NULL DEFAULT 0,
  idempotency_key text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number int NOT NULL,
  data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- pending | created | updated | duplicate | error | skipped
  error text,
  entity_id uuid,
  UNIQUE (job_id, row_number)
);

CREATE TABLE report_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  entity text NOT NULL,
  fields text[] NOT NULL DEFAULT '{}',
  filters jsonb NOT NULL DEFAULT '[]'::jsonb,
  group_by text,
  metric text,
  chart text NOT NULL DEFAULT 'table', -- table | bar | line
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
  cadence text NOT NULL DEFAULT 'weekly', -- daily | weekly | monthly
  recipients text[] NOT NULL DEFAULT '{}',
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  trigger_kind text NOT NULL, -- event | schedule
  trigger_event text,
  schedule text, -- hourly | daily | every_5m
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  requires_approval boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status text NOT NULL, -- succeeded | failed | skipped | pending_approval | approved | rejected | test
  trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, dedupe_key)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued', -- queued | running | succeeded | failed
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  progress int NOT NULL DEFAULT 0,
  last_error text,
  dedupe_key text UNIQUE,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ON jobs (status, run_at);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id),
  actor_label text,
  impersonator_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text,
  entity_id text,
  entity_label text,
  before jsonb,
  after jsonb,
  reason text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_events (organization_id, created_at DESC);

-- Audit events are immutable.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TABLE custom_field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity text NOT NULL,
  key text NOT NULL,
  label text NOT NULL,
  type text NOT NULL DEFAULT 'text', -- text | number | date | select | boolean
  options text[] NOT NULL DEFAULT '{}',
  required boolean NOT NULL DEFAULT false,
  filterable boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, entity, key)
);

CREATE TABLE custom_field_values (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL,
  value text,
  PRIMARY KEY (field_id, entity_id)
);

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  subject text NOT NULL,
  body text,
  status text NOT NULL DEFAULT 'open', -- open | pending | resolved
  priority text NOT NULL DEFAULT 'normal',
  created_by uuid REFERENCES users(id),
  assigned_to uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_ticket_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE impersonation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id uuid NOT NULL REFERENCES users(id),
  target_user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  session_id text,
  reason text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count int NOT NULL,
  window_start timestamptz NOT NULL
);
