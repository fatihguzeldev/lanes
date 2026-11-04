import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import { readActiveList } from '../../../tasks/server/queries/lists';
import {
  BoardAppearanceSchema,
  BoardColorSchema,
  BoardPatchSchema,
  CreateBoardSchema,
  type Board,
  type BoardAppearance,
  type BoardMembership,
  type BoardPatch,
  type CreateBoardInput,
  type DeleteBoardResult,
} from '../../contracts/board';
import type { BoardServiceOptions } from './context';
import { BoardPersistence } from './persistence';
import { BoardQueries } from './queries';
import { board, boardFields, type BoardRow } from './records';
import { parse, positionSchema, revisionSchema } from './validation';

export class BoardService {
  private readonly persistence: BoardPersistence;
  readonly queries: BoardQueries;
  constructor(
    private readonly db: D1Database,
    private readonly options: BoardServiceOptions,
  ) {
    this.persistence = new BoardPersistence(db, options);
    this.queries = new BoardQueries(db, this.persistence);
  }

  private async checkBoardRevision(
    accountId: string,
    boardId: string,
    expectedRevision: number,
  ): Promise<Board> {
    const current = await this.queries.getBoard(accountId, boardId);
    if (current.revision !== expectedRevision)
      throw new AppError(
        'conflict',
        'the board changed; refresh before applying this edit',
        409,
        false,
        { revision: String(current.revision) },
      );
    return current;
  }

  private async checkMembershipRevision(
    accountId: string,
    listId: string,
    expectedRevision: number,
  ): Promise<BoardMembership> {
    const current = await this.queries.getMembership(accountId, listId);
    if (current.revision !== expectedRevision)
      throw new AppError(
        'conflict',
        'the list placement changed; refresh before moving it',
        409,
        false,
        { membershipRevision: String(current.revision) },
      );
    return current;
  }

  async ensureMainBoard(accountId: string): Promise<Board> {
    const existing = await this.persistence.first<BoardRow>(
      this.db
        .prepare(`SELECT ${boardFields} FROM boards_boards WHERE account_id=? AND is_main=1`)
        .bind(accountId),
    );
    if (existing) return board(existing);
    await this.options.assertLocalWritable(accountId);
    try {
      await this.db
        .prepare(
          `INSERT INTO boards_boards(id,account_id,title,is_main,color,position,revision,created_at)
        SELECT ?,?,'everyday',1,'#f1f0e9',
          COALESCE((SELECT MIN(position)-1 FROM boards_boards WHERE account_id=?),0),0,?
        WHERE NOT EXISTS (SELECT 1 FROM boards_boards WHERE account_id=? AND is_main=1)`,
        )
        .bind(crypto.randomUUID(), accountId, accountId, Date.now(), accountId)
        .run();
    } catch {
      throw new AppError(
        'storage_unavailable',
        'the main board could not be initialized',
        503,
        true,
      );
    }
    const created = await this.persistence.first<BoardRow>(
      this.db
        .prepare(`SELECT ${boardFields} FROM boards_boards WHERE account_id=? AND is_main=1`)
        .bind(accountId),
    );
    if (!created)
      throw new AppError(
        'storage_unavailable',
        'the main board could not be initialized',
        503,
        true,
      );
    return board(created);
  }

  /** Prepare an admitted local container step; its caller owns the atomic journal
   * claim/account fence. This creates no board until those writes are committed. */
  async prepareCreateBoard(
    accountId: string,
    input: CreateBoardInput,
    admittedId: string,
  ): Promise<{ writes: D1PreparedStatement[]; boardId: string }> {
    const value = parse(CreateBoardSchema, input);
    await this.options.assertLocalWritable(accountId);
    await this.ensureMainBoard(accountId);
    const boardId = parse(ResourceIdSchema, admittedId);
    return {
      boardId,
      writes: [
        this.db
          .prepare(
            `INSERT INTO boards_boards(id,account_id,title,is_main,emoji,color,background_url,position,revision,created_at)
      SELECT ?,?,?,0,?,?,?,COALESCE(MAX(position)+1,0),0,? FROM boards_boards WHERE account_id=?`,
          )
          .bind(
            boardId,
            accountId,
            value.title,
            value.emoji,
            value.color,
            value.backgroundUrl,
            Date.now(),
            accountId,
          ),
      ],
    };
  }

  async createBoard(
    accountId: string,
    input: CreateBoardInput,
    admittedId?: string,
  ): Promise<Board> {
    const prepared = await this.prepareCreateBoard(
      accountId,
      input,
      admittedId ?? crypto.randomUUID(),
    );
    await this.persistence.batch(prepared.writes, async () => {
      const existing = await this.persistence.first<BoardRow>(
        this.db
          .prepare(`SELECT ${boardFields} FROM boards_boards WHERE account_id=? AND id=?`)
          .bind(accountId, prepared.boardId),
      );
      if (existing)
        throw new AppError('conflict', 'the admitted board identity is already in use', 409);
    });
    return this.queries.getBoard(accountId, prepared.boardId);
  }

