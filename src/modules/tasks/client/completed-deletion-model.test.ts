import { describe, expect, it } from 'vitest';
import {
  completedDeletionAcknowledged,
  mayAdvanceCompletedDeletion,
} from './completed-deletion-model';

describe('completed deletion confirmation', () => {
  it('requires a real nonempty selection and explicit deletion confirmation', () => {
    const counts = { totalDeleteCount: 3, openDescendantCount: 0, assignedTaskCount: 0 };
    expect(
      completedDeletionAcknowledged(counts, {
        permanent: false,
        openChildren: false,
        assignments: false,
      }),
    ).toBe(false);
    expect(
      completedDeletionAcknowledged(counts, {
        permanent: true,
        openChildren: false,
        assignments: false,
      }),
    ).toBe(true);
    expect(
      completedDeletionAcknowledged(
        { ...counts, totalDeleteCount: 0 },
        { permanent: true, openChildren: true, assignments: true },
      ),
    ).toBe(false);
  });
  it('requires separate acknowledgement for open descendants and source assignments', () => {
    const counts = { totalDeleteCount: 7, openDescendantCount: 2, assignedTaskCount: 1 };
    expect(
      completedDeletionAcknowledged(counts, {
        permanent: true,
        openChildren: false,
        assignments: true,
      }),
    ).toBe(false);
    expect(
      completedDeletionAcknowledged(counts, {
        permanent: true,
        openChildren: true,
        assignments: false,
      }),
    ).toBe(false);
    expect(
      completedDeletionAcknowledged(counts, {
        permanent: true,
        openChildren: true,
        assignments: true,
      }),
    ).toBe(true);
  });
});

describe('completed deletion continuation', () => {
  const now = 1_800_000_000_000;
  const running = {
    state: 'running' as const,
    finished: false,
    inputSealed: true,
    cancelRequested: false,
    nextAttemptAt: null,
  };
  it('continues only sealed admitted work whose next attempt is due', () => {
    expect(mayAdvanceCompletedDeletion(running, now)).toBe(true);
    expect(mayAdvanceCompletedDeletion({ ...running, inputSealed: false }, now)).toBe(false);
    expect(mayAdvanceCompletedDeletion({ ...running, nextAttemptAt: now + 60_000 }, now)).toBe(
      false,
    );
    expect(
      mayAdvanceCompletedDeletion({ ...running, state: 'succeeded', finished: true }, now),
    ).toBe(false);
  });
  it('stops on uncertain, reconnect and quota states instead of blindly retrying', () => {
    for (const state of [
      'uncertain',
      'reconnect_required',
      'blocked_by_limit',
      'failed',
      'cancelled',
    ] as const)
      expect(mayAdvanceCompletedDeletion({ ...running, state }, now)).toBe(false);
  });
});
