import { describe, expect, it } from 'vitest';
import { boardCreationRejected, captureBoardCreation } from '../board-creation';

describe('inline board creation', () => {
  it('captures a trimmed board name before allocating its retry identity', () => {
    const captured = captureBoardCreation('  reading  ', () => 'same-attempt');
    expect(captured).toMatchObject({
      identity: 'same-attempt',
      command: { kind: 'board.create', input: { title: 'reading' } },
    });
    let allocated = false;
    expect(() =>
      captureBoardCreation(' ', () => {
        allocated = true;
        return 'unused';
      }),
    ).toThrow('enter a board name');
    expect(allocated).toBe(false);
  });
  it('keeps the same command and identity for an ambiguous retry', () => {
    expect(
      boardCreationRejected(
        { state: 'cancelled', finished: true, confirmedSteps: 0 },
        undefined,
        true,
      ),
    ).toBe(true);
    expect(
      boardCreationRejected(
        { state: 'cancelled', finished: true, confirmedSteps: 1 },
        undefined,
        true,
      ),
    ).toBe(false);
    expect(boardCreationRejected(null, 'server_unavailable', true)).toBe(false);
    expect(
      boardCreationRejected(
        { state: 'uncertain', finished: false, confirmedSteps: 0 },
        'outcome_uncertain',
        true,
      ),
    ).toBe(false);
    expect(boardCreationRejected(null, 'conflict', true)).toBe(false);
    expect(boardCreationRejected(null, 'connection_paused', false)).toBe(true);
    expect(
      boardCreationRejected(
        { state: 'failed', finished: true, confirmedSteps: 0 },
        undefined,
        true,
      ),
    ).toBe(true);
    expect(
      boardCreationRejected(
        { state: 'failed', finished: true, confirmedSteps: 1 },
        undefined,
        true,
      ),
    ).toBe(false);
  });
});
