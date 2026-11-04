CREATE INDEX tasks_provider_identity ON tasks_tasks(account_id,provider_id) WHERE deleted_at IS NULL;
