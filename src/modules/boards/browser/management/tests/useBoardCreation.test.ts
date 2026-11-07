import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoardCreation } from '../useBoardCreation';

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

const notice = vi.fn();
function render(version = 0, inventoryReady = true) {
  harness.cursor = 0;
  harness.effects = [];
  const result = useBoardCreation({
    accountId: 'account',
    clockOffset: 0,
    version,
    inventoryReady,
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
  });
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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
    expect(render(1).previews).toHaveLength(0);
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
