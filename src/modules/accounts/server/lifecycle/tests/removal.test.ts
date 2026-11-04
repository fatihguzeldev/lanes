import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { testDatabase, seedAccount } from '../../../../../../tests/sqlite-d1';
import { encryptToken } from '../../credentials/crypto';
import { accountGrantContext, type AccountConfig } from '../../oauth/account-service';
import { GOOGLE_TASKS_SCOPE } from '../../oauth/google';
import { ProviderAccess } from '../../credentials/provider-access';
import {
  AccountLifecycle,
  assertAccountNotRemoving,
  maintainAccountLifecycle,
  type LifecycleOwner,
} from '../removal';
import { OperationStore } from '../../../../tasks/server/operations';
import { TasksLifecycle } from '../../../../tasks/server/lifecycle';
import { AppError } from '../../../../../shared/contracts/errors';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskProjectionStore } from '../../../../tasks/server/projection';
import { TaskCommandService } from '../../../../tasks/server/commands/provider-commands';
import { RecurrenceService } from '../../../../tasks/server/recurrence';
const now = Date.parse('2026-11-02T12:00:00Z');
const config: AccountConfig = {
  origin: 'https://lanes.example',
  ownerEmail: 'owner@example.com',
  sessionKey: Buffer.alloc(32, 1).toString('base64url'),
  tokenKey: { id: 'key', value: Buffer.alloc(32, 2).toString('base64url') },
  google: {
    clientId: 'client',
    clientSecret: 'test-secret',
    redirectUri: 'https://lanes.example/auth/google/callback',
  },
};
describe('account lifecycle', () => {
  let fixture: ReturnType<typeof testDatabase>;
  let db: D1Database;
  let clock: number;
  let lifecycle: AccountLifecycle;
  let access: ProviderAccess;
  let owner: LifecycleOwner;
  let revoke: Mock<() => Promise<void>>;
  const row = (sql: string, ...bindings: (string | number)[]) =>
    db
      .prepare(sql)
      .bind(...bindings)
      .first<Record<string, unknown>>();
  beforeEach(async () => {
    fixture = testDatabase();
    db = fixture.db;
    clock = now;
    revoke = vi.fn(async () => {});
    await seedAccount(db, 'a', clock);
    await seedAccount(db, 'b', clock);
    await db
      .prepare(
        "INSERT INTO accounts_installation(id,owner_subject,bootstrap_email,owner_generation,token_key_id,created_at) VALUES(1,'owner',?,'generation','key',?)",
      )
      .bind(config.ownerEmail, clock)
      .run();
    const grant = {
      accessToken: 'access-test',
      refreshToken: 'refresh-test',
      tokenType: 'Bearer',
      expiresAt: clock + 3_600_000,
      scopes: [GOOGLE_TASKS_SCOPE],
    };
    await db
      .prepare(
        'UPDATE accounts_connections SET grant_ciphertext=?,scopes_json=?,access_expires_at=?,grant_expires_at=? WHERE id=?',
      )
      .bind(
        await encryptToken(JSON.stringify(grant), config.tokenKey, accountGrantContext('a')),
        JSON.stringify(grant.scopes),
        grant.expiresAt,
        clock + 7 * 86_400_000,
        'a',
      )
      .run();
    access = new ProviderAccess(db, config, { now: () => clock, revoke });
    owner = {
      name: 'example',
      pause: vi.fn(async () => ({ done: true, pending: false })),
      remove: vi.fn(async () => ({ done: true, deleted: 0 })),
      hasUnresolved: vi.fn(async () => false),
    };
    lifecycle = new AccountLifecycle(db, { access, owners: [owner], now: () => clock });
  });
  afterEach(() => fixture.close());
  async function disconnect() {
    await lifecycle.startDisconnect('a');
    for (let i = 0; i < 10; i++) {
      const status = await lifecycle.advanceDisconnect('a');
      if (!status.pending) return status;
      clock += 1_001;
    }
    throw new Error('disconnect stalled');
  }
  async function beginRemoval() {
    await disconnect();
    const revision = Number(
      (await row("SELECT revision FROM accounts_connections WHERE id='a'"))?.revision,
    );
    return lifecycle.startRemoval('a', { confirm: true, revision });
  }
  async function removeAll() {
    for (let i = 0; i < 200; i++) {
      const result = await lifecycle.advanceRemoval('a');
      if (result.state === 'completed') return result;
      clock += 1_001;
    }
    throw new Error('removal stalled');
  }
  it('pauses owners before revocation and preserves the disconnected workspace', async () => {
    await db
      .prepare(
        "INSERT INTO history_events(id,account_id,kind,origin,dedup_key,recorded_at,summary_json) VALUES('event','a','task_completed','observed','event',?,'{}')",
      )
      .bind(clock)
      .run();
    await lifecycle.startDisconnect('a');
    expect(revoke).not.toHaveBeenCalled();
    expect(await row("SELECT state FROM accounts_connections WHERE id='a'")).toMatchObject({
      state: 'disconnecting',
    });
    await lifecycle.advanceDisconnect('a');
    expect(owner.pause).toHaveBeenCalledWith('a');
    expect(revoke).not.toHaveBeenCalled();
    const status = await lifecycle.advanceDisconnect('a');
    expect(status).toMatchObject({
      state: 'disconnected',
      pending: false,
      remoteRevocation: 'succeeded',
    });
    expect((await row('SELECT COUNT(*) AS n FROM history_events'))?.n).toBe(1);
    expect(
      await row("SELECT grant_ciphertext FROM accounts_connections WHERE id='a'"),
    ).toMatchObject({ grant_ciphertext: null });
  });
  it('reports failed remote revocation while still erasing the local grant', async () => {
    revoke.mockRejectedValue(new Error('unavailable'));
    expect(await disconnect()).toMatchObject({ state: 'disconnected', remoteRevocation: 'failed' });
    expect(
      await row("SELECT grant_ciphertext FROM accounts_connections WHERE id='a'"),
    ).toMatchObject({ grant_ciphertext: null });
  });
  it('keeps disconnect pending while issued work is settling', async () => {
    owner.pause = vi.fn(async () => ({ done: false, pending: true }));
    await lifecycle.startDisconnect('a');
    expect(await lifecycle.advanceDisconnect('a')).toMatchObject({
      state: 'disconnecting',
      pending: true,
      nextAttemptAt: clock + 1_000,
    });
    expect(revoke).not.toHaveBeenCalled();
  });
  it('requires explicit removal confirmation, disconnected state, and resolved provider outcomes', async () => {
    await expect(lifecycle.startRemoval('a', { confirm: true, revision: 0 })).rejects.toMatchObject(
      { code: 'conflict' },
    );
    await disconnect();
    owner.hasUnresolved = vi.fn(async () => true);
    const revision = Number(
      (await row("SELECT revision FROM accounts_connections WHERE id='a'"))?.revision,
    );
    await expect(lifecycle.startRemoval('a', { confirm: true, revision })).rejects.toMatchObject({
      code: 'outcome_uncertain',
    });
    expect(await row("SELECT id FROM accounts_connections WHERE id='a'")).toBeTruthy();
  });
  it('removes one owner slice per request, then deletes the connection last', async () => {
    let remaining = 205;
    owner.remove = vi.fn(async (_account, limit) => {
      const deleted = Math.min(remaining, limit);
      remaining -= deleted;
      return { deleted, done: remaining === 0 };
    });
    await beginRemoval();
    const first = await lifecycle.advanceRemoval('a');
    expect(first.deletedRecords).toBe(100);
    expect(await row("SELECT id FROM accounts_connections WHERE id='a'")).toBeTruthy();
    const result = await removeAll();
    expect(result.state).toBe('completed');
    expect(await row("SELECT id FROM accounts_connections WHERE id='a'")).toBeNull();
    expect(await row("SELECT id FROM accounts_connections WHERE id='b'")).toBeTruthy();
    expect(owner.remove).toHaveBeenCalledTimes(3);
  });
  it('fences a late reconnect in SQLite for the entire local removal', async () => {
    await beginRemoval();
    await expect(assertAccountNotRemoving(db, 'a')).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      db
        .prepare(
          "UPDATE accounts_connections SET state='connecting',grant_ciphertext='late' WHERE id='a'",
        )
        .run(),
    ).rejects.toThrow();
    expect(
      await row("SELECT state,grant_ciphertext FROM accounts_connections WHERE id='a'"),
    ).toMatchObject({ state: 'disconnected', grant_ciphertext: null });
  });
  it('coalesces removal workers around a durable claim', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    owner.remove = async () => {
      calls++;
      await gate;
      return { done: true, deleted: 1 };
    };
    await beginRemoval();
    const first = lifecycle.advanceRemoval('a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await lifecycle.advanceRemoval('a');
    expect(calls).toBe(1);
    release();
    await first;
  });
  it('persists an honest unknown revocation receipt after a crash between credential erasure and receipt commit', async () => {
    await lifecycle.startDisconnect('a');
    await lifecycle.advanceDisconnect('a');
    await access.finalizeDisconnect('a');
    expect(await lifecycle.advanceDisconnect('a')).toMatchObject({
      state: 'disconnected',
      pending: false,
      remoteRevocation: 'unknown',
    });
  });
  it('task cleanup stays bounded and account-scoped without cascading a large subtree', async () => {
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES('list-a','a','ga','a'),('list-b','b','gb','b')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES('parent','a','list-a','gp','parent'),('keep','b','list-b','gk','keep')",
      )
      .run();
    await db
      .prepare(
        "WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,title) SELECT 'child-'||x,'a','list-a','parent','gc-'||x,'child' FROM n",
      )
      .run();
    const operations = new OperationStore(db);
    const tasks = new TasksLifecycle(db, {
      operations,
      commands: {
        advance: async () => {
          throw new Error('no provider repair expected');
        },
      },
      now: () => clock,
    });
    await db
      .prepare(
        "UPDATE accounts_connections SET state='disconnected',grant_ciphertext=NULL,removal_requested_at=? WHERE id='a'",
      )
      .bind(clock)
      .run();
    for (let i = 0; i < 80; i++) {
      const before = fixture.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      const result = await tasks.remove('a', 100);
      const after = fixture.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      expect(after - before).toBeLessThanOrEqual(100);
      if (result.done) break;
    }
    expect((await row("SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id='a'"))?.n).toBe(0);
    expect((await row("SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id='b'"))?.n).toBe(1);
  });
  it('commits final connection deletion and its completion receipt atomically', async () => {
    await beginRemoval();
    for (let i = 0; i < 8; i++) {
      if (
        (await row("SELECT phase FROM accounts_removal_jobs WHERE account_id='a'"))?.phase ===
        'connection'
      )
        break;
      await lifecycle.advanceRemoval('a');
    }
    let fail = true;
    const interrupted = {
      ...db,
      batch: async (statements: Parameters<D1Database['batch']>[0]) => {
        const sql = statements.map((statement) => (statement as unknown as { sql: string }).sql);
        if (fail && sql.some((value) => value.startsWith('DELETE FROM accounts_connections'))) {
          fail = false;
          if (!sql.some((value) => value.startsWith('UPDATE accounts_removal_jobs')))
            await db.batch(statements);
          throw new Error('interrupted final commit');
        }
        return db.batch(statements);
      },
    } as D1Database;
    const resumed = new AccountLifecycle(interrupted, {
      access,
      owners: [owner],
      now: () => clock,
    });
    await expect(resumed.advanceRemoval('a')).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    clock += 1_001;
    expect(await resumed.advanceRemoval('a')).toMatchObject({ state: 'completed' });
  });
  it('pauses unissued operation input and claims without dispatching or discarding the captured plan', async () => {
    const operations = new OperationStore(db);
    const id = now + ':unissuedabcdefghij';
    const admitted = await operations.admit(
      {
        id,
        accountId: 'a',
        ownerSubject: 'owner',
        kind: 'task.create',
        resourceKey: 'new-task',
        input: { title: 'kept' },
        steps: [{ key: 'create', kind: 'task.create', input: { title: 'kept' } }],
      },
      clock,
    );
    await operations.claimNext(id, 'claim', clock);
    await access.requestDisconnect('a');
    const advance = vi.fn(async () => {
      throw new Error('must not dispatch');
    });
    const tasks = new TasksLifecycle(db, { operations, commands: { advance }, now: () => clock });
    expect(await tasks.pause('a')).toMatchObject({ done: true, pending: false });
    expect(await operations.get(id, 'a')).toMatchObject({
      state: 'reconnect_required',
      input: admitted.input,
    });
    expect((await operations.getStep(id, 'create'))?.state).toBe('accepted');
    expect(advance).not.toHaveBeenCalled();
  });
  it('retains a receipt needing provider verification as unresolved and still permits local revoke', async () => {
    const operations = new OperationStore(db);
    const id = now + ':issuedabcdefghijkl';
    await operations.admit(
      {
        id,
        accountId: 'a',
        ownerSubject: 'owner',
        kind: 'task.move',
        resourceKey: 'task:source',
        input: {},
        steps: [{ key: 'move', kind: 'task.move', input: {} }],
      },
      clock,
    );
    await operations.claimNext(id, 'claim', clock);
    await operations.markDispatched(id, 'move', 'claim', clock);
    await operations.recordResponse(id, 'move', 'claim', { id: 'known-google-id' }, clock);
    const advance = vi.fn(async () => {
      throw new AppError('reconnect_required', 'verification needs google', 409);
    });
    const tasks = new TasksLifecycle(db, { operations, commands: { advance }, now: () => clock });
    await access.requestDisconnect('a');
    expect(await tasks.pause('a')).toMatchObject({ pending: true });
    expect(advance).not.toHaveBeenCalled();
    clock += 31_000;
    await tasks.pause('a');
    expect(await tasks.pause('a')).toMatchObject({ done: true, pending: false });
    expect(await tasks.hasUnresolved('a')).toBe(true);
    expect((await operations.getStep(id, 'move'))?.response).toEqual({ id: 'known-google-id' });
    expect(await access.finalizeDisconnect('a')).toMatchObject({ state: 'disconnected' });
  });
  it('leaves another owner’s known receipt available to that owner during disconnect', async () => {
    const operations = new OperationStore(db),
      id = now + ':sheetsabcdefghijklm';
    await operations.admit(
      {
        id,
        accountId: 'a',
        ownerSubject: 'owner',
        kind: 'sheets.export',
        resourceKey: 'sheets:one',
        input: {},
        steps: [{ key: 'sheets.create', kind: 'sheets.create', input: {} }],
      },
      clock,
    );
    await operations.claimNext(id, 'sheets-owner', clock);
    await operations.markDispatched(id, 'sheets.create', 'sheets-owner', clock);
    await operations.recordResponse(
      id,
      'sheets.create',
      'sheets-owner',
      { id: 'verified-sheet' },
      clock,
    );
    await access.requestDisconnect('a');
    clock += 31_000;
    const advance = vi.fn(async () => {
      throw new Error('foreign receipt must not reach Tasks');
    });
    const tasks = new TasksLifecycle(db, { operations, commands: { advance }, now: () => clock });
    expect(await tasks.pause('a')).toMatchObject({ done: false, pending: true });
    expect(advance).not.toHaveBeenCalled();
    expect(await operations.getStep(id, 'sheets.create')).toMatchObject({
      state: 'dispatched',
      response: { id: 'verified-sheet' },
    });
  });
  it('waits for an active sync reader and fences an expired reader before pausing its cursor', async () => {
    const operations = new OperationStore(db);
    const tasks = new TasksLifecycle(db, {
      operations,
      commands: {
        advance: async () => {
          throw new Error('no command');
        },
      },
      now: () => clock,
    });
    await access.requestDisconnect('a');
    await db
      .prepare(
        "INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,claim_id,claim_until) VALUES('a',?,?,'reader',?)",
      )
      .bind(clock, clock, clock + 20_000)
      .run();
    expect(await tasks.pause('a')).toMatchObject({ done: false, pending: true });
    clock += 21_000;
    await tasks.pause('a');
    expect(
      await row("SELECT claim_id,next_at FROM tasks_sync_jobs WHERE account_id='a'"),
    ).toMatchObject({ claim_id: null, next_at: Number.MAX_SAFE_INTEGER });
  });
  it('retains paused repeat rules and resumes only an explicitly selected rule after relink', async () => {
    const operations = new OperationStore(db);
    const tasks = new TasksLifecycle(db, {
      operations,
      commands: {
        advance: async () => {
          throw new Error('no command');
        },
      },
      now: () => clock,
    });
    const rule = JSON.stringify({
      frequency: 'daily',
      interval: 1,
      anchorDay: '2026-11-02',
      zone: 'UTC',
      weekStart: 1,
      weekdays: [],
      end: { type: 'never' },
    });
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES('list','a','gl','home')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,scheduled_day,repeat_rule_json) VALUES('repeat','a','list','gr','repeat','2026-11-02',?)",
      )
      .bind(rule)
      .run();
    await access.requestDisconnect('a');
    for (let i = 0; i < 8; i++) if ((await tasks.pause('a')).done) break;
    const history = new HistoryService(db);
    const commands = new TaskCommandService(db, {
      operations,
      projection: new TaskProjectionStore(db, { history }),
      history,
      clientFor: async () => {
        throw new Error('no provider request');
      },
    });
    const recurrence = new RecurrenceService(db, {
      operations,
      commands,
      ownerSubjectFor: async () => 'owner',
      now: () => clock,
    });
    expect(await recurrence.status('a', 'repeat')).toMatchObject({ state: 'paused' });
    await db
      .prepare(
        "UPDATE accounts_connections SET state='connected',disconnect_requested_at=NULL WHERE id='a'",
      )
      .run();
    expect(
      (await row("SELECT next_at FROM tasks_recurrence_watches WHERE task_id='repeat'"))?.next_at,
    ).toBe(Number.MAX_SAFE_INTEGER);
    await recurrence.resume('a', 'repeat');
    expect(await recurrence.status('a', 'repeat')).toMatchObject({ state: 'active' });
    expect(
      (await row("SELECT repeat_rule_json FROM tasks_tasks WHERE id='repeat'"))?.repeat_rule_json,
    ).toBe(rule);
  });
  it('empties journal and copy children before their parent rows within the same deletion budget', async () => {
    const operations = new OperationStore(db);
    const id = now + ':largerecordsabcdef';
    await operations.admit(
      {
        id,
        accountId: 'a',
        ownerSubject: 'owner',
        kind: 'copy.repetition',
        resourceKey: 'copy:large',
        input: {},
        steps: [{ key: 'first', kind: 'task.create', input: {} }],
        totalSteps: 1000,
      },
      clock,
    );
    await db
      .prepare(
        "WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<999) INSERT INTO tasks_operation_steps(operation_id,item_key,position,kind,input_json,state) SELECT ?,'step-'||x,x,'task.create','{}','accepted' FROM n",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "INSERT INTO tasks_command_plans(operation_id,account_id,owner_subject,request_json,capture_nonce,resource_key,total_steps,created_at) VALUES(?,'a','owner','{}','nonce','copy:large',1000,?)",
      )
      .bind(id, clock)
      .run();
    await db
      .prepare(
        "WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<200) INSERT INTO tasks_command_copy_entries(operation_id,item_key,position,task_id,input_json) SELECT ?,'item-'||x,x,'copy-task-'||x,'{}' FROM n",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        'INSERT INTO tasks_command_copy_receipts(operation_id,item_key,task_id,revision) SELECT operation_id,item_key,task_id,1 FROM tasks_command_copy_entries WHERE operation_id=?',
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "UPDATE accounts_connections SET state='disconnected',grant_ciphertext=NULL,removal_requested_at=? WHERE id='a'",
      )
      .bind(clock)
      .run();
    const tasks = new TasksLifecycle(db, {
      operations,
      commands: {
        advance: async () => {
          throw new Error('no HTTP');
        },
      },
    });
    for (let i = 0; i < 30; i++) {
      const before = fixture.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      const result = await tasks.remove('a', 100);
      const after = fixture.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      expect(after - before).toBeLessThanOrEqual(100);
      if (result.done) break;
    }
    expect((await row('SELECT COUNT(*) AS n FROM tasks_operation_steps'))?.n).toBe(0);
    expect((await row('SELECT COUNT(*) AS n FROM tasks_command_copy_receipts'))?.n).toBe(0);
    expect((await row('SELECT COUNT(*) AS n FROM tasks_operations'))?.n).toBe(0);
  });
  it('advances persisted disconnect work after the initiating browser is gone', async () => {
    await lifecycle.startDisconnect('a');
    expect(await lifecycle.advanceNextDisconnect()).toMatchObject({ pausedOwners: 1 });
    expect(await lifecycle.advanceNextDisconnect()).toMatchObject({
      state: 'disconnected',
      pending: false,
    });
    expect(await lifecycle.advanceNextDisconnect()).toBeNull();
  });
  it('preserves the known revocation outcome when disconnect is retried after completion', async () => {
    revoke.mockRejectedValue(new Error('provider unavailable'));
    await disconnect();
    expect(await lifecycle.startDisconnect('a')).toMatchObject({
      pending: false,
      remoteRevocation: 'failed',
    });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it('keeps only a short-lived hashed callback fence after local account removal', async () => {
    await beginRemoval();
    await removeAll();
    expect(
      (await row("SELECT subject_hash FROM accounts_removal_jobs WHERE account_id='a'"))
        ?.subject_hash,
    ).toBe('');
    expect((await row('SELECT COUNT(*) AS n FROM accounts_removed_subjects'))?.n).toBe(1);
    clock += 86_400_001;
    expect(await maintainAccountLifecycle(db, clock, 100)).toBe(1);
    expect((await row('SELECT COUNT(*) AS n FROM accounts_removed_subjects'))?.n).toBe(0);
  });
});
