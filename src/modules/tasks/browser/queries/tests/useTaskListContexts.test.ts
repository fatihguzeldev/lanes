import { beforeEach, expect, it, vi } from 'vitest';
import type { TaskList } from '../../../contracts/task';
import { useTaskListContexts } from '../useTaskListContexts';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
}));
const request = vi.hoisted(() => vi.fn());
vi.mock('../../../../../shared/browser/http/http', () => ({ request }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    const slot = (hooks.slots[index] ??= {
      value: typeof initial === 'function' ? initial() : initial,
    }) as { value: unknown };
    return [
      slot.value,
      (value: unknown) => {
        slot.value = typeof value === 'function' ? value(slot.value) : value;
      },
    ];
  },
  useRef: (current: unknown) => (hooks.slots[hooks.cursor++] ??= { current }),
  useEffect: (effect: () => void, dependencies: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as unknown[] | undefined;
    if (!previous || dependencies.some((value, offset) => value !== previous[offset])) {
      hooks.slots[index] = dependencies;
      hooks.effects.push(effect);
    }
  },
}));

const list = {
  id: 'list',
  accountId: 'account',
  title: 'work',
  providerId: 'provider',
  providerEtag: null,
  isDefault: false,
  revision: 1,
} satisfies TaskList;
function render(account = 'account', ids = ['list'], known: readonly TaskList[] = [], version = 0) {
  hooks.cursor = 0;
  hooks.effects = [];
  const result = useTaskListContexts(account, ids, version, known);
  hooks.effects.forEach((effect) => effect());
  return result;
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  hooks.slots = [];
  request.mockReset();
  request.mockResolvedValue({
    items: [list],
    contexts: [{ listId: 'list', boardId: 'other', boardTitle: 'other board' }],
  });
});

it('uses known list names immediately without another inventory or resolve read', () => {
  const value = render('account', ['list'], [list]);
  expect(value.items).toEqual([list]);
  expect(value.settled).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it('retries failed result context even when task membership and version stay unchanged', async () => {
  request.mockRejectedValueOnce(new Error('temporary failure'));
  render();
  await flush();
  const failed = render();
  expect(failed.error).toBe('temporary failure');
  expect(failed.settled).toBe(true);
  failed.retry();
  render();
  await flush();
  const recovered = render();
  expect(recovered.items).toEqual([list]);
  expect(recovered.contexts).toEqual([
    { listId: 'list', boardId: 'other', boardTitle: 'other board' },
  ]);
  expect(recovered.error).toBe('');
  expect(request).toHaveBeenCalledTimes(2);
});

it('does not expose an old account context while its new account read is pending', async () => {
  render();
  await flush();
  expect(render().items).toEqual([list]);
  request.mockImplementationOnce(() => new Promise(() => {}));
  expect(render('other').items).toEqual([]);
});

it('resolves only missing result IDs and bounds requests to 100 IDs', async () => {
  const ids = ['list', ...Array.from({ length: 101 }, (_, index) => `unknown-${index}`)];
  request.mockResolvedValue({ items: [], contexts: [] });
  render('account', ids, [list]);
  await flush();
  expect(request.mock.calls.map((call) => call[2].body.ids.length)).toEqual([100, 1]);
  expect(request.mock.calls.flatMap((call) => call[2].body.ids)).not.toContain('list');
});
