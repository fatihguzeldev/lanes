CREATE TABLE boards_boards (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  is_main INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0,1)),
  emoji TEXT,
  color TEXT NOT NULL DEFAULT '#f1f0e9',
  background_url TEXT,
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id,id)
) STRICT;
CREATE UNIQUE INDEX boards_one_main ON boards_boards(account_id) WHERE is_main = 1;
CREATE INDEX boards_order ON boards_boards(account_id, position, id);

CREATE TABLE tasks_account_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts_connections(id) ON DELETE CASCADE,
  inventory_count INTEGER NOT NULL DEFAULT 0 CHECK (inventory_count >= 0),
  inventory_complete_at INTEGER,
  inventory_revision INTEGER NOT NULL DEFAULT 0,
  inventory_cursor TEXT,
  inventory_scan_id TEXT,
  graph_revision INTEGER NOT NULL DEFAULT 0,
  foreground_refresh_at INTEGER,
  next_background_at INTEGER,
  full_sync_cursor TEXT
) STRICT;

CREATE TABLE tasks_lists (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  provider_etag TEXT,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0,
  last_seen_scan TEXT,
  last_synced_at INTEGER,
  tasks_complete_at INTEGER,
  completed_complete_at INTEGER,
  sync_cursor TEXT,
  sync_watermark TEXT,
  deleted_at INTEGER,
  UNIQUE(account_id,id),
  UNIQUE(account_id,provider_id)
) STRICT;
CREATE INDEX tasks_lists_active ON tasks_lists(account_id,deleted_at,id);
CREATE UNIQUE INDEX tasks_one_default ON tasks_lists(account_id) WHERE is_default = 1 AND deleted_at IS NULL;

CREATE TABLE boards_memberships (
  account_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#f8f6ef',
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,list_id),
  FOREIGN KEY(account_id,list_id) REFERENCES tasks_lists(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,board_id) REFERENCES boards_boards(account_id,id)
) STRICT;
CREATE INDEX boards_membership_order ON boards_memberships(account_id,board_id,position,list_id);

