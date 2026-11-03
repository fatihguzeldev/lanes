-- This disposition survives child-first deletion of its detailed stop receipt.
-- The original uncertain state/response still describe the provider outcome.
ALTER TABLE tasks_operation_steps ADD COLUMN owner_stopped_at INTEGER;
