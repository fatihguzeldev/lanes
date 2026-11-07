import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskSchema, TaskSchema } from '../../../../tasks/contracts/task';
import type { PendingTaskCreation } from '../../../../tasks/browser/creation/useTaskCreations';
import type { BoardColumn, BoardSurfaceProps } from '../BoardSurface';
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

  it('keeps the submitted title when the save is done but its list read is still old', () => {
    const { column, acknowledged } = render({ readVersion: 5 });
    expect(column.creations?.map((item) => item.input.title)).toEqual(['ring64']);
    expect(acknowledged).not.toHaveBeenCalled();
  });

  it('removes the local row in the same render that presents the fresh confirmed task', () => {
    const saved = TaskSchema.parse({
      ...creation().input,
      id: 'saved-task',
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
    const { column, acknowledged } = render({ readVersion: 6 }, [creation(), next]);
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
