import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { ErrorCode, Page } from '../../../../shared/contracts/http';
import type {
  OperationProgress,
  OperationStepSummary,
  OperationSummary,
} from '../../contracts/receipt';
import type { Row } from '../journal/records';
import type { OperationState } from '../journal/context';
import { failureMessage } from '../journal/failures';

/** Public receipt projections exclude captured input and raw provider responses. */
export class OperationQueries {
  constructor(private readonly db: D1Database) {}

  async list(
    accountId: string,
    options: { limit?: number; cursor?: string; activeOnly?: boolean } = {},
  ): Promise<Page<OperationSummary>> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'choose a page size from 1 to 100.', 400);
    let anchor: { createdAt: number; id: string } | null = null;
    if (options.cursor) {
      try {
        const value: unknown = JSON.parse(atob(options.cursor));
        if (!value || typeof value !== 'object') throw new Error();
        const v = value as Record<string, unknown>;
        if (
          v.accountId !== accountId ||
          v.activeOnly !== !!options.activeOnly ||
          typeof v.id !== 'string' ||
          typeof v.createdAt !== 'number' ||
          !Number.isSafeInteger(v.createdAt)
        )
          throw new Error();
        anchor = { id: v.id, createdAt: v.createdAt };
      } catch {
        throw new AppError(
          'validation_failed',
          'this operation cursor belongs to another selection.',
          400,
        );
      }
    }
    const active = options.activeOnly ? ' AND terminal_at IS NULL' : '';
    const after = anchor ? ' AND (created_at<? OR (created_at=? AND id<?))' : '';
    const bindings: (string | number)[] = [accountId];
    if (anchor) bindings.push(anchor.createdAt, anchor.createdAt, anchor.id);
    bindings.push(limit + 1);
    const rows = await this.db
      .prepare(
        `SELECT id,account_id,kind,state,created_at,updated_at,cancel_requested,total_steps,confirmed_steps,input_sealed,error_code,error_message,next_attempt_at,terminal_at
      FROM tasks_operations WHERE account_id=?${active}${after} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .bind(...bindings)
      .all<
        Omit<
          Row,
          'owner_subject' | 'resource_key' | 'input_hash' | 'input_json' | 'result_json'
        > & {
          error_code: ErrorCode | null;
          error_message: string | null;
          next_attempt_at: number | null;
          terminal_at: number | null;
        }
      >();
    const shown = rows.results.slice(0, limit),
      last = shown.at(-1);
    return {
      items: shown.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        kind: row.kind,
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        cancelRequested: !!row.cancel_requested,
        totalSteps: row.total_steps,
        confirmedSteps: row.confirmed_steps,
        inputSealed: !!row.input_sealed,
        error: row.error_code
          ? { code: row.error_code, message: failureMessage(row.error_code) }
          : null,
        nextAttemptAt: row.next_attempt_at,
        finished: row.terminal_at !== null,
      })),
      nextCursor:
        rows.results.length > limit && last
          ? btoa(
              JSON.stringify({
                accountId,
                activeOnly: !!options.activeOnly,
                createdAt: last.created_at,
                id: last.id,
              }),
            )
          : null,
      coverage: { complete: true, stale: false, lastSyncedAt: null },
    };
  }

  async summary(id: string, accountId: string): Promise<OperationSummary | null> {
    const row = await this.db
      .prepare(
        `SELECT id,account_id,kind,state,created_at,updated_at,cancel_requested,total_steps,confirmed_steps,input_sealed,error_code,next_attempt_at,terminal_at
      FROM tasks_operations WHERE id=? AND account_id=?`,
      )
      .bind(id, accountId)
      .first<{
        id: string;
        account_id: string;
        kind: string;
        state: OperationState;
        created_at: number;
        updated_at: number;
        cancel_requested: number;
        total_steps: number;
        confirmed_steps: number;
        input_sealed: number;
        error_code: ErrorCode | null;
        next_attempt_at: number | null;
        terminal_at: number | null;
      }>();
    return row
      ? {
          id: row.id,
          accountId: row.account_id,
          kind: row.kind,
          state: row.state,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          cancelRequested: !!row.cancel_requested,
          totalSteps: row.total_steps,
          confirmedSteps: row.confirmed_steps,
          inputSealed: !!row.input_sealed,
          error: row.error_code
            ? { code: row.error_code, message: failureMessage(row.error_code) }
            : null,
          nextAttemptAt: row.next_attempt_at,
          finished: row.terminal_at !== null,
        }
      : null;
  }

  /** Result references only. Captured input and raw provider responses remain server-side. */
  async steps(
    id: string,
    accountId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<OperationStepSummary>> {
    const summary = await this.summary(id, accountId);
    if (!summary) throw new AppError('not_found', 'this operation was not found.', 404);
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new AppError('validation_failed', 'read at most ten operation steps per page.', 400);
    let after: { position: number; key: string } | null = null;
    if (options.cursor) {
      try {
        const value = JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(atob(options.cursor), (char) => char.charCodeAt(0)),
          ),
        ) as Record<string, unknown>;
        if (
          value.accountId !== accountId ||
          value.id !== id ||
          !Number.isSafeInteger(value.position) ||
          typeof value.key !== 'string'
        )
          throw new Error();
        after = { position: value.position as number, key: value.key };
      } catch {
        throw new AppError(
          'validation_failed',
          'this step cursor belongs to another operation.',
          400,
        );
      }
    }
    const reference = (key: string) =>
      `CASE WHEN json_type(result_json,'$.${key}')='text' THEN json_extract(result_json,'$.${key}') ELSE NULL END`;
    const rows = (
      await this.db
        .prepare(
          `SELECT item_key,position,kind,state,error_code,${reference('taskId')} AS task_id,${reference('listId')} AS list_id,${reference('spreadsheetId')} AS spreadsheet_id,COALESCE(json_extract(result_json,'$.deleted'),0) AS deleted,
      CASE WHEN owner_stopped_at IS NOT NULL THEN 'keep_provider_current' ELSE NULL END AS stop_decision
      FROM tasks_operation_steps WHERE operation_id=? ${after ? 'AND(position>? OR(position=? AND item_key>?))' : ''} ORDER BY position,item_key LIMIT ?`,
        )
        .bind(id, ...(after ? [after.position, after.position, after.key] : []), limit + 1)
        .all<{
          item_key: string;
          position: number;
          kind: string;
          state: OperationStepSummary['state'];
          error_code: string | null;
          task_id: string | null;
          list_id: string | null;
          spreadsheet_id: string | null;
          deleted: number;
          stop_decision: 'keep_provider_current' | null;
        }>()
    ).results;
    const shown = rows.slice(0, limit),
      last = shown.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? btoa(
            String.fromCharCode(
              ...new TextEncoder().encode(
                JSON.stringify({ accountId, id, position: last.position, key: last.item_key }),
              ),
            ),
          )
        : null;
    return {
      items: shown.map((row) => ({
        key: row.item_key,
        position: row.position,
        kind: row.kind,
        state: row.state,
        errorCode: row.error_code,
        taskId: row.task_id,
        listId: row.list_id,
        spreadsheetId: row.spreadsheet_id,
        deleted: !!row.deleted,
        stopDecision: row.stop_decision,
      })),
      nextCursor,
      coverage: { complete: summary.inputSealed, stale: false, lastSyncedAt: null },
    };
  }

  async progress(id: string, accountId: string, now = Date.now()): Promise<OperationProgress> {
    const summary = await this.summary(id, accountId);
    if (!summary) throw new AppError('not_found', 'this operation was not found.', 404);
    const rows = (
      await this.db
        .prepare(
          "SELECT state,COUNT(*) AS count,SUM(kind='task.create') AS creates FROM tasks_operation_steps WHERE operation_id=? GROUP BY state",
        )
        .bind(id)
        .all<{ state: string; count: number; creates: number }>()
    ).results;
    const steps = {
        confirmed: summary.confirmedSteps,
        failed: 0,
        uncertain: 0,
        cancelled: 0,
        remaining: 0,
      },
      taskCreates = { confirmed: 0, failed: 0, uncertain: 0, cancelled: 0 };
    for (const row of rows) {
      if (
        row.state === 'confirmed' ||
        row.state === 'failed' ||
        row.state === 'uncertain' ||
        row.state === 'cancelled'
      ) {
        steps[row.state] = row.count;
        taskCreates[row.state] = row.creates;
      }
    }
    steps.remaining = Math.max(
      0,
      summary.totalSteps - steps.confirmed - steps.failed - steps.uncertain - steps.cancelled,
    );
    return {
      operationId: id,
      accountId,
      inputSealed: summary.inputSealed,
      finished: summary.finished,
      totalSteps: summary.totalSteps,
      steps,
      taskCreates,
      checkedAt: now,
    };
  }
}
