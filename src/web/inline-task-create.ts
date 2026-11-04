import type { TaskList } from '../modules/tasks/contracts';
import type { OperationSummary } from '../modules/tasks/operation-contract';
import { ProviderCommandSchema } from '../modules/tasks/provider-command-contract';

export function captureInlineTask(
  list: Pick<TaskList, 'id' | 'accountId' | 'revision'>,
  title: string,
  identity: () => string,
) {
  const command = ProviderCommandSchema.parse({
    kind: 'task.create',
    listId: list.id,
    listRevision: list.revision,
    title,
  });
  return { accountId: list.accountId, identity: identity(), command };
}
export type InlineTaskAttempt = ReturnType<typeof captureInlineTask>;

export function inlineCreateWasRejected(
  operation: Pick<OperationSummary, 'state' | 'finished'> | null,
  errorCode: string | undefined,
  hasOperationReference: boolean,
): boolean {
  if (operation) return operation.state === 'failed' && operation.finished;
  return (
    !hasOperationReference &&
    ['validation_failed', 'conflict', 'not_found', 'connection_paused'].includes(errorCode ?? '')
  );
}
