import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionSummary } from '../../../../accounts/contracts/connection';
import { TaskSchema } from '../../../../tasks/contracts/task';
import { BoardListSchema } from '../../../contracts/board';
import type { PlacementPreview } from '../placement-model';
import { useTaskPlacement } from '../useTaskPlacement';

const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as Array<() => void>,
}));
const commands = vi.hoisted(() => ({
  busy: false,
  latest: null,
  error: '',
  errorDetails: null,
  submit: vi.fn(),
  clearError: vi.fn(),
}));
const read = vi.hoisted(() => vi.fn());
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const slot = (harness.slots[harness.cursor++] ??= { value: initial }) as { value: unknown };
    return [
      slot.value,
      (next: unknown) => (slot.value = typeof next === 'function' ? next(slot.value) : next),
    ];
  },
  useRef: (initial: unknown) => (harness.slots[harness.cursor++] ??= { current: initial }),
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
    const index = harness.cursor++;
    const slot = harness.slots[index] as
      { dependencies: unknown[]; cleanup: (() => void) | undefined } | undefined;
    if (!slot || dependencies.some((value, key) => !Object.is(value, slot.dependencies[key]))) {
      harness.effects.push(() => {
        slot?.cleanup?.();
        harness.slots[index] = { dependencies, cleanup: effect() || undefined };
      });
    }
  },
}));
vi.mock('../../../../operations/browser/submission/useCommands', () => ({
  useCommands: () => commands,
}));
vi.mock('../../../../operations/browser/submission/operation-identity', () => ({
  newOperationId: () => 'placement-identity',
}));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: read }));
vi.mock('../../../../../shared/browser/connectivity/useServerConnection', () => ({
  useServerConnection: () => 'reachable',
}));

