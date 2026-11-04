import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { BoardServiceOptions } from './context';

/** Board reads and guarded write batches retain the caller's operation transaction. */
export class BoardPersistence {
  constructor(
    private readonly db: D1Database,
    private readonly options: BoardServiceOptions,
  ) {}

  async first<T>(statement: D1PreparedStatement): Promise<T | null> {
    try {
      return await statement.first<T>();
    } catch {
      throw new AppError('storage_unavailable', 'the workspace could not be read', 503, true);
    }
  }

  async rows<T>(statement: D1PreparedStatement): Promise<T[]> {
    try {
      return (await statement.all<T>()).results;
    } catch {
      throw new AppError('storage_unavailable', 'the workspace could not be read', 503, true);
    }
  }

  async batch<T>(
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
  assertBatch(sql: string, bindings: (string | number | null)[]): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO boards_write_guards(valid) SELECT 0 WHERE NOT EXISTS (${sql})`)
      .bind(...bindings);
  }

  boardGuard(
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
}
