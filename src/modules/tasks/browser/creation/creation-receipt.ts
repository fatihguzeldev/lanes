import { request } from '../../../../shared/browser/http/http';
import {
  OperationStepPageSchema,
  type OperationStepSummary,
} from '../../../operations/contracts/receipt';
import type { Page } from '../../../../shared/contracts/http';
import { readTask } from '../queries/references';
import type { CreateTask } from '../../contracts/task';

/** Only a confirmed public receipt can turn a local draft into a server task address. */
export async function readCreatedTask(
  accountId: string,
  operationId: string,
  input: CreateTask,
  onAddress?: (taskId: string) => void,
) {
  if (input.accountId !== accountId) throw new Error('this task belongs to another account.');
  const base = `/api/accounts/${encodeURIComponent(accountId)}/operations/${encodeURIComponent(operationId)}/steps`;
  let cursor: string | null = null;
  const visited = new Set<string>();
  do {
    const page: Page<OperationStepSummary> = await request(
      `${base}${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
      OperationStepPageSchema,
    );
    const created = page.items.find(
      (step) =>
        step.kind === 'task.create' && step.state === 'confirmed' && step.taskId && !step.deleted,
    );
    if (created?.taskId) {
      if (created.listId && created.listId !== input.listId)
        throw new Error('the saved task’s list could not be verified.');
      onAddress?.(created.taskId);
      const task = await readTask(accountId, created.taskId);
      if (
        task.accountId !== accountId ||
        task.listId !== input.listId ||
        task.parentId !== input.parentId ||
        task.id !== created.taskId
      )
        throw new Error('the saved task’s address could not be verified.');
      return task;
    }
    cursor = page.nextCursor;
    if (cursor && visited.has(cursor))
      throw new Error('the saved task’s receipt could not be read.');
    if (cursor) visited.add(cursor);
  } while (cursor);
  throw new Error('the saved task’s address is not available yet.');
}
