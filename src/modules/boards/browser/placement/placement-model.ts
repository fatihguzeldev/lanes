import type { z } from 'zod';
import type { Task } from '../../../tasks/contracts/task';
import type { TaskConsequencesSchema } from '../../../tasks/contracts/consequence';
import { ProviderCommandSchema } from '../../../tasks/contracts/provider-commands';
import type { BoardList } from '../../contracts/board';
import type { OperationSummary } from '../../../operations/contracts/receipt';

export type PlacementPreview = z.infer<typeof TaskConsequencesSchema>;
export interface PlacementChoice {
  list: BoardList;
  parent?: Task | null;
  previous?: Task | null;
  position: 'first' | 'last' | 'after';
}

export function captureTaskPlacement(
  task: Task,
  preview: PlacementPreview,
  choice: PlacementChoice,
  identity: () => string,
) {
  const { list, parent = null, previous = null, position } = choice;
  if (task.accountId !== list.accountId) throw new Error('choose a list in this account.');
  if (!task.capabilities.canMove || task.unsupportedHierarchy)
    throw new Error('google does not allow moving this task.');
  if (preview.taskId !== task.id || preview.revision !== task.revision)
    throw new Error('this task changed. refresh it before moving.');
  if (!preview.coverageComplete)
    throw new Error('refresh the source list before moving its task tree.');
  if (
    parent &&
    (!task.capabilities.canNest ||
      task.repeatRule !== null ||
      preview.subtaskCount > 0 ||
      parent.id === task.id ||
      parent.accountId !== task.accountId ||
      parent.listId !== list.id ||
      parent.parentId !== null ||
      !parent.capabilities.canHaveChildren ||
      parent.unsupportedHierarchy)
  )
    throw new Error('choose an eligible top-level parent.');
  if (
    position === 'after' &&
    (!previous ||
      previous.id === task.id ||
      previous.accountId !== task.accountId ||
      previous.listId !== list.id ||
      previous.parentId !== (parent?.id ?? null))
  )
    throw new Error('choose a sibling in this destination.');
  const command = ProviderCommandSchema.parse({
    kind: 'task.move',
    taskId: task.id,
    revision: task.revision,
    listId: list.id,
    listRevision: list.revision,
    parentId: parent?.id ?? null,
    ...(parent ? { parentRevision: parent.revision } : {}),
    ...(position === 'first'
      ? { previousId: null }
      : position === 'after' && previous
        ? { previousId: previous.id, previousRevision: previous.revision }
        : {}),
    confirmSubtaskCount: preview.subtaskCount,
  });
  return {
    identity: identity(),
    command,
    taskId: task.id,
    title: task.title,
    listTitle: list.title,
    subtaskCount: preview.subtaskCount,
  };
}
export type PlacementAttempt = ReturnType<typeof captureTaskPlacement>;

export function placementAttemptRejected(
  receipt: Pick<OperationSummary, 'state' | 'finished' | 'confirmedSteps'> | null,
  code: string | undefined,
  hasReceipt: boolean,
): boolean {
  if (receipt)
    return (
      receipt.finished &&
      ['failed', 'cancelled'].includes(receipt.state) &&
      receipt.confirmedSteps === 0
    );
  return (
    !hasReceipt &&
    ['validation_failed', 'conflict', 'not_found', 'connection_paused', 'forbidden'].includes(
      code ?? '',
    )
  );
}
