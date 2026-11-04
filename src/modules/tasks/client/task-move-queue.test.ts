import { describe, expect, it, vi } from 'vitest';
import { TaskSchema, type Task } from '../contracts';
import type { TaskMoveList } from './task-move-model';
import {
  movesAcknowledged,
  openTaskOrder,
  projectTaskMoves,
  type QueuedTaskMove,
} from './task-move-model';
import { createTaskMoveQueue } from './task-move-queue';

function task(id: string, listId = 'one', parentId: string | null = null): Task {
  return TaskSchema.parse({
    id,
    accountId: 'account',
    listId,
    parentId,
    title: id,
    notes: 'keep notes',
    completed: false,
    completedAt: null,
    scheduledDay: '2026-11-04',
    scheduledTime: '09:30',
    timeZone: 'Europe/Istanbul',
    repeatRule: null,
    seriesId: null,
    occurrenceId: null,
    labelIds: ['label'],
    priority: 'high',
    starred: true,
    blockedBy: ['blocker'],
    revision: 1,
    unsupportedHierarchy: false,
    provider: { id, listId, etag: 'old', position: id, updatedAt: null },
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
}
function column(id: string, tasks: Task[]): TaskMoveList {
  return {
    list: {
      id,
      accountId: 'account',
      title: id,
      revision: 1,
      providerId: id,
      providerEtag: null,
      isDefault: false,
    },
    tasks,
    coverage: { complete: true, stale: false, lastSyncedAt: null },
    status: 'ready',
    readVersion: 1,
    providerComplete: true,
    nextCursor: null,
  };
}
function move(
  id: string,
  previousTaskId: string | null,
  destinationListId = 'one',
): QueuedTaskMove {
  return {
    id,
    intent: {
      accountId: 'account',
      taskId: id,
      revision: 1,
      sourceListId: 'one',
      destinationListId,
      parentId: null,
      previousTaskId,
    },
    task: task(id),
    children: [],
    readyListIds: ['one', 'two'],
    scope: 'board',
    confirmed: false,
  };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('optimistic task positions', () => {
  it('removes a stale source copy when a newer destination snapshot arrives without queued moves', () => {
    const stale = { ...task('a'), revision: 1, title: 'old title' };
    const current = { ...task('a', 'two'), revision: 2, title: 'current title' };
    const original = [column('one', [stale, task('b')]), column('two', [current])];
    const projected = projectTaskMoves(original, []);
    expect(projected[0]!.tasks.map((item) => item.id)).toEqual(['b']);
    expect(projected[1]!.tasks).toEqual([current]);
    expect(projected.flatMap((item) => item.tasks).filter((item) => item.id === 'a')).toHaveLength(
      1,
    );
    expect(original[0]!.tasks).toContain(stale);
  });
  it('shows the new order without changing provider positions or task metadata', () => {
    const original = [column('one', [task('a'), task('b'), task('c')])];
    const projected = projectTaskMoves(original, [move('c', null)]);
    expect(openTaskOrder(projected[0]!)).toEqual(['c', 'a', 'b']);
    expect(openTaskOrder(original[0]!)).toEqual(['a', 'b', 'c']);
    expect(projected[0]!.tasks.find((task) => task.id === 'c')).toEqual(task('c'));
  });
  it('keeps each identity once while moving a parent and children across lists', () => {
    const queued = { ...move('a', 'x', 'two'), children: [task('child', 'one', 'a')] };
    const projected = projectTaskMoves(
      [column('one', [task('a'), task('child', 'one', 'a')]), column('two', [task('x', 'two')])],
      [queued],
    );
    expect(projected[0]!.tasks).toEqual([]);
    expect(openTaskOrder(projected[1]!)).toEqual(['x', 'a']);
    expect(projected[1]!.tasks.find((task) => task.id === 'child')).toMatchObject({
      listId: 'two',
      parentId: 'a',
      notes: 'keep notes',
    });
    expect(new Set(projected.flatMap((column) => column.tasks.map((task) => task.id))).size).toBe(
      3,
    );
  });
  it('keeps a task visible when its destination or anchor is no longer available', () => {
    const original = [column('one', [task('a'), task('b')])];
    expect(projectTaskMoves(original, [move('a', null, 'removed')])).toEqual(original);
    expect(projectTaskMoves(original, [move('a', 'removed')])).toEqual(original);
  });
  it('acknowledges a confirmed position from a newer complete provider read rather than its rank', () => {
    const queued = { ...move('c', null), confirmed: true, confirmedAfter: 7 };
    const initial = { ...column('one', [task('a'), task('b'), task('c')]), readVersion: 7 };
    expect(movesAcknowledged([initial], [queued])).toBe(false);
    const fresh = { ...initial, readVersion: 8 };
    expect(movesAcknowledged([fresh], [queued])).toBe(true);
    expect(movesAcknowledged([{ ...fresh, providerComplete: false }], [queued])).toBe(false);
    expect(movesAcknowledged([{ ...fresh, status: 'loading' }], [queued])).toBe(false);
    expect(movesAcknowledged([{ ...fresh, readVersion: undefined }], [queued])).toBe(false);
    expect(
      movesAcknowledged(
        [{ ...fresh, coverage: { ...fresh.coverage, complete: false }, nextCursor: 'next' }],
        [queued],
      ),
    ).toBe(true);
  });
  it('requires both source and destination provider reads to be newer than confirmation', () => {
    const queued = { ...move('a', null, 'two'), confirmed: true, confirmedAfter: 7 };
    const source = { ...column('one', []), readVersion: 8 };
    const destination = { ...column('two', [task('a', 'two')]), readVersion: 7 };
    expect(movesAcknowledged([source, destination], [queued])).toBe(false);
    expect(movesAcknowledged([source, { ...destination, readVersion: 8 }], [queued])).toBe(true);
  });
  it('keeps the newest task snapshot when separate query pages contain the same identity', () => {
    const stale = { ...task('a'), title: 'old title', revision: 1 };
    const latest = { ...task('a'), title: 'current title', revision: 2 };
    const projected = projectTaskMoves(
      [column('one', [stale, latest]), column('two', [])],
      [move('a', null, 'two')],
    );
    expect(projected[1]!.tasks).toEqual([{ ...latest, listId: 'two' }]);
  });
  it('does not keep an old open snapshot as an anchor after its newer snapshot is completed', () => {
    const stale = task('a');
    const completed = {
      ...stale,
      revision: 2,
      completed: true,
      completedAt: '2026-11-04T12:00:00Z',
    };
    expect(openTaskOrder(column('one', [stale, completed, task('b')]))).toEqual(['b']);
  });
});

describe('background move queue', () => {
  it.each(['deleted', 'moved'] as const)(
    'accepts a newer authoritative read where the task was %s without resurrecting its captured position',
    async (outcome) => {
      let snapshot: readonly QueuedTaskMove[] = [];
      const queue = createTaskMoveQueue(
        async (queued) => {
          queued.confirmedAfter = 7;
          return true;
        },
        (moves) => {
          snapshot = moves;
        },
        vi.fn(),
      );
      queue.enqueue(move('a', null, 'two'));
      await turn();
      expect(snapshot[0]?.confirmed).toBe(true);
      const fresh = [
        column('one', []),
        column('two', []),
        column('three', outcome === 'moved' ? [task('a', 'three')] : []),
      ].map((item) => ({ ...item, readVersion: 8 }));
      queue.reconcile(fresh, 'board');
      expect(snapshot).toEqual([]);
      const remaining = projectTaskMoves(fresh, snapshot).flatMap((item) =>
        item.tasks.filter((item) => item.id === 'a'),
      );
      expect(remaining.map((item) => item.listId)).toEqual(outcome === 'moved' ? ['three'] : []);
    },
  );
  it('retires confirmed work from an older scope while retaining a pending move in this scope', async () => {
    let finish!: () => void;
    let snapshot: readonly QueuedTaskMove[] = [];
    const save = vi.fn(async (queued: QueuedTaskMove) => {
      if (queued.id === 'b')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      queued.confirmedAfter = 7;
      return true;
    });
    const queue = createTaskMoveQueue(
      save,
      (moves) => {
        snapshot = moves;
      },
      vi.fn(),
    );
    queue.enqueue({ ...move('c', null), scope: 'older-board' });
    queue.enqueue(move('b', null));
    await turn();
    queue.reconcile([{ ...column('one', []), readVersion: 8 }], 'board');
    expect(snapshot.map((item) => item.id)).toEqual(['b']);
    expect(snapshot[0]?.confirmed).toBe(false);
    finish();
    await turn();
    queue.reconcile([{ ...column('one', []), readVersion: 8 }], 'board');
    expect(snapshot).toEqual([]);
  });
  it('stops draining unsent work and publishing after disposal while a sent move finishes', async () => {
    let finish!: (saved: boolean) => void;
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const changed = vi.fn();
    const failed = vi.fn();
    const queue = createTaskMoveQueue(save, changed, failed);
    queue.enqueue(move('c', null));
    queue.enqueue(move('b', 'c'));
    const publications = changed.mock.calls.length;
    queue.dispose();
    queue.enqueue(move('a', 'b'));
    finish(true);
    await turn();
    expect(save).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(publications);
    expect(failed).not.toHaveBeenCalled();
  });
  it('shows queued intents immediately and sends them sequentially', async () => {
    let finish!: (saved: boolean) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(true);
    let snapshot: readonly QueuedTaskMove[] = [];
    const queue = createTaskMoveQueue(
      save,
      (moves) => {
        snapshot = moves;
      },
      vi.fn(),
    );
    queue.enqueue(move('c', null));
    queue.enqueue(move('b', 'c'));
    expect(snapshot.map((move) => move.id)).toEqual(['c', 'b']);
    expect(save).toHaveBeenCalledTimes(1);
    finish(true);
    await turn();
    expect(save).toHaveBeenCalledTimes(2);
    expect(snapshot.every((move) => move.confirmed)).toBe(true);
  });
  it('rolls back failed and dependent unsent positions while keeping earlier confirmed work', async () => {
    let fail!: (error: Error) => void;
    const save = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      );
    let snapshot: readonly QueuedTaskMove[] = [];
    const error = vi.fn();
    const queue = createTaskMoveQueue(
      save,
      (moves) => {
        snapshot = moves;
      },
      error,
    );
    queue.enqueue(move('c', null));
    queue.enqueue(move('b', 'c'));
    queue.enqueue(move('a', 'b'));
    await turn();
    fail(new Error('rejected'));
    await turn();
    expect(save).toHaveBeenCalledTimes(2);
    expect(snapshot.map((move) => move.id)).toEqual(['c']);
    expect(error).toHaveBeenCalledTimes(1);
    expect(
      openTaskOrder(
        projectTaskMoves([column('one', [task('a'), task('b'), task('c')])], snapshot)[0]!,
      ),
    ).toEqual(['c', 'a', 'b']);
  });
  it('cancels an unconfirmed checklist move without presenting a save failure', async () => {
    const failed = vi.fn();
    let snapshot: readonly QueuedTaskMove[] = [];
    const queue = createTaskMoveQueue(
      async () => false,
      (moves) => {
        snapshot = moves;
      },
      failed,
    );
    queue.enqueue(move('a', null, 'two'));
    await turn();
    expect(snapshot).toEqual([]);
    expect(failed).not.toHaveBeenCalled();
  });
});
