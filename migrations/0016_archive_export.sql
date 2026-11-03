CREATE TABLE transfer_archive_export_guards (valid INTEGER NOT NULL CHECK(valid=1));
CREATE TABLE transfer_archive_exports (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts_connections(id),
 request_json TEXT NOT NULL,request_hash TEXT NOT NULL,header_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'capturing' CHECK(state IN('capturing','ready','failed','cancelled')),
 phase TEXT NOT NULL DEFAULT 'boards',cursor TEXT,revision INTEGER NOT NULL DEFAULT 0,nonce TEXT,
 record_count INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL,
 task_count INTEGER NOT NULL DEFAULT 0,list_count INTEGER NOT NULL DEFAULT 0,
 unmatched_schedules INTEGER NOT NULL DEFAULT 0,graph_revision INTEGER,
 freshness_json TEXT,capture_hash TEXT NOT NULL,error_code TEXT,
 payload_pruned_at INTEGER,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,finished_at INTEGER
);
CREATE INDEX transfer_archive_exports_account ON transfer_archive_exports(account_id,created_at DESC,id);
CREATE INDEX transfer_archive_exports_work ON transfer_archive_exports(state,updated_at,id);
CREATE INDEX transfer_archive_exports_cleanup ON transfer_archive_exports(finished_at,id);
CREATE TABLE transfer_archive_export_records (
 export_id TEXT NOT NULL REFERENCES transfer_archive_exports(id),
 item_key TEXT NOT NULL,position INTEGER NOT NULL,kind TEXT NOT NULL,
 source_id TEXT NOT NULL,input_json TEXT NOT NULL,input_hash TEXT NOT NULL,byte_count INTEGER NOT NULL,
 PRIMARY KEY(export_id,item_key),UNIQUE(export_id,position)
);
CREATE INDEX transfer_archive_export_records_kind ON transfer_archive_export_records(export_id,kind,position);
CREATE TABLE transfer_archive_export_jobs (
 export_id TEXT NOT NULL REFERENCES transfer_archive_exports(id),item_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('board_lists','template','schedule')),
 source_id TEXT NOT NULL,source_kind TEXT,source_version INTEGER,
 state TEXT NOT NULL DEFAULT 'queued',cursor TEXT,payload_json TEXT NOT NULL DEFAULT '{}',
 required INTEGER NOT NULL DEFAULT 0,
 snapshot_id TEXT,pin_owner TEXT,
 PRIMARY KEY(export_id,item_key)
);
CREATE INDEX transfer_archive_export_jobs_work ON transfer_archive_export_jobs(export_id,kind,state,item_key);
