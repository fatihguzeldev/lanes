import { beforeEach, expect, it, vi } from 'vitest';
import type { TaskPage } from '../../../contracts/query';
import { useTaskQuery } from '../useTaskQuery';
import { RequestError } from '../../../../../shared/browser/http/http';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
}));
const request = vi.hoisted(() => vi.fn());
vi.mock('../../../../../shared/browser/http/http', async (original) => ({
  ...(await original<typeof import('../../../../../shared/browser/http/http')>()),
  request,
}));
vi.mock('react', () => ({
  useCallback: (callback: unknown, dependencies: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as
      { callback: unknown; dependencies: unknown[] } | undefined;
    if (previous && dependencies.every((value, offset) => value === previous.dependencies[offset]))
      return previous.callback;
    hooks.slots[index] = { callback, dependencies };
    return callback;
  },
  useRef: (current: unknown) => (hooks.slots[hooks.cursor++] ??= { current }),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    const slot = (hooks.slots[index] ??= { value: initial }) as { value: unknown };
    return [
      slot.value,
      (value: unknown) => {
        slot.value = typeof value === 'function' ? value(slot.value) : value;
      },
    ];
  },
  useEffect: (effect: () => void, dependencies: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as unknown[] | undefined;
    if (!previous || dependencies.some((value, offset) => value !== previous[offset])) {
      hooks.slots[index] = dependencies;
      hooks.effects.push(effect);
    }
  },
}));
const input = { listIds: ['list'] };
function render(version = 0) {
  hooks.cursor = 0;
  hooks.effects = [];
  const value = useTaskQuery('account', input, version);
  hooks.effects.forEach((effect) => effect());
  return value;
}
function page(orderReadyTaskIds: string[], nextCursor: string | null = null): TaskPage {
  return {
    items: [],
    matchedTaskIds: [],
    contextTaskIds: [],
    subtaskSummaries: {},
    orderReadyTaskIds,
    nextCursor,
    coverage: { complete: false, stale: false, lastSyncedAt: null },
    providerCoverage: { complete: false, stale: false, lastSyncedAt: null },
  };
}
beforeEach(() => {
  hooks.slots = [];
  request.mockReset();
});
it('retains order proof across local pages and replaces it on a fresh read', async () => {
  request
    .mockResolvedValueOnce(page(['first'], 'next'))
    .mockResolvedValueOnce(page(['second']))
    .mockResolvedValueOnce(page([]));
  render();
  await Promise.resolve();
  await render().loadMore();
  expect(render().page.orderReadyTaskIds).toEqual(['first', 'second']);
  render(1);
  await Promise.resolve();
  expect(render(1).page.orderReadyTaskIds).toEqual([]);
  expect(render(1).settled).toBe(true);
});
it('does not treat retained order proof as a settled read while its replacement is in flight', async () => {
  request.mockResolvedValueOnce(page(['saved-task'])).mockReturnValueOnce(new Promise(() => {}));
  render();
  await Promise.resolve();
  expect(render().settled).toBe(true);
  expect(render(1).settled).toBe(false);
  expect(render(1).settled).toBe(false);
});

it('rereads a superseded initial snapshot once without exposing a transient conflict', async () => {
  request
    .mockRejectedValueOnce(new RequestError('conflict', 'the task page changed'))
    .mockResolvedValueOnce(page(['saved-task']));
  render();
  await vi.waitFor(() => expect(render().status).toBe('ready'));
  expect(request).toHaveBeenCalledTimes(2);
  expect(render().page.orderReadyTaskIds).toEqual(['saved-task']);
  expect(render().error).toBe('');
});

it('bounds snapshot retries and restarts an invalidated page without replaying its cursor', async () => {
  request.mockRejectedValue(new RequestError('conflict', 'the task page changed'));
  render();
  await vi.waitFor(() => expect(render().status).toBe('error'));
  expect(request).toHaveBeenCalledTimes(2);
  request
    .mockReset()
    .mockResolvedValueOnce(page(['first'], 'next'))
    .mockRejectedValueOnce(new RequestError('conflict', 'the task page changed'))
    .mockRejectedValueOnce(new RequestError('conflict', 'the task page changed again'));
  await render().reload();
  await render().loadMore();
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls.map((call) => call[2].body.cursor)).toEqual([
    undefined,
    'next',
    undefined,
  ]);
  expect(render().status).toBe('error');
});

it('replaces accumulated pages after a cursor conflict without exposing the transient error', async () => {
  request
    .mockResolvedValueOnce(page(['old'], 'old-cursor'))
    .mockRejectedValueOnce(new RequestError('conflict', 'the list order changed'))
    .mockResolvedValueOnce(page(['fresh'], 'new-cursor'));
  render();
  await Promise.resolve();
  await render().loadMore();
  expect(request.mock.calls.map((call) => call[2].body.cursor)).toEqual([
    undefined,
    'old-cursor',
    undefined,
  ]);
  expect(render().status).toBe('ready');
  expect(render().page.orderReadyTaskIds).toEqual(['fresh']);
  expect(render().page.nextCursor).toBe('new-cursor');
  expect(render().error).toBe('');
});

it('ignores a delayed page restart after a newer invalidation has replaced it', async () => {
  let finish!: (value: TaskPage) => void;
  request
    .mockResolvedValueOnce(page(['old'], 'old-cursor'))
    .mockRejectedValueOnce(new RequestError('conflict', 'the list order changed'))
    .mockReturnValueOnce(
      new Promise<TaskPage>((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce(page(['newer']));
  render();
  await Promise.resolve();
  const restart = render().loadMore();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  render(1);
  await Promise.resolve();
  expect(render(1).page.orderReadyTaskIds).toEqual(['newer']);
  finish(page(['obsolete']));
  await restart;
  expect(render(1).page.orderReadyTaskIds).toEqual(['newer']);
  expect(render(1).settled).toBe(true);
});

it('uses the latest scoped list proof when another page reveals pending order work', async () => {
  request
    .mockResolvedValueOnce({ ...page(['first'], 'next'), orderReadyListIds: ['list'] })
    .mockResolvedValueOnce({ ...page([]), orderReadyListIds: [] });
  render();
  await Promise.resolve();
  await render().loadMore();
  expect(render().page.orderReadyListIds).toEqual([]);
});
