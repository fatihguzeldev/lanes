import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { AppError } from '../../../contracts/errors';
import type { ErrorCode, Page } from '../../../contracts/http';
import type {
  IssuedOperationStep,
  OperationProgress,
  OperationStepSummary,
  OperationSummary,
} from '../operation-contract';
import {
  assertDisconnecting,
  assertLocalWritable,
  assertProviderWritable,
  disconnectWorkGuard,
  localWriteGuard,
  providerWriteGuard,
} from '../../accounts/access';

export type OperationState =
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'reconnect_required'
  | 'blocked_by_limit'
  | 'uncertain'
  | 'failed'
  | 'cancelled';
export interface OperationRecord {
  id: string;
  accountId: string;
  ownerSubject: string;
  kind: string;
  resourceKey: string;
  inputHash: string;
  input: unknown;
  state: OperationState;
  result: unknown;
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  totalSteps: number;
  confirmedSteps: number;
  inputSealed: boolean;
  finished: boolean;
}
export interface OperationAdmission {
  id: string;
  accountId: string;
  ownerSubject: string;
  kind: string;
  resourceKey: string;
  input: unknown;
  steps: readonly { key: string; kind: string; input: unknown }[];
  listSlots?: number;
  totalSteps?: number;
}
export interface OperationStep {
  operationId: string;
  key: string;
  kind: string;
  input: unknown;
  state: string;
  claimId: string | null;
  claimUntil: number | null;
  response: unknown;
  result: unknown;
  listSlot: number;
  position: number;
}
export interface ClaimedStep extends OperationStep {
  mode: 'dispatch' | 'repair';
}
export interface ResolutionEvidence {
  kind: 'owner_candidate' | 'provider_readback';
  providerId: string;
  etag?: string;
  digest?: string;
}
export interface ResolveUnknownResponse {
  operationId: string;
  accountId: string;
  stepKey: string;
  expectedClaimId: string;
  response: unknown;
  evidence: ResolutionEvidence;
}
export interface StopRecordedIntent {
  operationId: string;
  accountId: string;
  stepKey: string;
  expectedClaimId: string | null;
  expectedResponse: unknown | null;
  evidence: ResolutionEvidence;
  decision: 'keep_provider_current';
}
export interface StoppedIntent {
  stepKey: string;
  expectedClaimId: string | null;
  expectedResponseHash: string | null;
  evidence: ResolutionEvidence;
  decision: 'keep_provider_current';
  createdAt: number;
}
interface Row {
  id: string;
  account_id: string;
  owner_subject: string;
  kind: string;
  resource_key: string;
  input_hash: string;
  input_json: string;
  state: OperationState;
  result_json: string | null;
  created_at: number;
  updated_at: number;
  cancel_requested: number;
  total_steps: number;
  confirmed_steps: number;
  input_sealed: number;
  terminal_at: number | null;
}
interface StepRow {
  operation_id: string;
  item_key: string;
  kind: string;
  input_json: string;
  state: string;
  claim_id: string | null;
  claim_until: number | null;
  response_json: string | null;
  result_json: string | null;
  list_slot: number;
  position: number;
}
const claimDuration = 30_000;
const initialAdmissionLifetime = 86_400_000;
const inventoryFreshness = 60_000;
const maxInputBytes = 65_536;
const parseJson = (value: string | null): unknown => (value === null ? null : JSON.parse(value));
const record = (row: Row): OperationRecord => ({
  id: row.id,
  accountId: row.account_id,
  ownerSubject: row.owner_subject,
  kind: row.kind,
  resourceKey: row.resource_key,
  inputHash: row.input_hash,
  input: parseJson(row.input_json),
  state: row.state,
  result: parseJson(row.result_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  cancelRequested: !!row.cancel_requested,
  totalSteps: row.total_steps,
  confirmedSteps: row.confirmed_steps,
  inputSealed: !!row.input_sealed,
  finished: row.terminal_at !== null,
});
const stepRecord = (row: StepRow): OperationStep => ({
  operationId: row.operation_id,
  key: row.item_key,
  kind: row.kind,
  input: parseJson(row.input_json),
  state: row.state,
  claimId: row.claim_id,
  claimUntil: row.claim_until,
  response: parseJson(row.response_json),
  result: parseJson(row.result_json),
  listSlot: row.list_slot,
  position: row.position,
});
const failureMessages: Partial<Record<ErrorCode, string>> = {
  reconnect_required: 'reconnect this google account to continue.',
  permission_required: 'this account needs the requested google permission.',
  provider_rate_limited: 'google is limiting requests. this work will wait before retrying.',
  list_limit_reached: 'this work needs available list capacity.',
  storage_unavailable: 'this work could not be recorded. its confirmed output is retained.',
  conflict: 'the resource changed. inspect its current values before continuing.',
  outcome_uncertain:
    'google may have accepted this change. inspect its result before repeating it.',
  not_found: 'this resource could not be found at its recorded address.',
  forbidden: 'this account is not allowed to make this change.',
  validation_failed: 'check the submitted fields before continuing.',
  destination_removed:
    'the destination board was removed after dispatch. the confirmed list was preserved on the main board and unsent remaining work was stopped.',
  owner_stopped:
    'you kept the current google values and stopped applying this intent. its original provider outcome and receipt remain recorded.',
};
const failureMessage = (code: ErrorCode) =>
  failureMessages[code] ?? 'this work could not finish. its confirmed output is retained.';

export interface StepRejection {
  code: ErrorCode;
  /** Only a transport/provider classification can establish this; a timeout cannot. */
  definitelyRejected: boolean;
  operationState?: 'failed' | 'reconnect_required' | 'blocked_by_limit';
  retryAt?: number;
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 20)
    throw new AppError('validation_failed', 'this command is nested too deeply.', 400);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item, depth + 1)]),
    );
  }
  throw new AppError('validation_failed', 'this command contains an unsupported value.', 400);
}
async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function boundedJson(value: unknown): string {
  const json = JSON.stringify(canonical(value));
  if (new TextEncoder().encode(json).length > maxInputBytes)
    throw new AppError('validation_failed', 'this command exceeds the 64 kib input limit.', 413);
  return json;
}
function checkFreshIdentity(id: string, now: number): void {
  const match = /^(\d{13}):([a-zA-Z0-9_-]{16,64})$/.exec(id);
  const issued = Number(match?.[1]);
  if (
    !match ||
    !Number.isSafeInteger(issued) ||
    issued > now + 300_000 ||
    now - issued > initialAdmissionLifetime
  ) {
    throw new AppError(
      'conflict',
      'this unrecorded operation identity has expired. inspect existing work before starting a new action.',
      409,
    );
  }
}

/** Durable execution receipts. No method here sends a provider request. */
export class OperationStore {
  constructor(private readonly db: D1Database) {}

  async listCapacity(
    accountId: string,
    now = Date.now(),
  ): Promise<{ known: number | null; reserved: number; available: number | null; stale: boolean }> {
    const row = await this.db
      .prepare(
        `SELECT inventory_count,inventory_complete_at,
      COALESCE((SELECT SUM(remaining) FROM tasks_list_reservations WHERE account_id=?),0) AS reserved
      FROM tasks_account_state WHERE account_id=?`,
      )
      .bind(accountId, accountId)
      .first<{ inventory_count: number; inventory_complete_at: number | null; reserved: number }>();
    const known =
      row?.inventory_complete_at === null || row?.inventory_complete_at === undefined
        ? null
        : row.inventory_count;
    return {
      known,
      reserved: row?.reserved ?? 0,
      available: known === null ? null : Math.max(0, 2000 - known - (row?.reserved ?? 0)),
      stale: !row?.inventory_complete_at || row.inventory_complete_at < now - inventoryFreshness,
    };
  }

