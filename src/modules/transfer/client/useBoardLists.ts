import { useEffect, useState } from 'react';
import { request } from '../../../shared/browser/http/http';
import { usePagedResource } from '../../../shared/browser/resources/usePagedResource';
import { BoardListPageSchema, BoardPageSchema } from '../../boards/contracts/query';
import { accountBase, pageQuery, escaped } from './transfer-context';
export function useBoardLists(accountId: string, version = 0) {
  const [boardId, setBoardId] = useState('');
  useEffect(() => setBoardId(''), [accountId]);
  const boards = usePagedResource(
    accountId ? `${accountId}:transfer-boards` : null,
    (cursor, signal) =>
      request(`${accountBase(accountId)}/boards${pageQuery(cursor, 50)}`, BoardPageSchema, {
        signal,
      }),
    (item) => item.id,
    version,
  );
  const selectedBoard = boards.items.find(
    (board) => board.id === boardId && board.accountId === accountId,
  );
  const lists = usePagedResource(
    selectedBoard ? `${accountId}:transfer-lists:${boardId}` : null,
    (cursor, signal) =>
      request(
        `${accountBase(accountId)}/boards/${escaped(boardId)}/lists${pageQuery(cursor, 50)}`,
        BoardListPageSchema,
        { signal },
      ),
    (item) => item.id,
    version,
  );
  return {
    boardId,
    setBoardId,
    boards,
    lists,
    board: selectedBoard,
  };
}
export type BoardLists = ReturnType<typeof useBoardLists>;
export function destinationValue(resource: BoardLists, kind: 'new' | 'existing', listId: string) {
  if (kind === 'new') {
    if (!resource.board) throw new Error('choose a loaded destination board.');
    return { kind, boardId: resource.board.id, boardRevision: resource.board.revision } as const;
  }
  const list = resource.lists.items.find((list) => list.id === listId);
  if (!list) throw new Error('choose a loaded destination list.');
  return { kind, listId: list.id, revision: list.revision } as const;
}
