import type { TaskMoveIntent } from '../../contracts/task';
import { TaskSchema, TaskListSchema } from '../../contracts/task';
import { TaskConsequencesSchema } from '../../contracts/consequence';
import { TaskPageSchema } from '../../contracts/query';
import {
  OperationSummarySchema,
  type OperationSummary,
} from '../../../operations/contracts/receipt';
import { SyncAdvanceSchema, SyncStatusSchema } from '../../contracts/sync';
import { request, RequestError } from '../../../../shared/browser/http/http';
import { serverConnection } from '../../../../shared/browser/connectivity/connectivity';
import { uncapturedPlacementReferenceField } from '../../contracts/provider-commands';
import { sameTaskMoveContext } from '../../model/task-move-context';

const pause = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const done = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
const progressing = new Set(['accepted', 'running', 'partial']);

export class TaskMoveError extends Error {
  constructor(
    message: string,
    readonly operationId?: string,
  ) {
    super(message);
  }
}

export async function saveTaskMove(
  intent: TaskMoveIntent,
  operationId: string,
  confirmChildren?: (title: string, count: number) => Promise<boolean>,
  signal?: AbortSignal,
  clockOffset = 0,
): Promise<boolean> {
  signal?.throwIfAborted();
  const send: typeof request = (path, schema, options = {}) =>
    request(path, schema, { ...options, ...(signal ? { signal } : {}) });
  const serverNow = () => Date.now() + clockOffset;
  if (serverConnection() !== 'reachable')
    throw new TaskMoveError('couldn’t move this task. the server connection is paused.');
  const base = `/api/accounts/${encodeURIComponent(intent.accountId)}`;
  const listIds = [...new Set([intent.sourceListId, intent.destinationListId])];
  async function waitForOrder() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const pages = await Promise.all(
        listIds.map((id) =>
          send(`${base}/tasks/query`, TaskPageSchema, {
            method: 'POST',
            body: { listIds: [id], limit: 2, filter: { completion: 'all' } },
          }),
        ),
      );
      if (pages.every((page, index) => page.orderReadyListIds?.includes(listIds[index]!))) return;
      const sync = await send(`${base}/sync`, SyncStatusSchema);
      if (
        !sync.pending ||
        sync.errorCode ||
        sync.nextAttemptAt === null ||
        sync.nextAttemptAt - serverNow() > 5_000
      )
        throw new TaskMoveError('this list could not refresh. its last confirmed order is kept.');
      await pause(Math.max(100, Math.min(1_000, sync.nextAttemptAt - serverNow())), signal);
      await send(`${base}/sync/advance`, SyncAdvanceSchema, { method: 'POST', body: {} });
    }
    throw new TaskMoveError(
      'this list is taking too long to refresh. its last confirmed order is kept.',
    );
  }
  const relativeOrder =
    intent.sourceListId === intent.destinationListId &&
    (intent.sourceParentId ?? null) === intent.parentId &&
    intent.position !== 'last';
  if (!relativeOrder) await waitForOrder();
  let [task, destination, preview] = await Promise.all([
    send(`${base}/tasks/${encodeURIComponent(intent.taskId)}`, TaskSchema),
    send(`${base}/lists/${encodeURIComponent(intent.destinationListId)}`, TaskListSchema),
    relativeOrder
      ? null
      : send(
          `${base}/tasks/${encodeURIComponent(intent.taskId)}/consequences`,
          TaskConsequencesSchema,
        ),
  ]);
  if (
    task.id !== intent.taskId ||
    destination.id !== intent.destinationListId ||
    destination.accountId !== intent.accountId ||
    task.accountId !== intent.accountId ||
    task.listId !== intent.sourceListId ||
    task.parentId !== (intent.sourceParentId ?? null) ||
    (task.completed && !intent.allowCompleted) ||
    task.unsupportedHierarchy ||
    !task.capabilities.canMove ||
    (preview && (!preview.coverageComplete || preview.revision !== task.revision))
  )
    throw new TaskMoveError('this task changed. its last confirmed position has been restored.');
  let [parent, previous] = await Promise.all([
    intent.parentId
      ? send(`${base}/tasks/${encodeURIComponent(intent.parentId)}`, TaskSchema)
      : null,
    intent.position !== 'last' && intent.previousTaskId
      ? send(`${base}/tasks/${encodeURIComponent(intent.previousTaskId)}`, TaskSchema)
      : null,
  ]);
  if (
    parent &&
    (parent.id !== intent.parentId ||
      parent.id === task.id ||
      parent.accountId !== intent.accountId ||
      parent.listId !== destination.id ||
      parent.parentId !== null ||
      !parent.capabilities.canHaveChildren ||
      parent.unsupportedHierarchy ||
      (!relativeOrder &&
        (!task.capabilities.canNest ||
          task.repeatRule !== null ||
          (preview?.subtaskCount ?? 0) > 0)))
  )
    throw new TaskMoveError(
      'this parent is no longer eligible. the confirmed task position has been restored.',
    );
  if (
    previous &&
    (previous.id !== intent.previousTaskId ||
      previous.id === task.id ||
      previous.accountId !== intent.accountId ||
      previous.listId !== destination.id ||
      previous.parentId !== intent.parentId)
  )
    throw new TaskMoveError('this sibling changed. the confirmed task position has been restored.');
  if (
    preview?.subtaskCount &&
    task.listId !== destination.id &&
    confirmChildren &&
    !(await confirmChildren(preview.title, preview.subtaskCount))
  )
    return false;
  let admitted = false;
  try {
    signal?.throwIfAborted();
    const admit = () =>
      send(`${base}/commands/provider`, OperationSummarySchema, {
        method: 'POST',
        body: {
          operationId,
          command: {
            kind: 'task.move',
            taskId: task.id,
            revision: task.revision,
            listId: destination.id,
            listRevision: destination.revision,
            parentId: intent.parentId,
            ...(parent ? { parentRevision: parent.revision } : {}),
            ...(intent.position === 'last' ? {} : { previousId: intent.previousTaskId }),
            ...(previous ? { previousRevision: previous.revision } : {}),
            ...(preview ? { confirmSubtaskCount: preview.subtaskCount } : {}),
          },
        },
      });
    let operation: OperationSummary;
    try {
      operation = await admit();
    } catch (error) {
      const reference =
        error instanceof RequestError
          ? error.fields?.[uncapturedPlacementReferenceField]
          : undefined;
      if (
        !(error instanceof RequestError) ||
        error.code !== 'conflict' ||
        error.operationId ||
        !(
          reference === 'task' ||
          (reference === 'parent' && parent) ||
          (reference === 'previous' && previous)
        )
      )
        throw error;
      const [freshTask, freshParent, freshPrevious] = await Promise.all([
        send(`${base}/tasks/${encodeURIComponent(task.id)}`, TaskSchema),
        parent ? send(`${base}/tasks/${encodeURIComponent(parent.id)}`, TaskSchema) : null,
        previous ? send(`${base}/tasks/${encodeURIComponent(previous.id)}`, TaskSchema) : null,
      ]);
      if (
        !sameTaskMoveContext(task, freshTask) ||
        (parent && (!freshParent || !sameTaskMoveContext(parent, freshParent))) ||
        (previous && (!freshPrevious || !sameTaskMoveContext(previous, freshPrevious)))
      )
        throw new TaskMoveError(
          'this placement changed. its last confirmed position has been restored.',
        );
      task = freshTask;
      parent = freshParent;
      previous = freshPrevious;
      signal?.throwIfAborted();
      operation = await admit();
    }
    admitted = true;
    const deadline = Date.now() + 30_000;
    while (!operation.finished && progressing.has(operation.state) && Date.now() < deadline) {
      if (operation.nextAttemptAt !== null && operation.nextAttemptAt - serverNow() > 5_000) break;
      await pause(
        Math.max(150, Math.min(1_000, (operation.nextAttemptAt ?? serverNow()) - serverNow())),
        signal,
      );
      operation = await send(
        `${base}/operations/${encodeURIComponent(operationId)}/advance`,
        OperationSummarySchema,
        { method: 'POST', body: {} },
      );
    }
    if (operation.state === 'succeeded') return true;
    throw new TaskMoveError(
      operation.error?.message ??
        (operation.finished
          ? 'couldn’t move this task. its confirmed position has been restored.'
          : 'this move still needs confirmation. check the sync menu before trying it again.'),
      operation.finished ? undefined : operationId,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TaskMoveError) throw error;
    if (
      !admitted &&
      error instanceof RequestError &&
      !error.operationId &&
      [
        'validation_failed',
        'conflict',
        'not_found',
        'forbidden',
        'unauthenticated',
        'reconnect_required',
        'permission_required',
        'list_limit_reached',
      ].includes(error.code)
    )
      throw new TaskMoveError(error.message);
    let recorded: OperationSummary | null = null;
    try {
      recorded = await send(
        `${base}/operations/${encodeURIComponent(operationId)}`,
        OperationSummarySchema,
      );
    } catch {
      /* Preserve the same receipt identity. */
    }
    if (recorded?.state === 'succeeded') return true;
    throw new TaskMoveError(
      recorded?.error?.message ??
        'couldn’t confirm this move. check the sync menu before trying it again.',
      recorded?.finished ? undefined : operationId,
    );
  }
}
