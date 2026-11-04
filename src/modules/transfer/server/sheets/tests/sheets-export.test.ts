import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { AppError } from '../../../../../shared/contracts/errors';
import { OperationStore } from '../../../../operations/server/journal/store';
import { CommandRetention } from '../../../../tasks/server/commands/retention';
import { readActiveLists } from '../../../../tasks/server/queries/lists';
import { TaskQueries } from '../../../../tasks/server/queries/tasks';
import { SheetsExportSummarySchema } from '../../../contracts/export';
import { GoogleSheetsClient } from '../sheets';
import {
  MAX_SHEETS_EXPORT_BYTES,
  MAX_SHEETS_EXPORT_TASKS,
  SheetsExportService,
} from '../sheets-export';

const initial = Date.parse('2026-11-02T12:00:00Z');
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const operationId = (suffix = 'a') => `${initial}:${suffix.repeat(16)}`;
const input = (extra = {}) => ({
  operationId: operationId(),
  accountId: 'a',
  ownerSubject: 'owner',
  title: 'lanes tasks',
  export: {
    exportId: 'export-0123456789abcdef',
    scope: { listIds: ['list-a'] },
    includeCompleted: true,
    today: '2026-11-02',
    limit: 10,
  },
  ...extra,
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  let now = initial;
  await seedAccount(database.db, 'a', now);
  await seedAccount(database.db, 'b', now);
  await database.db
    .prepare(
      "INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key,last_synced_at,tasks_complete_at,completed_complete_at) VALUES ('list-a','a','google-list','work','work',?,?,?)",
    )
    .bind(now, now, now)
    .run();
  const queries = new TaskQueries(database.db),
    operations = createOperationStore(database.db);
  const creates: unknown[] = [],
    writes: { range: string; values: unknown[][] }[] = [];
  const providerRows = new Map<number, unknown[]>();
  let lostCreate = false,
    lostWrite = false,
    rejectStatus = 0;
  let holdCreate = false,
    releaseCreate: (() => void) | undefined;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'GET') {
      const url = new URL(String(_url)),
        selectedRange = url.searchParams.get('ranges');
      const created = creates[0] as {
        properties: { title: string };
        sheets: {
          properties: { title: string; gridProperties: { rowCount: number; columnCount: number } };
        }[];
      };
      const candidateId = url.pathname.split('/').at(-1)!;
      if (!selectedRange)
        return new Response(
          JSON.stringify({
            spreadsheetId: candidateId,
            properties: { title: created.properties.title },
            sheets: created.sheets.map((sheet, index) => ({
              properties: { ...sheet.properties, sheetId: index },
            })),
          }),
        );
      const match = /!A(\d+):[A-Z]+(\d+)$/.exec(selectedRange)!;
      const start = Number(match[1]),
        end = Number(match[2]);
      return new Response(
        JSON.stringify({
          spreadsheetId: candidateId,
          sheets: [
            {
              properties: { title: 'tasks', sheetId: 0 },
              data: [
                {
                  startRow: start - 1,
                  startColumn: 0,
                  rowData: Array.from({ length: end - start + 1 }, (_, index) => ({
                    values: (providerRows.get(start + index) ?? []).map((value) =>
                      value && typeof value === 'object'
                        ? {
                            userEnteredValue: { formulaValue: '=fake()' },
                            effectiveValue: { stringValue: (value as { cached: string }).cached },
                          }
                        : {
                            effectiveValue:
                              typeof value === 'number'
                                ? { numberValue: value }
                                : typeof value === 'boolean'
                                  ? { boolValue: value }
                                  : { stringValue: String(value) },
                          },
                    ),
                  })),
                },
              ],
            },
          ],
        }),
      );
    }
    const body = JSON.parse(String(init?.body)) as {
      properties?: unknown;
      sheets?: unknown[];
      range?: string;
      values?: unknown[][];
    };
    if (rejectStatus)
      return new Response(JSON.stringify({ error: { message: 'private content' } }), {
        status: rejectStatus,
        headers: { 'retry-after': '1' },
      });
    if (init?.method === 'POST') {
      creates.push(body);
      if (holdCreate)
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
      if (lostCreate) throw new Error('response lost after create');
      const sheets = body.sheets as {
        properties: { title: string; gridProperties: { rowCount: number; columnCount: number } };
      }[];
      return new Response(
        JSON.stringify({
          spreadsheetId:
            creates.length === 1 ? 'new-spreadsheet' : 'new-spreadsheet-' + creates.length,
          sheets: sheets.map((sheet, index) => ({
            properties: { ...sheet.properties, sheetId: index },
          })),
        }),
      );
    }
    writes.push({ range: body.range!, values: body.values! });
    const rowStart = Number(/!A(\d+):/.exec(body.range!)?.[1]);
    for (const [index, row] of body.values!.entries()) providerRows.set(rowStart + index, row);
    if (lostWrite) throw new Error('response lost after write');
    return new Response(
      JSON.stringify({
        spreadsheetId: new URL(String(_url)).pathname.split('/')[3],
        updatedRange: body.range,
        updatedRows: body.values!.length,
        updatedColumns: body.values![0]!.length,
        updatedCells: body.values!.length * body.values![0]!.length,
      }),
    );
  });
  const options = {
    operations,
    queries,
    readLists: (account: string, ids: readonly string[]) =>
      readActiveLists(database.db, account, ids),
    clientFor: async () => new GoogleSheetsClient({ accessToken: 'server-token', fetch: fetcher }),
    now: () => now,
  };
  const service = new SheetsExportService(database.db, options);
  async function task(
    id: string,
    fields: { title?: string; notes?: string; parent?: string } = {},
  ) {
    await database.db
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,title,title_key,notes,search_text,provider_position,revision) VALUES (?,'a','list-a',?,?,?,?,?,?,?,1)",
      )
      .bind(
        id,
        fields.parent ?? null,
        'google-' + id,
        fields.title ?? id,
        fields.title ?? id,
        fields.notes ?? '',
        fields.title ?? id,
        id,
      )
      .run();
  }
  async function ready() {
    await service.begin(input());
    let run = await service.get('a', operationId());
    while (run.state === 'capturing') run = await service.captureNext('a', operationId());
    return run;
  }
  async function drain(target = service) {
    for (let index = 0; index < 100; index++) {
      now += 5000;
      const advanced = await target.advance('a', operationId());
      if (
        advanced.run.operation?.finished ||
        ['uncertain', 'reconnect_required', 'blocked_by_limit'].includes(advanced.run.state)
      )
        return advanced.run;
    }
    throw new Error('sheets export did not settle');
  }
  return {
    ...database,
    service,
    options,
    operations,
    task,
    ready,
    drain,
    creates,
    writes,
    fetcher,
    now: () => now,
    tick: (milliseconds = 5000) => {
      now += milliseconds;
    },
    reject: (status: number) => {
      rejectStatus = status;
    },
    loseCreate: () => {
      lostCreate = true;
    },
    recoverCreate: () => {
      lostCreate = false;
    },
    loseWrite: () => {
      lostWrite = true;
    },
    holdCreate: () => {
      holdCreate = true;
    },
    releaseCreate: () => releaseCreate?.(),
    seedProviderRow: (row: number, values: unknown[]) => providerRows.set(row, values),
  };
}

