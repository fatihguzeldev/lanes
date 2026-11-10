import { afterEach, expect, it, vi } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { HistoryService } from '../../../../history/server/events/event-store';
import { OperationQueries } from '../../../../operations/server/queries/receipts';
import { TaskCommandService } from '../../../server/commands/service';
import { TaskMetadataService } from '../../../server/metadata/tasks';
import { TaskProjectionStore } from '../../../server/projection/store';
import { GoogleTasksClient, type GoogleTaskDTO } from '../../../server/provider/google-tasks';
import { readActiveList } from '../../../server/queries/lists';
import { TaskQueries } from '../../../server/queries/tasks';
import { AppError } from '../../../../../shared/contracts/errors';
import { uncapturedPlacementReferenceField } from '../../../contracts/provider-commands';
import { recordServerConnection } from '../../../../../shared/browser/connectivity/connectivity';
import { saveTaskMove } from '../save-task-move';

const now = Date.parse('2026-11-10T12:00:00Z');
const operationId = `${now}:placement-reference-race`;
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

async function fixture(
  reference: 'parent' | 'previous',
  changes: string[] = ['star'],
  timing: 'read' | 'capture' = 'read',
) {
  const data = testDatabase();
  cleanup.push(data.close);
  const { db } = data;
  await seedAccount(db, 'account', now);
  await db
    .prepare(
      `INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at)
       VALUES('list','account','google-list','work',1,?,?)`,
    )
    .bind(now, now)
    .run();
  const history = new HistoryService(db, { now: () => now });
  const projection = new TaskProjectionStore(db, { history, now: () => now });
  const tasks = new Map<string, GoogleTaskDTO>([
    [
      'a',
      {
        id: 'a',
        title: 'a',
        position: '001',
        etag: 'a-v1',
        status: 'needsAction',
        ...(reference === 'parent' ? { parent: 'b' } : {}),
      },
    ],
    [
      'b',
      {
        id: 'b',
        title: 'b',
        notes: 'keep notes',
        position: '002',
        etag: 'b-v1',
        status: 'needsAction',
      },
    ],
  ]);
  const knownTaskIds = new Map([
    ['a', 'a'],
    ['b', 'b'],
  ]);
  await db.batch(
    (
      await projection.prepareConfirmedWrites('account', 'list', [...tasks.values()], {
        knownTaskIds,
      })
    ).writes,
  );
  const queries = new TaskQueries(db);
  const metadata = new TaskMetadataService(db, {
    history,
    commitWrites: (writes) => db.batch(writes),
  });
  const receipts = new OperationQueries(db);
  const providerMoves: string[] = [];
  const client = new GoogleTasksClient({
    accessToken: 'test',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname.endsWith('/move')) {
        providerMoves.push(url.pathname);
        const moved = { ...tasks.get('a')!, position: '003', etag: 'a-v2' };
        tasks.set('a', moved);
        return Response.json(moved);
      }
      return Response.json(tasks.get(url.pathname.split('/').at(-1)!));
    },
  });
  const changeReference = async (snapshot: Awaited<ReturnType<TaskQueries['getTask']>>) => {
    const change = changes.shift();
    if (change === 'star')
      await metadata.patchTask('account', 'b', { starred: !snapshot.starred }, snapshot.revision, {
        operationId: 'star',
        stepKey: 'star',
        origin: 'owner',
        recordedAt: new Date(now).toISOString(),
      });
    else if (change) {
      const updated = {
        ...tasks.get('b')!,
        [change]: change === 'status' ? 'completed' : 'changed',
        etag: 'b-v2',
      };
      tasks.set('b', updated);
      await db.batch(
        (
          await projection.prepareConfirmedWrites('account', 'list', [updated], {
            knownTaskIds,
          })
        ).writes,
      );
    }
  };
  const capturedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: Parameters<typeof db.batch>[0]) => {
          if (
            timing === 'capture' &&
            changes.length &&
            statements.some((statement) =>
              (statement as unknown as { sql: string }).sql.startsWith(
                'INSERT INTO tasks_command_plans',
              ),
            )
          )
            await changeReference(await queries.getTask('account', 'b'));
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const service = new TaskCommandService(capturedDb, {
    queries,
    projection,
    history,
    metadata,
    operations: createOperationStore(db),
    now: () => now,
    clientFor: async () => client,
  });
  let admissions = 0;
  const uncapturedRejections: boolean[] = [];
  const submitted: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'https://lanes.test').pathname;
    try {
      if (path.endsWith('/tasks/a')) return Response.json(await queries.getTask('account', 'a'));
      if (path.endsWith('/tasks/b')) {
        const snapshot = await queries.getTask('account', 'b');
        if (timing === 'read') await changeReference(snapshot);
        return Response.json(snapshot);
      }
      if (path.endsWith('/lists/list'))
        return Response.json(await readActiveList(db, 'account', 'list'));
      if (path.endsWith('/commands/provider')) {
        admissions++;
        const body = JSON.parse(String(init?.body));
        submitted.push(body.command);
        await service.capture.prepare({ accountId: 'account', ownerSubject: 'owner', ...body });
        await service.advance('account', body.operationId);
        return Response.json(await receipts.summary(body.operationId, 'account'));
      }
      throw new Error(`unexpected ${path}`);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.fields?.[uncapturedPlacementReferenceField])
        uncapturedRejections.push(
          !(await service.capture.hasCapturedCommand('account', operationId)) &&
            (await receipts.summary(operationId, 'account')) === null,
        );
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
            fields: error.fields,
            operationId: error.operationId,
            requestId: 'test',
            retryable: error.retryable,
          },
        },
        { status: error.status },
      );
    }
  });
  recordServerConnection('reachable');
  const move = () =>
    saveTaskMove(
      {
        accountId: 'account',
        taskId: 'a',
        revision: 1,
        sourceListId: 'list',
        destinationListId: 'list',
        sourceParentId: reference === 'parent' ? 'b' : null,
        parentId: reference === 'parent' ? 'b' : null,
        previousTaskId: reference === 'previous' ? 'b' : null,
        position: reference === 'previous' ? 'after' : 'first',
      },
      operationId,
    );
  return {
    ...data,
    queries,
    receipts,
    move,
    providerMoves,
    submitted,
    uncapturedRejections,
    admissions: () => admissions,
  };
}

