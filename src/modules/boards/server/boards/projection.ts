import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { TaskList } from '../../../tasks/contracts/task';
import type { BoardService } from './service';
import { z } from 'zod';

import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import { AppError } from '../../../../shared/contracts/errors';
import { BoardColorSchema } from '../../contracts/board';

/** Only confirmed list identity/default changes enter through this seam. */
export class BoardProjection {
  constructor(
    private readonly db: D1Database,
    private readonly boards: BoardService,
  ) {}

  async listSelection(
    accountId: string,
    boardId: string,
  ): Promise<{ sql: string; bindings: string[] }> {
    await this.boards.queries.getBoard(accountId, boardId);
    return {
      sql: 'SELECT list_id FROM boards_memberships WHERE account_id=? AND board_id=?',
      bindings: [accountId, boardId],
    };
  }

  async listContexts(
    accountId: string,
    listIds: readonly string[],
  ): Promise<{ listId: string; boardId: string; boardTitle: string }[]> {
    if (!z.array(ResourceIdSchema.max(1024)).max(100).safeParse(listIds).success)
      throw new AppError('validation_failed', 'resolve at most100 list contexts.', 400);
    if (!listIds.length) return [];
    const result = await this.db
      .prepare(
        `SELECT m.list_id AS listId,b.id AS boardId,b.title AS boardTitle
      FROM boards_memberships m JOIN boards_boards b ON b.account_id=m.account_id AND b.id=m.board_id
      WHERE m.account_id=? AND m.list_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(accountId, JSON.stringify(listIds))
      .all<{ listId: string; boardId: string; boardTitle: string }>();
    return result.results;
  }

  placementWrites(list: TaskList, defaultStatusChanged: boolean): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO boards_write_guards(valid) SELECT 0 WHERE NOT EXISTS
        (SELECT 1 FROM boards_boards WHERE account_id=? AND is_main=1)`,
        )
        .bind(list.accountId),
      this.db
        .prepare(
          `INSERT INTO boards_memberships(account_id,list_id,board_id,position)
        SELECT ?,?,b.id,COALESCE((SELECT MAX(position)+1 FROM boards_memberships WHERE account_id=? AND board_id=b.id),0)
        FROM boards_boards b WHERE b.account_id=? AND b.is_main=1
        ON CONFLICT(account_id,list_id) DO NOTHING`,
        )
        .bind(list.accountId, list.id, list.accountId, list.accountId),
      ...(list.isDefault
        ? [
            this.db
              .prepare(
                `UPDATE boards_memberships SET
        position=CASE WHEN board_id<>(SELECT id FROM boards_boards WHERE account_id=? AND is_main=1)
          THEN COALESCE((SELECT MAX(position)+1 FROM boards_memberships WHERE account_id=? AND board_id=(SELECT id FROM boards_boards WHERE account_id=? AND is_main=1)),0) ELSE position END,
        board_id=(SELECT id FROM boards_boards WHERE account_id=? AND is_main=1),revision=revision+1
        WHERE account_id=? AND list_id=? AND (?=1 OR board_id<>(SELECT id FROM boards_boards WHERE account_id=? AND is_main=1))`,
              )
              .bind(
                list.accountId,
                list.accountId,
                list.accountId,
                list.accountId,
                list.accountId,
                list.id,
                defaultStatusChanged ? 1 : 0,
                list.accountId,
              ),
          ]
        : []),
    ];
  }

  removalWrites(accountId: string, listId: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare('DELETE FROM boards_memberships WHERE account_id=? AND list_id=?')
        .bind(accountId, listId),
    ];
  }

  /** A dispatched create can settle after its custom board was removed. Keep its content in main. */
  creationWrites(
    list: TaskList,
    boardId: string,
    appearance?: { color?: string },
  ): D1PreparedStatement[] {
    const color =
      appearance?.color === undefined ? null : BoardColorSchema.safeParse(appearance.color);
    if (color && !color.success)
      throw new AppError('validation_failed', 'use a hexadecimal list color.', 400);
    return [
      ...this.placementWrites(list, false),
      this.db
        .prepare(
          `UPDATE boards_memberships SET board_id=?,position=COALESCE
        ((SELECT MAX(position)+1 FROM boards_memberships WHERE account_id=? AND board_id=? AND list_id<>?),0),revision=revision+1
        WHERE account_id=? AND list_id=? AND EXISTS(SELECT 1 FROM boards_boards WHERE account_id=? AND id=? AND is_main=0)`,
        )
        .bind(
          boardId,
          list.accountId,
          boardId,
          list.id,
          list.accountId,
          list.id,
          list.accountId,
          boardId,
        ),
      ...(color?.success
        ? [
            this.db
              .prepare(
                'UPDATE boards_memberships SET color=?,revision=revision+1 WHERE account_id=? AND list_id=?',
              )
              .bind(color.data, list.accountId, list.id),
          ]
        : []),
    ];
  }

  async appearanceSnapshot(accountId: string, listId: string): Promise<{ color: string }> {
    const membership = await this.boards.queries.getMembership(accountId, listId);
    return { color: membership.color };
  }

  targetGuard(accountId: string, boardId: string, revision?: number): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO boards_write_guards(valid) SELECT 0 WHERE NOT EXISTS
      (SELECT 1 FROM boards_boards WHERE account_id=? AND id=?${revision === undefined ? '' : ' AND revision=?'})`,
      )
      .bind(accountId, boardId, ...(revision === undefined ? [] : [revision]));
  }

  targetMissingPredicate(accountId: string, boardId: string): { sql: string; bindings: string[] } {
    return {
      sql: 'NOT EXISTS(SELECT 1 FROM boards_boards WHERE account_id=? AND id=?)',
      bindings: [accountId, boardId],
    };
  }

  async placementResult(
    accountId: string,
    listId: string,
    requestedBoardId: string,
  ): Promise<{ boardId: string; fellBack: boolean }> {
    const membership = await this.boards.queries.getMembership(accountId, listId);
    return { boardId: membership.boardId, fellBack: membership.boardId !== requestedBoardId };
  }
}
