DROP TRIGGER IF EXISTS tasks_command_cleanup;
ALTER TABLE tasks_command_plans ADD COLUMN request_hash TEXT;
ALTER TABLE tasks_command_plans ADD COLUMN payload_pruned_at INTEGER;
ALTER TABLE tasks_command_copy_entries ADD COLUMN input_hash TEXT;
ALTER TABLE tasks_command_copy_lists ADD COLUMN input_hash TEXT;
CREATE INDEX tasks_command_prune ON tasks_command_plans(payload_pruned_at,created_at,operation_id);
