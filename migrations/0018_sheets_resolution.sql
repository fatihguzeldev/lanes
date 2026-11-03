CREATE TABLE transfer_sheets_verifications (
 id TEXT PRIMARY KEY,
 export_id TEXT NOT NULL REFERENCES transfer_sheets_exports(id),
 account_id TEXT NOT NULL,
 step_key TEXT NOT NULL,
 original_claim_id TEXT NOT NULL,
 step_hash TEXT NOT NULL,
 candidate_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('sheets.create','sheets.rows')),
 status TEXT NOT NULL CHECK(status IN ('verifying','matched','mismatch','adopted','cancelled')),
 phase TEXT NOT NULL CHECK(phase IN ('metadata','cells')),
 first_row INTEGER NOT NULL,
 next_row INTEGER NOT NULL,
 last_row INTEGER NOT NULL,
 column_count INTEGER NOT NULL,
 proof_hash TEXT NOT NULL,
 verified_at INTEGER,
 mismatch_code TEXT,
 revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX transfer_sheets_verifications_account ON transfer_sheets_verifications(account_id,status,id);
CREATE INDEX transfer_sheets_verifications_export ON transfer_sheets_verifications(export_id,id);

CREATE TABLE transfer_sheets_fresh_attempts (
 new_export_id TEXT PRIMARY KEY REFERENCES transfer_sheets_exports(id),
 original_export_id TEXT NOT NULL REFERENCES transfer_sheets_exports(id),
 account_id TEXT NOT NULL,
 original_step_key TEXT NOT NULL,
 original_claim_id TEXT NOT NULL,
 original_capture_hash TEXT NOT NULL,
 cloned_chunks INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE INDEX transfer_sheets_fresh_attempts_account ON transfer_sheets_fresh_attempts(account_id,new_export_id);
