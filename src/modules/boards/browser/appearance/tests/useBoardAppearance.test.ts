import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, BoardList } from '../../../contracts/board';
import { useBoardAppearance } from '../useBoardAppearance';

const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  read: vi.fn(),
}));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: harness.read }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots))
      harness.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      harness.slots[index],
      (value: unknown) => {
        harness.slots[index] = typeof value === 'function' ? value(harness.slots[index]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = harness.cursor++;
    return (harness.slots[index] ??= { current: initial });
  },
  useEffect(effect: () => void) {
    harness.effects.push(effect);
  },
}));

const original: Board = {
  id: 'board',
  accountId: 'account',
  title: 'reading',
  emoji: null,
  color: '#f1f0e9',
  backgroundUrl: null,
  revision: 3,
  position: 0,
  isMain: true,
  createdAt: '2026-11-06T10:00:00Z',
};
let board: Board;
let lists: BoardList[];
const submit = vi.fn();
const notice = vi.fn();
function render() {
  harness.cursor = 0;
  harness.effects = [];
  const controller = useBoardAppearance({
    accountId: 'account',
    board,
    boards: [board],
    lists,
    submit,
    onNotice: notice,
  });
  harness.effects.forEach((effect) => effect());
  return controller;
}
beforeEach(() => {
  harness.slots = [];
  board = { ...original };
  lists = [];
  submit.mockReset();
  notice.mockReset();
  harness.read.mockReset();
  harness.read.mockImplementation(async (url: string) => {
    if (url.includes('/boards/')) return { ...board, color: '#82966f', revision: 4 };
    if (url.endsWith('/placement'))
      return { ...lists[0], membershipRevision: undefined, revision: 7 };
    return { ...lists[0], title: 'articles', revision: 4 };
  });
});

