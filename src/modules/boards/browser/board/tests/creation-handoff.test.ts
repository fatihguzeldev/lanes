import type { BoardColumn } from '../board-column';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskSchema, TaskSchema } from '../../../../tasks/contracts/task';
import type { PendingTaskCreation } from '../../../../tasks/browser/creation/creation-model';
import type { BoardSurfaceProps } from '../BoardSurface';
import { BoardWorkspace, type BoardWorkspaceProps } from '../BoardWorkspace';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as Array<() => void>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.slots[index], vi.fn()];
  },
  useMemo: (value: () => unknown) => value(),
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void) => hooks.effects.push(effect),
}));

const creation = (id = 1): PendingTaskCreation => ({
  id,
  input: CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'ring64' }),
  confirmedAfter: 5,
  resolvedTaskId: `saved-task-${id}`,
});
const list = { id: 'list', accountId: 'account', boardId: 'board' };
function render(
  column: Partial<BoardColumn>,
  creations = [creation()],
  extra: Partial<BoardWorkspaceProps> = {},
) {
  hooks.index = 0;
  hooks.effects = [];
  hooks.slots = [{ list: { list, tasks: [], status: 'ready', nextCursor: null, ...column } }];
  const acknowledged = vi.fn();
  const props = {
    account: { id: 'account', state: 'connected' },
    board: { id: 'board' },
    lists: [list],
    filter: {},
    query: '',
    sort: 'manual',
    version: 6,
    creations,
    onCreationRead: acknowledged,
    moveQueue: { moves: [], reconcile() {} },
    ...extra,
  } as unknown as BoardWorkspaceProps;
  const view = BoardWorkspace(props) as ReactElement<{
    children: [unknown, ReactElement<BoardSurfaceProps>];
  }>;
  hooks.effects.forEach((effect) => effect());
  return { column: view.props.children[1].props.columns[0]!, acknowledged };
}

describe('creation handoff to confirmed list data', () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.index = 0;
    hooks.effects = [];
  });

  it('keeps a newly inserted task first when a fresh read still has stale sibling positions', () => {
    const saved = {
      ...creation().input,
      id: 'saved-task',
      completed: false,
      revision: 1,
      provider: { id: 'new', position: '000' },
    } as import('../../../../tasks/contracts/task').Task;
    const old = {
      ...saved,
      id: 'a-old',
      title: 'survive',
      provider: { ...saved.provider, id: 'old' },
    };
    const pending = { ...creation(), resolvedTaskId: saved.id };
    const before = render({ readVersion: 6, tasks: [old, saved], orderReadyTaskIds: [] }, [
      pending,
    ]);
    expect(before.column.creations?.map((item) => item.input.title)).toEqual(['ring64']);
    expect(before.column.tasks.map((task) => task.title)).toEqual(['survive']);
    expect(before.acknowledged).not.toHaveBeenCalled();
    const after = render(
      {
        readVersion: 7,
        tasks: [saved, { ...old, provider: { ...old.provider, position: '001' } }],
        orderReadyTaskIds: [saved.id, old.id],
      },
      [pending],
    );
    expect(after.column.creations).toEqual([]);
    expect(after.column.tasks.map((task) => task.title)).toEqual(['ring64', 'survive']);
    expect(after.acknowledged).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('keeps the submitted title when the save is done but its list read is still old', () => {
    const { column, acknowledged } = render({ readVersion: 5 });
    expect(column.creations?.map((item) => item.input.title)).toEqual(['ring64']);
    expect(acknowledged).not.toHaveBeenCalled();
  });

  it.each([
    { filter: { starred: true }, query: '' },
    { filter: {}, query: 'something else' },
    { filter: { completion: 'completed' as const }, query: '' },
  ])(
    'hides a creation excluded by the current view without inventing a confirmed task',
    (selection) => {
      const { column, acknowledged } = render(
        { readVersion: 6, orderReadyTaskIds: [] },
        [creation()],
        selection,
      );
      expect(column.creations).toEqual([]);
      expect(acknowledged).not.toHaveBeenCalled();
    },
  );

  it('hides a pending completed creation from the open view immediately', () => {
    const { column } = render({ readVersion: 6 }, [
      { ...creation(), completed: true, confirmedAfter: null },
    ]);
    expect(column.creations).toEqual([]);
  });
  it('retires a filtered-out creation once its own list has verified order', () => {
    const { column, acknowledged } = render(
      { readVersion: 6, orderReadyTaskIds: [], orderReadyListIds: ['list'] },
      [creation()],
      { filter: { starred: true } },
    );
    expect(column.creations).toEqual([]);
    expect(acknowledged).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('removes the local row in the same render that presents the fresh confirmed task', () => {
    const saved = TaskSchema.parse({
      ...creation().input,
      id: 'saved-task-1',
      completed: false,
      completedAt: null,
      seriesId: null,
      occurrenceId: null,
      revision: 1,
      provider: {
        id: 'google-task',
        listId: 'google-list',
        etag: null,
        position: '1',
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
      unsupportedHierarchy: false,
    });
    const { column, acknowledged } = render({
      readVersion: 6,
      tasks: [saved],
      orderReadyTaskIds: [saved.id],
    });
    expect(column.tasks).toEqual([saved]);
    expect(column.creations).toEqual([]);
    expect(acknowledged).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(['loading', 'error'] as const)(
    'preserves the local row while the fresh read is %s',
    (status) => {
      const { column, acknowledged } = render({ status });
      expect(column.creations).toHaveLength(1);
      expect(acknowledged).not.toHaveBeenCalled();
    },
  );

  it('keeps another creation visible while the first successful one is acknowledged', () => {
    const next = { ...creation(2), confirmedAfter: null };
    const { column, acknowledged } = render(
      { readVersion: 6, orderReadyTaskIds: ['saved-task-1'] },
      [creation(), next],
    );
    expect(column.creations?.map((item) => item.id)).toEqual([2]);
    expect(acknowledged).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('never displays or acknowledges another account or list through this column', () => {
    const other = { ...creation(), input: { ...creation().input, listId: 'another-list' } };
    const foreign = {
      ...creation(2),
      input: { ...creation().input, accountId: 'another-account' },
    };
    const { column, acknowledged } = render({ readVersion: 6 }, [other, foreign]);
    expect(column.creations).toEqual([]);
    expect(acknowledged).not.toHaveBeenCalled();
  });
});

it('keeps a submitted edit visible until a newer confirmed list read replaces it', () => {
  const task = {
    id: 'task',
    accountId: 'account',
    listId: 'list',
    title: 'old',
    revision: 1,
  } as import('../../../../tasks/contracts/task').Task;
  const edit = {
    id: 3,
    task,
    input: {
      accountId: 'account',
      taskId: 'task',
      listId: 'list',
      expectedRevision: 1,
      patch: { title: 'new' },
    },
    confirmedAfter: 5,
  };
  const onEditRead = vi.fn();
  const pending = render({ readVersion: 5, tasks: [task] }, [], { edits: [edit], onEditRead });
  expect(pending.column.tasks[0]?.title).toBe('new');
  expect(pending.column.tasks[0]?.revision).toBe(1);
  expect(onEditRead).not.toHaveBeenCalled();
  const fresh = render({ readVersion: 6, tasks: [{ ...task, title: 'new', revision: 2 }] }, [], {
    edits: [edit],
    onEditRead,
  });
  expect(fresh.column.tasks[0]?.revision).toBe(2);
  expect(onEditRead).toHaveBeenCalledExactlyOnceWith(3);
});
