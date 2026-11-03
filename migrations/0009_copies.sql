ALTER TABLE tasks_command_copy_entries ADD COLUMN list_key TEXT NOT NULL DEFAULT 'list';
CREATE INDEX tasks_command_copy_siblings ON tasks_command_copy_entries(operation_id,list_key,parent_key,position);
CREATE TABLE tasks_command_copy_lists (
  operation_id TEXT NOT NULL REFERENCES tasks_command_plans(operation_id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99),
  list_id TEXT NOT NULL,
  board_id TEXT,
  board_revision INTEGER,
  is_new INTEGER NOT NULL CHECK(is_new IN (0,1)),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  list_json TEXT NOT NULL CHECK(json_valid(list_json)),
  PRIMARY KEY(operation_id,item_key),
  UNIQUE(operation_id,position),
  UNIQUE(operation_id,list_id)
) STRICT;
