import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskMoveIntent } from '../contracts';
import { TaskSchema } from '../contracts';
import type { OperationSummary } from '../operation-contract';
import { recordServerConnection } from '../../../client/connectivity';
import { saveTaskMove, TaskMoveError } from './save-task-move';

const now = Date.parse('2026-11-04T17:00:00Z');
const operationId = `${now}:abcdefghijklmnop`;
const base = '/api/accounts/account';
const intent: TaskMoveIntent = {
  accountId: 'account',
  taskId: 'task',
  revision: 1,
  sourceListId: 'one',
  destinationListId: 'one',
  parentId: null,
  previousTaskId: 'tail',
};
const task = TaskSchema.parse({
  id: 'task',
  accountId: 'account',
  listId: 'one',
  parentId: null,
  title: 'write a test',
  notes: 'keep notes',
  completed: false,
  completedAt: null,
  scheduledDay: null,
  scheduledTime: null,
  timeZone: null,
  repeatRule: null,
  seriesId: null,
  occurrenceId: null,
  labelIds: [],
  priority: 'none',
  starred: false,
  blockedBy: [],
  revision: 7,
  unsupportedHierarchy: false,
  provider: {
    id: 'google-task',
    listId: 'google-one',
    etag: 'fresh',
    position: '100',
    updatedAt: null,
  },
  capabilities: {
    canEdit: true,
    canEditNotes: true,
    canMove: true,
    canDelete: true,
    canHaveChildren: true,
    canNest: true,
    assignmentSource: null,
    sourceUrl: null,
    restriction: null,
  },
});
const destination = {
  id: 'one',
  accountId: 'account',
  title: 'one',
  revision: 3,
  providerId: 'google-one',
  providerEtag: 'list-fresh',
  isDefault: false,
};
const preview = {
  taskId: 'task',
  revision: 7,
  title: task.title,
  openSubtaskCount: 0,
  subtaskCount: 0,
  openBlockerCount: 0,
  unknownBlockerCount: 0,
  assignmentSource: null,
  coverageComplete: true,
};
const page = (complete = true) => ({
  items: [task],
  matchedTaskIds: [task.id],
  contextTaskIds: [],
  subtaskSummaries: {},
  nextCursor: null,
  coverage: { complete, stale: !complete, lastSyncedAt: new Date(now).toISOString() },
  providerCoverage: { complete, stale: !complete, lastSyncedAt: new Date(now).toISOString() },
});
const receipt = (patch: Partial<OperationSummary> = {}): OperationSummary => ({
  id: operationId,
  accountId: 'account',
  kind: 'task.move',
  state: 'accepted',
  createdAt: now,
  updatedAt: now,
  cancelRequested: false,
  totalSteps: 1,
  confirmedSteps: 0,
  inputSealed: true,
  error: null,
  nextAttemptAt: now,
  finished: false,
  ...patch,
});
const succeeded = () =>
  receipt({ state: 'succeeded', confirmedSteps: 1, finished: true, nextAttemptAt: null });
const errorResponse = (code: string, reference?: string) =>
  Response.json(
    {
      error: {
        code,
        message: 'the receipt could not be returned',
        requestId: 'request-a',
        retryable: true,
        ...(reference ? { operationId: reference } : {}),
      },
    },
    { status: 503 },
  );
interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}
function network(override: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        path: decodeURIComponent(new URL(String(input), 'https://lanes.test').pathname),
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      };
      calls.push(call);
      const overridden = await override(call);
      if (overridden !== undefined)
        return overridden instanceof Response ? overridden : Response.json(overridden);
      if (call.path === `${base}/tasks/query`) return Response.json(page());
      if (call.path === `${base}/tasks/task/consequences`) return Response.json(preview);
      if (call.path === `${base}/tasks/task`) return Response.json(task);
      if (call.path === `${base}/lists/one`) return Response.json(destination);
      throw new Error(`unexpected test request: ${call.method} ${call.path}`);
    }),
  );
  return calls;
}
beforeEach(() => recordServerConnection('reachable'));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('durable task move driver', () => {
  it('captures fresh revisions, advances one receipt and waits for the targeted provider order refresh', async () => {
    let complete = true;
    const calls = network((call) => {
      if (call.path === `${base}/tasks/query`) return page(complete);
      if (call.path === `${base}/commands/provider`) {
        complete = false;
        return receipt();
      }
      if (call.path === `${base}/operations/${operationId}/advance`) return succeeded();
      if (call.path === `${base}/sync`)
        return {
          initialized: false,
          pending: true,
          nextAttemptAt: Date.now(),
          phase: 'tasks',
          errorCode: null,
        };
      if (call.path === `${base}/sync/advance`) {
        complete = true;
        return { accountId: 'account', phase: 'tasks', continued: false };
      }
    });
    await expect(saveTaskMove(intent, operationId)).resolves.toBe(true);
    expect(calls.filter((call) => call.path === `${base}/commands/provider`)).toEqual([
      {
        path: `${base}/commands/provider`,
        method: 'POST',
        body: {
          operationId,
          command: {
            kind: 'task.move',
            taskId: 'task',
            revision: 7,
            listId: 'one',
            listRevision: 3,
            parentId: null,
            previousId: 'tail',
            confirmSubtaskCount: 0,
          },
        },
      },
    ]);
    expect(calls.filter((call) => call.path.endsWith('/advance')).map((call) => call.path)).toEqual(
      [`${base}/operations/${operationId}/advance`, `${base}/sync/advance`],
    );
    expect(calls.filter((call) => call.path === `${base}/tasks/query`)).toHaveLength(3);
  });

  it.each([operationId, undefined])(
    'looks up the same intent after ambiguous HTTP admission failure (reference %s)',
    async (reference) => {
      const calls = network((call) => {
        if (call.path === `${base}/commands/provider`)
          return errorResponse('storage_unavailable', reference);
        if (call.path === `${base}/operations/${operationId}`) return succeeded();
      });
      await expect(saveTaskMove(intent, operationId)).resolves.toBe(true);
      expect(calls.filter((call) => call.path === `${base}/commands/provider`)).toHaveLength(1);
      expect(
        calls.filter((call) => call.path === `${base}/operations/${operationId}`),
      ).toHaveLength(1);
    },
  );

  it('keeps an unfinished uncertain receipt without dispatching the intent again', async () => {
    const calls = network((call) => {
      if (call.path === `${base}/commands/provider`)
        return receipt({
          state: 'uncertain',
          error: { code: 'outcome_uncertain', message: 'google may have accepted this change.' },
          nextAttemptAt: null,
        });
    });
    await expect(saveTaskMove(intent, operationId)).rejects.toMatchObject({
      name: 'Error',
      operationId,
      message: 'google may have accepted this change.',
    });
    expect(calls.filter((call) => call.path === `${base}/commands/provider`)).toHaveLength(1);
    expect(calls.some((call) => call.path.endsWith('/advance'))).toBe(false);
  });

  it('does not invent a recovery receipt for an explicit unadmitted validation rejection', async () => {
    const calls = network((call) => {
      if (call.path === `${base}/commands/provider`)
        return Response.json(
          {
            error: {
              code: 'validation_failed',
              message: 'choose a valid destination',
              requestId: 'request-a',
              retryable: false,
            },
          },
          { status: 422 },
        );
    });
    await expect(saveTaskMove(intent, operationId)).rejects.toMatchObject({
      operationId: undefined,
      message: 'choose a valid destination',
    });
    expect(calls.some((call) => call.path.startsWith(`${base}/operations/`))).toBe(false);
  });

  it('retains the receipt identity when admission and its recovery read both lose their responses', async () => {
    const calls = network((call) => {
      if (
        call.path === `${base}/commands/provider` ||
        call.path === `${base}/operations/${operationId}`
      )
        throw new TypeError('connection dropped');
    });
    const error = await saveTaskMove(intent, operationId).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TaskMoveError);
    expect(error).toMatchObject({ operationId });
    expect(calls.filter((call) => call.path === `${base}/commands/provider`)).toHaveLength(1);
  });

  it('aborts after reading fresh values without submitting a command', async () => {
    const controller = new AbortController();
    const calls = network((call) => {
      if (call.path === `${base}/tasks/task/consequences`) {
        controller.abort(new DOMException('account left', 'AbortError'));
        return preview;
      }
    });
    await expect(
      saveTaskMove(intent, operationId, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.some((call) => call.path === `${base}/commands/provider`)).toBe(false);
  });

  it.each([-60_000, 60_000])(
    'uses server-adjusted time for refresh and receipt deadlines with local clock skew %i',
    async (skew) => {
      vi.spyOn(Date, 'now').mockReturnValue(now + skew);
      let complete = false;
      const calls = network((call) => {
        if (call.path === `${base}/tasks/query`) return page(complete);
        if (call.path === `${base}/sync`)
          return {
            initialized: false,
            pending: true,
            nextAttemptAt: now + 200,
            phase: 'tasks',
            errorCode: null,
          };
        if (call.path === `${base}/sync/advance`) {
          complete = true;
          return { accountId: 'account', phase: 'tasks', continued: false };
        }
        if (call.path === `${base}/commands/provider`) return receipt({ nextAttemptAt: now + 200 });
        if (call.path === `${base}/operations/${operationId}/advance`) return succeeded();
      });
      await expect(saveTaskMove(intent, operationId, undefined, undefined, -skew)).resolves.toBe(
        true,
      );
      expect(calls.filter((call) => call.path === `${base}/commands/provider`)).toHaveLength(1);
      expect(calls.filter((call) => call.path.endsWith('/advance'))).toHaveLength(2);
    },
  );
});