describe('immediate board appearance', () => {
  it('changes a list color locally with its membership revision and restores it on failure', async () => {
    const list: BoardList = {
      id: 'list',
      accountId: 'account',
      title: 'todo',
      providerId: 'google-list',
      providerEtag: null,
      isDefault: false,
      revision: 2,
      boardId: 'board',
      color: '#f1f0e9',
      position: 0,
      membershipRevision: 7,
    };
    lists = [list];
    let finish!: (done: boolean) => void;
    submit.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = render().updateListColor(list, '#82966f');
    expect(render().list(list).color).toBe('#82966f');
    expect(submit).toHaveBeenCalledWith(
      { kind: 'list.appearance', listId: 'list', revision: 7, color: '#82966f' },
      'local',
    );
    finish(false);
    await pending;
    await Promise.resolve();
    expect(render().list(list).color).toBe('#f1f0e9');
  });
  it('previews a background immediately and rolls back a rejected change', async () => {
    let finish!: (done: boolean) => void;
    submit.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = render().updateBoard(board, { backgroundUrl: '/backgrounds/lines.svg' });
    expect(render().board(board)?.backgroundUrl).toBe('/backgrounds/lines.svg');
    expect(render().isSaving()).toBe(true);
    expect(await render().updateBoard(board, { color: '#82966f' })).toBe(true);
    expect(render().board(board)?.color).toBe('#82966f');
    expect(submit).toHaveBeenCalledOnce();
    finish(false);
    await pending;
    await Promise.resolve();
    expect(render().board(board)?.backgroundUrl).toBeNull();
    expect(render().pending).toBe(false);
  });
  it('queues another appearance edit without waiting for the refreshed inventory', async () => {
    submit.mockResolvedValue(true);
    expect(await render().updateBoard(board, { color: '#82966f' })).toBe(true);
    expect(render().board(board)?.color).toBe('#82966f');
    expect(await render().updateBoard(board, { emoji: '🌱' })).toBe(true);
    expect(submit.mock.calls[1]?.[0]).toMatchObject({ revision: 4, input: { emoji: '🌱' } });
    board = { ...board, color: '#82966f', revision: 4 };
    render();
    expect(render().board(board)?.emoji).toBe('🌱');
  });
  it('finishes the interaction before the queued request has completed', async () => {
    let finish!: (done: boolean) => void;
    submit.mockImplementation(() => new Promise<boolean>((resolve) => (finish = resolve)));
    let captured = false;
    void render()
      .updateBoard(board, { title: 'books' })
      .then(() => (captured = true));
    await Promise.resolve();
    expect(captured).toBe(true);
    expect(render().board(board)?.title).toBe('books');
    expect(render().isSaving()).toBe(true);
    finish(true);
    await Promise.resolve();
  });
  it('does not submit unchanged fields or invalid emoji', async () => {
    expect(await render().updateBoard(board, { title: ' reading ' })).toBe(true);
    expect(await render().updateBoard(board, { emoji: 'not an emoji' })).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith('choose one emoji');
  });
  it('does not mutate a board from another account', async () => {
    expect(await render().updateBoard({ ...board, accountId: 'other' }, { color: '#82966f' })).toBe(
      false,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(render().pending).toBe(false);
  });
  it('rebases consecutive names and list colors against their own confirmed revisions', async () => {
    const source: BoardList = {
      id: 'list',
      accountId: 'account',
      title: 'todo',
      providerId: 'google-list',
      providerEtag: null,
      isDefault: false,
      revision: 2,
      boardId: 'board',
      color: '#f1f0e9',
      position: 0,
      membershipRevision: 7,
    };
    lists = [source];
    const finish: ((value: boolean) => void)[] = [];
    submit.mockImplementation(() => new Promise<boolean>((resolve) => finish.push(resolve)));
    await render().updateListTitle(source, 'articles');
    await render().updateListTitle(source, 'books');
    await render().updateListColor(source, '#82966f');
    expect(render().list(source)).toMatchObject({ title: 'books', color: '#82966f' });
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'list.rename', listId: 'list', revision: 2, title: 'articles' },
      'provider',
    );
    finish[0]!(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(submit.mock.calls[1]).toMatchObject([
      { kind: 'list.rename', listId: 'list', revision: 4, title: 'books' },
      'provider',
    ]);
    expect(harness.read).toHaveBeenCalledWith(
      '/api/accounts/account/lists/list',
      expect.anything(),
      expect.anything(),
    );
    finish[1]!(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(submit.mock.calls[2]).toMatchObject([
      { kind: 'list.appearance', listId: 'list', revision: 7, color: '#82966f' },
      'local',
    ]);
    finish[2]!(true);
    await Promise.resolve();
    expect(render().isSaving()).toBe(false);
  });
  it('drops only dependent unsent changes when a resource fails', async () => {
    const other = { ...board, id: 'other' };
    const finish: ((value: boolean) => void)[] = [];
    submit.mockImplementation(() => new Promise<boolean>((resolve) => finish.push(resolve)));
    await render().updateBoard(board, { color: '#82966f' });
    await render().updateBoard(board, { emoji: '🌱' });
    await render().updateBoard(other, { color: '#bd91a1' });
    finish[0]!(false);
    await Promise.resolve();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toMatchObject({
      boardId: 'other',
      input: { color: '#bd91a1' },
    });
    expect(render().board(board)).toEqual(board);
    expect(notice).not.toHaveBeenCalled();
    finish[1]!(true);
    await Promise.resolve();
    expect(render().board(other)?.color).toBe('#bd91a1');
  });
  it('restores the last confirmed appearance when a later change fails', async () => {
    submit.mockResolvedValueOnce(true);
    await render().updateBoard(board, { color: '#82966f' });
    let finish!: (value: boolean) => void;
    submit.mockImplementation(() => new Promise<boolean>((resolve) => (finish = resolve)));
    await render().updateBoard(board, { emoji: '🌱' });
    await render().updateBoard(board, { title: 'dependent name' });
    finish(false);
    await Promise.resolve();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(render().board(board)).toMatchObject({
      color: '#82966f',
      emoji: null,
      title: 'reading',
    });
  });
});
