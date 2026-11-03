CREATE TABLE transfer_sheets_write_guards (valid INTEGER NOT NULL CHECK (valid=1));

CREATE TABLE transfer_sheets_exports (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts_connections(id),
 owner_subject TEXT NOT NULL,
 request_json TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 title TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('capturing','ready','admitted','paused','uncertain','finished','failed','cancelled')),
 revision INTEGER NOT NULL DEFAULT 0,
 nonce TEXT,
 cursor TEXT,
 capture_hash TEXT NOT NULL,
 generated_at TEXT,
 freshness_json TEXT,
 counts_json TEXT NOT NULL DEFAULT '{}',
 row_count INTEGER NOT NULL DEFAULT 0,
 column_count INTEGER NOT NULL DEFAULT 16,
 chunk_count INTEGER NOT NULL DEFAULT 0,
 captured_bytes INTEGER NOT NULL DEFAULT 0,
 promoted_chunks INTEGER NOT NULL DEFAULT 0,
 confirmed_rows INTEGER NOT NULL DEFAULT 0,
 file_id TEXT,
 file_url TEXT,
 confirmed_at INTEGER,
 finished_at INTEGER,
 error_code TEXT,
 next_attempt_at INTEGER,
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 active_step TEXT,
 active_claim TEXT,
 active_until INTEGER,
 unresolved INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX transfer_sheets_exports_work ON transfer_sheets_exports(state,next_attempt_at,updated_at,id);
CREATE INDEX transfer_sheets_exports_account ON transfer_sheets_exports(account_id,id);
CREATE INDEX transfer_sheets_exports_retention ON transfer_sheets_exports(finished_at,id);

CREATE TABLE transfer_sheets_export_chunks (
 export_id TEXT NOT NULL REFERENCES transfer_sheets_exports(id),
 position INTEGER NOT NULL,
 start_row INTEGER NOT NULL,
 data_rows INTEGER NOT NULL,
 row_count INTEGER NOT NULL,
 rows_json TEXT NOT NULL,
 input_hash TEXT NOT NULL,
 byte_count INTEGER NOT NULL,
 confirmed_at INTEGER,
 payload_pruned_at INTEGER,
 PRIMARY KEY(export_id,position),
 UNIQUE(export_id,start_row)
);
