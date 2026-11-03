CREATE TABLE tasks_completed_deletions (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts_connections(id), owner_subject TEXT NOT NULL,
 list_id TEXT NOT NULL, provider_list_id TEXT NOT NULL, list_title TEXT NOT NULL, list_revision INTEGER NOT NULL,
 projection_revision INTEGER NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL,
 selected_count INTEGER NOT NULL, total_count INTEGER NOT NULL, open_count INTEGER NOT NULL, assigned_count INTEGER NOT NULL,
 root_count INTEGER NOT NULL, captured_count INTEGER NOT NULL DEFAULT 0, deleted_count INTEGER NOT NULL DEFAULT 0,
 deleted_roots INTEGER NOT NULL DEFAULT 0, failed_roots INTEGER NOT NULL DEFAULT 0, cancelled_roots INTEGER NOT NULL DEFAULT 0,
 capture_cursor TEXT, capture_hash TEXT NOT NULL DEFAULT '', preview_hash TEXT, current_task_id TEXT,
 work_claim TEXT, work_until INTEGER, work_order INTEGER NOT NULL DEFAULT 0, error_code TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER, payload_pruned_at INTEGER
) STRICT;
CREATE INDEX tasks_completed_deletion_pages ON tasks_completed_deletions(account_id,list_id,created_at,id);
CREATE INDEX tasks_completed_deletion_work ON tasks_completed_deletions(state,work_order,updated_at,id);
CREATE INDEX tasks_completed_deletion_retention ON tasks_completed_deletions(finished_at,id);
CREATE UNIQUE INDEX tasks_completed_deletion_active_list ON tasks_completed_deletions(account_id,list_id) WHERE finished_at IS NULL;
CREATE TABLE tasks_completed_deletion_items (
 deletion_id TEXT NOT NULL REFERENCES tasks_completed_deletions(id), task_id TEXT NOT NULL, root_task_id TEXT NOT NULL,
 parent_id TEXT, title TEXT, completed INTEGER NOT NULL, revision INTEGER NOT NULL, provider_id TEXT NOT NULL,
 provider_etag TEXT, is_root INTEGER NOT NULL, assignment_source TEXT, child_count INTEGER NOT NULL,
 can_delete INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'captured', operation_id TEXT UNIQUE, error_code TEXT,
 PRIMARY KEY(deletion_id,task_id)
) STRICT;
CREATE INDEX tasks_completed_deletion_roots ON tasks_completed_deletion_items(deletion_id,is_root,state,task_id);
CREATE INDEX tasks_completed_deletion_children ON tasks_completed_deletion_items(deletion_id,root_task_id,task_id);
