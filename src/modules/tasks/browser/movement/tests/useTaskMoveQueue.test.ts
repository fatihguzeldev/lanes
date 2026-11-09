import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskSchema, TaskListSchema } from '../../../contracts/task';
import { useTaskMoveQueue } from '../useTaskMoveQueue';

const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, save: vi.fn() }));
vi.mock('react', () => ({
  useRef(initial: unknown) {
    return (state.slots[state.cursor++] ??= { current: initial });
  },
  useState(initial: unknown) {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = initial;
    return [
      state.slots[index],
      (value: unknown) => {
        state.slots[index] = value;
      },
    ];
  },
  useEffect() {},
}));
vi.mock('../save-task-move', () => ({ saveTaskMove: state.save }));
const task = TaskSchema.parse({
  id: 'child',
  accountId: 'account',
  listId: 'list',
  parentId: 'parent',
  title: 'child',
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
  provider: {
    id: 'google-child',
    listId: 'google-list',
    etag: null,
    position: '100',
    updatedAt: null,
  },
  capabilities: {
    canEdit: true,
    canEditNotes: true,
    canMove: true,
    canDelete: true,
    canHaveChildren: true,
    canNest: false,
    assignmentSource: null,
    sourceUrl: null,
    restriction: null,
  },
});
const parent = { ...task, id: 'parent', parentId: null };
const list = TaskListSchema.parse({
  id: 'list',
  accountId: 'account',
  title: 'list',
  providerId: 'google-list',
  providerEtag: null,
  isDefault: false,
  revision: 1,
});
function render() {
  state.cursor = 0;
  return useTaskMoveQueue('account', {
    version: 0,
    clockOffset: 0,
    onRefresh() {},
    onError() {},
    confirmChildren: async () => true,
  });
}
beforeEach(() => {
  state.slots = [];
  state.cursor = 0;
  state.save.mockReset().mockResolvedValue(true);
});

describe('queued relative placements', () => {
  it('accepts an existing child reorder even when new nesting is unavailable', async () => {
    expect(render().enqueuePlacement(task, { list, parent, position: 'first' })).toBe(true);
    await Promise.resolve();
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        sourceParentId: parent.id,
        parentId: parent.id,
        previousTaskId: null,
      }),
      expect.any(String),
      expect.any(Function),
      expect.any(AbortSignal),
      0,
    );
  });

  it('still rejects actual reparenting when the task cannot nest', () => {
    expect(
      render().enqueuePlacement(task, {
        list,
        parent: { ...parent, id: 'other-parent' },
        position: 'first',
      }),
    ).toBe(false);
    expect(state.save).not.toHaveBeenCalled();
  });
});
