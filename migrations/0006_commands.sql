CREATE TABLE tasks_command_plans (
  operation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  capture_nonce TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  list_slots INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX tasks_command_capture_expiry ON tasks_command_plans(created_at,operation_id);
CREATE TABLE tasks_command_steps (
  operation_id TEXT NOT NULL REFERENCES tasks_command_plans(operation_id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  PRIMARY KEY(operation_id,item_key),
  UNIQUE(operation_id,position)
) STRICT;
CREATE TRIGGER tasks_command_cleanup AFTER DELETE ON tasks_operations BEGIN
  DELETE FROM tasks_command_plans WHERE operation_id=OLD.id;
END;
CREATE TABLE tasks_command_resources (
  operation_id TEXT NOT NULL REFERENCES tasks_command_plans(operation_id) ON DELETE CASCADE,
  list_id TEXT NOT NULL,
  PRIMARY KEY(operation_id,list_id)
) STRICT;
CREATE TABLE tasks_command_locks (
  account_id TEXT NOT NULL REFERENCES accounts_connections(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES tasks_command_plans(operation_id) ON DELETE CASCADE,
  PRIMARY KEY(account_id,list_id)
) STRICT;
CREATE INDEX tasks_command_locks_owner ON tasks_command_locks(operation_id);
ALTER TABLE tasks_command_plans ADD COLUMN copy_context_json TEXT CHECK(copy_context_json IS NULL OR json_valid(copy_context_json));
CREATE TABLE tasks_command_copy_entries (
  operation_id TEXT NOT NULL REFERENCES tasks_command_plans(operation_id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  parent_key TEXT,
  previous_key TEXT,
  previous_explicit INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  PRIMARY KEY(operation_id,item_key),
  UNIQUE(operation_id,position),
  UNIQUE(operation_id,task_id)
) STRICT;
CREATE TABLE tasks_command_copy_receipts (
  operation_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  provider_etag TEXT,
  PRIMARY KEY(operation_id,item_key),
  FOREIGN KEY(operation_id,item_key) REFERENCES tasks_command_copy_entries(operation_id,item_key) ON DELETE CASCADE
) STRICT;
CREATE TABLE tasks_command_move_members (
  operation_id TEXT NOT NULL REFERENCES tasks_command_plans(operation_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  source_provider_id TEXT NOT NULL,
  target_provider_id TEXT,
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  title_key TEXT,
  search_text TEXT,
  PRIMARY KEY(operation_id,task_id),
  UNIQUE(operation_id,target_provider_id)
) STRICT;
CREATE TABLE tasks_command_projection_deltas (
  operation_id TEXT NOT NULL REFERENCES tasks_command_plans(operation_id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  list_id TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK(delta>=0),
  PRIMARY KEY(operation_id,step_key,list_id)
) STRICT;
CREATE TABLE tasks_command_copy_sources (
  operation_id TEXT NOT NULL REFERENCES tasks_command_plans(operation_id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  PRIMARY KEY(operation_id,item_key),
  UNIQUE(operation_id,position)
) STRICT;
