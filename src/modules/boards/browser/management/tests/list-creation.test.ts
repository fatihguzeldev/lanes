import { describe, expect, it, vi } from 'vitest';
import type { Board } from '../../../contracts/board';
import { captureListCreation, listCreationRejected } from '../list-creation';

const board: Board = {
  id: 'board',
  accountId: 'account',
  title: 'reading',
  isMain: true,
  emoji: null,
  color: '#f1f0e9',
  backgroundUrl: null,
  position: 0,
  revision: 2,
  createdAt: '2026-11-05T12:00:00Z',
};
describe('inline list admission', () => {
  it('captures a valid destination before allocating retry identity', () => {
    const identity = vi.fn(() => 'identity');
    expect(captureListCreation(board, '  articles  ', identity)).toEqual({
      accountId: board.accountId,
      identity: 'identity',
      command: { kind: 'list.create', title: 'articles', boardId: board.id, boardRevision: 2 },
    });
    identity.mockClear();
    expect(() => captureListCreation(board, ' ', identity)).toThrow();
    expect(identity).not.toHaveBeenCalled();
  });
  it('preserves a partially created list instead of issuing another google creation', () => {
    expect(
      listCreationRejected({ state: 'failed', finished: true, confirmedSteps: 1 }, undefined, true),
    ).toBe(false);
    expect(
      listCreationRejected({ state: 'failed', finished: true, confirmedSteps: 0 }, undefined, true),
    ).toBe(true);
    expect(listCreationRejected(null, 'server_unavailable', true)).toBe(false);
    expect(listCreationRejected(null, 'conflict', false)).toBe(true);
  });
});
