import { request } from '../../../../shared/browser/http/http';
import {
  OperationStepPageSchema,
  type OperationStepSummary,
} from '../../../operations/contracts/receipt';
import type { Page } from '../../../../shared/contracts/http';
import { TaskListSchema } from '../../../tasks/contracts/task';
import { BoardMembershipSchema, BoardSchema, type BoardList } from '../../contracts/board';

async function createdAddress(
  accountId: string,
  operationId: string,
  kind: 'board' | 'list',
  signal?: AbortSignal,
) {
  const base = `/api/accounts/${encodeURIComponent(accountId)}/operations/${encodeURIComponent(operationId)}/steps`;
  let cursor: string | null = null;
  const visited = new Set<string>();
  do {
    const page: Page<OperationStepSummary> = await request(
      `${base}${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
      OperationStepPageSchema,
      signal ? { signal } : {},
    );
    const created = page.items.find(
      (step) =>
        step.kind === `${kind}.create` &&
        step.state === 'confirmed' &&
        !step.deleted &&
        (kind === 'board' ? step.boardId : step.listId),
    );
    const id = kind === 'board' ? created?.boardId : created?.listId;
    if (id) return id;
    cursor = page.nextCursor;
    if (cursor && visited.has(cursor))
      throw new Error('the saved item’s receipt could not be read.');
    if (cursor) visited.add(cursor);
  } while (cursor);
  throw new Error(
    'the saved item’s address is not available yet. check its save before trying again.',
  );
}

export async function readCreatedBoard(
  accountId: string,
  operationId: string,
  signal?: AbortSignal,
  onAddress?: (id: string) => void,
) {
  const id = await createdAddress(accountId, operationId, 'board', signal);
  onAddress?.(id);
  const board = await request(
    `/api/accounts/${encodeURIComponent(accountId)}/boards/${encodeURIComponent(id)}`,
    BoardSchema,
    signal ? { signal } : {},
  );
  if (board.accountId !== accountId || board.id !== id)
    throw new Error('the saved board’s account could not be verified.');
  return board;
}

export async function readCreatedList(
  accountId: string,
  operationId: string,
  signal?: AbortSignal,
  onAddress?: (id: string) => void,
): Promise<BoardList> {
  const id = await createdAddress(accountId, operationId, 'list', signal);
  onAddress?.(id);
  const base = `/api/accounts/${encodeURIComponent(accountId)}/lists/${encodeURIComponent(id)}`;
  const options = signal ? { signal } : {};
  const [list, placement] = await Promise.all([
    request(base, TaskListSchema, options),
    request(`${base}/placement`, BoardMembershipSchema, options),
  ]);
  if (
    list.accountId !== accountId ||
    list.id !== id ||
    placement.accountId !== accountId ||
    placement.listId !== id
  )
    throw new Error('the saved list’s account could not be verified.');
  return {
    ...list,
    boardId: placement.boardId,
    color: placement.color,
    position: placement.position,
    membershipRevision: placement.revision,
  };
}
