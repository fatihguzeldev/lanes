import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board } from '../../../contracts/board';
import { useListCreation } from '../useListCreation';

const harness = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
const command = vi.hoisted(() => ({
  busy: false,
  error: '',
  errorDetails: null as { code: string; operationId?: string } | null,
  latest: null,
  submit: vi.fn(),
  clearError: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    const slot = (harness.slots[index] ??= { value: initial }) as { value: unknown };
    return [slot.value, (value: unknown) => (slot.value = value)];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    return (harness.slots[index] ??= { current: initial });
  },
  useEffect: () => undefined,
}));
vi.mock('../../../../operations/browser/submission/useCommands', () => ({
  useCommands: () => command,
}));
vi.mock('../../../../operations/browser/submission/operation-identity', () => ({
  newOperationId: () => 'creation-identity',
}));

const board: Board = {
  id: 'board',
  accountId: 'account',
  title: 'reading',
  isMain: false,
  emoji: null,
  color: '#f1f0e9',
  backgroundUrl: null,
  position: 0,
  revision: 2,
  createdAt: '2026-11-05T12:00:00Z',
};
const notice = vi.fn();
function render(currentBoard: Board | null = board) {
  harness.cursor = 0;
  return useListCreation({
    accountId: 'account',
    board: currentBoard,
    clockOffset: 0,
    onChanged: vi.fn(),
    onNotice: notice,
    onInspect: vi.fn(),
  });
}

describe('list entry completion', () => {
  beforeEach(() => {
    harness.cursor = 0;
    harness.slots = [];
    command.busy = false;
    command.error = '';
    command.errorDetails = null;
    command.latest = null;
    command.submit.mockReset();
    command.clearError.mockReset();
    notice.mockReset();
    command.submit.mockResolvedValue({ state: 'succeeded' });
  });

  it('leaves an empty name without creating a google list', async () => {
    render().show(board);
    expect(render()).toMatchObject({ open: true, boardId: board.id, title: '', dirty: false });
    render().change('  ');
    await render().finish();
    expect(command.submit).not.toHaveBeenCalled();
    expect(render()).toMatchObject({ open: false, title: '', dirty: false });
  });

  it('creates on blur with one captured command when Enter also fires', async () => {
    let finish!: (value: { state: string }) => void;
    command.submit.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render().show(board);
    render().change('  articles  ');
    const entry = render();
    const pending = entry.finish();
    expect(entry.isSaving()).toBe(true);
    await entry.save();
    expect(command.submit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'list.create', title: 'articles', boardId: board.id, boardRevision: 2 },
      'provider',
      'creation-identity',
    );
    finish({ state: 'succeeded' });
    await pending;
    expect(render()).toMatchObject({ open: false, title: '', locked: false, dirty: false });
  });

  it('retains its original target and identity after navigating away from an uncertain save', async () => {
    command.submit.mockResolvedValue(null);
    render().show(board);
    render().change('articles');
    await render().finish();
    command.error = 'connection lost';
    command.errorDetails = { code: 'server_unavailable', operationId: 'creation-identity' };
    const elsewhere = { ...board, id: 'elsewhere', revision: 10 };
    const entry = render(elsewhere);
    expect(entry).toMatchObject({ open: true, boardId: board.id, title: 'articles', locked: true });
    entry.close();
    expect(render(elsewhere)).toMatchObject({
      open: false,
      boardId: board.id,
      title: 'articles',
      locked: true,
    });
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('not been confirmed'));
    await entry.finish();
    expect(command.submit).toHaveBeenCalledOnce();
    command.submit.mockResolvedValue({ state: 'succeeded' });
    await entry.save();
    expect(command.submit.mock.calls[1]).toEqual(command.submit.mock.calls[0]);
  });

  it('refreshes the board revision only for a new attempt after confirmed rejection', async () => {
    command.submit.mockResolvedValue(null);
    render().show(board);
    render().change('articles');
    await render().finish();
    command.error = 'stale board revision';
    command.errorDetails = { code: 'conflict' };
    const entry = render({ ...board, revision: 3 });
    expect(entry.locked).toBe(false);
    await entry.finish();
    expect(command.submit).toHaveBeenCalledOnce();
    command.submit.mockResolvedValue({ state: 'succeeded' });
    await entry.save();
    expect(command.submit.mock.calls[1]?.[0]).toEqual({
      kind: 'list.create',
      title: 'articles',
      boardId: board.id,
      boardRevision: 3,
    });
  });

  it('rejects a foreign account and does not replace an unfinished board target', () => {
    render().show({ ...board, accountId: 'foreign' });
    expect(render().open).toBe(false);
    render().show(board);
    render().change('articles');
    render().show({ ...board, id: 'elsewhere' });
    expect(render().boardId).toBe(board.id);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('finish the open list entry'));
  });
});
