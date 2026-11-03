ALTER TABLE tasks_label_deletions ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX tasks_label_background ON tasks_label_deletions(state,next_attempt_at,id);
