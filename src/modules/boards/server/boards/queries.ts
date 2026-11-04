import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import { readActiveLists, readListInventoryCoverage } from '../../../tasks/server/queries/lists';
import {
  BoardPageOptionsSchema,
  type Board,
  type BoardList,
  type BoardMembership,
  type BoardPageOptions,
} from '../../contracts/board';
import { decodeCursor, encodeCursor } from './pagination';
import type { BoardPersistence } from './persistence';
import {
  board,
  boardFields,
  membership,
  membershipFields,
  type BoardRow,
  type MembershipRow,
} from './records';
import { parse } from './validation';

const localCoverage = { complete: true, lastSyncedAt: null, stale: false } as const;

export class BoardQueries {
  constructor(
    private readonly db: D1Database,
    private readonly persistence: BoardPersistence,
  ) {}

  /** Read-only portability/preview seam; initialization remains explicit. */
  async getMainBoard(accountId: string): Promise<Board> {
    const existing = await this.persistence.first<BoardRow>(
      this.db
        .prepare(`SELECT ${boardFields} FROM boards_boards WHERE account_id=? AND is_main=1`)
        .bind(accountId),
    );
    if (!existing)
      throw new AppError('not_found', 'this account main board has not been initialized.', 404);
    return board(existing);
  }

  async getBoard(accountId: string, boardId: string): Promise<Board> {
    const row = await this.persistence.first<BoardRow>(
      this.db
        .prepare(`SELECT ${boardFields} FROM boards_boards WHERE account_id=? AND id=?`)
        .bind(accountId, boardId),
    );
    if (!row) throw new AppError('not_found', 'the board is not available in this account', 404);
    return board(row);
  }

  async listBoards(accountId: string, input: BoardPageOptions = {}): Promise<Page<Board>> {
    const options = parse(BoardPageOptionsSchema, input);
    const cursor = decodeCursor(options.cursor, { kind: 'boards', accountId });
    const rows = await this.persistence.rows<BoardRow>(
      this.db
        .prepare(
          `SELECT ${boardFields} FROM boards_boards WHERE account_id=?
      ${cursor ? 'AND (position>? OR (position=? AND id>?))' : ''} ORDER BY position,id LIMIT ?`,
        )
        .bind(
          accountId,
          ...(cursor ? [cursor.position, cursor.position, cursor.id] : []),
          options.limit + 1,
        ),
    );
    const selected = rows.slice(0, options.limit);
    const last = selected[selected.length - 1];
    return {
      items: selected.map(board),
      nextCursor:
        rows.length > options.limit && last
          ? encodeCursor({ kind: 'boards', accountId, position: last.position, id: last.id })
          : null,
      coverage: { ...localCoverage },
    };
  }

  async getMembership(accountId: string, listId: string): Promise<BoardMembership> {
    const row = await this.persistence.first<MembershipRow>(
      this.db
        .prepare(
          `SELECT ${membershipFields} FROM boards_memberships WHERE account_id=? AND list_id=?`,
        )
        .bind(accountId, listId),
    );
    if (!row) throw new AppError('not_found', 'the list is not placed in this account', 404);
    return membership(row);
  }

  async listBoardLists(
    accountId: string,
    boardId: string,
    input: BoardPageOptions = {},
  ): Promise<Page<BoardList>> {
    await this.getBoard(accountId, boardId);
    const options = parse(BoardPageOptionsSchema, input);
    const cursor = decodeCursor(options.cursor, { kind: 'lists', accountId, boardId });
    const rows = await this.persistence.rows<MembershipRow>(
      this.db
        .prepare(
          `SELECT ${membershipFields} FROM boards_memberships
      WHERE account_id=? AND board_id=? ${cursor ? 'AND (position>? OR (position=? AND list_id>?))' : ''}
      ORDER BY position,list_id LIMIT ?`,
        )
        .bind(
          accountId,
          boardId,
          ...(cursor ? [cursor.position, cursor.position, cursor.id] : []),
          options.limit + 1,
        ),
    );
    const selected = rows.slice(0, options.limit);
    const taskLists = new Map(
      (
        await readActiveLists(
          this.db,
          accountId,
          selected.map((row) => row.list_id),
        )
      ).map((list) => [list.id, list]),
    );
    const items = selected.flatMap((row): BoardList[] => {
      const list = taskLists.get(row.list_id);
      return list
        ? [
            {
              ...list,
              boardId: row.board_id,
              color: row.color,
              position: row.position,
              membershipRevision: row.revision,
            },
          ]
        : [];
    });
    const last = selected[selected.length - 1];
    const inventory = await readListInventoryCoverage(this.db, accountId);
    const missing = items.length !== selected.length;
    return {
      items,
      nextCursor:
        rows.length > options.limit && last
          ? encodeCursor({
              kind: 'lists',
              accountId,
              boardId,
              position: last.position,
              id: last.list_id,
            })
          : null,
      coverage: {
        complete: inventory.complete && !missing,
        lastSyncedAt: inventory.lastSyncedAt,
        stale: inventory.stale || missing,
      },
    };
  }
}
