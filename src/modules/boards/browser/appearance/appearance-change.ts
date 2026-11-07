import {
  BoardColorSchema,
  BoardPatchSchema,
  type Board,
  type BoardList,
} from '../../contracts/board';

export function captureBoardChange(board: Board, input: unknown) {
  const parsed = BoardPatchSchema.parse(input);
  const patch = { ...parsed };
  for (const field of ['title', 'emoji', 'color', 'backgroundUrl'] as const) {
    if (patch[field] === undefined || patch[field] === board[field]) delete patch[field];
  }
  return Object.keys(patch).length
    ? { kind: 'board.update' as const, boardId: board.id, revision: board.revision, input: patch }
    : null;
}

export function captureListColor(list: BoardList, value: string) {
  const color = BoardColorSchema.parse(value);
  return color === list.color
    ? null
    : {
        kind: 'list.appearance' as const,
        listId: list.id,
        revision: list.membershipRevision,
        color,
      };
}
