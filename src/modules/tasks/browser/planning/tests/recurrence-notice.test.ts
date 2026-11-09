import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, request: vi.fn() }));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = initial;
    return [state.slots[index], (next: unknown) => (state.slots[index] = next)];
  },
  useRef: (current: unknown) => {
    const index = state.cursor++;
    return (state.slots[index] ??= { current });
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
}));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: state.request }));

import { useRecurrenceWork } from '../useRecurrenceWork';

function render() {
  state.cursor = 0;
  return useRecurrenceWork('account-a', true, () => {});
}

describe('recurrence failure notice', () => {
  beforeEach(() => {
    state.slots = [];
    state.cursor = 0;
    state.request.mockReset();
  });

  it('dismisses a failed background check without submitting more work', async () => {
    state.request.mockRejectedValueOnce(new Error('could not check repeating tasks'));
    await render().run();
    const failed = render();
    expect(failed.error).toBe('could not check repeating tasks');
    failed.clearError();
    expect(render().error).toBe('');
    expect(state.request).toHaveBeenCalledTimes(1);
  });

  it('can report a later failure after the previous notice was dismissed', async () => {
    state.request.mockRejectedValueOnce(new Error('first check failed'));
    await render().run();
    render().clearError();
    state.request.mockRejectedValueOnce(new Error('next check failed'));
    await render().run();
    expect(render().error).toBe('next check failed');
  });
});
