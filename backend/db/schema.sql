-- Smart CRM: Postgres schema (Sprint 2 MVP)
-- Tenant isolation: every table carries workspace_id; enable RLS on each.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  auth_id text UNIQUE NOT NULL,            -- id from Clerk/Auth0/Supabase
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One per client business an agency manages
CREATE TABLE business_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  services text,
  website_url text,
  tone_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Connected inbox per business profile (tokens encrypted at app level)
CREATE TABLE email_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  business_profile_id uuid NOT NULL REFERENCES business_profiles ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('gmail','outlook')),
  address text NOT NULL,
  refresh_token_enc bytea NOT NULL,
  sync_cursor text,                        -- Gmail historyId / Graph delta link
  status text NOT NULL DEFAULT 'active',
  UNIQUE (business_profile_id, address)
);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  business_profile_id uuid NOT NULL REFERENCES business_profiles ON DELETE CASCADE,
  owner_id uuid REFERENCES users,
  full_name text NOT NULL,
  email text NOT NULL,
  phone text,
  company text,
  notes text,
  stage text NOT NULL DEFAULT 'new'
    CHECK (stage IN ('new','contacted','interested','proposal_sent','closed')),
  source text,
  unsubscribed boolean NOT NULL DEFAULT false,
  last_activity_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_profile_id, email)
);
CREATE INDEX leads_stage_idx ON leads (workspace_id, business_profile_id, stage);

-- Event log: the timeline and the AI's source of truth
CREATE TABLE interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email_out','email_in','note','stage_change','call')),
  thread_id text,                          -- provider thread id for reply matching
  provider_message_id text UNIQUE,
  subject text,
  body text,
  classification text                      -- interested | objection | not_now | ooo | unsubscribe
    CHECK (classification IN ('interested','objection','not_now','ooo','unsubscribe')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interactions_lead_idx ON interactions (lead_id, occurred_at DESC);
CREATE INDEX interactions_thread_idx ON interactions (thread_id);

-- Every AI draft or next action, and what the human did with it
CREATE TABLE ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('draft_email','draft_reply','next_action','stage_change')),
  content text NOT NULL,
  confidence numeric(3,2),
  model text,
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','accepted','edited','rejected')),
  final_content text,                      -- what was actually sent, if edited
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads ON DELETE CASCADE,
  title text NOT NULL,
  due_at timestamptz NOT NULL,
  done_at timestamptz,
  auto_generated boolean NOT NULL DEFAULT false
);
CREATE INDEX tasks_due_idx ON tasks (workspace_id, due_at) WHERE done_at IS NULL;

-- Row-level security example (repeat per table; set app.workspace_id per request)
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON leads
  USING (workspace_id = current_setting('app.workspace_id')::uuid);
