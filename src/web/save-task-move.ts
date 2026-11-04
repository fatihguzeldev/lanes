import type { TaskMoveIntent } from '../modules/boards/components/BoardSurface';
import { TaskSchema, TaskListSchema } from '../modules/tasks/contracts';
import { TaskConsequencesSchema } from '../modules/tasks/consequence-contract';
import { TaskPageSchema } from '../modules/tasks/query-contract';
import { OperationSummarySchema, type OperationSummary } from '../modules/tasks/operation-contract';
import { SyncAdvanceSchema, SyncStatusSchema } from '../modules/tasks/sync-contract';
import { request, RequestError } from '../client/http';
import { serverConnection } from '../client/connectivity';

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
      if (pages.every((page) => page.providerCoverage.complete)) return;
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
  await waitForOrder();
  const [task, destination, preview] = await Promise.all([
    send(`${base}/tasks/${encodeURIComponent(intent.taskId)}`, TaskSchema),
    send(`${base}/lists/${encodeURIComponent(intent.destinationListId)}`, TaskListSchema),
    send(`${base}/tasks/${encodeURIComponent(intent.taskId)}/consequences`, TaskConsequencesSchema),
  ]);
  if (
    task.accountId !== intent.accountId ||
    task.listId !== intent.sourceListId ||
    task.parentId !== null ||
    task.completed ||
    !task.capabilities.canMove ||
    !preview.coverageComplete ||
    preview.revision !== task.revision
  )
    throw new TaskMoveError('this task changed. its last confirmed position has been restored.');
  if (
    preview.subtaskCount &&
    task.listId !== destination.id &&
    confirmChildren &&
    !(await confirmChildren(preview.title, preview.subtaskCount))
  )
    return false;
  let admitted = false;
  try {
    signal?.throwIfAborted();
    let operation = await send(`${base}/commands/provider`, OperationSummarySchema, {
      method: 'POST',
      body: {
        operationId,
        command: {
          kind: 'task.move',
          taskId: task.id,
          revision: task.revision,
          listId: destination.id,
          listRevision: destination.revision,
          parentId: null,
          previousId: intent.previousTaskId,
          confirmSubtaskCount: preview.subtaskCount,
        },
      },
    });
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
    if (operation.state === 'succeeded') {
      // The move is confirmed even if its follow-up provider scan is temporarily unavailable.
      try {
        await waitForOrder();
      } catch {
        /* A later move waits for this same durable scan. */
      }
      return true;
    }
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
