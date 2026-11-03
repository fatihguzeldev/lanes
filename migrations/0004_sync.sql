ALTER TABLE tasks_lists ADD COLUMN projection_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks_lists ADD COLUMN provider_missing_at INTEGER;
ALTER TABLE tasks_lists ADD COLUMN last_full_sync_at INTEGER;
ALTER TABLE tasks_tasks ADD COLUMN provider_missing_at INTEGER;
ALTER TABLE tasks_tasks ADD COLUMN provider_hidden INTEGER NOT NULL DEFAULT 0 CHECK(provider_hidden IN (0,1));

CREATE TABLE tasks_sync_jobs (
  account_id TEXT PRIMARY KEY REFERENCES tasks_account_state(account_id) ON DELETE CASCADE,
  claim_id TEXT,
  claim_until INTEGER,
  next_at INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  fairness_order INTEGER NOT NULL DEFAULT 0,
  manual_at INTEGER,
  default_pending INTEGER NOT NULL DEFAULT 1 CHECK(default_pending IN (0,1)),
  inventory_pending INTEGER NOT NULL DEFAULT 1 CHECK(inventory_pending IN (0,1)),
  task_turn INTEGER NOT NULL DEFAULT 0 CHECK(task_turn IN (0,1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  auth_refresh_attempted INTEGER NOT NULL DEFAULT 0 CHECK(auth_refresh_attempted IN (0,1)),
  error_code TEXT
) STRICT;
CREATE INDEX tasks_sync_due ON tasks_sync_jobs(next_at,fairness_order,account_id);
CREATE TABLE tasks_sync_fairness (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  turn INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO tasks_sync_fairness(singleton) VALUES (1);
CREATE TABLE tasks_sync_list_work (
  account_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  next_at INTEGER NOT NULL,
  mode TEXT CHECK(mode IN ('full','delta')),
  page_token TEXT,
  scan_id TEXT,
  started_at INTEGER,
  updated_min TEXT,
  PRIMARY KEY(account_id,list_id),
  FOREIGN KEY(account_id,list_id) REFERENCES tasks_lists(account_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX tasks_sync_list_due ON tasks_sync_list_work(account_id,next_at,priority,list_id);
CREATE TABLE tasks_sync_checks (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('list','task')),
  resource_id TEXT NOT NULL,
  next_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,kind,resource_id),
  FOREIGN KEY(account_id) REFERENCES tasks_account_state(account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX tasks_sync_checks_due ON tasks_sync_checks(account_id,next_at,kind,resource_id);

CREATE TABLE tasks_schedule_pauses (
  account_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  rule_json TEXT NOT NULL CHECK(json_valid(rule_json)),
  reason TEXT NOT NULL,
  paused_at INTEGER NOT NULL,
  provider_version TEXT NOT NULL,
  PRIMARY KEY(account_id,task_id),
  FOREIGN KEY(account_id,task_id) REFERENCES tasks_tasks(account_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE tasks_recurrence_transitions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('completed','reopened')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  children_complete INTEGER NOT NULL CHECK(children_complete IN (0,1)),
  observed_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('captured','pending','admitted','resolved','cancelled')),
  UNIQUE(account_id,task_id,provider_version,kind),
  FOREIGN KEY(account_id,task_id) REFERENCES tasks_tasks(account_id,id)
) STRICT;
CREATE INDEX tasks_recurrence_pending ON tasks_recurrence_transitions(state,observed_at,id);
CREATE TABLE tasks_recurrence_transition_children (
  transition_id TEXT NOT NULL REFERENCES tasks_recurrence_transitions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(transition_id,task_id)
) STRICT;

-- A scan may observe child completion on an earlier page than its parent.
-- Freeze the first pre-page checklist until the scan finishes or resumes.
CREATE TABLE tasks_recurrence_observations (
  account_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  children_complete INTEGER NOT NULL CHECK(children_complete IN (0,1)),
  PRIMARY KEY(account_id,task_id),
  FOREIGN KEY(account_id,task_id) REFERENCES tasks_tasks(account_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX tasks_recurrence_observation_list ON tasks_recurrence_observations(account_id,list_id);
CREATE TABLE tasks_recurrence_observation_children (
  account_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(account_id,parent_id,task_id),
  FOREIGN KEY(account_id,parent_id) REFERENCES tasks_recurrence_observations(account_id,task_id) ON DELETE CASCADE
) STRICT;
