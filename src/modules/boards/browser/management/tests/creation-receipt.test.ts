import { beforeEach, expect, it, vi } from 'vitest';
import { readCreatedBoard, readCreatedList } from '../creation-receipt';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../../../../shared/browser/http/http', () => ({ request }));
const board = { id: 'created', accountId: 'account', title: 'new board' };
const list = { id: 'created', accountId: 'account', title: 'new list' };
beforeEach(() => request.mockReset());

it('reads the created board from its confirmed public receipt, never from its name', async () => {
  request.mockResolvedValueOnce({
    items: [{ kind: 'board.create', state: 'confirmed', boardId: 'created', deleted: false }],
    nextCursor: null,
  });
  request.mockResolvedValueOnce(board);
  expect(await readCreatedBoard('account', 'receipt')).toEqual(board);
  expect(request.mock.calls[1]?.[0]).toBe('/api/accounts/account/boards/created');
});

it('hydrates a created list and its actual board placement from the receipt list address', async () => {
  request.mockResolvedValueOnce({
    items: [{ kind: 'list.create', state: 'confirmed', listId: 'created', deleted: false }],
    nextCursor: null,
  });
  request.mockResolvedValueOnce(list);
  request.mockResolvedValueOnce({
    accountId: 'account',
    listId: 'created',
    boardId: 'board',
    color: '#123456',
    position: 50,
    revision: 2,
  });
  expect(await readCreatedList('account', 'receipt')).toEqual({
    ...list,
    boardId: 'board',
    color: '#123456',
    position: 50,
    membershipRevision: 2,
  });
});

it('rejects unconfirmed or foreign-account resource addresses without matching by title', async () => {
  request.mockResolvedValueOnce({
    items: [{ kind: 'board.create', state: 'accepted', boardId: 'created', deleted: false }],
    nextCursor: null,
  });
  await expect(readCreatedBoard('account', 'receipt')).rejects.toThrow('not available');
  expect(request).toHaveBeenCalledOnce();
  request.mockResolvedValueOnce({
    items: [{ kind: 'board.create', state: 'confirmed', boardId: 'created', deleted: false }],
    nextCursor: null,
  });
  request.mockResolvedValueOnce({ ...board, accountId: 'other' });
  await expect(readCreatedBoard('account', 'receipt')).rejects.toThrow('account');
});
