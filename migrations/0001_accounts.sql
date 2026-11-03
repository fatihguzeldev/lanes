PRAGMA foreign_keys = ON;

CREATE TABLE accounts_installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_subject TEXT,
  bootstrap_email TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  token_key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE accounts_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX accounts_sessions_expiry ON accounts_sessions(expires_at);

CREATE TABLE accounts_connections (
  id TEXT PRIMARY KEY,
  google_subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  picture_url TEXT,
  state TEXT NOT NULL CHECK (state IN ('connecting','connected','reconnect_required','temporarily_unavailable','disconnecting','disconnected')),
  grant_ciphertext TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes_json)),
  access_expires_at INTEGER,
  grant_expires_at INTEGER,
  token_revision INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  refresh_claim TEXT,
  refresh_claim_until INTEGER,
  work_claim TEXT,
  work_claim_until INTEGER,
  disconnect_requested_at INTEGER,
  planning_zone TEXT NOT NULL DEFAULT 'UTC',
  week_start INTEGER NOT NULL DEFAULT 1 CHECK (week_start IN (1,7)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX accounts_connections_due ON accounts_connections(state, work_claim_until);

CREATE TABLE accounts_oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signin','link','reconnect','sheets_import','sheets_export')),
  session_hash TEXT,
  account_id TEXT REFERENCES accounts_connections(id) ON DELETE CASCADE,
  verifier_ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_path TEXT NOT NULL,
  planning_zone TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX accounts_oauth_expiry ON accounts_oauth_states(expires_at);

CREATE TABLE accounts_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0)
) STRICT;

CREATE TABLE accounts_write_guards (
  valid INTEGER NOT NULL CHECK(valid = 1)
) STRICT;
CREATE INDEX accounts_connections_page ON accounts_connections(created_at,id);
