import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoardCreation } from '../useBoardCreation';
import type { Board } from '../../../contracts/board';

const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  identity: 0,
}));
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
  useEffect: (effect: () => void) => harness.effects.push(effect),
}));
vi.mock('../../../../operations/browser/submission/useCommands', () => ({
  useCommands: () => command,
}));
vi.mock('../../../../operations/browser/submission/operation-identity', () => ({
  newOperationId: () => `creation-${++harness.identity}`,
}));
const reads = vi.hoisted(() => ({ board: vi.fn() }));
vi.mock('../creation-receipt', () => ({ readCreatedBoard: reads.board }));

const notice = vi.fn();
function render(
  version = 0,
  inventoryReady = true,
  observedIds: readonly string[] = [],
  knownBoards: readonly Board[] = [],
) {
  harness.cursor = 0;
  harness.effects = [];
  const result = useBoardCreation({
    accountId: 'account',
    clockOffset: 0,
    version,
    inventoryReady,
    observedIds,
    knownBoards,
    onChanged: vi.fn(),
    onNotice: notice,
    onInspect: vi.fn(),
  });
  harness.effects.forEach((effect) => effect());
  return result;
}

describe('board entry capture and background queue', () => {
  beforeEach(() => {
    harness.cursor = 0;
    harness.slots = [];
    harness.effects = [];
    harness.identity = 0;
    command.busy = false;
    command.error = '';
    command.errorDetails = null;
    command.latest = null;
    command.submit.mockReset();
    command.clearError.mockReset();
    notice.mockReset();
    command.submit.mockResolvedValue({ state: 'succeeded' });
    reads.board.mockReset();
    reads.board.mockImplementation(
      async (
        accountId: string,
        identity: string,
        _signal: AbortSignal,
        onAddress: (id: string) => void,
      ) => {
        const board = {
          id: `saved-${identity}`,
          accountId,
          title: 'created board',
          isMain: false,
          emoji: null,
          color: '#f1f0e9',
          backgroundUrl: null,
          position: 50,
          revision: 0,
          createdAt: '2026-11-09T12:00:00Z',
        };
        onAddress(board.id);
        return board;
      },
    );
  });
  const flush = async () => {
    for (let index = 0; index < 12; index++) await Promise.resolve();
  };
  it('discards an empty entry without creating anything', () => {
    render().show();
    render().change('  ');
    render().finish();
    expect(render()).toMatchObject({ open: false, title: '', dirty: false });
    expect(command.submit).not.toHaveBeenCalled();
  });
  it('retains an invalid draft and reports validation before capture', () => {
    render().show();
    render().change('x'.repeat(129));
    render().finish();
    expect(render().open).toBe(true);
    expect(render().dirty).toBe(true);
    expect(notice).toHaveBeenCalledOnce();
    expect(command.submit).not.toHaveBeenCalled();
  });
  it('closes at capture, accepts another draft, and serializes the creates', async () => {
    let complete!: (value: { state: string }) => void;
    command.submit.mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)));
    render().show();
    render().change('first');
    const entry = render();
    entry.finish();
    entry.save();
    expect(render()).toMatchObject({ open: false, title: '', dirty: false });
    expect(render().previews.map((item) => item.title)).toEqual(['first']);
    render().show();
    render().change('second');
    render().save();
    expect(render().previews.map((item) => item.title)).toEqual(['first', 'second']);
    expect(command.submit).toHaveBeenCalledOnce();
    complete({ state: 'succeeded' });
    await flush();
    expect(command.submit).toHaveBeenCalledTimes(2);
    expect(command.submit.mock.calls.map((call) => call[2])).toEqual(['creation-1', 'creation-2']);
    expect(render().isSaving()).toBe(false);
    expect(render(1, false).previews).toHaveLength(2);
    render(1);
    expect(render(1).resources.map((board) => board.id)).toEqual([
      'saved-creation-1',
      'saved-creation-2',
    ]);
    expect(render(1).previews).toHaveLength(2);
    render(1, true, ['saved-creation-1']);
    expect(render(1).previews.map((entry) => entry.identity)).toEqual(['creation-2']);
    render(1, true, ['saved-creation-2']);
    expect(render(1).previews).toHaveLength(0);
  });
  it('retains a created board’s refreshed name and appearance after leaving it beyond the first page', async () => {
    render().show();
    render().change('new board');
    render().save();
    await flush();
    const created = render().resources[0]!;
    const renamed = { ...created, title: 'renamed', color: '#abcdef', revision: 2 };
    render(1, true, [], [renamed]);
    expect(render(1).resources).toEqual([renamed]);
    expect(render(2).resources).toEqual([renamed]);
    expect(render(2).previews).toHaveLength(1);
  });
  it('retries only the missing resource read after its create receipt is confirmed', async () => {
    reads.board.mockRejectedValueOnce(new Error('could not load the created board'));
    render().show();
    render().change('new board');
    render().save();
    await flush();
    expect(render().previews[0]).toMatchObject({ state: 'failed', receiptConfirmed: true });
    render().retry('creation-1');
    await flush();
    expect(render().resources).toHaveLength(1);
    expect(command.submit).toHaveBeenCalledOnce();
    expect(reads.board.mock.calls.map((call) => call[1])).toEqual(['creation-1', 'creation-1']);
  });
  it('hands off an already observed confirmed identity even when its hydration read fails', async () => {
    reads.board.mockImplementationOnce(async (_account, _identity, _signal, onAddress) => {
      onAddress('saved-creation-1');
      throw new Error('read interrupted');
    });
    render().show();
    render().change('new board');
    render().save();
    await flush();
    render(0, true, ['saved-creation-1']);
    expect(render().previews).toEqual([]);
    expect(command.submit).toHaveBeenCalledOnce();
  });
  it('retains a failed save without replacing the next open draft', async () => {
    let complete!: (value: null) => void;
    command.submit.mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)));
    render().show();
    render().change('first');
    render().save();
    render().show();
    render().change('next draft');
    complete(null);
    await flush();
    expect(render()).toMatchObject({ open: true, title: 'next draft' });
    expect(render().previews[0]).toMatchObject({
      title: 'first',
      state: 'failed',
      identity: 'creation-1',
    });
    render().finish();
    await flush();
    expect(command.submit).toHaveBeenCalledTimes(2);
    expect(render().previews[0]!.state).toBe('failed');
  });
  it('retries only explicitly, preserving the exact original identity and input', async () => {
    command.submit.mockResolvedValueOnce(null);
    render().show();
    render().change('original');
    render().save();
    await flush();
    render().finish();
    expect(command.submit).toHaveBeenCalledOnce();
    render().retry('creation-1');
    await flush();
    expect(command.submit.mock.calls[1]).toEqual(command.submit.mock.calls[0]);
  });
  it('reopens a definitely rejected creation for correction with a fresh identity', async () => {
    command.submit.mockResolvedValueOnce({ state: 'failed', finished: true, confirmedSteps: 0 });
    render().show();
    render().change('first name');
    render().save();
    await flush();
    expect(render().previews[0]?.rejected).toBe(true);
    render().editFailed('creation-1');
    expect(render()).toMatchObject({ open: true, title: 'first name' });
    render().change('corrected name');
    render().save();
    await flush();
    expect(command.submit.mock.calls[1]?.[2]).toBe('creation-2');
  });
});
