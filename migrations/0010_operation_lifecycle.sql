-- Finished partial output no longer reserves a resource against future user commands.
DROP INDEX tasks_operation_resource;
CREATE UNIQUE INDEX tasks_operation_resource ON tasks_operations(account_id,resource_key)
  WHERE terminal_at IS NULL AND state IN ('accepted','running','partial','reconnect_required','blocked_by_limit','uncertain');
