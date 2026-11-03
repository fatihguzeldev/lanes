CREATE TABLE tasks_template_snapshots (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
 schema_version INTEGER NOT NULL CHECK(schema_version=1), sealed INTEGER NOT NULL DEFAULT 1 CHECK(sealed IN (0,1)), date_mode TEXT NOT NULL CHECK(date_mode IN ('relative','none')),
 save_day TEXT NOT NULL, zone TEXT NOT NULL, list_count INTEGER NOT NULL CHECK(list_count BETWEEN 0 AND 100), task_count INTEGER NOT NULL CHECK(task_count BETWEEN 0 AND 2000),
 context_parent_count INTEGER NOT NULL, completed_included_count INTEGER NOT NULL, omitted_dependency_count INTEGER NOT NULL,
 source_dated_count INTEGER NOT NULL, source_timed_count INTEGER NOT NULL, source_repeat_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(account_id,id)
) STRICT;
CREATE TABLE tasks_template_lists (
 snapshot_id TEXT NOT NULL REFERENCES tasks_template_snapshots(id) ON DELETE CASCADE,
 item_key TEXT NOT NULL, position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99), title TEXT NOT NULL, color TEXT NOT NULL,
 PRIMARY KEY(snapshot_id,item_key), UNIQUE(snapshot_id,position)
) STRICT;
CREATE TABLE tasks_template_nodes (
 snapshot_id TEXT NOT NULL REFERENCES tasks_template_snapshots(id) ON DELETE CASCADE,
 item_key TEXT NOT NULL, position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 1999), list_key TEXT NOT NULL, parent_key TEXT,
 content_json TEXT NOT NULL CHECK(json_valid(content_json)), PRIMARY KEY(snapshot_id,item_key), UNIQUE(snapshot_id,position),
 FOREIGN KEY(snapshot_id,list_key) REFERENCES tasks_template_lists(snapshot_id,item_key)
) STRICT;
CREATE TABLE tasks_template_snapshot_pins (
 account_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, owner_key TEXT NOT NULL,
 PRIMARY KEY(snapshot_id,owner_key), UNIQUE(account_id,owner_key),
 FOREIGN KEY(account_id,snapshot_id) REFERENCES tasks_template_snapshots(account_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE tasks_list_templates (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
 name TEXT NOT NULL, description TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, content_revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(account_id,id)
) STRICT;
CREATE INDEX tasks_template_gallery ON tasks_list_templates(account_id,deleted_at,updated_at DESC,id);
CREATE TABLE tasks_list_template_versions (
 template_id TEXT NOT NULL REFERENCES tasks_list_templates(id) ON DELETE CASCADE, version INTEGER NOT NULL,
 snapshot_id TEXT NOT NULL REFERENCES tasks_template_snapshots(id), PRIMARY KEY(template_id,version)
) STRICT;
CREATE TABLE boards_templates (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
 name TEXT NOT NULL, description TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, content_revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(account_id,id)
) STRICT;
CREATE INDEX boards_template_gallery ON boards_templates(account_id,deleted_at,updated_at DESC,id);
CREATE TABLE boards_template_versions (
 template_id TEXT NOT NULL REFERENCES boards_templates(id) ON DELETE CASCADE, version INTEGER NOT NULL,
 snapshot_id TEXT NOT NULL REFERENCES tasks_template_snapshots(id), appearance_json TEXT NOT NULL CHECK(json_valid(appearance_json)), PRIMARY KEY(template_id,version)
) STRICT;
CREATE TABLE boards_template_schedules (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
 template_kind TEXT NOT NULL CHECK(template_kind IN ('list','board')), template_id TEXT NOT NULL, template_revision INTEGER NOT NULL,
 board_id TEXT NOT NULL, timing_json TEXT NOT NULL CHECK(json_valid(timing_json)), use_relative_dates INTEGER NOT NULL CHECK(use_relative_dates IN (0,1)), list_prefix TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','paused','deleted')), pause_reason TEXT, revision INTEGER NOT NULL DEFAULT 0,
 next_run_at INTEGER, next_attempt_at INTEGER NOT NULL, last_claimed_day TEXT, last_resolved_day TEXT, resume_slot_day TEXT, catch_up_required INTEGER NOT NULL DEFAULT 0 CHECK(catch_up_required IN (0,1)), active_run_id TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(account_id,id)
) STRICT;
CREATE INDEX boards_template_schedule_due ON boards_template_schedules(state,next_attempt_at,next_run_at,id);
CREATE INDEX boards_template_schedule_target ON boards_template_schedules(account_id,board_id,state);
CREATE INDEX boards_template_schedule_source ON boards_template_schedules(account_id,template_kind,template_id,state);
CREATE TABLE boards_template_runs (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE, schedule_id TEXT,
 slot_day TEXT NOT NULL, snapshot_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('capturing','running','partial','paused','succeeded','cancelled')), error_code TEXT,
 captured_json TEXT NOT NULL CHECK(json_valid(captured_json)), list_cursor TEXT, task_cursor TEXT, lists_captured INTEGER NOT NULL DEFAULT 0, tasks_captured INTEGER NOT NULL DEFAULT 0,
 skipped_before TEXT, next_attempt_at INTEGER NOT NULL, work_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(schedule_id,slot_day), UNIQUE(operation_id), UNIQUE(account_id,id)
) STRICT;
CREATE INDEX boards_template_run_work ON boards_template_runs(state,next_attempt_at,work_order,id);
CREATE INDEX boards_template_run_account ON boards_template_runs(account_id,created_at DESC,id);
CREATE TABLE boards_template_skips (
 schedule_id TEXT NOT NULL REFERENCES boards_template_schedules(id) ON DELETE CASCADE,
 after_day TEXT NOT NULL, through_day TEXT NOT NULL, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL,
 PRIMARY KEY(schedule_id,after_day,through_day)
) STRICT;

CREATE TABLE tasks_template_documents (
 snapshot_id TEXT PRIMARY KEY REFERENCES tasks_template_snapshots(id) ON DELETE CASCADE,
 header_json TEXT NOT NULL CHECK(json_valid(header_json)), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE tasks_template_label_definitions (
 snapshot_id TEXT NOT NULL REFERENCES tasks_template_snapshots(id) ON DELETE CASCADE,
 name_key TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
 PRIMARY KEY(snapshot_id,name_key)
) STRICT;

CREATE INDEX boards_template_run_fair_counter ON boards_template_runs(work_order DESC);
