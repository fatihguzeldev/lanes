CREATE INDEX tasks_issued_step ON tasks_operation_steps(operation_id,position)
  WHERE state IN ('dispatched','uncertain');
