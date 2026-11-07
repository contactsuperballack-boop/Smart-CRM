-- Run after migrations-002.sql, as the OWNER role.
BEGIN;

-- Minimal proof that deletions happened. Ids and counts only: no emails, names or content.
CREATE TABLE IF NOT EXISTS deletion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,                 -- deliberately no foreign key: the workspace no longer exists
  deleted_at timestamptz NOT NULL DEFAULT now(),
  leads_deleted int NOT NULL,
  tokens_revoked int NOT NULL,
  tokens_revoke_failed int NOT NULL
);

-- A task pointing at a deleted suggestion should just lose the link, not block the delete
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_suggestion_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_suggestion_id_fkey
  FOREIGN KEY (suggestion_id) REFERENCES ai_suggestions ON DELETE SET NULL;

GRANT SELECT, INSERT ON deletion_log TO crm_app;
COMMIT;
