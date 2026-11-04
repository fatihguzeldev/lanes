import { useEffect, useState } from 'react';
import { request, RequestError } from '../../../shared/browser/http/http';
import { usePagedResource } from '../../../shared/browser/resources/usePagedResource';
import { BoardSchema, type Board } from '../contracts';
import { BoardListPageSchema, BoardPageSchema } from '../query-contract';
import { readStartBoard, saveStartBoard } from './view-preferences';

export function useBoardData({
  accountId,
  version,
  retainedBoard,
  onNotice,
}: {
  accountId: string;
  version: number;
  retainedBoard: Board | null;
  onNotice: (message: string) => void;
}) {
  const [boardId, setBoardId] = useState<string | null>(() => readStartBoard(accountId));
  const [startBoardId, setStartBoardId] = useState<string | null>(() => readStartBoard(accountId));
  const [resolvedBoard, setResolvedBoard] = useState<Board | null>(null);
  const [failedBoardLookup, setFailedBoardLookup] = useState<string | null>(null);
  const base = `/api/accounts/${encodeURIComponent(accountId)}`;
  const boards = usePagedResource(
    `${accountId}:boards`,
    (cursor, signal) =>
      request(
        `${base}/boards${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardPageSchema,
        { signal },
      ),
    (board) => board.id,
    version,
  );
  const board = boardId
    ? (boards.items.find((item) => item.id === boardId) ??
      (resolvedBoard?.id === boardId ? resolvedBoard : null) ??
      (retainedBoard?.id === boardId ? retainedBoard : null))
    : (boards.items.find((item) => item.isMain) ?? (retainedBoard?.isMain ? retainedBoard : null));
  useEffect(() => {
    if (!boardId) {
      setResolvedBoard(null);
      return;
    }
    const loaded = boards.items.find((item) => item.id === boardId);
    if (loaded) {
      setResolvedBoard(loaded);
      return;
    }
    const controller = new AbortController();
    setFailedBoardLookup(null);
    void request(`${base}/boards/${encodeURIComponent(boardId)}`, BoardSchema, {
      signal: controller.signal,
    })
      .then(setResolvedBoard)
      .catch((error) => {
        if (controller.signal.aborted) return;
        setFailedBoardLookup(boardId);
        if (error instanceof RequestError && error.code === 'not_found') {
          setBoardId(null);
          if (startBoardId === boardId) {
            saveStartBoard(accountId, null);
            setStartBoardId(null);
          }
          onNotice('that board is no longer available. opening the main board.');
        } else onNotice(error instanceof Error ? error.message : 'this board could not load.');
      });
    return () => controller.abort();
  }, [base, boardId, boards.items, version, startBoardId, accountId, onNotice]);
  const lists = usePagedResource(
    board ? `${accountId}:${board.id}:lists` : null,
    (cursor, signal) =>
      request(
        `${base}/boards/${encodeURIComponent(board!.id)}/lists${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardListPageSchema,
        { signal },
      ),
    (list) => list.id,
    version,
  );
  return {
    boards,
    board,
    lists,
    boardId,
    startBoardId,
    failedBoardLookup,
    selectBoardId: setBoardId,
    selectBoard(item: Board) {
      setBoardId(item.id);
      setResolvedBoard(item);
    },
    setStartBoard(id: string | null) {
      saveStartBoard(accountId, id);
      setStartBoardId(id);
    },
  };
}
