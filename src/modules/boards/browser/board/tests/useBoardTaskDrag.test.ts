import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SortableDroppable } from '@dnd-kit/dom/sortable';
import type { DragDropEventHandlers } from '@dnd-kit/react';
import { TaskSchema, type Task } from '../../../../tasks/contracts/task';
import { openTaskOrder } from '../../../../tasks/browser/movement/task-move-model';
import type { BoardColumn } from '../board-column';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
}));
vi.mock('react', () => ({
  useRef: (current: unknown) => {
    const index = hooks.cursor++;
    return (hooks.slots[index] ??= { current });
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => (hooks.slots[index] = value)];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | undefined, dependencies?: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as
      { dependencies?: unknown[]; cleanup?: (() => void) | undefined } | undefined;
    if (
      previous &&
      dependencies &&
      previous.dependencies?.length === dependencies.length &&
      dependencies.every((value, position) => Object.is(value, previous.dependencies?.[position]))
    )
      return;
    hooks.effects.push(() => {
      previous?.cleanup?.();
      hooks.slots[index] = { dependencies, cleanup: effect() };
    });
  },
}));

import { useBoardTaskDrag } from '../useBoardTaskDrag';

function task(id: string, listId = 'source', patch: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id,
    accountId: 'account',
    listId,
    parentId: null,
    title: id,
    notes: '',
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
function column(id: string, tasks: Task[]): BoardColumn {
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
    nextCursor: null,
    status: 'ready',
  };
}
const initialColumns = () => [
  column('source', [task('a'), task('b'), task('c')]),
  column('destination', [task('d', 'destination')]),
  column('empty', []),
];
type Options = Parameters<typeof useBoardTaskDrag>[0];
type Controller = ReturnType<typeof useBoardTaskDrag>;
type Operation = Parameters<DragDropEventHandlers['onDragOver']>[0]['operation'];
const source = {
  id: 'b',
  data: { kind: 'task', accountId: 'account', taskId: 'b', listId: 'source', revision: 1 },
};
function target(taskId: string, listId: string, index: number) {
  return Object.create(SortableDroppable.prototype, {
    id: { value: taskId },
    data: { value: { kind: 'task', accountId: 'account', taskId, listId, revision: 1 } },
    sortable: { value: { index, group: listId } },
    shape: { value: { center: { x: 100, y: 100 } } },
  });
}
function operation(dropTarget: unknown = null, y = 120, shapeY = y): Operation {
  return {
    source,
    target: dropTarget,
    position: { current: { x: 100, y } },
    shape: { current: { center: { x: 100, y: shapeY } } },
  } as unknown as Operation;
}
function setup(patch: Partial<Options> = {}) {
  let options: Options = {
    accountId: 'account',
    scope: 'board',
    enabled: true,
    columns: initialColumns(),
    onMoveTask: vi.fn(),
    ...patch,
  };
  let result: Controller;
  const manager = {
    actions: {
      stop: vi.fn(({ canceled }: { canceled: boolean }) =>
        result.onDragEnd({ operation: operation(), canceled } as never, manager as never),
      ),
    },
  };
  function render(next: Partial<Options> = {}, flushEffects = true) {
    options = { ...options, ...next };
    hooks.cursor = 0;
    result = useBoardTaskDrag(options);
    if (flushEffects) hooks.effects.splice(0).forEach((effect) => effect());
    return result;
  }
  const begin = () => {
    result.onBeforeDragStart(
      { operation: operation(), preventDefault: vi.fn() } as never,
      manager as never,
    );
    result.onDragStart({ operation: operation() } as never, manager as never);
    return render();
  };
  const over = (dropTarget: unknown, y?: number, shapeY?: number) => {
    result.onDragOver({ operation: operation(dropTarget, y, shapeY) } as never, manager as never);
    return render();
  };
  const end = (dropTarget: unknown, canceled = false) => {
    result.onDragEnd({ operation: operation(dropTarget), canceled } as never, manager as never);
    return render();
  };
  render();
  const unmount = () => {
    for (const slot of hooks.slots) (slot as { cleanup?: () => void })?.cleanup?.();
  };
  return { render, begin, over, end, options, manager, unmount };
}

