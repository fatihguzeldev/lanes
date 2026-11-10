import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RequestError } from '../../../../../shared/browser/http/http';
import { TaskSchema, TaskListSchema } from '../../../contracts/task';
import { useTaskMoveQueue } from '../useTaskMoveQueue';

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void>,
  request: vi.fn(),
  save: vi.fn(),
  refresh: vi.fn(),
  resume: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../../../shared/browser/http/http', async (original) => ({
  ...(await original<typeof import('../../../../../shared/browser/http/http')>()),
  request: state.request,
}));
vi.mock('../save-task-move', () => ({ saveTaskMove: state.save }));
vi.mock('react', () => ({
  useRef(current: unknown) {
    return (state.slots[state.cursor++] ??= { current });
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
  useEffect(effect: () => (() => void) | undefined, dependencies: unknown[]) {
    const index = state.cursor++;
    const previous = state.slots[index] as
      { dependencies: unknown[]; cleanup?: (() => void) | undefined } | undefined;
    if (
      previous &&
      dependencies.length === previous.dependencies.length &&
      dependencies.every((value, n) => Object.is(value, previous.dependencies[n]))
    )
      return;
    state.effects.push(() => {
      previous?.cleanup?.();
      state.slots[index] = { dependencies, cleanup: effect() };
    });
  },
}));
const list = TaskListSchema.parse({
  id: 'two',
  accountId: 'account',
  title: 'two',
  revision: 1,
  providerId: 'google-two',
  providerEtag: null,
  isDefault: false,
});
const task = TaskSchema.parse({
  id: 'task',
  accountId: 'account',
  listId: 'one',
  parentId: null,
  title: 'task',
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
  blockedBy: [],
  priority: 'none',
  starred: false,
  revision: 1,
  unsupportedHierarchy: false,
  provider: {
    id: 'google-task',
    listId: 'google-one',
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
    canNest: true,
    assignmentSource: null,
    sourceUrl: null,
    restriction: null,
  },
});
function render(version = 0, active = true) {
  state.cursor = 0;
  state.effects = [];
  const queue = useTaskMoveQueue('account', {
    version,
    active,
    clockOffset: 0,
    onRefresh: state.refresh,
    onError: state.error,
    resumeOrder: state.resume,
    confirmChildren: async () => true,
  });
  state.effects.forEach((effect) => effect());
  return queue;
}
async function flush() {
  for (let n = 0; n < 12; n++) await Promise.resolve();
}
beforeEach(() => {
  state.slots = [];
  vi.clearAllMocks();
  state.save.mockResolvedValue(true);
  state.resume.mockResolvedValue(undefined);
  state.request.mockResolvedValue({ orderReadyListIds: ['one', 'two'] });
});
afterEach(() => {
  for (const slot of state.slots) (slot as { cleanup?: () => void } | null)?.cleanup?.();
});

it('verifies only the moved lists without a mounted board, then hands off to a newer presented read', async () => {
  render().enqueuePlacement(task, { list, position: 'first' });
  await flush();
  render(1);
  await flush();
  const verified = render(1);
  expect(state.resume).toHaveBeenCalledOnce();
  expect(state.request).toHaveBeenCalledWith(
    '/api/accounts/account/tasks/query',
    expect.anything(),
    expect.objectContaining({
      body: { listIds: ['one', 'two'], limit: 2, filter: { completion: 'all' } },
    }),
  );
  expect(verified.moves[0]?.verifiedAfter).toBe(1);
  verified.observeRead(1);
  expect(render(1).moves).toHaveLength(1);
  render(2).observeRead(2);
  expect(render(2).moves).toEqual([]);
  expect(state.refresh).toHaveBeenCalledTimes(2);
  expect(state.request).toHaveBeenCalledOnce();
});

it('ignores a late probe after deactivation and resumes verification on return', async () => {
  let finish!: (page: { orderReadyListIds: string[] }) => void;
  state.request.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render().enqueuePlacement(task, { list, position: 'first' });
  await flush();
  render(1);
  const signal = state.request.mock.calls[0]![2].signal as AbortSignal;
  render(2, false);
  finish({ orderReadyListIds: ['one', 'two'] });
  await flush();
  expect(signal.aborted).toBe(true);
  expect(render(2, false).moves[0]?.verifiedAfter).toBeUndefined();
  expect(state.refresh).toHaveBeenCalledOnce();
  render(2);
  await flush();
  expect(render(2).moves[0]?.verifiedAfter).toBe(2);
  expect(state.request).toHaveBeenCalledTimes(2);
});

it('accepts confirmed list absence without turning a verification read into a save error', async () => {
  state.request.mockImplementation(async (_path, _schema, options) => {
    const ids = options.body.listIds as string[];
    if (ids.includes('two')) throw new RequestError('not_found', 'list was deleted');
    return { orderReadyListIds: ['one'] };
  });
  render().enqueuePlacement(task, { list, position: 'first' });
  await flush();
  render(1);
  await flush();
  expect(render(1).moves[0]?.verifiedAfter).toBe(1);
  expect(state.error).not.toHaveBeenCalled();
  render(2).observeRead(2);
  expect(render(2).moves).toEqual([]);
});

it('does not continuously poll after a failed proof read; later sync progress can retry it', async () => {
  state.request.mockRejectedValueOnce(new RequestError('server_unavailable', 'offline'));
  render().enqueuePlacement(task, { list, position: 'first' });
  await flush();
  render(1);
  await flush();
  expect(render(1).moves[0]?.verifiedAfter).toBeUndefined();
  expect(state.request).toHaveBeenCalledOnce();
  expect(state.error).not.toHaveBeenCalled();
  render(2);
  await flush();
  expect(render(2).moves[0]?.verifiedAfter).toBe(2);
});
