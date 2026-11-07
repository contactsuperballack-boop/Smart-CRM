-- Run once after schema.sql, as the OWNER role (not the app role).
BEGIN;

-- Webhook + reply matching
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS reply_token text UNIQUE;
UPDATE business_profiles SET reply_token = encode(gen_random_bytes(6), 'hex') WHERE reply_token IS NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bounced boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS unassigned_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  business_profile_id uuid NOT NULL REFERENCES business_profiles ON DELETE CASCADE,
  from_email text, subject text, body text,
  provider_message_id text UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Follow-up scheduler
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sequence_no int;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS suggestion_id uuid REFERENCES ai_suggestions;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_auto_task ON tasks (lead_id) WHERE auto_generated AND done_at IS NULL;

-- Row-level security on every tenant table (replaces the single example policy from schema.sql)
DROP POLICY IF EXISTS tenant_isolation ON leads;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['business_profiles','email_accounts','leads','interactions','ai_suggestions','tasks','unassigned_replies']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'')::uuid)', t);
  END LOOP;
END $$;
-- users and workspaces are read before a tenant is known (login, scheduler), so they stay outside RLS.

-- App role: must NOT own the tables and must NOT have BYPASSRLS, or RLS does nothing.
-- CREATE ROLE crm_app LOGIN PASSWORD '<strong-password>' NOSUPERUSER NOBYPASSRLS;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app;
COMMIT;