describe('board task drag flow', () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.cursor = 0;
    hooks.effects = [];
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  });
  afterEach(() => {
    for (const slot of hooks.slots) (slot as { cleanup?: () => void })?.cleanup?.();
    vi.unstubAllGlobals();
  });

  it('moves surrounding rows locally and only submits the changed placement after release', () => {
    const flow = setup();
    expect(flow.begin().dragging).toBe(true);
    const finalTarget = target('c', 'source', 2);
    const preview = flow.over(finalTarget);
    expect(openTaskOrder(preview.columns[0]!)).toEqual(['a', 'c', 'b']);
    expect(flow.options.onMoveTask).not.toHaveBeenCalled();
    expect(flow.options.columns[0]!.tasks.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(flow.end(finalTarget).dragging).toBe(false);
    expect(flow.options.onMoveTask).toHaveBeenCalledExactlyOnceWith({
      accountId: 'account',
      taskId: 'b',
      revision: 1,
      sourceListId: 'source',
      destinationListId: 'source',
      parentId: null,
      previousTaskId: 'c',
    });
  });

  it('keeps a local reorder interactive when only sync coverage changes during the gesture', () => {
    const flow = setup();
    flow.begin();
    const drop = target('c', 'source', 2);
    expect(openTaskOrder(flow.over(drop).columns[0]!)).toEqual(['a', 'c', 'b']);
    const columns = initialColumns().map((column) => ({
      ...column,
      coverage: { ...column.coverage, complete: false },
      orderReady: false,
    }));
    const pending = flow.render({ columns });
    expect(pending.dragging).toBe(true);
    expect(flow.manager.actions.stop).not.toHaveBeenCalled();
    flow.end(drop);
    expect(flow.options.onMoveTask).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ previousTaskId: 'c' }),
    );
  });

  it.each(['metadata', 'provider order'] as const)(
    'keeps a held reorder when only %s is confirmed',
    (change) => {
      const initial = initialColumns();
      initial[0]!.tasks = initial[0]!.tasks.map((task) =>
        task.id === 'b' ? { ...task, starred: true } : task,
      );
      const flow = setup({ columns: initial });
      flow.begin();
      const drop = target('c', 'source', 2);
      expect(openTaskOrder(flow.over(drop).columns[0]!)).toEqual(['a', 'c', 'b']);
      const confirmed = initialColumns();
      confirmed[0]!.tasks = initial[0]!.tasks.map((task) =>
        task.id === 'b'
          ? {
              ...task,
              revision: 2,
              ...(change === 'provider order'
                ? { provider: { ...task.provider, position: 'bb', etag: 'order-v2' } }
                : {}),
            }
          : task,
      );
      flow.render({ columns: confirmed });
      expect(flow.manager.actions.stop).not.toHaveBeenCalled();
      expect(flow.render().dragging).toBe(true);
      flow.end(drop);
      expect(flow.options.onMoveTask).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ taskId: 'b', revision: 2, previousTaskId: 'c' }),
      );
    },
  );

  it('can lift and reorder retained rows without waiting for the list scan', () => {
    const columns = initialColumns().map((column) => ({
      ...column,
      coverage: { ...column.coverage, complete: false },
      orderReady: false,
    }));
    const flow = setup({ columns });
    expect(flow.begin().dragging).toBe(true);
    const drop = target('c', 'source', 2);
    expect(openTaskOrder(flow.over(drop).columns[0]!)).toEqual(['a', 'c', 'b']);
    expect(flow.options.onMoveTask).not.toHaveBeenCalled();
    flow.end(drop);
    expect(flow.options.onMoveTask).toHaveBeenCalledOnce();
  });

  it('restores an unchanged gap without submitting a move', () => {
    const flow = setup();
    flow.begin();
    flow.over(target('c', 'source', 2));
    const originalGap = target('c', 'source', 1);
    flow.over(originalGap);
    const ownPlaceholder = target('b', 'source', 1);
    flow.end(ownPlaceholder);
    expect(flow.options.onMoveTask).not.toHaveBeenCalled();
  });

  it('does not submit a task lifted and released over its original placeholder', () => {
    const flow = setup();
    flow.begin();
    const ownPlaceholder = target('b', 'source', 1);
    flow.over(ownPlaceholder);
    flow.end(ownPlaceholder);
    expect(flow.options.onMoveTask).not.toHaveBeenCalled();
  });

  it('rejects a lift whose rendered source revision is already stale', () => {
    const columns = initialColumns();
    columns[0]!.tasks = [task('a'), task('b', 'source', { revision: 2 }), task('c')];
    const flow = setup({ columns });
    expect(flow.begin().dragging).toBe(false);
    expect(flow.options.onMoveTask).not.toHaveBeenCalled();
  });

  it.each(['outside', 'cancel'] as const)(
    'restores cross-list preview on %s without saving',
    (kind) => {
      const flow = setup();
      flow.begin();
      const destination = target('d', 'destination', 0);
      const preview = flow.over(destination);
      expect(openTaskOrder(preview.columns[1]!)).toEqual(['d', 'b']);
      expect(flow.end(kind === 'outside' ? null : destination, kind === 'cancel').dragging).toBe(
        false,
      );
      expect(flow.options.onMoveTask).not.toHaveBeenCalled();
    },
  );

  it('uses the held card center when a tall card is grabbed below its midpoint', () => {
    const flow = setup();
    flow.begin();
    const preview = flow.over(target('d', 'destination', 0), 120, 80);
    expect(openTaskOrder(preview.columns[1]!)).toEqual(['b', 'd']);
    expect(flow.options.onMoveTask).not.toHaveBeenCalled();
  });

  it('moves children together to an empty list while retaining provider identities', () => {
    const columns = initialColumns();
    columns[0]!.tasks = [...columns[0]!.tasks, task('child', 'source', { parentId: 'b' })];
    const flow = setup({ columns });
    flow.begin();
    const empty = { id: 'task-list:empty', data: { kind: 'task-list', listId: 'empty' } };
    const preview = flow.over(empty);
    expect(preview.columns[2]!.tasks.map((item) => item.id)).toEqual(['b', 'child']);
    expect(preview.columns[2]!.tasks[0]!.provider.listId).toBe('source');
    flow.end(empty);
    expect(flow.options.onMoveTask).toHaveBeenCalledWith(
      expect.objectContaining({ destinationListId: 'empty', previousTaskId: null }),
    );
  });

  it('keeps unrelated refreshed values frozen during a gesture and reveals them afterwards', () => {
    const flow = setup();
    flow.begin();
    const refreshed = initialColumns();
    refreshed[1]!.tasks = [task('d', 'destination', { title: 'refreshed title', revision: 2 })];
    expect(flow.render({ columns: refreshed }).columns[1]!.tasks[0]!.title).toBe('d');
    expect(flow.end(null).columns[1]!.tasks[0]!.title).toBe('refreshed title');
  });

  it.each(['content', 'order', 'scope', 'disabled'] as const)(
    'cancels when %s invalidates the gesture',
    (change) => {
      const flow = setup();
      flow.begin();
      flow.over(target('c', 'source', 2));
      const columns = initialColumns();
      if (change === 'content')
        columns[0]!.tasks = [
          task('a'),
          task('b', 'source', { title: 'changed task', revision: 2 }),
          task('c'),
        ];
      if (change === 'order') columns[0]!.orderedTaskIds = ['c', 'b', 'a'];
      flow.render({
        columns,
        ...(change === 'scope' ? { scope: 'other-board' } : {}),
        ...(change === 'disabled' ? { enabled: false } : {}),
      });
      expect(flow.manager.actions.stop).toHaveBeenCalledWith({ canceled: true });
      expect(flow.render().dragging).toBe(false);
      expect(flow.options.onMoveTask).not.toHaveBeenCalled();
    },
  );

  it('revalidates the latest source even before invalidation effects have run', () => {
    const flow = setup();
    flow.begin();
    const destination = target('d', 'destination', 0);
    flow.over(destination);
    const columns = initialColumns();
    columns[0]!.tasks = [task('a'), task('b', 'source', { completed: true }), task('c')];
    flow.render({ columns }, false);
    flow.end(destination);
    expect(flow.options.onMoveTask).not.toHaveBeenCalled();
  });

  it.each([
    { title: 'changed title' },
    { notes: 'changed notes' },
    { completed: true },
    { parentId: 'a' },
    { scheduledDay: '2026-11-11' },
    { provider: { ...task('b').provider, id: 'another-provider-task' } },
    { capabilities: { ...task('b').capabilities, canMove: false } },
    { unsupportedHierarchy: true },
  ] satisfies Partial<Task>[])(
    'still cancels an identity, content or eligibility change during the gesture: %j',
    (patch) => {
      const flow = setup();
      flow.begin();
      const drop = target('c', 'source', 2);
      flow.over(drop);
      const columns = initialColumns();
      columns[0]!.tasks = [task('a'), task('b', 'source', { ...patch, revision: 2 }), task('c')];
      flow.render({ columns }, false);
      flow.end(drop);
      expect(flow.options.onMoveTask).not.toHaveBeenCalled();
    },
  );

  it('cancels when the destination changes rather than persisting a stale numeric gap', () => {
    const flow = setup();
    flow.begin();
    flow.over(target('d', 'destination', 0));
    const columns = initialColumns();
    columns[1]!.tasks = [task('new', 'destination'), ...columns[1]!.tasks];
    flow.render({ columns });
    expect(flow.manager.actions.stop).toHaveBeenCalledWith({ canceled: true });
    expect(flow.options.onMoveTask).not.toHaveBeenCalled();
  });

  it('cancels the active gesture on unmount without retaining its listeners or saving', () => {
    const flow = setup();
    flow.begin();
    flow.over(target('d', 'destination', 0));
    flow.unmount();
    expect(flow.manager.actions.stop).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('blur'));
    expect(flow.manager.actions.stop).toHaveBeenCalledTimes(1);
    expect(flow.options.onMoveTask).not.toHaveBeenCalled();
  });

  it.each(['blur', 'visibilitychange'] as const)(
    'cancels on %s without submitting work',
    (event) => {
      const flow = setup();
      flow.begin();
      flow.over(target('d', 'destination', 0));
      if (event === 'visibilitychange') Object.assign(document, { visibilityState: 'hidden' });
      (event === 'blur' ? window : document).dispatchEvent(new Event(event));
      expect(flow.manager.actions.stop).toHaveBeenCalledWith({ canceled: true });
      expect(flow.render().dragging).toBe(false);
      expect(flow.options.onMoveTask).not.toHaveBeenCalled();
    },
  );
});