  async updateBoard(
    accountId: string,
    boardId: string,
    input: BoardPatch,
    expectedRevision: number,
  ): Promise<Board> {
    const patch = parse(BoardPatchSchema, input);
    const revision = parse(revisionSchema, expectedRevision);
    await this.options.assertLocalWritable(accountId);
    await this.checkBoardRevision(accountId, boardId, revision);
    const columns = {
      title: 'title',
      emoji: 'emoji',
      color: 'color',
      backgroundUrl: 'background_url',
    } as const;
    const fields = (Object.keys(columns) as (keyof typeof columns)[]).filter(
      (field) => patch[field] !== undefined,
    );
    await this.persistence.batch(
      [
        this.persistence.boardGuard(accountId, boardId, revision),
        this.db
          .prepare(
            `UPDATE boards_boards SET ${fields.map((field) => `${columns[field]}=?`).join(',')},revision=revision+1 WHERE account_id=? AND id=? AND revision=?`,
          )
          .bind(...fields.map((field) => patch[field] ?? null), accountId, boardId, revision),
      ],
      async () => {
        await this.checkBoardRevision(accountId, boardId, revision);
      },
    );
    return this.queries.getBoard(accountId, boardId);
  }

  async renameBoard(
    accountId: string,
    boardId: string,
    title: string,
    expectedRevision: number,
  ): Promise<Board> {
    return this.updateBoard(accountId, boardId, { title }, expectedRevision);
  }

  async updateAppearance(
    accountId: string,
    boardId: string,
    appearance: BoardAppearance,
    expectedRevision: number,
  ): Promise<Board> {
    return this.updateBoard(
      accountId,
      boardId,
      parse(BoardAppearanceSchema, appearance),
      expectedRevision,
    );
  }

  /** Position is a zero-based insertion index; a larger index appends. */
  async reorderBoard(
    accountId: string,
    boardId: string,
    expectedRevision: number,
    position: number,
  ): Promise<Board> {
    const revision = parse(revisionSchema, expectedRevision);
    const index = parse(positionSchema, position);
    await this.options.assertLocalWritable(accountId);
    await this.checkBoardRevision(accountId, boardId, revision);
    await this.persistence.batch(
      [
        this.persistence.boardGuard(accountId, boardId, revision),
        this.db
          .prepare(
            `WITH others AS MATERIALIZED (
          SELECT id,ROW_NUMBER() OVER (ORDER BY position,id)-1 AS ordinal FROM boards_boards WHERE account_id=? AND id<>?
        ), insertion AS MATERIALIZED (SELECT MIN(?,COUNT(*)) AS ordinal FROM others),
        placement AS MATERIALIZED (
          SELECT id,ordinal+CASE WHEN ordinal>=(SELECT ordinal FROM insertion) THEN 1 ELSE 0 END AS target_position FROM others
          UNION ALL SELECT ?,(SELECT ordinal FROM insertion)
        )
        UPDATE boards_boards SET position=(SELECT target_position FROM placement WHERE placement.id=boards_boards.id),revision=revision+1
        WHERE account_id=? AND id IN (SELECT id FROM placement)
          AND (id=? OR position<>(SELECT target_position FROM placement WHERE placement.id=boards_boards.id))`,
          )
          .bind(accountId, boardId, index, boardId, accountId, boardId),
      ],
      async () => {
        await this.checkBoardRevision(accountId, boardId, revision);
      },
    );
    return this.queries.getBoard(accountId, boardId);
  }

