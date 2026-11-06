import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, BoardList } from '../../../contracts/board';
import { useBoardAppearance } from '../useBoardAppearance';

const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
}));
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
    expect(await render().updateBoard(board, { color: '#82966f' })).toBe(false);
    expect(submit).toHaveBeenCalledOnce();
    finish(false);
    await pending;
    expect(render().board(board)?.backgroundUrl).toBeNull();
    expect(render().pending).toBe(false);
  });
  it('keeps the preview until the confirmed revision arrives before accepting another edit', async () => {
    submit.mockResolvedValue(true);
    expect(await render().updateBoard(board, { color: '#82966f' })).toBe(true);
    expect(render().board(board)?.color).toBe('#82966f');
    expect(await render().updateBoard(board, { emoji: '🌱' })).toBe(false);
    board = { ...board, color: '#82966f', revision: 4 };
    render();
    expect(render().pending).toBe(false);
    expect(await render().updateBoard(board, { emoji: '🌱' })).toBe(true);
    expect(submit.mock.calls[1]?.[0]).toMatchObject({ revision: 4, input: { emoji: '🌱' } });
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
});
