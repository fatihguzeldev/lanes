import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../shared/contracts/errors';
import type { ProviderAccess } from './provider-access';
import {
  RemoveAccountSchema,
  type AccountLifecycleStatus,
  type DisconnectStatus,
  type RemovalStatus,
  type RemoveAccount,
} from './lifecycle-contract';

export interface LifecycleOwner {
  name: string;
  pause(accountId: string): Promise<{ done: boolean; pending: boolean }>;
  remove(accountId: string, limit: number): Promise<{ done: boolean; deleted: number }>;
  hasUnresolved(accountId: string): Promise<boolean>;
}
export interface AccountLifecycleOptions {
  access: Pick<ProviderAccess, 'requestDisconnect' | 'finalizeDisconnect'>;
  owners: readonly LifecycleOwner[];
  now?: () => number;
  id?: () => string;
}
async function subjectHash(subject: string): Promise<string> {
  if (!subject || subject.length > 512)
    throw new AppError(
      'validation_failed',
      'provide a verified google subject for the account link fence',
      422,
    );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode('lanes-account-removal:' + subject),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function accountRelinkFence(
  subject: string,
  startedAt: number,
): Promise<{ sql: string; values: (string | number)[] }> {
  if (!Number.isSafeInteger(startedAt) || startedAt < 0)
    throw new AppError('validation_failed', 'preserve the original authorization start time', 422);
  return {
    sql: 'NOT EXISTS(SELECT 1 FROM accounts_removed_subjects WHERE subject_hash=? AND fresh_after>=?)',
    values: [await subjectHash(subject), startedAt],
  };
}
export async function assertAccountLinkFresh(
  db: D1Database,
  subject: string,
  startedAt: number,
): Promise<{ sql: string; values: (string | number)[] }> {
  const fence = await accountRelinkFence(subject, startedAt);
  if (
    !(await db
      .prepare(`SELECT 1 AS fresh WHERE ${fence.sql}`)
      .bind(...fence.values)
      .first())
  )
    throw new AppError(
      'conflict',
      'this authorization began before local account removal finished. start a new account link.',
      409,
    );
  return fence;
}
export async function maintainAccountLifecycle(
  db: D1Database,
  now = Date.now(),
  limit = 100,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new AppError('validation_failed', 'clean at most 100 expired account link fences', 422);
  return (
    await db
      .prepare(
        'DELETE FROM accounts_removed_subjects WHERE subject_hash IN(SELECT subject_hash FROM accounts_removed_subjects WHERE fresh_after<? ORDER BY fresh_after LIMIT ?)',
      )
      .bind(now - 86_400_000, limit)
      .run()
  ).meta.changes;
}
export async function assertAccountNotRemoving(db: D1Database, accountId: string): Promise<void> {
  const row = await db
    .prepare('SELECT removal_requested_at FROM accounts_connections WHERE id=?')
    .bind(accountId)
    .first<{ removal_requested_at: number | null }>();
  if (row?.removal_requested_at !== null && row?.removal_requested_at !== undefined)
    throw new AppError(
      'conflict',
      'this account’s local data is being removed. wait until removal finishes before linking it again.',
      409,
    );
}
export function accountRemovalGuard(db: D1Database, accountId: string): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO accounts_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM accounts_connections WHERE id=? AND state='disconnected' AND grant_ciphertext IS NULL AND removal_requested_at IS NOT NULL)",
    )
    .bind(accountId);
}
export class AccountLifecycle {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly ownerNames: string;
  constructor(
    private readonly db: D1Database,
    private readonly options: AccountLifecycleOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
    const names = options.owners.map((owner) => owner.name);
    if (
      !names.length ||
      names.length > 20 ||
      new Set(names).size !== names.length ||
      names.some((name) => !/^[a-z][a-z_-]{0,63}$/.test(name))
    )
      throw new AppError(
        'installation_unavailable',
        'lifecycle owners need distinct stable names in dependency order',
        503,
      );
    this.ownerNames = JSON.stringify(names);
  }
  private async connection(accountId: string) {
    if (!accountId || accountId.length > 256)
      throw new AppError('validation_failed', 'choose a connected account', 422);
    return this.db
      .prepare(
        'SELECT id,google_subject,state,revision,grant_ciphertext IS NOT NULL AS has_grant,removal_requested_at FROM accounts_connections WHERE id=?',
      )
      .bind(accountId)
      .first<{
        id: string;
        google_subject: string;
        state: string;
        revision: number;
        has_grant: number;
        removal_requested_at: number | null;
      }>();
  }
  private async disconnectRow(accountId: string) {
    return this.db
      .prepare('SELECT * FROM accounts_disconnect_jobs WHERE account_id=?')
      .bind(accountId)
      .first<DisconnectRow>();
  }
  private async removalRow(accountId: string) {
    return this.db
      .prepare('SELECT * FROM accounts_removal_jobs WHERE account_id=?')
      .bind(accountId)
      .first<RemovalRow>();
  }
  private ownersMatch(value: string): void {
    if (value !== this.ownerNames)
      throw new AppError(
        'installation_unavailable',
        'the lifecycle owner order changed while work was unfinished; restore its recorded owner order before continuing',
        503,
      );
  }
  private disconnectStatus(row: DisconnectRow, state: string): DisconnectStatus {
    return {
      accountId: row.account_id,
      state: state === 'disconnected' ? 'disconnected' : 'disconnecting',
      pending: row.phase !== 'completed',
      remoteRevocation: row.remote_revocation,
      pausedOwners: row.owner_position,
      totalOwners: JSON.parse(row.owner_names_json).length as number,
      nextAttemptAt: row.next_at,
      errorCode: row.error_code,
    };
  }
  private removalStatus(row: RemovalRow): RemovalStatus {
    return {
      id: row.id,
      accountId: row.account_id,
      state: row.state,
      owner:
        row.phase === 'owners'
          ? ((JSON.parse(row.owner_names_json) as string[])[row.owner_position] ?? null)
          : row.phase === 'completed'
            ? null
            : 'accounts',
      deletedRecords: row.deleted_records,
      nextAttemptAt: row.next_at,
      errorCode: row.error_code,
    };
  }
  private claimGuard(
    table: 'accounts_disconnect_jobs' | 'accounts_removal_jobs',
    accountId: string,
    claim: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO accounts_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM ${table} WHERE account_id=? AND claim_id=? AND claim_until>?)`,
      )
      .bind(accountId, claim, this.now());
  }
  async status(accountId: string): Promise<AccountLifecycleStatus> {
    const [account, disconnect, removal] = await Promise.all([
      this.connection(accountId),
      this.disconnectRow(accountId),
      this.removalRow(accountId),
    ]);
    return {
      disconnect:
        disconnect && account && ['disconnecting', 'disconnected'].includes(account.state)
          ? this.disconnectStatus(disconnect, account.state)
          : null,
      removal: removal ? this.removalStatus(removal) : null,
    };
  }
  async startDisconnect(accountId: string): Promise<DisconnectStatus> {
    await assertAccountNotRemoving(this.db, accountId);
    const [account, prior] = await Promise.all([
      this.connection(accountId),
      this.disconnectRow(accountId),
    ]);
    if (account?.state === 'disconnected' && prior?.phase === 'completed')
      return this.disconnectStatus(prior, account.state);
    const result = await this.options.access.requestDisconnect(accountId);
    await this.db
      .prepare(
        `INSERT INTO accounts_disconnect_jobs(account_id,owner_names_json,next_at,remote_revocation,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET owner_names_json=excluded.owner_names_json,owner_position=0,phase='pause',remote_revocation=excluded.remote_revocation,next_at=excluded.next_at,error_code=NULL,claim_id=NULL,claim_until=NULL,updated_at=excluded.updated_at WHERE accounts_disconnect_jobs.phase='completed'`,
      )
      .bind(accountId, this.ownerNames, this.now(), result.remoteRevocation, this.now(), this.now())
      .run();
    return (await this.status(accountId)).disconnect!;
  }
  async advanceDisconnect(accountId: string): Promise<DisconnectStatus> {
    const account = await this.connection(accountId);
    const existing = await this.disconnectRow(accountId);
    if (!account || !existing)
      throw new AppError('not_found', 'start disconnect before advancing this account', 404);
    if (existing.phase === 'completed') return this.disconnectStatus(existing, account.state);
    if (!['disconnecting', 'disconnected'].includes(account.state))
      throw new AppError('conflict', 'this account is no longer disconnecting', 409);
    this.ownersMatch(existing.owner_names_json);
    const claim = this.id();
    const job = await this.db
      .prepare(
        "UPDATE accounts_disconnect_jobs SET claim_id=?,claim_until=? WHERE account_id=? AND phase<>'completed' AND (next_at IS NULL OR next_at<=?) AND (claim_until IS NULL OR claim_until<=?) RETURNING *",
      )
      .bind(claim, this.now() + 45_000, accountId, this.now(), this.now())
      .first<DisconnectRow>();
    if (!job) return this.disconnectStatus(existing, account.state);
    try {
      if (job.phase === 'pause') {
        const owner = this.options.owners[job.owner_position];
        const progress = owner ? await owner.pause(accountId) : { done: true, pending: false };
        const position = job.owner_position + Number(progress.done && Boolean(owner));
        await this.db.batch([
          this.claimGuard('accounts_disconnect_jobs', accountId, claim),
          this.db
            .prepare(
              'UPDATE accounts_disconnect_jobs SET owner_position=?,phase=?,next_at=?,claim_id=NULL,claim_until=NULL,error_code=NULL,updated_at=? WHERE account_id=?',
            )
            .bind(
              position,
              position >= this.options.owners.length ? 'revoke' : 'pause',
              progress.pending ? this.now() + 1_000 : this.now(),
              this.now(),
              accountId,
            ),
        ]);
      } else {
        const current = await this.connection(accountId);
        const result =
          current?.state === 'disconnected'
            ? {
                pending: false,
                remoteRevocation:
                  job.remote_revocation === 'pending'
                    ? ('unknown' as const)
                    : job.remote_revocation,
              }
            : await this.options.access.finalizeDisconnect(accountId);
        await this.db.batch([
          this.claimGuard('accounts_disconnect_jobs', accountId, claim),
          this.db
            .prepare(
              'UPDATE accounts_disconnect_jobs SET phase=?,remote_revocation=?,next_at=?,claim_id=NULL,claim_until=NULL,error_code=NULL,updated_at=? WHERE account_id=?',
            )
            .bind(
              result.pending ? 'revoke' : 'completed',
              result.remoteRevocation,
              result.pending ? this.now() + 1_000 : null,
              this.now(),
              accountId,
            ),
        ]);
      }
    } catch (error) {
      await this.db
        .prepare(
          'UPDATE accounts_disconnect_jobs SET error_code=?,next_at=?,claim_id=NULL,claim_until=NULL,updated_at=? WHERE account_id=? AND claim_id=?',
        )
        .bind(
          error instanceof AppError ? error.code : 'storage_unavailable',
          error instanceof AppError && !error.retryable ? null : this.now() + 1_000,
          this.now(),
          accountId,
          claim,
        )
        .run();
      if (error instanceof AppError) throw error;
      throw new AppError(
        'storage_unavailable',
        'disconnect could not advance; the account remains fenced from new work',
        503,
        true,
      );
    }
    return (await this.status(accountId)).disconnect!;
  }
  async advanceNextDisconnect(): Promise<DisconnectStatus | null> {
    const job = await this.db
      .prepare(
        "SELECT account_id FROM accounts_disconnect_jobs WHERE next_at IS NOT NULL AND next_at<=? AND phase<>'completed' AND (claim_until IS NULL OR claim_until<=?) ORDER BY next_at,account_id LIMIT 1",
      )
      .bind(this.now(), this.now())
      .first<{ account_id: string }>();
    return job ? this.advanceDisconnect(job.account_id) : null;
  }
  async startRemoval(accountId: string, input: RemoveAccount): Promise<RemovalStatus> {
    const parsed = RemoveAccountSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'confirm local account removal using its current revision',
        422,
      );
    const prior = await this.removalRow(accountId);
    if (prior) return this.removalStatus(prior);
    const account = await this.connection(accountId);
    if (
      !account ||
      account.state !== 'disconnected' ||
      account.has_grant ||
      account.revision !== input.revision
    )
      throw new AppError(
        'conflict',
        'finish disconnect and refresh the account before removing its retained local data',
        409,
      );
    if (
      (await Promise.all(this.options.owners.map((owner) => owner.hasUnresolved(accountId)))).some(
        Boolean,
      )
    )
      throw new AppError(
        'outcome_uncertain',
        'resolve issued provider work before removing its local evidence',
        409,
      );
    const id = this.id();
    const hash = await subjectHash(account.google_subject);
    try {
      await this.db.batch([
        this.db
          .prepare(
            "INSERT INTO accounts_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM accounts_connections WHERE id=? AND revision=? AND state='disconnected' AND grant_ciphertext IS NULL AND removal_requested_at IS NULL)",
          )
          .bind(accountId, input.revision),
        this.db
          .prepare(
            'INSERT INTO accounts_removal_jobs(id,account_id,subject_hash,owner_names_json,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
          )
          .bind(id, accountId, hash, this.ownerNames, this.now(), this.now(), this.now()),
        this.db
          .prepare(
            'INSERT INTO accounts_removed_subjects(subject_hash,fresh_after) VALUES(?,?) ON CONFLICT(subject_hash) DO UPDATE SET fresh_after=MAX(fresh_after,excluded.fresh_after)',
          )
          .bind(hash, this.now()),
        this.db
          .prepare(
            'UPDATE accounts_connections SET removal_requested_at=?,revision=revision+1,updated_at=? WHERE id=?',
          )
          .bind(this.now(), this.now(), accountId),
      ]);
    } catch {
      const raced = await this.removalRow(accountId);
      if (raced) return this.removalStatus(raced);
      throw new AppError('conflict', 'the account changed before local removal was admitted', 409);
    }
    return this.removalStatus((await this.removalRow(accountId))!);
  }
  async advanceNextRemoval(): Promise<RemovalStatus | null> {
    const job = await this.db
      .prepare(
        'SELECT account_id FROM accounts_removal_jobs WHERE next_at IS NOT NULL AND next_at<=? AND (claim_until IS NULL OR claim_until<=?) ORDER BY next_at,created_at,id LIMIT 1',
      )
      .bind(this.now(), this.now())
      .first<{ account_id: string }>();
    return job ? this.advanceRemoval(job.account_id) : null;
  }
  async advanceRemoval(accountId: string): Promise<RemovalStatus> {
    const existing = await this.removalRow(accountId);
    if (!existing)
      throw new AppError('not_found', 'this account has no confirmed local removal', 404);
    if (existing.state === 'completed') return this.removalStatus(existing);
    this.ownersMatch(existing.owner_names_json);
    const claim = this.id();
    const job = await this.db
      .prepare(
        "UPDATE accounts_removal_jobs SET state='running',claim_id=?,claim_until=? WHERE account_id=? AND state<>'completed' AND (next_at IS NULL OR next_at<=?) AND (claim_until IS NULL OR claim_until<=?) RETURNING *",
      )
      .bind(claim, this.now() + 45_000, accountId, this.now(), this.now())
      .first<RemovalRow>();
    if (!job) return this.removalStatus(existing);
    try {
      if (
        (
          await Promise.all(this.options.owners.map((owner) => owner.hasUnresolved(accountId)))
        ).some(Boolean)
      )
        throw new AppError(
          'outcome_uncertain',
          'issued provider work still needs its retained local evidence',
          409,
        );
      let phase = job.phase;
      let position = job.owner_position;
      let deleted = 0;
      let completed = false;
      if (phase === 'owners') {
        const owner = this.options.owners[position];
        const progress = owner ? await owner.remove(accountId, 100) : { done: true, deleted: 0 };
        if (!Number.isInteger(progress.deleted) || progress.deleted < 0 || progress.deleted > 100)
          throw new AppError(
            'installation_unavailable',
            'a cleanup owner exceeded its bounded removal contract',
            503,
          );
        deleted = progress.deleted;
        position += Number(progress.done && Boolean(owner));
        if (position >= this.options.owners.length) phase = 'oauth';
      } else if (phase === 'oauth') {
        const result = await this.db.batch([
          accountRemovalGuard(this.db, accountId),
          this.db
            .prepare(
              'DELETE FROM accounts_oauth_states WHERE state_hash IN(SELECT state_hash FROM accounts_oauth_states WHERE account_id=? LIMIT 100)',
            )
            .bind(accountId),
        ]);
        deleted = result[1]?.meta.changes ?? 0;
        if (
          !(await this.db
            .prepare('SELECT 1 AS remaining FROM accounts_oauth_states WHERE account_id=? LIMIT 1')
            .bind(accountId)
            .first())
        )
          phase = 'disconnect_receipt';
      } else if (phase === 'disconnect_receipt') {
        const result = await this.db.batch([
          accountRemovalGuard(this.db, accountId),
          this.db
            .prepare('DELETE FROM accounts_disconnect_jobs WHERE account_id=?')
            .bind(accountId),
        ]);
        deleted = result[1]?.meta.changes ?? 0;
        phase = 'connection';
      } else if (phase === 'connection') {
        // Owner hooks have emptied their account-owned children before this row.
        await this.db.batch([
          this.claimGuard('accounts_removal_jobs', accountId, claim),
          accountRemovalGuard(this.db, accountId),
          this.db.prepare('DELETE FROM accounts_connections WHERE id=?').bind(accountId),
          this.db
            .prepare(
              'INSERT INTO accounts_removed_subjects(subject_hash,fresh_after) VALUES(?,?) ON CONFLICT(subject_hash) DO UPDATE SET fresh_after=MAX(fresh_after,excluded.fresh_after)',
            )
            .bind(job.subject_hash, this.now()),
          this.db
            .prepare(
              "UPDATE accounts_removal_jobs SET phase='completed',state='completed',subject_hash='',deleted_records=deleted_records+1,next_at=NULL,error_code=NULL,claim_id=NULL,claim_until=NULL,updated_at=?,completed_at=? WHERE account_id=?",
            )
            .bind(this.now(), this.now(), accountId),
        ]);
        return this.removalStatus((await this.removalRow(accountId))!);
      }
      await this.db.batch([
        this.claimGuard('accounts_removal_jobs', accountId, claim),
        this.db
          .prepare(
            'UPDATE accounts_removal_jobs SET owner_position=?,phase=?,state=?,deleted_records=deleted_records+?,next_at=?,error_code=NULL,claim_id=NULL,claim_until=NULL,updated_at=?,completed_at=? WHERE account_id=?',
          )
          .bind(
            position,
            phase,
            completed ? 'completed' : 'pending',
            deleted,
            completed ? null : this.now(),
            this.now(),
            completed ? this.now() : null,
            accountId,
          ),
      ]);
    } catch (error) {
      await this.db
        .prepare(
          "UPDATE accounts_removal_jobs SET state='blocked',error_code=?,next_at=?,claim_id=NULL,claim_until=NULL,updated_at=? WHERE account_id=? AND claim_id=?",
        )
        .bind(
          error instanceof AppError ? error.code : 'storage_unavailable',
          error instanceof AppError && !error.retryable ? null : this.now() + 1_000,
          this.now(),
          accountId,
          claim,
        )
        .run();
      if (error instanceof AppError) throw error;
      throw new AppError(
        'storage_unavailable',
        'local removal stopped before its next checkpoint; confirmed deletion remains recorded',
        503,
        true,
      );
    }
    return this.removalStatus((await this.removalRow(accountId))!);
  }
}

interface DisconnectRow {
  account_id: string;
  owner_names_json: string;
  owner_position: number;
  phase: 'pause' | 'revoke' | 'completed';
  remote_revocation: DisconnectStatus['remoteRevocation'];
  next_at: number | null;
  error_code: string | null;
}
interface RemovalRow {
  id: string;
  account_id: string;
  subject_hash: string;
  owner_names_json: string;
  owner_position: number;
  phase: 'owners' | 'oauth' | 'disconnect_receipt' | 'connection' | 'completed';
  state: RemovalStatus['state'];
  deleted_records: number;
  next_at: number | null;
  error_code: string | null;
}
