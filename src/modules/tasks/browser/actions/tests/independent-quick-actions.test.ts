import { beforeEach, expect, it, vi } from 'vitest';
import type { OperationSummary } from '../../../../operations/contracts/receipt';
import { RequestError } from '../../../../../shared/browser/http/http';
import type { Task } from '../../../contracts/task';
import { useTaskActions } from '../useTaskActions';

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  read: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useState(initial: unknown) {
    const index = state.cursor++;
    if (!(index in state.slots))
      state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      state.slots[index],
      (next: unknown) => {
        state.slots[index] = typeof next === 'function' ? next(state.slots[index]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => (state.slots[state.cursor++] ??= { current: initial }),
}));
vi.mock('../../../../../shared/browser/http/http', async (original) => ({
  ...(await original<typeof import('../../../../../shared/browser/http/http')>()),
  request: state.read,
}));

const task = (id: string) =>
  ({
    id,
    accountId: 'account',
    revision: 1,
    starred: false,
    completed: false,
  }) as Task;
const receipt = (id: string) =>
  ({
    id,
    state: 'succeeded',
    confirmedSteps: 1,
    finished: true,
  }) as OperationSummary;
const onNotice = vi.fn();
function render() {
  state.cursor = 0;
  return useTaskActions(
    {
      accountId: 'account',
      submit: vi.fn(),
      confirm: vi.fn(),
      onNotice,
      onChanged: vi.fn(),
      onRepeat: vi.fn(),
      onReopen: vi.fn(),
      onTaskDeleted: vi.fn(),
      onListDeleteReady: vi.fn(),
    },
    0,
  );
}
beforeEach(() => {
  state.cursor = 0;
  state.slots = [];
  state.read.mockReset();
  onNotice.mockReset();
});

it('saves an unrelated local star while a provider completion is still unresolved', async () => {
  let finish!: (operation: OperationSummary) => void;
  state.read.mockImplementation(async (path: string, _schema, options) => {
    if (path.endsWith('/consequences')) return { revision: 1, coverageComplete: true };
    if (path.endsWith('/commands/provider'))
      return new Promise<OperationSummary>((resolve) => {
        finish = resolve;
      });
    if (path.endsWith('/commands/local')) return receipt(options.body.operationId);
    return task(path.split('/').at(-1)!);
  });
  const owner = render();
  const completion = owner.toggleComplete(task('one'), true);
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(await owner.toggleStar(task('two'), true)).toBe(true);
  expect(render().busy).toBe(true);
  finish(receipt('provider-save'));
  expect(await completion).toBe(true);
  expect(render().busy).toBe(false);
});

it('keeps each simultaneous admission error attached to its task', async () => {
  const reject = new Map<string, (failure: RequestError) => void>();
  state.read.mockImplementation(async (path: string, _schema, options) => {
    if (path.endsWith('/commands/local'))
      return new Promise((_resolve, fail) => {
        reject.set(options.body.command.taskId, fail);
      });
    return task(path.split('/').at(-1)!);
  });
  const owner = render();
  const first = owner.toggleStar(task('one'), true);
  const second = owner.toggleStar(task('two'), true);
  await vi.waitFor(() => expect(reject.size).toBe(2));
  reject.get('two')!(new RequestError('conflict', 'two changed'));
  reject.get('one')!(new RequestError('conflict', 'one changed'));
  expect(await Promise.all([first, second])).toEqual([false, false]);
  expect(onNotice.mock.calls).toEqual(
    expect.arrayContaining([
      ['one changed', null],
      ['two changed', null],
    ]),
  );
});
