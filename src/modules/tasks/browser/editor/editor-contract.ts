import type { Coverage } from '../../../../shared/contracts/http';
import type { CreateTask, Label, Task, TaskList, TaskPatch } from '../../contracts/task';
import type { RecurrenceStatus } from '../../contracts/recurrence';
import type { TaskDependantsProps } from './TaskDependants';
import type { LabelPickerPage } from '../labels/useLabels';

export interface EditorLocation {
  list: TaskList;
  boardId?: string;
}
export interface EditorSelection extends EditorLocation {
  task: Task | null;
  inlineCreate?: boolean;
  initialDay?: string | null;
  parent?: Task | null;
}

export interface TaskEditorSave {
  accountId: string;
  taskId: string;
  listId: string;
  expectedRevision: number;
  expectedGraphRevision?: number;
  patch: TaskPatch;
  baseline?: Task;
}
export interface TaskEditorCreate {
  accountId: string;
  listRevision: number;
  expectedGraphRevision?: number;
  input: CreateTask;
}
export interface TaskEditorProps {
  dependants?: Omit<TaskDependantsProps, 'accountId' | 'completed' | 'pending'>;
  open: boolean;
  accountId: string;
  accountLabel?: string;
  task: Task | null;
  inlineCreate?: boolean;
  list: TaskList;
  labels: readonly Label[];
  labelPage?: LabelPickerPage | undefined;
  relatedTasks: readonly Task[];
  timeZone: string;
  weekStart?: 1 | 7;
  graphRevision?: number;
  initialDay?: string | null;
  parent?: Task | null;
  providerWritesEnabled: boolean;
  localWritesEnabled: boolean;
  pending?: boolean;
  serverReachable?: boolean;
  onCheckConnection?(): void;
  submitted?: boolean;
  onRetryFailed?: () => void;
  onInspectSave?(): void;
  onInspectRecurrence?(id: string): void;
  error?: { message: string; code?: string; fields?: Record<string, string> } | null;
  subtasks?: {
    items: readonly Task[];
    nextCursor: string | null;
    coverage: Coverage;
    pending?: boolean;
  };
  pendingLabelIds?: ReadonlySet<string>;
  relatedTasksLoading?: boolean;
  dependencyError?: string | null;
  dependenciesHaveMore?: boolean;
  dependencySearchScope?: 'board' | 'account';
  onClose(): void;
  onSave(save: TaskEditorSave): void;
  onCreate(save: TaskEditorCreate): void;
  onDirtyChange?(dirty: boolean): void;
  onToggleComplete?(task: Task, completed: boolean): void;
  onOpenTask?(task: Task): void;
  onLoadMoreSubtasks?(): void;
  onCreateSubtask?(task: Task): void;
  onSearchDependencies?(query: string): void;
  onLoadMoreDependencies?(): void;
  onRefresh?(): void;
  onDelete?(task: Task): void;
  onManageLabels?(anchor: HTMLElement, create?: boolean): void;
  recurrence?: {
    status: RecurrenceStatus | null;
    loading: boolean;
    error: string | null;
    pending: boolean;
  };
  onRetryRecurrence?(): void;
  onResumeRecurrence?(): void;
  onOpenRecurrenceTask?(taskId: string): void;
}