CREATE TABLE tasks_tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  parent_id TEXT,
  provider_id TEXT NOT NULL,
  provider_parent_id TEXT,
  provider_etag TEXT,
  provider_position TEXT,
  provider_updated_at TEXT,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  completed_at TEXT,
  scheduled_day TEXT,
  scheduled_time TEXT,
  time_zone TEXT,
  repeat_rule_json TEXT CHECK (repeat_rule_json IS NULL OR json_valid(repeat_rule_json)),
  series_id TEXT,
  occurrence_id TEXT,
  priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high')),
  starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  unsupported_hierarchy INTEGER NOT NULL DEFAULT 0 CHECK (unsupported_hierarchy IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0,
  last_seen_scan TEXT,
  deleted_at INTEGER,
  UNIQUE(account_id,id),
  UNIQUE(account_id,list_id,id),
  UNIQUE(account_id,list_id,provider_id),
  FOREIGN KEY(account_id,list_id) REFERENCES tasks_lists(account_id,id),
  FOREIGN KEY(account_id,list_id,parent_id) REFERENCES tasks_tasks(account_id,list_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(parent_id IS NULL OR parent_id <> id),
  CHECK(scheduled_day IS NOT NULL OR (scheduled_time IS NULL AND repeat_rule_json IS NULL)),
  CHECK(scheduled_time IS NULL OR time_zone IS NOT NULL),
  CHECK(parent_id IS NULL OR repeat_rule_json IS NULL)
) STRICT;
CREATE INDEX tasks_list_order ON tasks_tasks(account_id,list_id,deleted_at,completed,parent_id,provider_position,id);
CREATE INDEX tasks_scheduled ON tasks_tasks(account_id,scheduled_day,deleted_at,completed,id);
CREATE INDEX tasks_completions ON tasks_tasks(account_id,completed,completed_at,id);
CREATE INDEX tasks_parent ON tasks_tasks(account_id,parent_id,deleted_at,id);
CREATE INDEX tasks_series ON tasks_tasks(account_id,series_id,occurrence_id);

CREATE TABLE tasks_labels (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  color TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id,id),
  UNIQUE(account_id,name_key)
) STRICT;
CREATE TABLE tasks_task_labels (
  account_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY(account_id,task_id,label_id),
  FOREIGN KEY(account_id,task_id) REFERENCES tasks_tasks(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,label_id) REFERENCES tasks_labels(account_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX tasks_label_lookup ON tasks_task_labels(account_id,label_id,task_id);

CREATE TABLE tasks_dependencies (
  account_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  blocker_id TEXT NOT NULL,
  PRIMARY KEY(account_id,task_id,blocker_id),
  FOREIGN KEY(account_id,task_id) REFERENCES tasks_tasks(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,blocker_id) REFERENCES tasks_tasks(account_id,id) ON DELETE CASCADE,
  CHECK(task_id <> blocker_id)
) STRICT;
CREATE INDEX tasks_dependants ON tasks_dependencies(account_id,blocker_id,task_id);

CREATE TABLE tasks_operations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  state TEXT NOT NULL CHECK(state IN ('accepted','running','succeeded','partial','reconnect_required','blocked_by_limit','uncertain','failed','cancelled')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  error_message TEXT,
  next_attempt_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  UNIQUE(account_id,id)
) STRICT;
CREATE UNIQUE INDEX tasks_operation_resource ON tasks_operations(account_id,resource_key)
  WHERE state IN ('accepted','running','partial','reconnect_required','blocked_by_limit','uncertain');
CREATE INDEX tasks_operation_work ON tasks_operations(state,next_attempt_at,updated_at,id);
CREATE INDEX tasks_operation_account ON tasks_operations(account_id,created_at,id);
CREATE INDEX tasks_operation_terminal ON tasks_operations(terminal_at);

CREATE TABLE tasks_operation_steps (
  operation_id TEXT NOT NULL REFERENCES tasks_operations(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  state TEXT NOT NULL CHECK(state IN ('accepted','claimed','dispatched','confirmed','failed','uncertain','cancelled')),
  claim_id TEXT,
  claim_until INTEGER,
  dispatched_at INTEGER,
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  next_attempt_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(operation_id,item_key)
) STRICT;
CREATE INDEX tasks_step_work ON tasks_operation_steps(operation_id,position,state);

CREATE TABLE tasks_list_reservations (
  operation_id TEXT PRIMARY KEY REFERENCES tasks_operations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
  slots INTEGER NOT NULL CHECK(slots >= 0),
  remaining INTEGER NOT NULL CHECK(remaining >= 0 AND remaining <= slots),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX tasks_reserved_slots ON tasks_list_reservations(account_id,remaining);

CREATE TABLE history_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
  task_id TEXT,
  list_id TEXT,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  task_title TEXT,
  list_title TEXT,
  recorded_at INTEGER NOT NULL,
  provider_at TEXT,
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  UNIQUE(account_id,dedup_key)
) STRICT;
CREATE INDEX history_account_time ON history_events(account_id,recorded_at DESC,id DESC);
CREATE INDEX history_task_time ON history_events(account_id,task_id,recorded_at DESC,id DESC);
CREATE INDEX history_list_time ON history_events(account_id,list_id,recorded_at DESC,id DESC);
CREATE INDEX history_expiry ON history_events(recorded_at);

-- Invalid conditional writes abort a D1 batch before cross-owner delete hooks run.
-- Valid operations insert no rows; this table intentionally remains empty.
CREATE TABLE boards_write_guards (
  valid INTEGER NOT NULL CHECK(valid = 1)
) STRICT;

CREATE TABLE tasks_write_guards (
  valid INTEGER NOT NULL CHECK(valid = 1)
) STRICT;