const task = TaskSchema.parse({
  id: 'task',
  accountId: 'account',
  listId: 'source',
  parentId: null,
  title: 'read',
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
  revision: 7,
  unsupportedHierarchy: false,
  provider: {
    id: 'google-task',
    listId: 'google-source',
    etag: 'etag',
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
});
const list = BoardListSchema.parse({
  id: 'destination',
  accountId: 'account',
  title: 'done',
  providerId: 'google-destination',
  providerEtag: null,
  isDefault: false,
  revision: 4,
  boardId: 'board',
  color: '#ffffff',
  position: 0,
  membershipRevision: 1,
});
const preview: PlacementPreview = {
  taskId: task.id,
  revision: task.revision,
  title: task.title,
  subtaskCount: 0,
  openSubtaskCount: 0,
  openBlockerCount: 0,
  openBlockedSubtaskCount: 0,
  unknownBlockerCount: 0,
  assignmentSource: null,
  coverageComplete: true,
};
const account = { id: 'account', state: 'connected' } as ConnectionSummary;
const notice = vi.fn();
const moved = vi.fn();
function render(onMoved = moved) {
  harness.cursor = 0;
  const controller = useTaskPlacement({
    account,
    clockOffset: 0,
    onChanged: vi.fn(),
    onNotice: notice,
    onInspect: vi.fn(),
    onMoved,
  });
  harness.effects.splice(0).forEach((effect) => effect());
  return controller;
}
async function open() {
  render().open(task, {} as HTMLElement, 'board');
  const controller = render();
  expect(controller.sourceLoading).toBe(false);
  expect(controller.source).toBeNull();
  return controller;
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('confirmed task placement events', () => {
  beforeEach(() => {
    harness.cursor = 0;
    harness.slots = [];
    harness.effects = [];
    commands.submit.mockReset().mockResolvedValue({ state: 'succeeded' });
    commands.clearError.mockReset();
    read
      .mockReset()
      .mockImplementation((path: string) =>
        Promise.resolve(path.endsWith('/consequences') ? preview : task),
      );
    moved.mockReset();
    notice.mockReset();
  });
  afterEach(() => {
    for (const slot of harness.slots) (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
  });

  it('does not refetch the task or its consequences just to browse destinations', () => {
    render().open(task, {} as HTMLElement, 'board');
    render();
    expect(read).not.toHaveBeenCalled();
    expect(commands.submit).not.toHaveBeenCalled();
  });

  it('notifies the source task only after the provider move is confirmed', async () => {
    const controller = await open();
    const saving = controller.choose({ list, position: 'last' });
    expect(moved).not.toHaveBeenCalled();
    await saving;
    expect(moved).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(render().selection).toBeNull();
  });

  it('checks the current task revision only after a destination is chosen', async () => {
    const controller = await open();
    const fresh = { ...task, revision: 8 };
    read.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/consequences') ? { ...preview, revision: 8 } : fresh),
    );
    await controller.choose({ list, position: 'last' });
    expect(read.mock.calls.map(([path]) => path)).toEqual([
      '/api/accounts/account/tasks/task',
      '/api/accounts/account/tasks/task/consequences',
    ]);
    expect(commands.submit).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 8, listRevision: list.revision }),
      'provider',
      'placement-identity',
    );
  });

  it('does not submit an incomplete or inconsistent task tree', async () => {
    const controller = await open();
    read.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/consequences') ? { ...preview, coverageComplete: false } : task,
      ),
    );
    await controller.choose({ list, position: 'last' });
    expect(commands.submit).not.toHaveBeenCalled();
    expect(render().error).toContain('refresh the source list');

    read.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/consequences') ? { ...preview, revision: 9 } : task),
    );
    await render().choose({ list, position: 'last' });
    expect(commands.submit).not.toHaveBeenCalled();
    expect(render().error).toContain('this task changed');
  });

  it('confirms a checklist discovered during the selected move preflight', async () => {
    const controller = await open();
    read.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/consequences') ? { ...preview, subtaskCount: 2 } : task),
    );
    await controller.choose({ list, position: 'last' });
    expect(commands.submit).not.toHaveBeenCalled();
    expect(render().confirmation?.subtaskCount).toBe(2);
    render().confirm();
    await settle();
    expect(commands.submit).toHaveBeenCalledOnce();
  });

  it('cancels a pending preflight when destinations close and ignores late replies', async () => {
    const controller = await open();
    let finish!: (value: typeof task) => void;
    read.mockImplementation((path: string) =>
      path.endsWith('/consequences')
        ? Promise.resolve(preview)
        : new Promise((resolve) => (finish = resolve)),
    );
    const pending = controller.choose({ list, position: 'last' });
    void controller.choose({ list, position: 'first' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(render().sourceLoading).toBe(true);
    render().close();
    expect((read.mock.calls[0]![2] as { signal: AbortSignal }).signal.aborted).toBe(true);
    finish(task);
    await pending;
    expect(commands.submit).not.toHaveBeenCalled();
    expect(render().selection).toBeNull();
    expect(render().source).toBeNull();
  });

  it('retains the destination menu when a source read fails and permits a fresh choice', async () => {
    const controller = await open();
    read.mockRejectedValueOnce(new Error('couldn’t read this task.'));
    await controller.choose({ list, position: 'last' });
    expect(commands.submit).not.toHaveBeenCalled();
    expect(render().selection?.task.id).toBe(task.id);
    expect(render().sourceLoading).toBe(false);
    expect(render().error).toBe('couldn’t read this task.');
    await render().choose({ list, position: 'last' });
    expect(commands.submit).toHaveBeenCalledOnce();
  });

  it('uses the latest menu callback after the move submenu has closed', async () => {
    let finish!: (result: { state: string }) => void;
    commands.submit.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const controller = await open();
    const saving = controller.choose({ list, position: 'last' });
    await settle();
    expect(commands.submit).toHaveBeenCalledOnce();
    controller.close();
    const latest = vi.fn();
    render(latest);
    finish({ state: 'succeeded' });
    await saving;
    expect(moved).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledExactlyOnceWith(task.id);
  });

  it.each([null, { state: 'failed' }])(
    'keeps the source menu when a move is unconfirmed: %j',
    async (result) => {
      commands.submit.mockResolvedValue(result);
      const controller = await open();
      await controller.choose({ list, position: 'last' });
      expect(moved).not.toHaveBeenCalled();
      expect(render().selection?.task.id).toBe(task.id);
      expect(notice).toHaveBeenCalledOnce();
    },
  );

  it('also closes a menu for a server-confirmed no-op receipt', async () => {
    commands.submit.mockResolvedValue({ state: 'succeeded', confirmedSteps: 0 });
    const controller = await open();
    await controller.choose({ list: { ...list, id: task.listId }, position: 'first' });
    expect(moved).toHaveBeenCalledExactlyOnceWith(task.id);
  });
});
