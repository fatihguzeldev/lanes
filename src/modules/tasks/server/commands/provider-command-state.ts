import type { LabelInput, Task, TaskList } from '../../contracts';
import type { TaskSchedule } from '../../planning-contract';
import type { GoogleTaskCreate, GoogleTaskPatch } from '../provider';
import type { CreationSource } from '../../../history/contracts/events';
import type { ProviderCommand } from '../../provider-command-contract';
import type { TaskMetadataPatch } from '../../metadata-command-contract';
export interface ListRef extends TaskList {
  projectionRevision: number;
  complete: boolean;
}
export type TaskRef = Pick<
  Task,
  | 'id'
  | 'listId'
  | 'parentId'
  | 'title'
  | 'completed'
  | 'completedAt'
  | 'scheduledDay'
  | 'scheduledTime'
  | 'timeZone'
  | 'repeatRule'
  | 'revision'
  | 'provider'
  | 'capabilities'
> & { occurrenceId?: Task['occurrenceId']; seriesId?: Task['seriesId'] };
export interface CapturedStep {
  action:
    | 'copy.begin'
    | 'copy.metadata'
    | 'task.create'
    | 'task.patch'
    | 'task.local'
    | 'task.delete'
    | 'task.move'
    | 'list.create'
    | 'list.rename'
    | 'list.delete';
  list: ListRef;
  task?: TaskRef;
  targetId?: string;
  parent?: TaskRef | null;
  previous?: TaskRef | null;
  destination?: ListRef;
  provider?: GoogleTaskCreate | GoogleTaskPatch;
  schedule?: TaskSchedule;
  beforeSchedule?: TaskSchedule;
  clearSchedulePause?: boolean;
  ordinaryReopenIdentity?: { seriesId: string | null; occurrenceId: string | null };
  event?: 'task_completed' | 'task_reopened';
  boardId?: string;
  boardRevision?: number;
  listColor?: string;
  title?: string;
  subtaskCount?: number;
  taskCount?: number;
  copyListKey?: string;
  copyKey?: string;
  copyParentKey?: string | null;
  copyPreviousKey?: string | null;
  copyPosition?: number;
  origin?: 'owner' | 'scheduled';
  source?: CreationSource;
  scheduleId?: string;
  runId?: string;
  sourceTaskId?: string;
  labelDefinitions?: LabelInput[];
  metadata?: TaskMetadataPatch;
  graphRevision?: number;
  commandKind: ProviderCommand['kind'];
}
