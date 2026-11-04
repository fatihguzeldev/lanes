import type { OperationStore } from '../../../operations/server/journal/store';
import { type RecurrenceStatus } from '../../contracts/recurrence';
import { type TaskCommandService } from '../commands/service';
export interface RecurrenceOptions {
  commands: TaskCommandService;
  operations: OperationStore;
  ownerSubjectFor(accountId: string): Promise<string>;
  requestTaskCheck?(accountId: string, taskId: string): Promise<void>;
  now?: () => number;
  id?: () => string;
}

export interface TaskRow {
  id: string;
  account_id: string;
  list_id: string;
  parent_id: string | null;
  title: string;
  completed: number;
  repeat_rule_json: string | null;
  scheduled_day: string | null;
  series_id: string | null;
  occurrence_id: string | null;
  revision: number;
  provider_etag: string | null;
  provider_missing_at: number | null;
  deleted_at: number | null;
}

export interface Transition {
  id: string;
  account_id: string;
  task_id: string;
  kind: 'completed' | 'reopened';
  snapshot_json: string;
  children_complete: number;
}

export interface Series {
  id: string;
  account_id: string;
  active_task_id: string;
  state: RecurrenceStatus['state'];
  created_count: number;
  revision: number;
}

export interface Occurrence {
  id: string;
  account_id: string;
  series_id: string;
  predecessor_occurrence_id: string;
  source_task_id: string;
  transition_id: string;
  state: string;
  phase: string;
  rule_json: string;
  scheduled_day: string | null;
  target_task_id: string | null;
  operation_id: string;
  owner_subject: string;
  list_id: string;
  list_revision: number;
  total_tasks: number;
  append_position: number;
  baseline_cursor: string | null;
  copy_confirmed_at: number | null;
  parent_counted: number;
  plan_captured: number;
  source_revision: number;
  attempt: number;
  checklist_complete: number;
  next_at: number | null;
  claim_id: string | null;
  claim_until: number | null;
  error_code: string | null;
  undo_choice: 'cancel_pending' | 'remove_untouched' | 'one_off' | null;
  undo_operation_id: string | null;
  undo_task_revision: number | null;
  verify_position: number;
  verify_requested_at: number | null;
}

export interface CopyRow {
  item_key: string;
  source_task_id: string;
  position: number;
  parent_key: string | null;
  snapshot_json: string;
}