  async moveList(
    accountId: string,
    listId: string,
    targetBoardId: string,
    expectedMembershipRevision: number,
    position?: number,
  ): Promise<BoardMembership> {
    const revision = parse(revisionSchema, expectedMembershipRevision);
    const index = position === undefined ? null : parse(positionSchema, position);
    await this.options.assertLocalWritable(accountId);
    const list = await readActiveList(this.db, accountId, listId);
    if (!list) throw new AppError('not_found', 'the list is not available in this account', 404);
    const target = await this.queries.getBoard(accountId, targetBoardId);
    if (list.isDefault && !target.isMain)
      throw new AppError(
        'validation_failed',
        'the default google list must stay on the main board',
        422,
        false,
        { boardId: 'choose the main board' },
      );
    await this.checkMembershipRevision(accountId, listId, revision);
    await this.persistence.batch(
      [
        this.persistence.assertBatch(
          `SELECT 1 FROM boards_memberships AS membership
        WHERE membership.account_id=? AND membership.list_id=? AND membership.revision=?
          AND EXISTS (SELECT 1 FROM boards_boards WHERE account_id=? AND id=?)`,
          [accountId, listId, revision, accountId, targetBoardId],
        ),
        this.db
          .prepare(
            `WITH others AS MATERIALIZED (
          SELECT list_id,ROW_NUMBER() OVER (ORDER BY position,list_id)-1 AS ordinal FROM boards_memberships
          WHERE account_id=? AND board_id=? AND list_id<>?
        ), insertion AS MATERIALIZED (SELECT MIN(COALESCE(?,COUNT(*)),COUNT(*)) AS ordinal FROM others),
        placement AS MATERIALIZED (
          SELECT list_id,ordinal+CASE WHEN ordinal>=(SELECT ordinal FROM insertion) THEN 1 ELSE 0 END AS target_position FROM others
          UNION ALL SELECT ?,(SELECT ordinal FROM insertion)
        )
        UPDATE boards_memberships SET board_id=?,position=(SELECT target_position FROM placement WHERE placement.list_id=boards_memberships.list_id),revision=revision+1
        WHERE account_id=? AND list_id IN (SELECT list_id FROM placement)
          AND (list_id=? OR position<>(SELECT target_position FROM placement WHERE placement.list_id=boards_memberships.list_id))`,
          )
          .bind(accountId, targetBoardId, listId, index, listId, targetBoardId, accountId, listId),
      ],
      async () => {
        await this.checkMembershipRevision(accountId, listId, revision);
        await this.queries.getBoard(accountId, targetBoardId);
      },
    );
    return this.queries.getMembership(accountId, listId);
  }

  async updateListAppearance(
    accountId: string,
    listId: string,
    color: string,
    expectedMembershipRevision: number,
  ): Promise<BoardMembership> {
    const value = parse(BoardColorSchema, color);
    const revision = parse(revisionSchema, expectedMembershipRevision);
    await this.options.assertLocalWritable(accountId);
    if (!(await readActiveList(this.db, accountId, listId)))
      throw new AppError('not_found', 'the list is not available in this account', 404);
    await this.checkMembershipRevision(accountId, listId, revision);
    await this.persistence.batch(
      [
        this.persistence.assertBatch(
          'SELECT 1 FROM boards_memberships WHERE account_id=? AND list_id=? AND revision=?',
          [accountId, listId, revision],
        ),
        this.db
          .prepare(
            'UPDATE boards_memberships SET color=?,revision=revision+1 WHERE account_id=? AND list_id=? AND revision=?',
          )
          .bind(value, accountId, listId, revision),
      ],
      async () => {
        await this.checkMembershipRevision(accountId, listId, revision);
      },
    );
    return this.queries.getMembership(accountId, listId);
  }

  async deleteBoard(
    accountId: string,
    boardId: string,
    expectedRevision: number,
  ): Promise<DeleteBoardResult> {
    const revision = parse(revisionSchema, expectedRevision);
    await this.options.assertLocalWritable(accountId);
    const current = await this.checkBoardRevision(accountId, boardId, revision);
    if (current.isMain)
      throw new AppError('validation_failed', 'the main board cannot be deleted', 422);
    const main = await this.ensureMainBoard(accountId);
    const results = await this.persistence.batch(
      [
        this.persistence.boardGuard(accountId, boardId, revision, true),
        this.db
          .prepare(
            `WITH destination AS MATERIALIZED (
          SELECT COALESCE(MAX(position)+1,0) AS base FROM boards_memberships WHERE account_id=? AND board_id=?
        ), moving AS MATERIALIZED (
          SELECT list_id,ROW_NUMBER() OVER (ORDER BY position,list_id)-1 AS ordinal FROM boards_memberships WHERE account_id=? AND board_id=?
        )
        UPDATE boards_memberships SET board_id=?,position=(SELECT base FROM destination)+(SELECT ordinal FROM moving WHERE moving.list_id=boards_memberships.list_id),revision=revision+1
        WHERE account_id=? AND board_id=?`,
          )
          .bind(accountId, main.id, accountId, boardId, main.id, accountId, boardId),
        ...(this.options.onDeleteWrites?.(accountId, boardId) ?? []),
        this.db
          .prepare(
            'DELETE FROM boards_boards WHERE account_id=? AND id=? AND revision=? AND is_main=0',
          )
          .bind(accountId, boardId, revision),
      ],
      async () => {
        await this.checkBoardRevision(accountId, boardId, revision);
      },
    );
    return {
      deletedBoardId: boardId,
      mainBoardId: main.id,
      movedListCount: results[1]?.meta.changes ?? 0,
    };
  }
}
