import { beforeEach, expect, it, vi } from 'vitest';
import type { BoardList } from '../../../contracts/board';
import { BoardColumnData } from '../BoardColumnData';

const state = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  cursor: 0,
  effects: [] as Array<() => void>,
  query: vi.fn(),
}));
vi.mock('react', () => ({
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => (state.refs[state.cursor++] ??= { current }),
  useEffect: (effect: () => void) => state.effects.push(effect),
}));
vi.mock('../../../../tasks/browser/queries/useTaskQuery', () => ({ useTaskQuery: state.query }));

const list = { id: 'list', accountId: 'account', color: '#123456' } as BoardList;
const props = () => ({
  accountId: 'account',
  list,
  filter: {},
  query: '',
  sort: 'manual' as const,
  version: 8,
  completedRequested: false,
  discoverCompleted: true,
  onData: vi.fn(),
  onActions: vi.fn(),
  onReady: vi.fn(),
});
const query = () => ({
  page: {
    items: [],
    matchedTaskIds: [],
    orderReadyTaskIds: [],
    orderReadyListIds: ['list'],
    subtaskSummaries: {},
    coverage: { complete: true, stale: false, lastSyncedAt: null },
    providerCoverage: { complete: true, stale: false, lastSyncedAt: null },
    nextCursor: null as string | null,
  },
  status: 'ready',
  settled: true,
  loaded: true,
  error: '',
  loadMore: vi.fn(async () => {}),
  reload: vi.fn(async () => {}),
});
function render(
  options: Parameters<typeof BoardColumnData>[0],
  open = query(),
  completed = query(),
) {
  state.cursor = 0;
  state.effects = [];
  state.query.mockReset().mockReturnValueOnce(open).mockReturnValueOnce(completed);
  BoardColumnData(options);
  state.effects.forEach((effect) => effect());
}
beforeEach(() => {
  state.refs = [];
});

it('publishes a coherent column read only after its open and completed queries settle', () => {
  const options = props();
  const completed = { ...query(), settled: false };
  render(options, query(), completed);
  expect(state.query.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ['account', { listIds: ['list'], query: '', sort: 'manual', filter: { completion: 'open' } }],
    [
      'account',
      { listIds: ['list'], query: '', sort: 'manual', filter: { completion: 'completed' } },
    ],
  ]);
  expect(options.onData).toHaveBeenLastCalledWith(
    'list',
    expect.objectContaining({ readVersion: undefined }),
  );
  expect(options.onReady).toHaveBeenLastCalledWith(
    'list',
    expect.objectContaining({ version: 8, settled: false }),
  );
  render(options);
  expect(options.onData).toHaveBeenLastCalledWith(
    'list',
    expect.objectContaining({ readVersion: 8, color: '#123456' }),
  );
  expect(options.onReady).toHaveBeenLastCalledWith(
    'list',
    expect.objectContaining({ version: 8, settled: true }),
  );
});

it('does not wait for an undiscovered completed section or start its query', () => {
  const options = { ...props(), discoverCompleted: false };
  render(options, query(), { ...query(), status: 'loading', settled: false, loaded: false });
  expect(state.query.mock.calls[1]![1]).toBeNull();
  expect(options.onData).toHaveBeenLastCalledWith(
    'list',
    expect.objectContaining({ readVersion: 8 }),
  );
  expect(options.onReady).toHaveBeenLastCalledWith(
    'list',
    expect.objectContaining({ settled: true }),
  );
});

it('keeps published pagination actions attached to the current query after refresh', async () => {
  const options = props();
  render(options);
  const actions = options.onActions.mock.calls[0]![1];
  const open = query();
  const completed = query();
  completed.page.nextCursor = 'next';
  render({ ...options, version: 9 }, open, completed);
  await actions.open();
  await actions.completed();
  await actions.retry();
  expect(open.loadMore).toHaveBeenCalledOnce();
  expect(completed.loadMore).toHaveBeenCalledOnce();
  expect(open.reload).toHaveBeenCalledOnce();
});