it.each(['parent', 'previous'] as const)(
  'refreshes an uncaptured %s metadata revision without losing the move',
  async (reference) => {
    const f = await fixture(reference);
    await expect(f.move()).resolves.toBe(true);
    expect(f.admissions()).toBe(2);
    expect(f.providerMoves).toHaveLength(1);
    expect(f.uncapturedRejections).toEqual([true]);
    expect(f.submitted[1]).toMatchObject({
      [reference === 'parent' ? 'parentRevision' : 'previousRevision']: 2,
    });
    expect((await f.queries.getTask('account', 'b')).starred).toBe(true);
  },
);

it.each(['parent', 'previous'] as const)(
  'refreshes an uncaptured %s that changes immediately before the atomic capture',
  async (reference) => {
    const f = await fixture(reference, ['star'], 'capture');
    await expect(f.move()).resolves.toBe(true);
    expect(f.admissions()).toBe(2);
    expect(f.providerMoves).toHaveLength(1);
    expect(f.uncapturedRejections).toEqual([true]);
  },
);

it.each(['title', 'notes', 'status'])(
  'does not reapply a placement when its reference %s changed',
  async (change) => {
    const f = await fixture('previous', [change]);
    await expect(f.move()).rejects.toThrow();
    expect(f.admissions()).toBe(1);
    expect(f.providerMoves).toHaveLength(0);
    expect(f.uncapturedRejections).toEqual([true]);
    expect(await f.receipts.summary(operationId, 'account')).toBeNull();
  },
);

it('bounds retries when the reference keeps changing before capture', async () => {
  const f = await fixture('previous', ['star', 'star', 'star']);
  await expect(f.move()).rejects.toThrow();
  expect(f.admissions()).toBe(2);
  expect(f.providerMoves).toHaveLength(0);
  expect(f.uncapturedRejections).toEqual([true, true]);
  expect(await f.receipts.summary(operationId, 'account')).toBeNull();
});

it('never marks an existing captured identity as safe to change and resubmit', async () => {
  const f = await fixture('previous');
  await expect(f.move()).resolves.toBe(true);
  await expect(f.move()).rejects.toThrow('different command input');
  expect(f.admissions()).toBe(3);
  expect(f.providerMoves).toHaveLength(1);
  expect(f.uncapturedRejections).toEqual([true]);
});