  async hasUnresolvedProviderWork(accountId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS pending FROM tasks_operations o JOIN tasks_operation_steps s ON s.operation_id=o.id
      WHERE o.account_id=? AND s.state IN ('dispatched','uncertain') AND s.owner_stopped_at IS NULL LIMIT 1`,
      )
      .bind(accountId)
      .first();
    return row !== null;
  }

  async deferDisconnectRepair(
    id: string,
    accountId: string,
    code: ErrorCode = 'outcome_uncertain',
    now = Date.now(),
  ): Promise<void> {
    await assertDisconnecting(this.db, accountId);
    await this.db.batch([
      disconnectWorkGuard(this.db, accountId),
      this.db
        .prepare(
          `UPDATE tasks_operation_steps SET state='uncertain',claim_until=NULL,error_code=?
        WHERE operation_id=? AND state='dispatched' AND response_json IS NOT NULL
        AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND account_id=? AND terminal_at IS NULL)`,
        )
        .bind(code, id, id, accountId),
      this.db
        .prepare(
          `UPDATE tasks_operations SET state='uncertain',error_code=?,error_message=?,updated_at=?
        WHERE id=? AND account_id=? AND terminal_at IS NULL AND EXISTS
        (SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND state='uncertain')`,
        )
        .bind(code, failureMessage(code), now, id, accountId, id),
    ]);
  }

  async drainDisconnect(
    accountId: string,
    limit = 10,
    now = Date.now(),
    repairPredicate: { sql: string; bindings: (string | number)[] } = { sql: '1', bindings: [] },
  ): Promise<{
    done: boolean;
    pending: boolean;
    unresolved: boolean;
    repairOperationId: string | null;
  }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new AppError(
        'validation_failed',
        'settle at most10 operations in one disconnect slice.',
        400,
      );
    await assertDisconnecting(this.db, accountId);
    const rows = await this.db
      .prepare(
        `SELECT o.id FROM tasks_operations o WHERE o.account_id=? AND o.terminal_at IS NULL
      AND (o.state IN ('accepted','running','partial') OR EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=o.id AND s.state='dispatched'))
      ORDER BY o.updated_at,o.id LIMIT ?`,
      )
      .bind(accountId, limit)
      .all<{ id: string }>();
    if (rows.results.length) {
      const ids = JSON.stringify(rows.results.map((row) => row.id));
      await this.db.batch([
        disconnectWorkGuard(this.db, accountId),
        this.db
          .prepare(
            `UPDATE tasks_operation_steps SET state='accepted',claim_id=NULL,claim_until=NULL WHERE state='claimed'
          AND operation_id IN (SELECT value FROM json_each(?))`,
          )
          .bind(ids),
        this.db
          .prepare(
            `UPDATE tasks_operation_steps SET state='uncertain' WHERE state='dispatched' AND response_json IS NULL AND claim_until<=?
          AND operation_id IN (SELECT value FROM json_each(?))`,
          )
          .bind(now, ids),
        this.db
          .prepare(
            `UPDATE tasks_operations SET state='uncertain',updated_at=? WHERE id IN (SELECT value FROM json_each(?))
          AND EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=tasks_operations.id AND s.state='uncertain')`,
          )
          .bind(now, ids),
        this.db
          .prepare(
            `UPDATE tasks_operations SET state='partial',updated_at=? WHERE id IN (SELECT value FROM json_each(?))
          AND EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=tasks_operations.id AND s.state='dispatched' AND s.response_json IS NOT NULL)`,
          )
          .bind(now, ids),
        this.db
          .prepare(
            `UPDATE tasks_operations SET state='reconnect_required',error_code='reconnect_required',error_message=?,updated_at=?
          WHERE id IN (SELECT value FROM json_each(?)) AND cancel_requested=0 AND terminal_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=tasks_operations.id AND s.state IN ('dispatched','uncertain'))`,
          )
          .bind(failureMessage('reconnect_required'), now, ids),
      ]);
    }
    const repair = await this.db
      .prepare(
        `SELECT o.id FROM tasks_operations o JOIN tasks_operation_steps s ON s.operation_id=o.id
      WHERE o.account_id=? AND o.terminal_at IS NULL AND s.state='dispatched' AND s.response_json IS NOT NULL AND s.claim_until<=? AND (${repairPredicate.sql})
      ORDER BY o.updated_at,o.id,s.position LIMIT 1`,
      )
      .bind(accountId, now, ...repairPredicate.bindings)
      .first<{ id: string }>();
    const pending = await this.db
      .prepare(
        `SELECT 1 AS pending FROM tasks_operations o WHERE o.account_id=? AND o.terminal_at IS NULL
      AND (o.state IN ('accepted','running','partial') OR EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=o.id AND s.state='dispatched')) LIMIT 1`,
      )
      .bind(accountId)
      .first();
    return {
      done: pending === null,
      pending: pending !== null,
      unresolved: await this.hasUnresolvedProviderWork(accountId),
      repairOperationId: repair?.id ?? null,
    };
  }

  /** The predicate is supplied by a server owner, never by a browser command. Join these to the known-response commit. */
  prepareStopRemainingWrites(
    id: string,
    condition: { sql: string; bindings: (string | number)[] },
  ): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `UPDATE tasks_operations SET cancel_requested=1,error_code='destination_removed',error_message=?
        WHERE id=? AND (${condition.sql})`,
        )
        .bind(failureMessage('destination_removed'), id, ...condition.bindings),
      this.db
        .prepare(
          `UPDATE tasks_operation_steps SET state='cancelled',claim_until=NULL WHERE operation_id=? AND state IN ('accepted','claimed')
        AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND cancel_requested=1 AND error_code='destination_removed')`,
        )
        .bind(id, id),
    ];
  }

  async failUnsealed(
    id: string,
    accountId: string,
    options: { code: ErrorCode },
    now = Date.now(),
  ): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE tasks_operations SET state='failed',terminal_at=?,updated_at=?,error_code=?,error_message=?
        WHERE id=? AND account_id=? AND input_sealed=0 AND confirmed_steps=0 AND terminal_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND state IN ('claimed','dispatched','confirmed','uncertain'))`,
        )
        .bind(now, now, options.code, failureMessage(options.code), id, accountId, id),
      this.db
        .prepare(
          `UPDATE tasks_operation_steps SET state='cancelled',claim_until=NULL WHERE operation_id=? AND state='accepted'
        AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND account_id=? AND state='failed' AND input_sealed=0 AND confirmed_steps=0)`,
        )
        .bind(id, id, accountId),
      this.db
        .prepare(
          `UPDATE tasks_list_reservations SET remaining=0 WHERE operation_id=?
        AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND account_id=? AND state='failed' AND input_sealed=0 AND confirmed_steps=0)`,
        )
        .bind(id, id, accountId),
    ]);
    if (!results[0]?.meta.changes) {
      const existing = await this.get(id, accountId);
      if (existing?.state === 'failed' && !existing.inputSealed && existing.confirmedSteps === 0)
        return;
      throw new AppError(
        'conflict',
        'only undispatched, unsealed capture can fail before provider work.',
        409,
      );
    }
  }

  async get(id: string, accountId: string): Promise<OperationRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM tasks_operations WHERE id=? AND account_id=?')
      .bind(id, accountId)
      .first<Row>();
    return row ? record(row) : null;
  }
  async getStep(id: string, key: string): Promise<OperationStep | null> {
    const row = await this.db
      .prepare('SELECT * FROM tasks_operation_steps WHERE operation_id=? AND item_key=?')
      .bind(id, key)
      .first<StepRow>();
    return row ? stepRecord(row) : null;
  }

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

  async firstUnresolvedStep(
    id: string,
    accountId: string,
    now = Date.now(),
  ): Promise<IssuedOperationStep | null> {
    const row = await this.db
      .prepare(
        `SELECT step.item_key,step.kind,step.state,step.response_json IS NOT NULL AS recorded,step.claim_until
      FROM tasks_operation_steps step JOIN tasks_operations operation ON operation.id=step.operation_id
      WHERE step.operation_id=? AND operation.account_id=? AND step.state IN('dispatched','uncertain')
      AND step.owner_stopped_at IS NULL
      ORDER BY step.position LIMIT 1`,
      )
      .bind(id, accountId)
      .first<{
        item_key: string;
        kind: string;
        state: 'dispatched' | 'uncertain';
        recorded: number;
        claim_until: number | null;
      }>();
    return row
      ? {
          key: row.item_key,
          kind: row.kind,
          state: row.state,
          hasRecordedResponse: !!row.recorded,
          claimActive: (row.claim_until ?? 0) > now,
        }
      : null;
  }

  async releaseUndispatched(
    id: string,
    key: string,
    claimId: string,
    options: {
      state?: 'failed' | 'reconnect_required' | 'blocked_by_limit';
      retryAt?: number;
      code?: ErrorCode;
    } = {},
    now = Date.now(),
  ): Promise<void> {
    const code = options.code ?? 'provider_unavailable';
    await this.settleRejection(
      id,
      key,
      claimId,
      {
        code,
        definitelyRejected: true,
        ...(options.state ? { operationState: options.state } : {}),
        ...(options.state === 'failed' ? {} : { retryAt: options.retryAt ?? now + 5_000 }),
      },
      'claimed',
      now,
    );
  }

  async rejectStep(
    id: string,
    key: string,
    claimId: string,
    rejection: StepRejection,
    now = Date.now(),
  ): Promise<void> {
    await this.settleRejection(id, key, claimId, rejection, 'dispatched', now);
  }

  private async settleRejection(
    id: string,
    key: string,
    claimId: string,
    rejection: StepRejection,
    from: 'claimed' | 'dispatched',
    now: number,
  ): Promise<void> {
    const retryAt = rejection.retryAt ?? null;
    if (retryAt !== null && (!Number.isSafeInteger(retryAt) || retryAt < now))
      throw new AppError('validation_failed', 'a retry must wait until a future instant.', 400);
    const uncertain = !rejection.definitelyRejected;
    const state = uncertain
      ? 'uncertain'
      : (rejection.operationState ?? (retryAt === null ? 'failed' : 'partial'));
    const terminal = state === 'failed';
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS
          (SELECT 1 FROM tasks_operation_steps s JOIN tasks_operations o ON o.id=s.operation_id
           WHERE s.operation_id=? AND s.item_key=? AND s.claim_id=? AND s.state=? AND s.response_json IS NULL AND o.terminal_at IS NULL)`,
          )
          .bind(id, key, claimId, from),
        this.db
          .prepare(
            `UPDATE tasks_operation_steps SET state=CASE
          WHEN ?=1 THEN 'uncertain' WHEN EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND cancel_requested=1) THEN 'cancelled'
          WHEN ?=1 THEN 'failed' ELSE 'accepted' END,error_code=?,next_attempt_at=?,claim_until=NULL
          WHERE operation_id=? AND item_key=?`,
          )
          .bind(uncertain ? 1 : 0, id, terminal ? 1 : 0, rejection.code, retryAt, id, key),
        this.db
          .prepare(
            `UPDATE tasks_operations SET state=CASE WHEN cancel_requested=1 AND ?=0 THEN 'cancelled' ELSE ? END,
          error_code=?,error_message=?,next_attempt_at=?,updated_at=?,terminal_at=CASE WHEN ?=1 OR (cancel_requested=1 AND ?=0) THEN ? ELSE NULL END WHERE id=?`,
          )
          .bind(
            uncertain ? 1 : 0,
            state,
            rejection.code,
            failureMessage(rejection.code),
            retryAt,
            now,
            terminal ? 1 : 0,
            uncertain ? 1 : 0,
            now,
            id,
          ),
        this.db
          .prepare(
            `UPDATE tasks_operation_steps SET state='cancelled',claim_until=NULL WHERE operation_id=? AND state IN ('accepted','claimed')
          AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND state IN ('failed','cancelled'))`,
          )
          .bind(id, id),
        this.db
          .prepare(
            `UPDATE tasks_list_reservations SET remaining=0 WHERE operation_id=?
          AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND state IN ('failed','cancelled'))`,
          )
          .bind(id, id),
      ]);
    } catch {
      throw new AppError(
        'conflict',
        'this response no longer belongs to the active step, or a provider receipt is already recorded.',
        409,
      );
    }
  }

  async resume(id: string, accountId: string, now = Date.now()): Promise<void> {
    await assertProviderWritable(this.db, accountId);
    const result = await this.db
      .prepare(
        `UPDATE tasks_operations SET state='partial',error_code=NULL,error_message=NULL,next_attempt_at=NULL,updated_at=?
      WHERE id=? AND account_id=? AND terminal_at IS NULL AND state IN ('reconnect_required','blocked_by_limit') AND cancel_requested=0
      AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND state='uncertain')`,
      )
      .bind(now, id, accountId, id)
      .run();
    if (!result.meta.changes)
      throw new AppError('conflict', 'only paused work with a known outcome can resume.', 409);
    await this.db
      .prepare(
        `UPDATE tasks_operation_steps SET next_attempt_at=NULL WHERE operation_id=? AND state='accepted'`,
      )
      .bind(id)
      .run();
  }

  /** Bound child-row deletion as well as operation count; unfinished work is never aged out. */
  async pruneTerminalPayloads(limit = 100, now = Date.now()): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'prune at most100 terminal payload rows.', 400);
    const cutoff = now - 86_400_000;
    const allowed = `o.terminal_at<=? AND (p.operation_id IS NULL OR p.payload_pruned_at IS NOT NULL)`;
    const stepResult = await this.db
      .prepare(
        `UPDATE tasks_operation_steps SET input_json='null',response_json=NULL WHERE (operation_id,item_key) IN
      (SELECT s.operation_id,s.item_key FROM tasks_operation_steps s JOIN tasks_operations o ON o.id=s.operation_id
       LEFT JOIN tasks_command_plans p ON p.operation_id=o.id WHERE ${allowed} AND (s.input_json<>'null' OR s.response_json IS NOT NULL)
       ORDER BY o.terminal_at,o.id,s.position LIMIT ?)`,
      )
      .bind(cutoff, limit)
      .run();
    const changed = stepResult.meta.changes;
    if (changed >= limit) return changed;
    const operationResult = await this.db
      .prepare(
        `UPDATE tasks_operations SET input_json='null' WHERE id IN
      (SELECT o.id FROM tasks_operations o LEFT JOIN tasks_command_plans p ON p.operation_id=o.id
       WHERE ${allowed} AND o.input_json<>'null' ORDER BY o.terminal_at,o.id LIMIT ?)`,
      )
      .bind(cutoff, limit - changed)
      .run();
    return changed + operationResult.meta.changes;
  }

  async cleanup(limit = 100, now = Date.now()): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'cleanup accepts at most100 records.', 400);
    const cutoff = now - 90 * 86_400_000;
    let remaining = limit;
    for (const table of ['tasks_operation_stops', 'tasks_operation_resolutions'] as const) {
      const result = await this.db
        .prepare(
          `DELETE FROM ${table} WHERE (operation_id,item_key) IN
        (SELECT r.operation_id,r.item_key FROM ${table} r JOIN tasks_operations o ON o.id=r.operation_id
         WHERE o.terminal_at<=? ORDER BY o.terminal_at,o.id LIMIT ?)`,
        )
        .bind(cutoff, remaining)
        .run();
      remaining -= result.meta.changes;
      if (!remaining) return 0;
    }
    const steps = await this.db
      .prepare(
        `DELETE FROM tasks_operation_steps WHERE (operation_id,item_key) IN
        (SELECT s.operation_id,s.item_key FROM tasks_operation_steps s JOIN tasks_operations o ON o.id=s.operation_id
         WHERE o.terminal_at<=? AND o.state IN ('succeeded','failed','cancelled','partial')
         AND NOT EXISTS(SELECT 1 FROM tasks_command_plans p WHERE p.operation_id=o.id)
         ORDER BY o.terminal_at,o.id,s.position LIMIT ?)`,
      )
      .bind(cutoff, remaining)
      .run();
    remaining -= steps.meta.changes;
    if (!remaining) return 0;
    // Remove this child explicitly: deleting its parent would hide a cascade from the budget.
    const reservations = await this.db
      .prepare(
        `DELETE FROM tasks_list_reservations WHERE operation_id IN
      (SELECT r.operation_id FROM tasks_list_reservations r JOIN tasks_operations o ON o.id=r.operation_id
       WHERE o.terminal_at<=? AND NOT EXISTS(SELECT 1 FROM tasks_command_plans p WHERE p.operation_id=o.id)
       AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=o.id)
       ORDER BY o.terminal_at,o.id LIMIT ?)`,
      )
      .bind(cutoff, remaining)
      .run();
    remaining -= reservations.meta.changes;
    if (!remaining) return 0;
    const operations = await this.db
      .prepare(
        `DELETE FROM tasks_operations WHERE id IN
        (SELECT o.id FROM tasks_operations o WHERE o.terminal_at<=? AND o.state IN ('succeeded','failed','cancelled','partial')
         AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=o.id)
         AND NOT EXISTS(SELECT 1 FROM tasks_command_plans p WHERE p.operation_id=o.id)
         AND NOT EXISTS(SELECT 1 FROM tasks_operation_resolutions r WHERE r.operation_id=o.id)
         AND NOT EXISTS(SELECT 1 FROM tasks_operation_stops stopped WHERE stopped.operation_id=o.id)
         ORDER BY o.terminal_at,o.id LIMIT ?)`,
      )
      .bind(cutoff, remaining)
      .run();
    return operations.meta.changes;
  }
  private assertReplay(
    existing: Row,
    input: OperationAdmission,
    inputHash: string,
  ): OperationRecord {
    if (
      existing.account_id !== input.accountId ||
      existing.owner_subject !== input.ownerSubject ||
      existing.input_hash !== inputHash
    ) {
      throw new AppError(
        'conflict',
        'this operation identity already belongs to different input.',
        409,
      );
    }
    return record(existing);
  }
  async admit(input: OperationAdmission, now = Date.now()): Promise<OperationRecord> {
    if (
      !input.steps.length ||
      input.steps.length > 10 ||
      new Set(input.steps.map((step) => step.key)).size !== input.steps.length ||
      input.resourceKey.length > 256
    ) {
      throw new AppError(
        'validation_failed',
        'a command accepts one to ten distinct bounded steps.',
        400,
      );
    }
    const slots = input.listSlots ?? 0;
    const totalSteps = input.totalSteps ?? input.steps.length;
    if (!Number.isInteger(totalSteps) || totalSteps < input.steps.length || totalSteps > 10000)
      throw new AppError('validation_failed', 'this captured plan has an invalid step count.', 400);
    const sealed = totalSteps === input.steps.length;
    const capturedSlots = input.steps.filter((step) => step.kind === 'list.create').length;
    if (capturedSlots > slots || (sealed && capturedSlots !== slots))
      throw new AppError(
        'validation_failed',
        'the list reservation does not match the captured plan.',
        400,
      );
    if (!Number.isInteger(slots) || slots < 0 || slots > 100)
      throw new AppError(
        'validation_failed',
        'a creation plan can reserve at most 100 new lists.',
        400,
      );
    const inputJson = boundedJson({
      accountId: input.accountId,
      ownerSubject: input.ownerSubject,
      kind: input.kind,
      resourceKey: input.resourceKey,
      input: input.input,
      steps: input.steps,
      listSlots: slots,
      totalSteps,
    });
    const inputHash = await hash(inputJson);
    const existing = await this.db
      .prepare('SELECT * FROM tasks_operations WHERE id=?')
      .bind(input.id)
      .first<Row>();
    if (existing) return this.assertReplay(existing, input, inputHash);
    checkFreshIdentity(input.id, now);
    const exists = `EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND account_id=? AND input_hash=?)`;
    const writes = [
      this.db
        .prepare(
          `INSERT INTO tasks_operations
      (id,account_id,owner_subject,kind,resource_key,input_hash,input_json,state,created_at,updated_at,total_steps,input_sealed)
      SELECT ?,?,?,?,?,?,?,'accepted',?,?,?,? WHERE ?=0 OR EXISTS
      (SELECT 1 FROM tasks_account_state s WHERE s.account_id=? AND s.inventory_complete_at>=?
       AND s.inventory_count+COALESCE((SELECT SUM(r.remaining) FROM tasks_list_reservations r WHERE r.account_id=s.account_id),0)+?<=2000)
      ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          input.id,
          input.accountId,
          input.ownerSubject,
          input.kind,
          input.resourceKey,
          inputHash,
          inputJson,
          now,
          now,
          totalSteps,
          sealed ? 1 : 0,
          slots,
          input.accountId,
          now - inventoryFreshness,
          slots,
        ),
      this.db
        .prepare(
          `INSERT INTO tasks_list_reservations(operation_id,account_id,slots,remaining,created_at)
        SELECT ?,?,?,?,? WHERE ${exists} ON CONFLICT(operation_id) DO NOTHING`,
        )
        .bind(input.id, input.accountId, slots, slots, now, input.id, input.accountId, inputHash),
      ...input.steps.map((step, position) =>
        this.db
          .prepare(
            `INSERT INTO tasks_operation_steps
        (operation_id,item_key,position,kind,input_json,state,list_slot) SELECT ?,?,?,?,?,'accepted',? WHERE ${exists}
        ON CONFLICT(operation_id,item_key) DO NOTHING`,
          )
          .bind(
            input.id,
            step.key,
            position,
            step.kind,
            boundedJson(step.input),
            step.kind === 'list.create' ? 1 : 0,
            input.id,
            input.accountId,
            inputHash,
          ),
      ),
    ];
    try {
      await this.db.batch(writes);
    } catch {
      const competing = await this.db
        .prepare(
          `SELECT id FROM tasks_operations WHERE account_id=? AND resource_key=?
        AND terminal_at IS NULL AND state IN ('accepted','running','partial','reconnect_required','blocked_by_limit','uncertain')`,
        )
        .bind(input.accountId, input.resourceKey)
        .first<{ id: string }>();
      if (competing && competing.id !== input.id)
        throw new AppError(
          'conflict',
          'another change to this resource is still pending.',
          409,
          false,
          undefined,
          competing.id,
        );
      throw new AppError(
        'storage_unavailable',
        'the command could not be recorded. no provider request was sent.',
        503,
        true,
      );
    }
    const admitted = await this.db
      .prepare('SELECT * FROM tasks_operations WHERE id=?')
      .bind(input.id)
      .first<Row>();
    if (admitted) return this.assertReplay(admitted, input, inputHash);
    const inventory = await this.db
      .prepare(
        `SELECT inventory_count,inventory_complete_at,
      COALESCE((SELECT SUM(remaining) FROM tasks_list_reservations WHERE account_id=?),0) AS reserved
      FROM tasks_account_state WHERE account_id=?`,
      )
      .bind(input.accountId, input.accountId)
      .first<{ inventory_count: number; inventory_complete_at: number | null; reserved: number }>();
    if (
      !inventory ||
      inventory.inventory_complete_at === null ||
      inventory.inventory_complete_at < now - inventoryFreshness
    )
      throw new AppError(
        'conflict',
        'refresh the complete google list inventory before reserving list capacity.',
        409,
      );
    throw new AppError(
      'list_limit_reached',
      `this action needs ${slots} list slots; ${Math.max(0, 2000 - inventory.inventory_count - inventory.reserved)} are available.`,
      409,
    );
  }

  async claimNext(id: string, claimId: string, now = Date.now()): Promise<ClaimedStep | null> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE tasks_operation_steps SET state='accepted',claim_id=NULL,claim_until=NULL
        WHERE operation_id=? AND state='claimed' AND claim_until<=?
        AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=tasks_operation_steps.operation_id AND terminal_at IS NULL)`,
        )
        .bind(id, now),
      this.db
        .prepare(
          `UPDATE tasks_operation_steps SET state='uncertain'
        WHERE operation_id=? AND state='dispatched' AND response_json IS NULL AND claim_until<=?
        AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=tasks_operation_steps.operation_id AND terminal_at IS NULL)`,
        )
        .bind(id, now),
      this.db
        .prepare(
          `UPDATE tasks_operations SET state='uncertain',updated_at=? WHERE id=? AND terminal_at IS NULL
        AND EXISTS(SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND state='uncertain')`,
        )
        .bind(now, id, id),
    ]);
    const result = await this.db
      .prepare(
        `UPDATE tasks_operation_steps SET
      state=CASE WHEN response_json IS NULL THEN 'claimed' ELSE 'dispatched' END,
      claim_id=?,claim_until=?,attempts=attempts+1
      WHERE operation_id=? AND item_key=(SELECT item_key FROM tasks_operation_steps WHERE operation_id=?
        AND state NOT IN ('confirmed','cancelled') ORDER BY position LIMIT 1)
      AND (state='accepted' OR (state='dispatched' AND response_json IS NOT NULL AND claim_until<=?))
      AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND terminal_at IS NULL AND (cancel_requested=0 OR response_json IS NOT NULL) AND input_sealed=1
        AND state IN ('accepted','running','partial')) RETURNING *`,
      )
      .bind(claimId, now + claimDuration, id, id, now, now, id)
      .first<StepRow>();
    if (!result) return null;
    await this.db
      .prepare(
        "UPDATE tasks_operations SET state='running',updated_at=? WHERE id=? AND terminal_at IS NULL AND state IN ('accepted','running','partial')",
      )
      .bind(now, id)
      .run();
    return { ...stepRecord(result), mode: result.response_json === null ? 'dispatch' : 'repair' };
  }

  async markDispatched(
    id: string,
    key: string,
    claimId: string,
    now = Date.now(),
    guards: D1PreparedStatement[] = [],
    dispatchInput?: unknown,
  ): Promise<void> {
    const inputJson = dispatchInput === undefined ? null : boundedJson(dispatchInput);
    const operation = await this.db
      .prepare('SELECT account_id FROM tasks_operations WHERE id=?')
      .bind(id)
      .first<{ account_id: string }>();
    if (!operation) throw new AppError('not_found', 'this operation is no longer available.', 404);
    try {
      const results = await this.db.batch([
        providerWriteGuard(this.db, operation.account_id),
        ...guards,
        this.db
          .prepare(
            `UPDATE tasks_operation_steps SET state='dispatched',dispatched_at=?,input_json=COALESCE(?,input_json)
          WHERE operation_id=? AND item_key=? AND state='claimed' AND claim_id=? AND claim_until>?
          AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND cancel_requested=0 AND terminal_at IS NULL)`,
          )
          .bind(now, inputJson, id, key, claimId, now, id),
      ]);
      if (!results[1 + guards.length]?.meta.changes)
        throw new AppError(
          'conflict',
          'this step was cancelled, expired, or already dispatched.',
          409,
        );
    } catch (error) {
      if (error instanceof AppError) throw error;
      await assertProviderWritable(this.db, operation.account_id);
      throw new AppError(
        'storage_unavailable',
        'dispatch could not be recorded. no provider request was sent.',
        503,
        true,
      );
    }
  }

  async recordResponse(
    id: string,
    key: string,
    claimId: string,
    response: unknown,
    now = Date.now(),
  ): Promise<void> {
    const json = boundedJson(response);
    const result = await this.db
      .prepare(
        `UPDATE tasks_operation_steps SET response_json=?,state='dispatched',claim_until=?
      WHERE operation_id=? AND item_key=? AND claim_id=? AND state IN ('dispatched','uncertain') AND response_json IS NULL AND owner_stopped_at IS NULL
      AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=tasks_operation_steps.operation_id AND terminal_at IS NULL)`,
      )
      .bind(json, now + claimDuration, id, key, claimId)
      .run();
    if (!result.meta.changes) {
      const step = await this.getStep(id, key);
      const stopped = await this.db
        .prepare(
          'SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND item_key=? AND owner_stopped_at IS NOT NULL',
        )
        .bind(id, key)
        .first();
      if (!stopped && step && step.response !== null && boundedJson(step.response) === json) return;
      throw new AppError(
        'conflict',
        'this provider receipt no longer belongs to the dispatched step.',
        409,
      );
    }
    await this.db
      .prepare(
        `UPDATE tasks_operations SET state='running',updated_at=? WHERE id=? AND state='uncertain' AND terminal_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND state='uncertain')`,
      )
      .bind(now, id, id)
      .run();
  }

  async getResolution(
    operationId: string,
    stepKey: string,
    accountId: string,
  ): Promise<{ responseHash: string; evidence: ResolutionEvidence; createdAt: number } | null> {
    const row = await this.db
      .prepare(
        'SELECT response_hash,evidence_json,created_at FROM tasks_operation_resolutions WHERE operation_id=? AND item_key=? AND account_id=?',
      )
      .bind(operationId, stepKey, accountId)
      .first<{ response_hash: string; evidence_json: string; created_at: number }>();
    return row
      ? {
          responseHash: row.response_hash,
          evidence: JSON.parse(row.evidence_json) as ResolutionEvidence,
          createdAt: row.created_at,
        }
      : null;
  }

  async getStoppedIntent(
    operationId: string,
    stepKey: string,
    accountId: string,
  ): Promise<StoppedIntent | null> {
    return this.readStoppedIntent(operationId, accountId, stepKey);
  }

  async findStoppedIntent(operationId: string, accountId: string): Promise<StoppedIntent | null> {
    return this.readStoppedIntent(operationId, accountId);
  }

  private async readStoppedIntent(
    operationId: string,
    accountId: string,
    stepKey?: string,
  ): Promise<StoppedIntent | null> {
    const row = await this.db
      .prepare(
        `SELECT item_key,expected_claim_id,response_hash,evidence_json,decision,created_at
      FROM tasks_operation_stops WHERE operation_id=? AND account_id=? ${stepKey === undefined ? '' : 'AND item_key=?'} LIMIT 1`,
      )
      .bind(operationId, accountId, ...(stepKey === undefined ? [] : [stepKey]))
      .first<{
        item_key: string;
        expected_claim_id: string | null;
        response_hash: string | null;
        evidence_json: string;
        decision: 'keep_provider_current';
        created_at: number;
      }>();
    return row
      ? {
          stepKey: row.item_key,
          expectedClaimId: row.expected_claim_id,
          expectedResponseHash: row.response_hash,
          evidence: JSON.parse(row.evidence_json) as ResolutionEvidence,
          decision: row.decision,
          createdAt: row.created_at,
        }
      : null;
  }

  /** Stops the automation intent. It neither confirms nor disproves the issued provider effect.
   * The owner supplies readback/CAS projection writes; this batch owns their settlement. */
  async stopRecordedIntent(
    input: StopRecordedIntent,
    writes: D1PreparedStatement[],
    now = Date.now(),
  ): Promise<void> {
    const { operationId, accountId, stepKey, expectedClaimId, decision } = input;
    const evidence = boundedJson(input.evidence);
    if (
      decision !== 'keep_provider_current' ||
      !['owner_candidate', 'provider_readback'].includes(input.evidence.kind) ||
      typeof input.evidence.providerId !== 'string' ||
      !input.evidence.providerId ||
      input.evidence.providerId.length > 2048 ||
      Object.keys(input.evidence).some(
        (key) => !['kind', 'providerId', 'etag', 'digest'].includes(key),
      ) ||
      (input.evidence.etag !== undefined &&
        (typeof input.evidence.etag !== 'string' || input.evidence.etag.length > 2048)) ||
      (input.evidence.digest !== undefined &&
        (typeof input.evidence.digest !== 'string' || input.evidence.digest.length > 256)) ||
      new TextEncoder().encode(evidence).length > 4096
    )
      throw new AppError('validation_failed', 'provide bounded exact-identity stop evidence.', 400);
    const response = input.expectedResponse === null ? null : boundedJson(input.expectedResponse);
    const responseHash = response === null ? null : await hash(response);
    const matches = (prior: StoppedIntent | null) =>
      prior !== null &&
      prior.expectedClaimId === expectedClaimId &&
      prior.expectedResponseHash === responseHash &&
      prior.decision === decision &&
      boundedJson(prior.evidence) === evidence;
    const prior = await this.getStoppedIntent(operationId, stepKey, accountId);
    if (prior) {
      if (matches(prior)) return;
      throw new AppError(
        'conflict',
        'this intent was already stopped with different provider evidence.',
        409,
      );
    }
    await assertLocalWritable(this.db, accountId);
    try {
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.db
          .prepare(
            `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS
          (SELECT 1 FROM tasks_operations o JOIN tasks_operation_steps s ON s.operation_id=o.id
           WHERE o.id=? AND o.account_id=? AND o.terminal_at IS NULL AND s.item_key=?
           AND s.claim_id IS ? AND s.response_json IS ? AND s.state IN('dispatched','uncertain') AND s.owner_stopped_at IS NULL AND COALESCE(s.claim_until,0)<=?
           AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps active WHERE active.operation_id=o.id
             AND active.state IN('claimed','dispatched','uncertain') AND COALESCE(active.claim_until,0)>?)
           AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps issued WHERE issued.operation_id=o.id
             AND issued.item_key<>s.item_key AND issued.state IN('dispatched','uncertain')))`,
          )
          .bind(operationId, accountId, stepKey, expectedClaimId, response, now, now),
        this.db
          .prepare(
            `INSERT INTO tasks_operation_stops(operation_id,item_key,account_id,expected_claim_id,response_hash,evidence_json,decision,created_at)
          VALUES(?,?,?,?,?,?,?,?)`,
          )
          .bind(
            operationId,
            stepKey,
            accountId,
            expectedClaimId,
            responseHash,
            evidence,
            decision,
            now,
          ),
        ...writes,
        this.db
          .prepare(
            `UPDATE tasks_operation_steps SET state='uncertain',owner_stopped_at=?,claim_id=NULL,claim_until=NULL,next_attempt_at=NULL,error_code='owner_stopped'
          WHERE operation_id=? AND item_key=?`,
          )
          .bind(now, operationId, stepKey),
        this.db
          .prepare(
            `UPDATE tasks_operation_steps SET state='cancelled',claim_id=NULL,claim_until=NULL,next_attempt_at=NULL
          WHERE operation_id=? AND state IN('accepted','claimed')`,
          )
          .bind(operationId),
        this.db
          .prepare(
            `UPDATE tasks_operations SET state='partial',cancel_requested=1,terminal_at=?,updated_at=?,next_attempt_at=NULL,
          error_code='owner_stopped',error_message=? WHERE id=?`,
          )
          .bind(now, now, failureMessage('owner_stopped'), operationId),
        // A selected current list does not prove that no other create reached Google.
        // Invalidate capacity before releasing any uncertain or unsent reservation.
        this.db
          .prepare(
            `UPDATE tasks_account_state SET inventory_complete_at=NULL,inventory_revision=inventory_revision+1
          WHERE account_id=? AND EXISTS(SELECT 1 FROM tasks_list_reservations WHERE operation_id=? AND remaining>0)`,
          )
          .bind(accountId, operationId),
        this.db
          .prepare('UPDATE tasks_list_reservations SET remaining=0 WHERE operation_id=?')
          .bind(operationId),
      ]);
    } catch (error) {
      if (matches(await this.getStoppedIntent(operationId, stepKey, accountId))) return;
      await assertLocalWritable(this.db, accountId);
      if (error instanceof AppError) throw error;
      throw new AppError(
        'conflict',
        'this issued intent, its provider receipt, or the current projection changed. refresh its resolution.',
        409,
      );
    }
  }

  /** A server owner verifies the exact provider address first; browser input is never a provider receipt. */
  async resolveUnknownResponse(input: ResolveUnknownResponse, now = Date.now()): Promise<void> {
    const { operationId, accountId, stepKey, expectedClaimId } = input;
    const response = boundedJson(input.response),
      responseHash = await hash(response),
      evidence = boundedJson(input.evidence);
    if (
      !['owner_candidate', 'provider_readback'].includes(input.evidence.kind) ||
      !input.evidence.providerId ||
      input.evidence.providerId.length > 2048 ||
      evidence.length > 4096
    )
      throw new AppError(
        'validation_failed',
        'provide bounded exact-identity resolution evidence.',
        400,
      );
    const prior = await this.getResolution(operationId, stepKey, accountId);
    if (prior) {
      if (prior.responseHash !== responseHash || boundedJson(prior.evidence) !== evidence)
        throw new AppError(
          'conflict',
          'this uncertainty was already resolved with different provider evidence.',
          409,
        );
      return;
    }
    await assertLocalWritable(this.db, accountId);
    try {
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.db
          .prepare(
            `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS
          (SELECT 1 FROM tasks_operations o JOIN tasks_operation_steps s ON s.operation_id=o.id
           WHERE o.id=? AND o.account_id=? AND o.terminal_at IS NULL AND s.item_key=? AND s.claim_id=? AND s.response_json IS NULL
           AND (s.state='uncertain' OR (s.state='dispatched' AND s.claim_until<=?)))`,
          )
          .bind(operationId, accountId, stepKey, expectedClaimId, now),
        this.db
          .prepare(
            'INSERT INTO tasks_operation_resolutions(operation_id,item_key,account_id,response_hash,evidence_json,created_at) VALUES(?,?,?,?,?,?)',
          )
          .bind(operationId, stepKey, accountId, responseHash, evidence, now),
        this.db
          .prepare(
            "UPDATE tasks_operation_steps SET response_json=?,state='dispatched',claim_id=NULL,claim_until=0,error_code=NULL,next_attempt_at=NULL WHERE operation_id=? AND item_key=?",
          )
          .bind(response, operationId, stepKey),
        this.db
          .prepare(
            "UPDATE tasks_operations SET state='partial',error_code=NULL,error_message=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?",
          )
          .bind(now, operationId),
      ]);
    } catch (error) {
      const replay = await this.getResolution(operationId, stepKey, accountId);
      if (replay?.responseHash === responseHash && boundedJson(replay.evidence) === evidence)
        return;
      if (error instanceof AppError) throw error;
      throw new AppError(
        'conflict',
        'this issued step changed or already has a provider receipt. refresh its resolution.',
        409,
      );
    }
  }

  /** Reopens local repair, never provider dispatch, after its required access has been restored. */
  async resumeRecordedResponse(
    operationId: string,
    stepKey: string,
    accountId: string,
    now = Date.now(),
  ): Promise<void> {
    await assertProviderWritable(this.db, accountId);
    const rows = await this.db.batch([
      providerWriteGuard(this.db, accountId),
      this.db
        .prepare(
          `UPDATE tasks_operation_steps SET state='dispatched',claim_id=NULL,claim_until=0,error_code=NULL,next_attempt_at=NULL
        WHERE operation_id=? AND item_key=? AND response_json IS NOT NULL AND (state='uncertain' OR (state='dispatched' AND claim_until<=?))
        AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND account_id=? AND terminal_at IS NULL)`,
        )
        .bind(operationId, stepKey, now, operationId, accountId),
      this.db
        .prepare(
          "UPDATE tasks_operations SET state='partial',error_code=NULL,error_message=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND account_id=? AND EXISTS(SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND item_key=? AND state='dispatched' AND response_json IS NOT NULL AND claim_until=0)",
        )
        .bind(now, operationId, accountId, operationId, stepKey),
    ]);
    if (!rows[1]?.meta.changes)
      throw new AppError(
        'conflict',
        'only a retained provider receipt can resume local repair.',
        409,
      );
  }

  async deferRepair(
    id: string,
    key: string,
    claimId: string,
    options: { retryAt: number; code?: ErrorCode },
    now = Date.now(),
  ): Promise<void> {
    if (!Number.isSafeInteger(options.retryAt) || options.retryAt < now)
      throw new AppError('validation_failed', 'repair retry needs a future instant.', 400);
    await this.setRepairWait(
      id,
      key,
      claimId,
      'partial',
      options.retryAt,
      options.code ?? null,
      now,
    );
  }

  async pauseRepair(
    id: string,
    key: string,
    claimId: string,
    options: { code: ErrorCode },
    now = Date.now(),
  ): Promise<void> {
    await this.setRepairWait(id, key, claimId, 'uncertain', null, options.code, now);
  }

  private async setRepairWait(
    id: string,
    key: string,
    claimId: string,
    state: 'partial' | 'uncertain',
    retryAt: number | null,
    code: ErrorCode | null,
    now: number,
  ): Promise<void> {
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS
          (SELECT 1 FROM tasks_operation_steps s JOIN tasks_operations o ON o.id=s.operation_id
           WHERE s.operation_id=? AND s.item_key=? AND s.claim_id=? AND s.state='dispatched' AND s.response_json IS NOT NULL AND o.terminal_at IS NULL)`,
          )
          .bind(id, key, claimId),
        this.db
          .prepare(
            `UPDATE tasks_operation_steps SET state=?,claim_until=?,next_attempt_at=?,error_code=? WHERE operation_id=? AND item_key=?`,
          )
          .bind(state === 'uncertain' ? 'uncertain' : 'dispatched', now, retryAt, code, id, key),
        this.db
          .prepare(
            `UPDATE tasks_operations SET state=?,updated_at=?,next_attempt_at=?,error_code=?,error_message=? WHERE id=?`,
          )
          .bind(state, now, retryAt, code, code ? failureMessage(code) : null, id),
      ]);
    } catch {
      throw new AppError(
        'conflict',
        'this repair no longer owns the recorded provider response.',
        409,
      );
    }
  }

  async appendSteps(
    id: string,
    accountId: string,
    steps: readonly { key: string; kind: string; input: unknown; position: number }[],
  ): Promise<void> {
    const operation = await this.get(id, accountId);
    if (!operation) throw new AppError('not_found', 'this operation is no longer available.', 404);
    if (
      !steps.length ||
      steps.length > 10 ||
      steps.some(
        (step) =>
          !Number.isInteger(step.position) ||
          step.position < 0 ||
          step.position >= operation.totalSteps,
      )
    )
      throw new AppError(
        'validation_failed',
        'append one to ten steps at their captured positions.',
        400,
      );
    const encoded = steps.map((step) => ({ ...step, json: boundedJson(step.input) }));
    let allPresent = true;
    for (const step of encoded) {
      const prior = await this.getStep(id, step.key);
      if (!prior) {
        allPresent = false;
        continue;
      }
      if (
        prior.kind !== step.kind ||
        prior.position !== step.position ||
        boundedJson(prior.input) !== step.json
      )
        throw new AppError('conflict', 'this captured item already has different input.', 409);
    }
    if (allPresent) return;
    if (operation.inputSealed || operation.cancelRequested || operation.state !== 'accepted')
      throw new AppError('conflict', 'this plan is already sealed or cancelled.', 409);
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS
          (SELECT 1 FROM tasks_operations WHERE id=? AND account_id=? AND input_sealed=0 AND cancel_requested=0 AND state='accepted')`,
          )
          .bind(id, accountId),
        ...encoded.flatMap((step) => [
          this.db
            .prepare(
              `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE EXISTS
            (SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND (item_key=? OR position=?)
             AND (item_key<>? OR position<>? OR kind<>? OR input_json<>?))`,
            )
            .bind(id, step.key, step.position, step.key, step.position, step.kind, step.json),
          this.db
            .prepare(
              `INSERT INTO tasks_operation_steps(operation_id,item_key,position,kind,input_json,state,list_slot)
            VALUES (?,?,?,?,?,'accepted',?) ON CONFLICT(operation_id,item_key) DO NOTHING`,
            )
            .bind(
              id,
              step.key,
              step.position,
              step.kind,
              step.json,
              step.kind === 'list.create' ? 1 : 0,
            ),
        ]),
      ]);
    } catch {
      throw new AppError('conflict', 'this plan was sealed or its captured input changed.', 409);
    }
  }

  async seal(id: string, accountId: string): Promise<void> {
    const operation = await this.get(id, accountId);
    if (!operation) throw new AppError('not_found', 'this operation is no longer available.', 404);
    if (operation.inputSealed) return;
    const result = await this.db
      .prepare(
        `UPDATE tasks_operations SET input_sealed=1 WHERE id=? AND account_id=? AND input_sealed=0 AND cancel_requested=0 AND state='accepted'
      AND total_steps=(SELECT COUNT(*) FROM tasks_operation_steps WHERE operation_id=?)
      AND (SELECT MIN(position) FROM tasks_operation_steps WHERE operation_id=?)=0
      AND (SELECT MAX(position) FROM tasks_operation_steps WHERE operation_id=?)=total_steps-1
      AND (SELECT COALESCE(SUM(list_slot),0) FROM tasks_operation_steps WHERE operation_id=?)=(SELECT slots FROM tasks_list_reservations WHERE operation_id=?)`,
      )
      .bind(id, accountId, id, id, id, id, id)
      .run();
    if (!result.meta.changes)
      throw new AppError(
        'conflict',
        'capture the complete validated plan before starting provider work.',
        409,
      );
  }

  private finishWrites(
    id: string,
    key: string,
    result: unknown,
    now: number,
  ): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `UPDATE tasks_operation_steps SET state='confirmed',result_json=?,claim_until=NULL WHERE operation_id=? AND item_key=?`,
        )
        .bind(boundedJson(result), id, key),
      this.db
        .prepare(
          'UPDATE tasks_operations SET confirmed_steps=confirmed_steps+1,updated_at=? WHERE id=?',
        )
        .bind(now, id),
      this.db
        .prepare(
          `UPDATE tasks_operations SET state=CASE WHEN error_code='destination_removed' THEN 'partial' WHEN cancel_requested=1 THEN 'cancelled' ELSE 'succeeded' END,terminal_at=?,updated_at=?,result_json=?
        WHERE id=? AND input_sealed=1 AND (confirmed_steps=total_steps OR (cancel_requested=1 AND NOT EXISTS
          (SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND state NOT IN ('confirmed','cancelled'))))`,
        )
        .bind(now, now, boundedJson(result), id, id),
      this.db
        .prepare(
          `UPDATE tasks_list_reservations SET remaining=0 WHERE operation_id=?
        AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND terminal_at IS NOT NULL)`,
        )
        .bind(id, id),
    ];
  }

  async commitLocalStep(
    id: string,
    key: string,
    claimId: string,
    result: unknown,
    writes: D1PreparedStatement[],
    now = Date.now(),
  ): Promise<D1Result[]> {
    const previous = await this.getStep(id, key);
    if (previous?.state === 'confirmed') return [];
    const operationRow = await this.db
      .prepare('SELECT account_id FROM tasks_operations WHERE id=?')
      .bind(id)
      .first<{ account_id: string }>();
    if (!operationRow)
      throw new AppError('not_found', 'this operation is no longer available.', 404);
    try {
      const outcome = await this.db.batch([
        localWriteGuard(this.db, operationRow.account_id),
        this.db
          .prepare(
            `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS
          (SELECT 1 FROM tasks_operation_steps s JOIN tasks_operations o ON o.id=s.operation_id
           WHERE s.operation_id=? AND s.item_key=? AND s.state='claimed' AND s.claim_id=? AND s.claim_until>?
           AND o.cancel_requested=0 AND o.input_sealed=1 AND o.terminal_at IS NULL)`,
          )
          .bind(id, key, claimId, now),
        ...writes,
        ...this.finishWrites(id, key, result, now),
      ]);
      return outcome.slice(2, 2 + writes.length);
    } catch (error) {
      await assertLocalWritable(this.db, operationRow.account_id);
      const step = await this.getStep(id, key);
      if (step?.state === 'confirmed') return [];
      if (
        !step ||
        step.state !== 'claimed' ||
        step.claimId !== claimId ||
        (step.claimUntil ?? 0) <= now
      )
        throw new AppError('conflict', 'this local step no longer owns the execution claim.', 409);
      // The owning command interprets its own SQL precondition failure.
      throw error;
    }
  }

  async commitStep(
    id: string,
    key: string,
    claimId: string,
    result: unknown,
    writes: D1PreparedStatement[],
    now = Date.now(),
  ): Promise<void> {
    const previous = await this.getStep(id, key);
    if (previous?.state === 'confirmed') return;
    const capacityWrites = previous?.listSlot
      ? [
          this.db
            .prepare(
              `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS
        (SELECT 1 FROM tasks_list_reservations r JOIN tasks_operation_steps s ON s.operation_id=r.operation_id
         JOIN tasks_lists l ON l.account_id=r.account_id AND l.provider_id=json_extract(s.response_json,'$.id') AND l.deleted_at IS NULL
         WHERE r.operation_id=? AND s.item_key=? AND r.remaining>=1)`,
            )
            .bind(id, key),
          this.db
            .prepare(
              `UPDATE tasks_account_state SET inventory_count=inventory_count+CASE WHEN EXISTS
        (SELECT 1 FROM tasks_operation_steps s JOIN tasks_lists l ON l.account_id=tasks_account_state.account_id
         AND l.provider_id=json_extract(s.response_json,'$.id') WHERE s.operation_id=? AND s.item_key=?
         AND l.last_seen_scan=tasks_account_state.last_complete_scan_id AND tasks_account_state.last_complete_scan_id IS NOT NULL)
        THEN 0 ELSE 1 END,inventory_revision=inventory_revision+1
        WHERE account_id=(SELECT account_id FROM tasks_operations WHERE id=?)`,
            )
            .bind(id, key, id),
          this.db
            .prepare(
              'UPDATE tasks_list_reservations SET remaining=remaining-1 WHERE operation_id=?',
            )
            .bind(id),
        ]
      : [];
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS
          (SELECT 1 FROM tasks_operation_steps s JOIN tasks_operations o ON o.id=s.operation_id
           WHERE s.operation_id=? AND s.item_key=? AND s.state='dispatched'
           AND s.claim_id=? AND s.response_json IS NOT NULL AND o.terminal_at IS NULL)`,
          )
          .bind(id, key, claimId),
        ...writes,
        ...capacityWrites,
        ...this.finishWrites(id, key, result, now),
      ]);
    } catch {
      if ((await this.getStep(id, key))?.state === 'confirmed') return;
      if (
        await this.db
          .prepare(
            'SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND item_key=? AND owner_stopped_at IS NOT NULL',
          )
          .bind(id, key)
          .first()
      )
        throw new AppError('conflict', 'the owner stopped applying this issued intent.', 409);
      throw new AppError(
        'storage_unavailable',
        'google returned a receipt, but local changes still need repair. the provider request will not be repeated.',
        503,
        true,
        undefined,
        id,
      );
    }
  }

  async cancel(id: string, accountId: string, now = Date.now()): Promise<void> {
    const existing = await this.get(id, accountId);
    if (!existing) throw new AppError('not_found', 'this operation is no longer available.', 404);
    if (existing.finished) return;
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE tasks_operations SET cancel_requested=1,updated_at=? WHERE id=? AND account_id=?',
        )
        .bind(now, id, accountId),
      this.db
        .prepare(
          "UPDATE tasks_operation_steps SET state='cancelled',claim_until=NULL WHERE operation_id=? AND state IN ('accepted','claimed')",
        )
        .bind(id),
      this.db
        .prepare(
          `UPDATE tasks_operations SET state='cancelled',terminal_at=? WHERE id=? AND account_id=?
        AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps WHERE operation_id=? AND state IN ('dispatched','uncertain'))`,
        )
        .bind(now, id, accountId, id),
      this.db
        .prepare(
          `UPDATE tasks_list_reservations SET remaining=MIN(remaining,
        (SELECT COALESCE(SUM(list_slot),0) FROM tasks_operation_steps WHERE operation_id=? AND state IN ('dispatched','uncertain')))
        WHERE operation_id=?`,
        )
        .bind(id, id),
    ]);
  }
}
