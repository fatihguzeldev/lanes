import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoardCreation } from '../useBoardCreation';

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

function render() {
  harness.cursor = 0;
  return useBoardCreation({
    accountId: 'account',
    clockOffset: 0,
    onChanged: vi.fn(),
    onNotice: vi.fn(),
    onInspect: vi.fn(),
  });
}

describe('board entry completion', () => {
  beforeEach(() => {
    harness.cursor = 0;
    harness.slots = [];
    command.busy = false;
    command.error = '';
    command.errorDetails = null;
    command.latest = null;
    command.submit.mockReset();
    command.clearError.mockReset();
    command.submit.mockResolvedValue({ state: 'succeeded' });
  });

  it('opens a blank name and leaves an empty entry without creating a board', async () => {
    render().show();
    let entry = render();
    expect(entry).toMatchObject({ open: true, title: '', dirty: false });
    entry.change('   ');
    await render().finish();
    entry = render();
    expect(entry).toMatchObject({ open: false, title: '', dirty: false });
    expect(command.submit).not.toHaveBeenCalled();
  });

  it('commits a nonblank name on blur and does not double-submit a following Enter', async () => {
    let finish!: (value: { state: string }) => void;
    command.submit.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render().show();
    render().change('  reading  ');
    const entry = render();
    const pending = entry.finish();
    expect(entry.isSaving()).toBe(true);
    await entry.save();
    expect(command.submit).toHaveBeenCalledOnce();
    expect(command.submit.mock.calls[0]).toMatchObject([
      { kind: 'board.create', input: { title: 'reading' } },
      'local',
      'creation-identity',
    ]);
    finish({ state: 'succeeded' });
    await pending;
    expect(render()).toMatchObject({ open: false, title: '', locked: false, dirty: false });
    expect(entry.isSaving()).toBe(false);
  });

  it('retains an uncertain name and identity without retrying on every blur', async () => {
    command.submit.mockResolvedValue(null);
    render().show();
    render().change('reading');
    await render().finish();
    command.error = 'connection lost';
    command.errorDetails = { code: 'server_unavailable', operationId: 'creation-identity' };
    let entry = render();
    expect(entry).toMatchObject({ open: true, title: 'reading', locked: true });
    await entry.finish();
    expect(command.submit).toHaveBeenCalledOnce();
    command.submit.mockResolvedValue({ state: 'succeeded' });
    await entry.save();
    expect(command.submit.mock.calls[1]).toEqual(command.submit.mock.calls[0]);
    entry = render();
    expect(entry).toMatchObject({ open: false, title: '' });
  });

  it('keeps a rejected name editable and waits for an edit or explicit retry', async () => {
    command.submit.mockResolvedValue(null);
    render().show();
    render().change('reading');
    await render().finish();
    command.error = 'check the name';
    command.errorDetails = { code: 'validation_failed' };
    let entry = render();
    expect(entry).toMatchObject({ open: true, title: 'reading', locked: false });
    await entry.finish();
    expect(command.submit).toHaveBeenCalledOnce();
    entry.change('books');
    command.error = '';
    entry = render();
    command.submit.mockResolvedValue({ state: 'succeeded' });
    await entry.finish();
    expect(command.submit).toHaveBeenCalledTimes(2);
    expect(command.submit.mock.calls[1]?.[0]).toMatchObject({
      kind: 'board.create',
      input: { title: 'books' },
    });
  });
});
