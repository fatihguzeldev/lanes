import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import {
  readActiveList,
  readActiveLists,
  readListInventoryCoverage,
} from '../../../tasks/server/queries/lists';

import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import {
  BoardAppearanceSchema,
  BoardColorSchema,
  BoardPageOptionsSchema,
  BoardPatchSchema,
  CreateBoardSchema,
  type Board,
  type BoardAppearance,
  type BoardList,
  type BoardMembership,
  type BoardPageOptions,
  type BoardPatch,
  type CreateBoardInput,
  type DeleteBoardResult,
} from '../../contracts/board';

interface BoardRow {
  id: string;
  account_id: string;
  title: string;
  is_main: number;
  emoji: string | null;
  color: string;
  background_url: string | null;
  position: number;
  revision: number;
  created_at: number;
}
interface MembershipRow {
  account_id: string;
  list_id: string;
  board_id: string;
  color: string;
  position: number;
  revision: number;
}
export interface BoardServiceOptions {
  assertLocalWritable(accountId: string): Promise<void>;
  commitWrites?(writes: D1PreparedStatement[]): Promise<D1Result[]>;
  onDeleteWrites?(accountId: string, boardId: string): D1PreparedStatement[];
}
const boardFields =
  'id,account_id,title,is_main,emoji,color,background_url,position,revision,created_at';
const membershipFields = 'account_id,list_id,board_id,color,position,revision';
const revisionSchema = z.number().int().nonnegative();
const positionSchema = z.number().int().nonnegative();
const cursorSchema = z
  .object({
    kind: z.enum(['boards', 'lists']),
    accountId: z.string(),
    boardId: z.string().optional(),
    position: z.number().int(),
    id: z.string().min(1),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(
      'validation_failed',
      'check the submitted board fields',
      422,
      false,
      Object.fromEntries(
        result.error.issues.map((issue) => [issue.path.join('.') || 'input', issue.message]),
      ),
    );
  return result.data;
}
function board(row: BoardRow): Board {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    isMain: row.is_main === 1,
    emoji: row.emoji,
    color: row.color,
    backgroundUrl: row.background_url,
    position: row.position,
    revision: row.revision,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
function membership(row: MembershipRow): BoardMembership {
  return {
    accountId: row.account_id,
    listId: row.list_id,
    boardId: row.board_id,
    color: row.color,
    position: row.position,
    revision: row.revision,
  };
}
function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
function decodeCursor(
  value: string | undefined,
  expected: { kind: Cursor['kind']; accountId: string; boardId?: string },
): Cursor | null {
  if (value === undefined) return null;
  try {
    if (!/^[\w-]+$/.test(value)) throw new Error('invalid cursor');
    const padded = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
    );
    const cursor = cursorSchema.parse(JSON.parse(text));
    if (
      cursor.kind !== expected.kind ||
      cursor.accountId !== expected.accountId ||
      cursor.boardId !== expected.boardId
    )
      throw new Error('wrong cursor scope');
    return cursor;
  } catch {
    throw new AppError(
      'validation_failed',
      'the page cursor does not belong to this selection',
      422,
    );
  }
}
const localCoverage = { complete: true, lastSyncedAt: null, stale: false } as const;

export class BoardService {
  constructor(
    private readonly db: D1Database,
    private readonly options: BoardServiceOptions,
  ) {}

  private async first<T>(statement: D1PreparedStatement): Promise<T | null> {
    try {
      return await statement.first<T>();
    } catch {
      throw new AppError('storage_unavailable', 'the workspace could not be read', 503, true);
    }
  }
  private async rows<T>(statement: D1PreparedStatement): Promise<T[]> {
    try {
      return (await statement.all<T>()).results;
    } catch {
      throw new AppError('storage_unavailable', 'the workspace could not be read', 503, true);
    }
  }
  private async batch<T>(
    statements: D1PreparedStatement[],
    checkConflict: () => Promise<void>,
  ): Promise<D1Result<T>[]> {
    try {
      const results = this.options.commitWrites
        ? await this.options.commitWrites(statements)
        : await this.db.batch(statements);
      return results as unknown as D1Result<T>[];
    } catch (error) {
      if (error instanceof AppError) throw error;
      await checkConflict();
      throw new AppError(
        'storage_unavailable',
        'the workspace change could not be saved',
        503,
        true,
      );
    }
  }
  // A failed SQL precondition must abort the whole D1 batch, including delete hooks.
  // The CHECK table stays empty: valid commands insert nothing; invalid ones abort.
  private assertBatch(sql: string, bindings: (string | number | null)[]): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO boards_write_guards(valid) SELECT 0 WHERE NOT EXISTS (${sql})`)
      .bind(...bindings);
  }
  private boardGuard(
    accountId: string,
    boardId: string,
    revision: number,
    customOnly = false,
  ): D1PreparedStatement {
    return this.assertBatch(
      `SELECT 1 FROM boards_boards WHERE account_id=? AND id=? AND revision=?${customOnly ? ' AND is_main=0' : ''}`,
      [accountId, boardId, revision],
    );
  }
  private async checkBoardRevision(
    accountId: string,
    boardId: string,
    expectedRevision: number,
  ): Promise<Board> {
    const current = await this.getBoard(accountId, boardId);
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
    const current = await this.getMembership(accountId, listId);
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

  /** Read-only portability/preview seam; initialization remains explicit. */
  async getMainBoard(accountId: string): Promise<Board> {
    const existing = await this.first<BoardRow>(
      this.db
        .prepare(`SELECT ${boardFields} FROM boards_boards WHERE account_id=? AND is_main=1`)
        .bind(accountId),
    );
    if (!existing)
      throw new AppError('not_found', 'this account main board has not been initialized.', 404);
    return board(existing);
  }

  async ensureMainBoard(accountId: string): Promise<Board> {
    const existing = await this.first<BoardRow>(
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
    const created = await this.first<BoardRow>(
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

  async getBoard(accountId: string, boardId: string): Promise<Board> {
    const row = await this.first<BoardRow>(
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
    const rows = await this.rows<BoardRow>(
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
    const row = await this.first<MembershipRow>(
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
    const rows = await this.rows<MembershipRow>(
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
    await this.batch(prepared.writes, async () => {
      const existing = await this.first<BoardRow>(
        this.db
          .prepare(`SELECT ${boardFields} FROM boards_boards WHERE account_id=? AND id=?`)
          .bind(accountId, prepared.boardId),
      );
      if (existing)
        throw new AppError('conflict', 'the admitted board identity is already in use', 409);
    });
    return this.getBoard(accountId, prepared.boardId);
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
    await this.batch(
      [
        this.boardGuard(accountId, boardId, revision),
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
    return this.getBoard(accountId, boardId);
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
    await this.batch(
      [
        this.boardGuard(accountId, boardId, revision),
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
    return this.getBoard(accountId, boardId);
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
    const target = await this.getBoard(accountId, targetBoardId);
    if (list.isDefault && !target.isMain)
      throw new AppError(
        'validation_failed',
        'the default google list must stay on the main board',
        422,
        false,
        { boardId: 'choose the main board' },
      );
    await this.checkMembershipRevision(accountId, listId, revision);
    await this.batch(
      [
        this.assertBatch(
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
        await this.getBoard(accountId, targetBoardId);
      },
    );
    return this.getMembership(accountId, listId);
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
    await this.batch(
      [
        this.assertBatch(
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
    return this.getMembership(accountId, listId);
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
    const results = await this.batch(
      [
        this.boardGuard(accountId, boardId, revision, true),
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
