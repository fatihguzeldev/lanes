-- Plans are captured in bounded chunks, then sealed before any dispatch.
ALTER TABLE tasks_operations ADD COLUMN total_steps INTEGER NOT NULL DEFAULT 1 CHECK(total_steps BETWEEN 1 AND 10000);
ALTER TABLE tasks_operations ADD COLUMN confirmed_steps INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_steps >= 0);
ALTER TABLE tasks_operations ADD COLUMN input_sealed INTEGER NOT NULL DEFAULT 1 CHECK(input_sealed IN (0,1));
ALTER TABLE tasks_operation_steps ADD COLUMN list_slot INTEGER NOT NULL DEFAULT 0 CHECK(list_slot IN (0,1));
UPDATE tasks_operations SET
  total_steps=MAX(1,(SELECT COUNT(*) FROM tasks_operation_steps s WHERE s.operation_id=tasks_operations.id)),
  confirmed_steps=(SELECT COUNT(*) FROM tasks_operation_steps s WHERE s.operation_id=tasks_operations.id AND s.state='confirmed');
UPDATE tasks_operation_steps SET list_slot=1 WHERE kind='list.create';
CREATE UNIQUE INDEX tasks_step_position ON tasks_operation_steps(operation_id,position);
CREATE INDEX accounts_rate_expiry ON accounts_rate_limits(window_start,bucket);
ALTER TABLE tasks_account_state ADD COLUMN last_complete_scan_id TEXT;
