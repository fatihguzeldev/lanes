-- A label stays readable while a journaled job removes at most ten associations
-- per slice. Pending labels cannot be assigned; completion deletes an empty label.
CREATE TABLE tasks_label_deletions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL,
  label_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','completed')),
  removed_associations INTEGER NOT NULL DEFAULT 0 CHECK(removed_associations >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(account_id,id),
  CHECK((state='pending' AND completed_at IS NULL) OR (state='completed' AND completed_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX tasks_label_delete_active ON tasks_label_deletions(account_id,label_id) WHERE state='pending';
CREATE INDEX tasks_label_delete_work ON tasks_label_deletions(state,created_at,id);
