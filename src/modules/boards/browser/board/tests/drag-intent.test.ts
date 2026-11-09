import { describe, expect, it } from 'vitest';
import { TaskSchema, type Task } from '../../../../tasks/contracts/task';
import type { TaskMoveList } from '../../../../tasks/browser/movement/task-move-model';
import { captureTaskDrag, resolveTaskDragIntent, type DraggedTask } from '../drag-intent';

function task(id: string, listId = 'source', patch: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id,
    accountId: 'account',
    listId,
    parentId: null,
    title: id,
    notes: 'retained notes',
    completed: false,
    completedAt: null,
    scheduledDay: null,
    scheduledTime: null,
    timeZone: null,
    repeatRule: null,
    seriesId: null,
    occurrenceId: null,
    labelIds: ['label'],
    priority: 'high',
    starred: true,
    blockedBy: [],
    revision: 1,
    unsupportedHierarchy: false,
    provider: { id, listId, etag: 'etag', position: id, updatedAt: null },
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
    ...patch,
  });
}
function column(id: string, tasks: Task[] = []): TaskMoveList {
  return {
    list: {
      id,
      accountId: 'account',
      providerId: id,
      providerEtag: null,
      title: id,
      isDefault: false,
      revision: 1,
    },
    tasks,
    coverage: { complete: true, stale: false, lastSyncedAt: null },
    status: 'ready',
    nextCursor: null,
  };
}
const dragged: DraggedTask = {
  accountId: 'account',
  taskId: 'b',
  revision: 1,
  sourceListId: 'source',
};
const columns = () => [
  column('source', [task('a'), task('b'), task('c')]),
  column('destination', [task('d', 'destination'), task('e', 'destination')]),
];
const resolve = (input: Partial<Parameters<typeof resolveTaskDragIntent>[0]> = {}) =>
  resolveTaskDragIntent({
    accountId: 'account',
    columns: columns(),
    dragged,
    destinationListId: 'source',
    index: 0,
    ...input,
  });

describe('task lift capture', () => {
  it('captures the current task identity independently from gesture presentation', () => {
    expect(captureTaskDrag({ accountId: 'account', columns: columns(), taskId: 'b' })).toEqual(
      dragged,
    );
  });

  it.each([
    { completed: true },
    { parentId: 'a' },
    { unsupportedHierarchy: true },
    { capabilities: { ...task('b').capabilities, canMove: false } },
    { accountId: 'other-account' },
  ] satisfies Partial<Task>[])('refuses ineligible or foreign tasks before lift: %j', (patch) => {
    expect(
      captureTaskDrag({
        accountId: 'account',
        columns: [column('source', [task('b', 'source', patch)])],
        taskId: 'b',
      }),
    ).toBeNull();
  });

  it('refuses pending tasks and missing source identities', () => {
    expect(
      captureTaskDrag({
        accountId: 'account',
        columns: columns(),
        taskId: 'b',
        pendingTaskIds: new Set(['b']),
      }),
    ).toBeNull();
    expect(captureTaskDrag({ accountId: 'account', columns: [], taskId: 'b' })).toBeNull();
  });
});

describe('released task placement', () => {
  it('reorders known siblings while provider coverage is incomplete without opening cross-list moves', () => {
    const base = columns();
    base[0] = {
      ...base[0]!,
      coverage: { complete: false, stale: true, lastSyncedAt: null },
      orderReady: false,
    };
    expect(captureTaskDrag({ accountId: 'account', columns: base, taskId: 'b' })).toEqual(dragged);
    expect(resolve({ columns: base, index: 2 })).toEqual({
      ...dragged,
      destinationListId: 'source',
      parentId: null,
      previousTaskId: 'c',
    });
    expect(resolve({ columns: base, destinationListId: 'destination', index: 0 })).toBeNull();
  });

  it('resolves changed indices against the base order without changing provider fields', () => {
    const base = columns();
    const original = structuredClone(base);
    expect(resolve({ columns: base, index: 0 })).toEqual({
      ...dragged,
      destinationListId: 'source',
      parentId: null,
      previousTaskId: null,
    });
    expect(resolve({ columns: base, index: 2 })).toEqual({
      ...dragged,
      destinationListId: 'source',
      parentId: null,
      previousTaskId: 'c',
    });
    expect(base).toEqual(original);
  });

  it.each([
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ] as const)('returns no intent for %s released at its current gap', (taskId, index) => {
    expect(resolve({ dragged: { ...dragged, taskId }, index })).toBeNull();
  });

  it('uses the queued presentation order rather than provider position strings', () => {
    const base = columns();
    base[0]!.orderedTaskIds = ['c', 'a', 'b'];
    expect(resolve({ columns: base, index: 2 })).toBeNull();
    expect(resolve({ columns: base, index: 1 })?.previousTaskId).toBe('c');
  });

  it('accepts every cross-list gap, including an empty destination', () => {
    expect(resolve({ destinationListId: 'destination', index: 0 })?.previousTaskId).toBeNull();
    expect(resolve({ destinationListId: 'destination', index: 1 })?.previousTaskId).toBe('d');
    expect(resolve({ destinationListId: 'destination', index: 2 })?.previousTaskId).toBe('e');
    expect(
      resolve({ columns: [columns()[0]!, column('empty')], destinationListId: 'empty', index: 0 }),
    ).toEqual({ ...dragged, destinationListId: 'empty', parentId: null, previousTaskId: null });
  });

  it('allows an order captured by pending moves without claiming complete provider coverage', () => {
    const base = columns().map((item) => ({
      ...item,
      coverage: { ...item.coverage, complete: false },
      orderReady: true,
    }));
    expect(resolve({ columns: base, index: 0 })).not.toBeNull();
  });

  it.each([-1, 3, 0.5, NaN, Infinity])('rejects an invalid final index: %s', (index) => {
    expect(resolve({ index })).toBeNull();
  });

  it('rejects unavailable and foreign destination lists', () => {
    expect(resolve({ destinationListId: 'missing' })).toBeNull();
    const base = columns();
    base[1]!.list.accountId = 'other-account';
    expect(resolve({ columns: base, destinationListId: 'destination' })).toBeNull();
  });

  it('revalidates both list orders and task state at release', () => {
    const base = columns();
    base[1]!.orderReady = false;
    expect(resolve({ columns: base, destinationListId: 'destination' })).toBeNull();
    expect(resolve({ dragged: { ...dragged, revision: 0 } })).toBeNull();
    expect(resolve({ dragged: { ...dragged, accountId: 'other-account' } })).toBeNull();
    expect(resolve({ pendingTaskIds: new Set(['b']) })).toBeNull();
    expect(resolve({ columns: [column('source', [task('a'), task('c')])] })).toBeNull();
    const partial = columns();
    partial[1]!.coverage.complete = false;
    expect(resolve({ columns: partial, destinationListId: 'destination' })).toBeNull();
  });

  it.each([
    { completed: true },
    { parentId: 'a' },
    { unsupportedHierarchy: true },
    { capabilities: { ...task('b').capabilities, canMove: false } },
  ] satisfies Partial<Task>[])('rejects a task that became ineligible while held: %j', (patch) => {
    const base = columns();
    base[0]!.tasks = [task('a'), task('b', 'source', patch), task('c')];
    expect(resolve({ columns: base })).toBeNull();
  });

  it('does not resurrect a stale source copy after an authoritative external move', () => {
    const base = columns();
    base[1]!.tasks = [...base[1]!.tasks, task('b', 'destination', { revision: 2 })];
    expect(resolve({ columns: base, destinationListId: 'destination' })).toBeNull();
  });
});
