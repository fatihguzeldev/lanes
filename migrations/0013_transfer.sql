-- tasks owns these identity/revision captures; transfer consumes its read/guard seam.
CREATE TABLE tasks_snapshots (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
 input_json TEXT NOT NULL, include_completed INTEGER NOT NULL, task_count INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE tasks_snapshot_lists (
 snapshot_id TEXT NOT NULL REFERENCES tasks_snapshots(id) ON DELETE CASCADE, list_id TEXT NOT NULL,
 position INTEGER NOT NULL, revision INTEGER NOT NULL, projection_revision INTEGER NOT NULL,
 title TEXT NOT NULL, PRIMARY KEY(snapshot_id,list_id), UNIQUE(snapshot_id,position)
);
CREATE TABLE tasks_snapshot_items (
 snapshot_id TEXT NOT NULL REFERENCES tasks_snapshots(id) ON DELETE CASCADE, task_id TEXT NOT NULL,
 position INTEGER NOT NULL, revision INTEGER NOT NULL, context_only INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(snapshot_id,task_id), UNIQUE(snapshot_id,position)
);
CREATE INDEX tasks_snapshots_retention ON tasks_snapshots(created_at,id);

CREATE TABLE transfer_imports (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
 owner_subject TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('staging','preview','capturing','running','finished','cancelled')),
 preview_hash TEXT, operation_id TEXT, capture_list_position INTEGER NOT NULL DEFAULT 0,
 capture_task_position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 finished_at INTEGER, revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE transfer_import_records (
 import_id TEXT NOT NULL REFERENCES transfer_imports(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN('list','task','issue')), item_key TEXT NOT NULL,
 position INTEGER NOT NULL, copy_position INTEGER, input_json TEXT NOT NULL, input_hash TEXT NOT NULL, label_definitions_json TEXT,
 PRIMARY KEY(import_id,kind,item_key), UNIQUE(import_id,kind,position)
);
CREATE INDEX transfer_imports_progress ON transfer_imports(state,updated_at,id);
CREATE INDEX transfer_imports_retention ON transfer_imports(finished_at,id);
CREATE TABLE transfer_write_guards (valid INTEGER NOT NULL CHECK(valid=1));
CREATE TABLE transfer_account_captures (
 import_id TEXT PRIMARY KEY REFERENCES transfer_imports(id) ON DELETE CASCADE,
 source_account_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
 list_position INTEGER NOT NULL DEFAULT 0, task_position INTEGER NOT NULL DEFAULT 0,
 task_cursor TEXT, omitted_dependencies INTEGER NOT NULL DEFAULT 0,
 completed_context INTEGER NOT NULL DEFAULT 0, color_conflicts INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'capturing' CHECK(state IN('capturing','ready'))
);
CREATE TABLE transfer_archives (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts_connections(id),
 owner_subject TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN('restore_metadata','copy_task_snapshots')),
 header_json TEXT NOT NULL, expected_records INTEGER NOT NULL, bytes INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'staging' CHECK(state IN('staging','preview','restoring','finished','cancelled')),
 revision INTEGER NOT NULL DEFAULT 0, preview_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 finished_at INTEGER
);
CREATE TABLE transfer_archive_records (
 archive_id TEXT NOT NULL REFERENCES transfer_archives(id), item_key TEXT NOT NULL,
 position INTEGER NOT NULL, kind TEXT NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
 match_json TEXT, incoming INTEGER NOT NULL DEFAULT 0, restore_state TEXT NOT NULL DEFAULT 'pending',
 result_json TEXT, PRIMARY KEY(archive_id,item_key), UNIQUE(archive_id,position)
);
CREATE INDEX transfer_archives_work ON transfer_archives(state,updated_at,id);
CREATE INDEX transfer_archives_retention ON transfer_archives(finished_at,id);
CREATE TABLE tasks_snapshot_labels (
 snapshot_id TEXT NOT NULL REFERENCES tasks_snapshots(id), label_id TEXT NOT NULL,
 revision INTEGER NOT NULL, PRIMARY KEY(snapshot_id,label_id)
);
ALTER TABLE transfer_archives ADD COLUMN preferences_incoming INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN preferences_revision INTEGER;
ALTER TABLE transfer_archive_records ADD COLUMN fields_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE transfer_archive_records ADD COLUMN accept_omitted INTEGER NOT NULL DEFAULT 0;
CREATE TABLE transfer_archive_actions (
 archive_id TEXT NOT NULL REFERENCES transfer_archives(id), item_key TEXT NOT NULL,
 phase TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL,
 result_json TEXT, state TEXT NOT NULL DEFAULT 'pending',
 PRIMARY KEY(archive_id,item_key,phase)
);
CREATE TABLE transfer_archive_copies (
 archive_id TEXT NOT NULL REFERENCES transfer_archives(id), import_id TEXT PRIMARY KEY REFERENCES transfer_imports(id),
 list_position INTEGER NOT NULL DEFAULT 0, task_position INTEGER NOT NULL DEFAULT 0,
 omitted_dependencies INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'capturing'
);
ALTER TABLE transfer_imports ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_imports ADD COLUMN error_code TEXT;
ALTER TABLE transfer_imports ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_imports ADD COLUMN work_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_imports ADD COLUMN summary_cache_json TEXT;
ALTER TABLE transfer_imports ADD COLUMN payload_pruned_at INTEGER;
ALTER TABLE transfer_archives ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN work_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN payload_pruned_at INTEGER;
ALTER TABLE transfer_archives ADD COLUMN validation_revision INTEGER;
ALTER TABLE transfer_archives ADD COLUMN hash_position INTEGER NOT NULL DEFAULT -1;
ALTER TABLE transfer_archives ADD COLUMN hash_chain TEXT NOT NULL DEFAULT '';
CREATE TABLE transfer_archive_graph_nodes (
 archive_id TEXT NOT NULL REFERENCES transfer_archives(id), scope TEXT NOT NULL, node_key TEXT NOT NULL,
 remaining INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(archive_id,scope,node_key)
);
CREATE INDEX transfer_archive_graph_ready ON transfer_archive_graph_nodes(archive_id,processed,remaining,scope,node_key);
CREATE TABLE transfer_archive_graph_edges (
 archive_id TEXT NOT NULL REFERENCES transfer_archives(id), scope TEXT NOT NULL,
 source_key TEXT NOT NULL,target_key TEXT NOT NULL,
 PRIMARY KEY(archive_id,scope,source_key,target_key)
);
CREATE INDEX transfer_archive_graph_targets ON transfer_archive_graph_edges(archive_id,scope,target_key,source_key);
CREATE TABLE transfer_archive_template_labels (
 archive_id TEXT NOT NULL REFERENCES transfer_archives(id),template_key TEXT NOT NULL,
 name_key TEXT NOT NULL,color TEXT NOT NULL,PRIMARY KEY(archive_id,template_key,name_key)
);
ALTER TABLE transfer_archives ADD COLUMN captured_records INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN match_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN matched_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN new_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN conflict_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN unmatched_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN selected_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN restored_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archives ADD COLUMN graph_remaining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archive_records ADD COLUMN restore_priority INTEGER NOT NULL DEFAULT 0;
CREATE INDEX transfer_archive_restore_work ON transfer_archive_records(archive_id,incoming,restore_state,restore_priority,position);
CREATE INDEX transfer_archive_template_refs ON transfer_archive_records(archive_id,kind,json_extract(input_json,'$.templateKey'),json_extract(input_json,'$.value.key'));
CREATE INDEX transfer_archive_template_positions ON transfer_archive_records(archive_id,kind,json_extract(input_json,'$.templateKey'),json_extract(input_json,'$.value.position'));
CREATE INDEX transfer_archive_list_provider ON transfer_archive_records(archive_id,kind,json_extract(input_json,'$.providerId'));
CREATE INDEX transfer_archive_task_provider ON transfer_archive_records(archive_id,kind,json_extract(input_json,'$.provider.listId'),json_extract(input_json,'$.provider.id'));
CREATE INDEX transfer_archive_event_identity ON transfer_archive_records(archive_id,kind,json_extract(input_json,'$.event.id'));
ALTER TABLE transfer_imports ADD COLUMN validation_revision INTEGER;
ALTER TABLE transfer_imports ADD COLUMN validation_records INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_imports ADD COLUMN hash_position INTEGER NOT NULL DEFAULT -1;
ALTER TABLE transfer_imports ADD COLUMN hash_chain TEXT NOT NULL DEFAULT '';
ALTER TABLE transfer_imports ADD COLUMN graph_remaining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_import_records ADD COLUMN validation_position INTEGER;
CREATE INDEX transfer_import_validation_positions ON transfer_import_records(import_id,validation_position);
CREATE INDEX transfer_archive_pending_matches ON transfer_archive_records(archive_id,position)WHERE match_json IS NULL;
CREATE TABLE transfer_import_graph_nodes (
 import_id TEXT NOT NULL REFERENCES transfer_imports(id),scope TEXT NOT NULL,node_key TEXT NOT NULL,
 remaining INTEGER NOT NULL,processed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(import_id,scope,node_key)
);
CREATE INDEX transfer_import_graph_ready ON transfer_import_graph_nodes(import_id,processed,remaining,scope,node_key);
CREATE TABLE transfer_import_graph_edges (
 import_id TEXT NOT NULL REFERENCES transfer_imports(id),scope TEXT NOT NULL,source_key TEXT NOT NULL,target_key TEXT NOT NULL,
 PRIMARY KEY(import_id,scope,source_key,target_key)
);
CREATE INDEX transfer_import_graph_targets ON transfer_import_graph_edges(import_id,scope,target_key,source_key);
ALTER TABLE transfer_account_captures ADD COLUMN request_hash TEXT;
ALTER TABLE transfer_account_captures ADD COLUMN snapshot_released INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks_snapshots ADD COLUMN context_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_archive_copies ADD COLUMN request_hash TEXT;