describe('captured sheets export', () => {
  it('captures and previews the complete immutable plan before creating a new file', async () => {
    const { service, task, ready, drain, creates, writes, db } = await fixture();
    await task('one', { title: '=SUM(1,2)', notes: "'exact\r\nnotes" });
    await task('two');
    const preview = await ready();
    expect(preview).toMatchObject({
      state: 'ready',
      totalRows: 2,
      confirmedRows: 0,
      spreadsheet: null,
    });
    expect(preview.captureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(creates).toHaveLength(0);
    expect(writes).toHaveLength(0);
    await db.prepare("UPDATE tasks_tasks SET title='changed after preview' WHERE id='one'").run();
    await service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    const result = await drain();
    expect(SheetsExportSummarySchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      state: 'succeeded',
      totalRows: 2,
      confirmedRows: 2,
      spreadsheet: {
        id: 'new-spreadsheet',
        url: 'https://docs.google.com/spreadsheets/d/new-spreadsheet/edit',
      },
    });
    expect(creates).toHaveLength(1);
    expect(writes.flatMap((write) => write.values)).toEqual(
      expect.arrayContaining([expect.arrayContaining(['=SUM(1,2)', "'exact\r\nnotes"])]),
    );
    expect(JSON.stringify(writes)).not.toContain('changed after preview');
    expect(writes[0]?.values[0]?.slice(0, 5)).toEqual([
      'source_key',
      'parent_key',
      'list',
      'task',
      'notes',
    ]);
    expect(writes[0]?.values[1]?.[8]).toBe(false);
    expect(
      await db.prepare('SELECT SUM(remaining) AS n FROM tasks_list_reservations').first('n'),
    ).toBe(0);
  });

  it('makes capture replay/concurrency harmless and rejects changed operation input or another account', async () => {
    const { service, task, db } = await fixture();
    await task('one');
    await service.begin(input());
    await service.begin(input());
    await Promise.all([
      service.captureNext('a', operationId()),
      service.captureNext('a', operationId()),
    ]);
    expect((await service.get('a', operationId())).totalRows).toBe(1);
    expect(
      await db.prepare('SELECT COUNT(*) AS n FROM transfer_sheets_export_chunks').first('n'),
    ).toBe(1);
    await expect(service.begin(input({ title: 'different' }))).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(service.get('b', operationId())).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      service.confirm('a', operationId(), { captureHash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('lists retained exports with an account-bound stable cursor for reload recovery', async () => {
    const f = await fixture();
    await f.service.begin(input());
    await f.service.begin(input({ operationId: operationId('b') }));
    const first = await f.service.list('a', { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await f.service.list('a', { limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    await expect(f.service.list('b', { cursor: first.nextCursor! })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect((await f.service.list('b')).items).toEqual([]);
  });

  it('resumes after confirmed row chunks without creating another file or resending those chunks', async () => {
    const f = await fixture();
    for (let index = 0; index < 23; index++)
      await f.task('task-' + index.toString().padStart(2, '0'));
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    while (!f.writes.length) {
      f.tick();
      await f.service.advance('a', operationId());
    }
    const first = f.writes[0]!.range;
    const result = await f.drain(new SheetsExportService(f.db, f.options));
    expect(result.confirmedRows).toBe(23);
    expect(f.creates).toHaveLength(1);
    expect(f.writes.filter((write) => write.range === first)).toHaveLength(1);
  });

  it('retains a lost create outcome and never blindly creates a second spreadsheet', async () => {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    f.loseCreate();
    const result = await f.drain();
    expect(result.state).toBe('uncertain');
    expect(result.spreadsheet).toBe(null);
    for (let index = 0; index < 4; index++) {
      f.tick(31000);
      await f.service.advance('a', operationId());
    }
    await f.service.cancel('a', operationId());
    expect(f.creates).toHaveLength(1);
    expect(f.writes).toHaveLength(0);
    expect((await f.service.get('a', operationId())).state).toBe('uncertain');
  });

  it('keeps the known file link and stops after an ambiguous row write', async () => {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    f.loseWrite();
    const result = await f.drain();
    expect(result.state).toBe('uncertain');
    expect(result.spreadsheet?.id).toBe('new-spreadsheet');
    f.tick(31000);
    await f.service.advance('a', operationId());
    expect(f.creates).toHaveLength(1);
    expect(f.writes).toHaveLength(1);
  });

  it('repairs a known create receipt locally without another provider call', async () => {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    f.sqlite.exec(
      "CREATE TRIGGER fail_sheet_receipt BEFORE UPDATE OF file_id ON transfer_sheets_exports BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    while (!f.creates.length) {
      f.tick();
      await f.service.advance('a', operationId());
    }
    expect((await f.operations.getStep(operationId(), 'sheets.create'))?.response).toMatchObject({
      id: 'new-spreadsheet',
    });
    f.sqlite.exec('DROP TRIGGER fail_sheet_receipt');
    const result = await f.drain();
    expect(result.state).toBe('succeeded');
    expect(f.creates).toHaveLength(1);
  });

  it('never treats a response-persistence failure as a definite provider rejection', async () => {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    class ResponseFailure extends OperationStore {
      override async recordResponse(
        ..._args: Parameters<OperationStore['recordResponse']>
      ): Promise<void> {
        throw new AppError('storage_unavailable', 'fixture storage outage', 503, true);
      }
    }
    const service = new SheetsExportService(f.db, {
      ...f.options,
      operations: new ResponseFailure(f.db, {
        lists: f.operations.lists,
        captures: new CommandRetention(f.db),
      }),
    });
    expect((await f.drain(service)).state).toBe('uncertain');
    f.tick(31000);
    await service.advance('a', operationId());
    expect(f.creates).toHaveLength(1);
    expect(await service.hasUnresolved('a')).toBe(true);
  });

  it('pauses denied optional permission without changing the tasks connection and resumes the same plan', async () => {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    f.reject(403);
    const denied = await f.drain();
    expect(denied.state).toBe('reconnect_required');
    expect(denied.operation?.error?.code).toBe('permission_required');
    expect(
      await f.db.prepare("SELECT state FROM accounts_connections WHERE id='a'").first('state'),
    ).toBe('connected');
    expect(await f.service.hasUnresolved('a')).toBe(false);
    f.reject(0);
    await f.service.resume('a', operationId());
    expect((await f.drain()).state).toBe('succeeded');
    expect(f.creates).toHaveLength(1);
  });

  it('refreshes a definitely rejected token once and retries only in a later slice', async () => {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    const refresh = vi.fn(async () => {
      f.reject(0);
    });
    const service = new SheetsExportService(f.db, { ...f.options, refreshRejectedToken: refresh });
    await service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    f.reject(401);
    while (!refresh.mock.calls.length) {
      f.tick();
      await service.advance('a', operationId());
    }
    expect(f.creates).toHaveLength(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((await f.drain(service)).state).toBe('succeeded');
    expect(f.creates).toHaveLength(1);
  });

  it('cancels unsent work and preserves confirmed output without a rollback delete', async () => {
    const f = await fixture();
    for (let index = 0; index < 23; index++) await f.task('task-' + index);
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    while (!f.writes.length) {
      f.tick();
      await f.service.advance('a', operationId());
    }
    const before = f.writes.length;
    await f.service.cancel('a', operationId());
    f.tick();
    await f.service.advance('a', operationId());
    const cancelled = await f.service.get('a', operationId());
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.spreadsheet?.id).toBe('new-spreadsheet');
    expect(cancelled.confirmedRows).toBeGreaterThan(0);
    expect(f.writes).toHaveLength(before);
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method !== 'DELETE')).toBe(true);
  });

  it('fails an oversized capture before creating a file and leaves task data unchanged', async () => {
    const f = await fixture();
    await f.task('one');
    await f.service.begin(input());
    await f.db
      .prepare('UPDATE transfer_sheets_exports SET captured_bytes=? WHERE id=?')
      .bind(MAX_SHEETS_EXPORT_BYTES, operationId())
      .run();
    await expect(f.service.captureNext('a', operationId())).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(f.creates).toHaveLength(0);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(1);
    expect(MAX_SHEETS_EXPORT_TASKS).toBeLessThan(100000);
  });

  it('waits for an active create during disconnect and settles its confirmed file without another token', async () => {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    while (!(await f.service.get('a', operationId())).operation?.inputSealed)
      await f.service.advance('a', operationId());
    f.holdCreate();
    const issued = f.service.advance('a', operationId());
    await vi.waitFor(() => expect(f.creates).toHaveLength(1));
    await f.db.prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='a'").run();
    expect(await f.service.pendingProviderWork('a')).toBe(true);
    expect(await f.service.pauseAccount('a')).toEqual({ done: true, pending: true });
    await expect(f.service.removeAccountSlice('a', 1)).rejects.toMatchObject({ code: 'conflict' });
    f.releaseCreate();
    await issued;
    expect(await f.service.pendingProviderWork('a')).toBe(false);
    expect(await f.service.hasUnresolved('a')).toBe(false);
    expect(await f.service.get('a', operationId())).toMatchObject({
      state: 'cancelled',
      spreadsheet: { id: 'new-spreadsheet' },
    });
    expect(f.writes).toHaveLength(0);
  });

  it('records an expired issued claim as uncertain without keeping disconnect pending forever', async () => {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    while (!(await f.service.get('a', operationId())).operation?.inputSealed)
      await f.service.advance('a', operationId());
    await f.operations.claimNext(operationId(), 'crashed-worker', f.now());
    await f.operations.markDispatched(operationId(), 'sheets.create', 'crashed-worker', f.now(), [
      f.db
        .prepare(
          "UPDATE transfer_sheets_exports SET active_step='sheets.create',active_claim='crashed-worker',active_until=?,unresolved=1 WHERE id=?",
        )
        .bind(f.now() + 30000, operationId()),
    ]);
    f.tick(31000);
    await f.db.prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='a'").run();
    expect(await f.service.pauseAccount('a')).toEqual({ done: true, pending: false });
    expect(await f.service.hasUnresolved('a')).toBe(true);
    expect((await f.service.get('a', operationId())).state).toBe('uncertain');
    expect(f.creates).toHaveLength(0);
  });
  it('honestly pauses known local repair during disconnect even after its active step marker was cleared', async () => {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    f.sqlite.exec(
      "CREATE TRIGGER fail_sheet_disconnect_receipt BEFORE UPDATE OF file_id ON transfer_sheets_exports BEGIN SELECT RAISE(ABORT,'fixture local outage'); END",
    );
    while (!f.creates.length) {
      f.tick();
      await f.service.advance('a', operationId());
    }
    expect(
      await f.db.prepare('SELECT active_step FROM transfer_sheets_exports').first('active_step'),
    ).toBe(null);
    await f.db.prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='a'").run();
    expect(await f.service.pauseAccount('a')).toEqual({ done: true, pending: false });
    expect((await f.operations.getStep(operationId(), 'sheets.create'))?.state).toBe('uncertain');
    expect((await f.operations.getStep(operationId(), 'sheets.create'))?.response).toMatchObject({
      id: 'new-spreadsheet',
    });
    expect(await f.service.hasUnresolved('a')).toBe(true);
    expect(f.creates).toHaveLength(1);
    f.sqlite.exec('DROP TRIGGER fail_sheet_disconnect_receipt');
    await f.db.prepare("UPDATE accounts_connections SET state='connected' WHERE id='a'").run();
    const repaired = await f.service.resumeRecordedResponse('a', operationId(), 'sheets.create');
    expect(repaired.spreadsheet?.id).toBe('new-spreadsheet');
    expect(f.creates).toHaveLength(1);
  });

  it('prunes finished payloads and removes account rows in bounded child-first slices', async () => {
    const f = await fixture();
    for (let index = 0; index < 23; index++)
      await f.task('task-' + index, { notes: 'retained note payload' });
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    await f.drain();
    f.tick(2 * 86400000);
    expect(await f.service.cleanup(1)).toBe(1);
    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM transfer_sheets_export_chunks WHERE rows_json='null'")
        .first('n'),
    ).toBe(1);
    expect((await f.service.get('a', operationId())).spreadsheet?.id).toBe('new-spreadsheet');
    expect((await f.service.advance('a', operationId())).advanced).toBe(false);
    await f.db.prepare("UPDATE accounts_connections SET state='disconnected' WHERE id='a'").run();
    const before =
      Number(
        await f.db.prepare('SELECT COUNT(*) AS n FROM transfer_sheets_export_chunks').first('n'),
      ) + 1;
    let deleted = 0,
      done = false;
    while (!done) {
      const result = await f.service.removeAccountSlice('a', 2);
      expect(result.deleted).toBeLessThanOrEqual(2);
      deleted += result.deleted;
      done = result.done;
    }
    expect(deleted).toBe(before);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(23);
  });

  it('never prunes unknown or unfinished provider work', async () => {
    const f = await fixture();
    await f.task('one', { notes: 'uncertain payload' });
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    f.loseCreate();
    await f.drain();
    f.tick(91 * 86400000);
    expect(await f.service.cleanup(100)).toBe(0);
    expect(
      await f.db
        .prepare('SELECT rows_json FROM transfer_sheets_export_chunks LIMIT 1')
        .first('rows_json'),
    ).toContain('uncertain payload');
  });
});

describe('explicit sheets uncertainty resolution', () => {
  async function uncertainCreate() {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    f.loseCreate();
    await f.drain();
    return f;
  }
  async function verify(f: Awaited<ReturnType<typeof fixture>>, stepKey = 'sheets.create') {
    const inspected = await f.service.inspectUncertain('a', operationId(), stepKey);
    let verification = await f.service.startVerification('a', operationId(), {
      stepKey,
      expectedClaimId: inspected.expectedClaimId,
      candidateId: 'new-spreadsheet',
    });
    while (verification.status === 'verifying')
      verification = await f.service.advanceVerification('a', operationId(), verification.id);
    return verification;
  }
  it('requires readback and an explicit candidate adoption before resuming a lost create', async () => {
    const f = await uncertainCreate(),
      verification = await verify(f);
    expect(verification.status).toBe('matched');
    expect(f.creates).toHaveLength(1);
    expect(f.writes).toHaveLength(0);
    await expect(
      f.service.adoptVerified('a', operationId(), {
        verificationId: verification.id,
        proofDigest: verification.proofDigest!,
        confirmAdoption: false as never,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const adopted = await f.service.adoptVerified('a', operationId(), {
      verificationId: verification.id,
      proofDigest: verification.proofDigest!,
      confirmAdoption: true,
    });
    expect(adopted.spreadsheet?.id).toBe('new-spreadsheet');
    expect((await f.drain()).state).toBe('succeeded');
    expect(f.creates).toHaveLength(1);
    expect(
      (await f.operations.getResolution(operationId(), 'sheets.create', 'a'))?.evidence,
    ).toMatchObject({
      kind: 'owner_candidate',
      providerId: 'new-spreadsheet',
      digest: verification.proofDigest,
    });
  });
  it('refuses a nonempty candidate instead of overwriting an existing spreadsheet', async () => {
    const f = await uncertainCreate();
    f.seedProviderRow(2, ['existing content']);
    const verification = await verify(f);
    expect(verification.status).toBe('mismatch');
    expect(verification.mismatchCode).toBe('content_mismatch');
    await expect(
      f.service.adoptVerified('a', operationId(), {
        verificationId: verification.id,
        proofDigest: verification.proofDigest ?? '0'.repeat(64),
        confirmAdoption: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.writes).toHaveLength(0);
    expect((await f.service.get('a', operationId())).state).toBe('uncertain');
  });
  it('verifies a lost RAW write by exact values and never resends that confirmed range', async () => {
    const f = await fixture();
    await f.task('one', { title: '=literal' });
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    f.loseWrite();
    await f.drain();
    const verification = await verify(f, 'rows:0');
    expect(verification.status).toBe('matched');
    const adopted = await f.service.adoptVerified('a', operationId(), {
      verificationId: verification.id,
      proofDigest: verification.proofDigest!,
      confirmAdoption: true,
    });
    expect(adopted.state).toBe('succeeded');
    expect(f.writes).toHaveLength(1);
    expect((await f.operations.getResolution(operationId(), 'rows:0', 'a'))?.evidence.kind).toBe(
      'provider_readback',
    );
  });
  it('rejects formulas as write evidence even when cached values resemble exported raw text', async () => {
    const f = await fixture();
    await f.task('one');
    const preview = await f.ready();
    await f.service.confirm('a', operationId(), { captureHash: preview.captureHash! });
    f.loseWrite();
    await f.drain();
    f.seedProviderRow(1, [{ cached: 'source_key' }]);
    expect((await verify(f, 'rows:0')).status).toBe('mismatch');
  });
  it('requires a recent proof and the unchanged original claim before adopting a candidate', async () => {
    const f = await uncertainCreate(),
      inspected = await f.service.inspectUncertain('a', operationId(), 'sheets.create');
    await expect(
      f.service.startVerification('a', operationId(), {
        stepKey: 'sheets.create',
        expectedClaimId: 'wrong-claim',
        candidateId: 'new-spreadsheet',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const verification = await verify(f);
    f.tick(61000);
    await expect(
      f.service.adoptVerified('a', operationId(), {
        verificationId: verification.id,
        proofDigest: verification.proofDigest!,
        confirmAdoption: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      f.service.advanceVerification('b', operationId(), verification.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    const restarted = await f.service.startVerification('a', operationId(), {
      stepKey: 'sheets.create',
      expectedClaimId: inspected.expectedClaimId,
      candidateId: 'new-spreadsheet',
      restart: true,
    });
    expect(restarted.status).toBe('verifying');
    expect(restarted.checkedRows).toBe(0);
  });
  it('makes a new acknowledged attempt from frozen rows while retaining the original uncertain outcome', async () => {
    const f = await uncertainCreate(),
      inspected = await f.service.inspectUncertain('a', operationId(), 'sheets.create');
    const newId = operationId('b');
    await expect(
      f.service.startFreshAttempt('a', operationId(), {
        newOperationId: newId,
        stepKey: 'sheets.create',
        expectedClaimId: inspected.expectedClaimId,
        confirmDuplicateRisk: false as never,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const fresh = await f.service.startFreshAttempt('a', operationId(), {
      newOperationId: newId,
      stepKey: 'sheets.create',
      expectedClaimId: inspected.expectedClaimId,
      confirmDuplicateRisk: true,
    });
    expect(fresh.retryOf).toMatchObject({
      operationId: operationId(),
      duplicateRiskAccepted: true,
    });
    await f.db.prepare("UPDATE tasks_tasks SET title='changed source' WHERE id='one'").run();
    let preview = await f.service.captureNext('a', newId);
    while (preview.state === 'capturing') preview = await f.service.captureNext('a', newId);
    await f.service.confirm('a', newId, { captureHash: preview.captureHash! });
    f.recoverCreate();
    for (let index = 0; index < 20; index++) {
      f.tick();
      const result = await f.service.advance('a', newId);
      if (result.run.state === 'succeeded') break;
    }
    const result = await f.service.get('a', newId);
    expect(result.state).toBe('succeeded');
    expect(result.spreadsheet?.id).toBe('new-spreadsheet-2');
    expect(JSON.stringify(f.writes)).not.toContain('changed source');
    expect(f.creates).toHaveLength(2);
    expect((await f.service.get('a', operationId())).state).toBe('uncertain');
    expect(await f.service.hasUnresolved('a')).toBe(true);
    expect(await f.operations.getResolution(operationId(), 'sheets.create', 'a')).toBe(null);
  });
});
