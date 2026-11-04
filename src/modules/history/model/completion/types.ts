import type { Task, TaskList } from '../../../tasks/contracts/task';
import type { HistoryEvent } from '../../contracts/events';

export type CompletedGroupKey =
  'today' | 'yesterday' | 'this_week' | 'earlier' | 'unknown_time' | 'future';
export interface CompletedOptions {
  accountId: string;
  zone: string;
  weekStart: 1 | 7;
  now: string;
  listIds?: readonly string[] | undefined;
  query?: string | undefined;
  lists?: readonly TaskList[] | undefined;
}
export interface CompletedTaskItem {
  task: Task;
  parent: Task | null;
  list: TaskList | null;
  completedDay: string | null;
}
export interface CompletedGroup {
  key: CompletedGroupKey;
  items: CompletedTaskItem[];
}
export interface CompletionSummary {
  days: { day: string; count: number; lists: { listId: string; count: number }[] }[];
  total: number;
  unknownTimeCount: number;
  outsideWindowCount: number;
  countingRule: 'current_completed_tasks_including_subtasks';
}
export interface HistoryDayGroup {
  day: string;
  events: HistoryEvent[];
}
