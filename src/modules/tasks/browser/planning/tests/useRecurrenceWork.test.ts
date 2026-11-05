import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecurrenceAdvance } from '../../../contracts/recurrence';

const boundary = vi.hoisted(() => ({
  request: vi.fn(),
  cleanups: [] as (() => void)[],
}));

vi.mock('react', () => ({
  useState: (value: unknown) => [value, () => {}],
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) boundary.cleanups.push(cleanup);
  },
}));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: boundary.request }));

import { useRecurrenceWork } from '../useRecurrenceWork';

function step(input: Partial<RecurrenceAdvance> = {}): RecurrenceAdvance {
  return {
    accountId: null,
    taskId: null,
    advanced: false,
    pending: false,
    state: 'idle',
    ...input,
  };
}

describe('recurrence work invalidation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    boundary.request.mockReset();
    boundary.cleanups = [];
  });
  afterEach(() => {
    boundary.cleanups.forEach((cleanup) => cleanup());
    vi.useRealTimers();
  });

  it('does not invalidate task reads after an idle no-op check', async () => {
    boundary.request.mockResolvedValue(step());
    const changed = vi.fn();
    await useRecurrenceWork('account-a', true, changed).run();
    expect(changed).not.toHaveBeenCalled();
  });

  it('invalidates a confirmed terminal advancement once', async () => {
    boundary.request.mockResolvedValue(step({ advanced: true, state: 'finished' }));
    const changed = vi.fn();
    await useRecurrenceWork('account-a', true, changed).run();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate reported progress again after a later idle response', async () => {
    boundary.request
      .mockResolvedValueOnce(step({ advanced: true, pending: true, state: 'pending' }))
      .mockResolvedValueOnce(step());
    const changed = vi.fn();
    const run = useRecurrenceWork('account-a', true, changed).run();
    await vi.advanceTimersByTimeAsync(350);
    await run;
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('flushes unreported progress if a later slice fails inside the debounce window', async () => {
    boundary.request
      .mockResolvedValueOnce(step({ advanced: true, pending: true, state: 'pending' }))
      .mockResolvedValueOnce(step({ advanced: true, pending: true, state: 'pending' }))
      .mockRejectedValueOnce(new Error('the next slice could not be read'));
    const changed = vi.fn();
    const run = useRecurrenceWork('account-a', true, changed).run();
    await vi.advanceTimersByTimeAsync(350);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(350);
    await run;
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate already reported progress again when a later slice fails', async () => {
    boundary.request
      .mockResolvedValueOnce(step({ advanced: true, pending: true, state: 'pending' }))
      .mockRejectedValueOnce(new Error('the next slice could not be read'));
    const changed = vi.fn();
    const run = useRecurrenceWork('account-a', true, changed).run();
    await vi.advanceTimersByTimeAsync(350);
    await run;
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('does not publish late progress after leaving the account', async () => {
    let release!: (value: RecurrenceAdvance) => void;
    boundary.request.mockImplementationOnce(
      () => new Promise<RecurrenceAdvance>((resolve) => (release = resolve)),
    );
    const changed = vi.fn();
    const run = useRecurrenceWork('account-a', true, changed).run();
    boundary.cleanups[0]!();
    release(step({ advanced: true, state: 'finished' }));
    await run;
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not flush buffered progress after cancellation', async () => {
    boundary.request.mockResolvedValue(step({ advanced: true, pending: true, state: 'pending' }));
    const changed = vi.fn();
    const run = useRecurrenceWork('account-a', true, changed).run();
    await vi.advanceTimersByTimeAsync(350);
    expect(changed).toHaveBeenCalledTimes(1);
    boundary.cleanups[0]!();
    await run;
    expect(changed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
