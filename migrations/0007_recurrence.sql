CREATE TABLE tasks_recurrence_series (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES tasks_account_state(account_id) ON DELETE CASCADE,
  active_task_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','pending','finished','paused','uncertain','reopen_required','undoing','stopped')),
  created_count INTEGER NOT NULL DEFAULT 1 CHECK(created_count BETWEEN 1 AND 10000),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id,id)
) STRICT;
CREATE INDEX tasks_recurrence_active ON tasks_recurrence_series(account_id,active_task_id);
CREATE TABLE tasks_recurrence_occurrences (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  predecessor_occurrence_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  transition_id TEXT NOT NULL REFERENCES tasks_recurrence_transitions(id),
  state TEXT NOT NULL DEFAULT 'capturing' CHECK(state IN ('capturing','copying','baselines','ready','finished','paused','uncertain','reopen_required','undoing','cancelled','stopped')),
  phase TEXT NOT NULL DEFAULT 'begin' CHECK(phase IN ('begin','append','seal','copy','baselines','ready','undo_cancel','undo_verify','undo_delete','undo_detach','undo_reopen','undo_finish')),
  rule_json TEXT NOT NULL CHECK(json_valid(rule_json)),
  scheduled_day TEXT,
  target_task_id TEXT,
  operation_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  list_id TEXT NOT NULL,
  list_revision INTEGER NOT NULL,
  total_tasks INTEGER NOT NULL CHECK(total_tasks BETWEEN 1 AND 2001),
  append_position INTEGER NOT NULL DEFAULT 0,
  baseline_cursor TEXT,
  copy_confirmed_at INTEGER,
  parent_counted INTEGER NOT NULL DEFAULT 0 CHECK(parent_counted IN (0,1)),
  plan_captured INTEGER NOT NULL DEFAULT 0 CHECK(plan_captured IN (0,1)),
  source_revision INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  checklist_complete INTEGER NOT NULL CHECK(checklist_complete IN (0,1)),
  next_at INTEGER,
  fairness_order INTEGER NOT NULL,
  claim_id TEXT,
  claim_until INTEGER,
  error_code TEXT,
  undo_choice TEXT CHECK(undo_choice IN ('cancel_pending','remove_untouched','one_off')),
  undo_operation_id TEXT,
  undo_task_revision INTEGER,
  verify_position INTEGER NOT NULL DEFAULT 0,
  verify_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id,series_id,predecessor_occurrence_id,attempt),
  FOREIGN KEY(account_id,series_id) REFERENCES tasks_recurrence_series(account_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX tasks_recurrence_due ON tasks_recurrence_occurrences(next_at,fairness_order,id) WHERE next_at IS NOT NULL;
CREATE INDEX tasks_recurrence_source ON tasks_recurrence_occurrences(account_id,source_task_id);
CREATE UNIQUE INDEX tasks_recurrence_one_intent ON tasks_recurrence_occurrences(account_id,source_task_id) WHERE state NOT IN ('cancelled','stopped','finished');
CREATE INDEX tasks_recurrence_target ON tasks_recurrence_occurrences(account_id,target_task_id);
CREATE TABLE tasks_recurrence_copy_items (
  occurrence_id TEXT NOT NULL REFERENCES tasks_recurrence_occurrences(id) ON DELETE CASCADE,
  source_task_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  parent_key TEXT,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  task_id TEXT,
  baseline_revision INTEGER,
  baseline_etag TEXT,
  PRIMARY KEY(occurrence_id,item_key),
  UNIQUE(occurrence_id,position),
  UNIQUE(occurrence_id,source_task_id)
) STRICT;
CREATE INDEX tasks_recurrence_copy_task ON tasks_recurrence_copy_items(occurrence_id,task_id);
CREATE TABLE tasks_recurrence_fairness (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  turn INTEGER NOT NULL DEFAULT 0,
  last_kind TEXT NOT NULL DEFAULT 'transition' CHECK(last_kind IN ('transition','work','watch'))
) STRICT;
INSERT INTO tasks_recurrence_fairness(singleton) VALUES (1);
CREATE TABLE tasks_recurrence_watches (
  account_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  next_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,task_id),
  FOREIGN KEY(account_id,task_id) REFERENCES tasks_tasks(account_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX tasks_recurrence_watch_due ON tasks_recurrence_watches(next_at,account_id,task_id);

-- This is a derived due-work index, not a second scheduling authority.
CREATE TRIGGER tasks_recurrence_watch_insert AFTER INSERT ON tasks_tasks
WHEN NEW.repeat_rule_json IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.parent_id IS NULL AND NEW.completed=0 AND NEW.provider_missing_at IS NULL BEGIN
  INSERT INTO tasks_recurrence_watches(account_id,task_id) VALUES (NEW.account_id,NEW.id) ON CONFLICT(account_id,task_id) DO NOTHING;
END;
CREATE TRIGGER tasks_recurrence_watch_update AFTER UPDATE OF repeat_rule_json,series_id,completed,deleted_at,parent_id,provider_missing_at ON tasks_tasks BEGIN
  DELETE FROM tasks_recurrence_watches WHERE account_id=NEW.account_id AND task_id=NEW.id AND
    (NEW.repeat_rule_json IS NULL OR NEW.deleted_at IS NOT NULL OR NEW.parent_id IS NOT NULL OR NEW.completed=1 OR NEW.provider_missing_at IS NOT NULL OR
      (NEW.series_id IS NOT NULL AND EXISTS(SELECT 1 FROM tasks_recurrence_series s WHERE s.account_id=NEW.account_id AND s.id=NEW.series_id AND s.active_task_id<>NEW.id)));
  INSERT INTO tasks_recurrence_watches(account_id,task_id) SELECT NEW.account_id,NEW.id WHERE NEW.repeat_rule_json IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.parent_id IS NULL AND NEW.completed=0 AND NEW.provider_missing_at IS NULL AND
    (NEW.series_id IS NULL OR NOT EXISTS(SELECT 1 FROM tasks_recurrence_series s WHERE s.account_id=NEW.account_id AND s.id=NEW.series_id AND s.active_task_id<>NEW.id))
    ON CONFLICT(account_id,task_id) DO NOTHING;
END;
INSERT INTO tasks_recurrence_watches(account_id,task_id) SELECT account_id,id FROM tasks_tasks WHERE repeat_rule_json IS NOT NULL AND deleted_at IS NULL AND parent_id IS NULL AND completed=0 AND provider_missing_at IS NULL;
ALTER TABLE tasks_tasks ADD COLUMN last_provider_check_at INTEGER;
CREATE TABLE tasks_recurrence_reopen_requests (
  operation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES tasks_account_state(account_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL REFERENCES tasks_recurrence_occurrences(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
-- A public action identity belongs to one canonical action, including staged undo.
CREATE TRIGGER tasks_recurrence_reserve_identity BEFORE INSERT ON tasks_recurrence_reopen_requests
WHEN EXISTS(SELECT 1 FROM tasks_operations WHERE id=NEW.operation_id) BEGIN
  SELECT RAISE(ABORT,'operation identity is already bound');
END;
CREATE TRIGGER tasks_recurrence_keep_identity BEFORE INSERT ON tasks_operations
WHEN EXISTS(SELECT 1 FROM tasks_recurrence_reopen_requests WHERE operation_id=NEW.id) BEGIN
  SELECT RAISE(ABORT,'operation identity is already bound');
END;
