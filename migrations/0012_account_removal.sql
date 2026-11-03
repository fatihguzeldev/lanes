ALTER TABLE accounts_connections ADD COLUMN removal_requested_at INTEGER;
CREATE TABLE accounts_disconnect_jobs (
  account_id TEXT PRIMARY KEY REFERENCES accounts_connections(id) ON DELETE CASCADE,
  owner_names_json TEXT NOT NULL CHECK(json_valid(owner_names_json)),
  owner_position INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'pause' CHECK(phase IN ('pause','revoke','completed')),
  remote_revocation TEXT NOT NULL DEFAULT 'pending' CHECK(remote_revocation IN ('pending','succeeded','failed','not_needed','unknown')),
  claim_id TEXT,
  claim_until INTEGER,
  next_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX accounts_disconnect_due ON accounts_disconnect_jobs(next_at,account_id) WHERE next_at IS NOT NULL;
CREATE TABLE accounts_removal_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  subject_hash TEXT NOT NULL,
  owner_names_json TEXT NOT NULL CHECK(json_valid(owner_names_json)),
  owner_position INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'owners' CHECK(phase IN ('owners','oauth','disconnect_receipt','connection','completed')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','blocked','completed')),
  deleted_records INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  claim_until INTEGER,
  next_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE INDEX accounts_removal_due ON accounts_removal_jobs(next_at,created_at,id) WHERE next_at IS NOT NULL;
CREATE TABLE accounts_removed_subjects (
  subject_hash TEXT PRIMARY KEY,
  fresh_after INTEGER NOT NULL
) STRICT;
CREATE INDEX accounts_removed_subject_expiry ON accounts_removed_subjects(fresh_after);
-- OAuth may finish after removal was confirmed. Its state/grant write must fail
-- in the same SQLite transaction, even if an earlier application check passed.
CREATE TRIGGER accounts_removal_fence BEFORE UPDATE OF state,grant_ciphertext ON accounts_connections
WHEN OLD.removal_requested_at IS NOT NULL AND (NEW.state<>'disconnected' OR NEW.grant_ciphertext IS NOT NULL) BEGIN
  SELECT RAISE(ABORT,'local account removal is in progress');
END;
