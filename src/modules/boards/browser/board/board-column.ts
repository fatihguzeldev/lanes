import type { Coverage } from '../../../../shared/contracts/http';
import type { IconName } from '../../../../shared/ui/icon/Icon';
import type { Task, TaskList } from '../../../tasks/contracts/task';
import type { PendingTaskCreation } from '../../../tasks/browser/creation/creation-model';
import type { SubtaskSummary } from '../../../tasks/contracts/query';

export interface BoardColumn {
  orderReadyTaskIds?: readonly string[] | undefined;
  orderReadyListIds?: readonly string[] | undefined;
  readVersion?: number | undefined;
  providerComplete?: boolean | undefined;
  list: TaskList;
  tasks: readonly Task[];
  creations?: readonly PendingTaskCreation[];
  coverage: Coverage;
  status: 'loading' | 'ready' | 'error';
  orderedTaskIds?: readonly string[] | undefined;
  orderReady?: boolean | undefined;
  countLoading?: boolean | undefined;
  nextCursor: string | null;
  subtaskSummaries?: Record<string, SubtaskSummary> | undefined;
  matchedTaskIds?: readonly string[] | undefined;
  errorMessage?: string | undefined;
  completedCoverage?: Coverage | undefined;
  completedNextCursor?: string | null | undefined;
  completedLoading?: boolean | undefined;
  completedCountLoading?: boolean | undefined;
  completedError?: string | undefined;
  icon?: IconName | undefined;
  color?: string | undefined;
}
