import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { assertLocalWritable } from '../../../../accounts/server/connections/access';
import { AccountsPortability } from '../../../../accounts/server/connections/portability';
import type { TemplateScheduleSummary } from '../../../../boards/contracts/template';
import { BoardService } from '../../../../boards/server/boards/service';
import { BoardTemplateService } from '../../../../boards/server/templates/definitions';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskMetadataService } from '../../../../tasks/server/metadata/tasks';
import { TaskSnapshotReader } from '../../../../tasks/server/queries/snapshot-reader';
import { TaskQueries } from '../../../../tasks/server/queries/tasks';
import { ListSnapshotStore } from '../../../../tasks/server/templates/snapshots';
import { ListTemplateService } from '../../../../tasks/server/templates/definitions';
import { ArchiveExportSummarySchema } from '../../../contracts/archive-export';
import { parseWorkspaceArchive } from '../../../formats/archive';
import { ArchiveExportService } from '../archive-export';

const now = Date.parse('2026-11-02T12:00:00Z');
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const selection = {
  id: 'archive-0123456789abcdef',
  accountId: 'a',
  includeTaskSnapshots: true,
  today: '2026-11-02',
};
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'a', now);
  await seedAccount(database.db, 'b', now);
  const boards = new BoardService(database.db, {
    assertLocalWritable: (account) => assertLocalWritable(database.db, account),
  });
  for (const [id, main, position] of [
    ['main', 1, 0],
    ['custom', 0, 1],
  ] as const)
    await database.db
      .prepare(
        "INSERT INTO boards_boards(id,account_id,title,is_main,position,color,created_at) VALUES (?,'a',?,?,?,?,?)",
      )
      .bind(id, id, main, position, '#abcdef', now)
      .run();
  for (const [list, board, position] of [
    ['list-a', 'main', 0],
    ['list-z', 'custom', 0],
  ] as const) {
    await database.db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key,last_synced_at,tasks_complete_at,completed_complete_at) VALUES (?,'a',?,?,?,?,?,?)",
      )
      .bind(list, 'google-' + list, 'equal list title', 'equal list title', now, now, now)
      .run();
    await database.db
      .prepare(
        "INSERT INTO boards_memberships(account_id,list_id,board_id,color,position) VALUES ('a',?,?,?,?)",
      )
      .bind(list, board, '#fedcba', position)
      .run();
  }
  const queries = new TaskQueries(database.db),
    references = new TaskSnapshotReader(database.db, { now: () => now });
  const snapshots = new ListSnapshotStore(database.db);
  const listTemplates = new ListTemplateService(database.db, {
    snapshots,
    commitWrites: (writes) => database.db.batch(writes),
    sourceListAppearance: async () => ({ color: '#abcdef', guardWrites: [] }),
  });
  const boardTemplates = new BoardTemplateService(database.db, {
    snapshots,
    commitWrites: (writes) => database.db.batch(writes),
  });
  const history = new HistoryService(database.db, {
    now: () => now,
    boardListSelection: async (_account, board) => ({
      sql: 'SELECT list_id FROM boards_memberships WHERE account_id=? AND board_id=?',
      bindings: ['a', board],
    }),
  });
  const metadata = new TaskMetadataService(database.db, {
    history,
    commitWrites: (writes) => database.db.batch(writes),
  });
  const accounts = new AccountsPortability(database.db);
  let scheduleItems: TemplateScheduleSummary[] = [];
  const options = {
    identity: accounts.identity.bind(accounts),
    boardQueries: boards.queries,
    queries,
    references,
    graphRevision: metadata.getGraphRevision.bind(metadata),
    listTemplates,
    boardTemplates,
    snapshots,
    schedules: {
      list: async () => ({
        items: scheduleItems,
        nextCursor: null,
        coverage: { complete: true, stale: false, lastSyncedAt: null },
      }),
    },
    history,
    now: () => now,
  };
  const service = new ArchiveExportService(database.db, options);
  async function task(id: string, list = 'list-a', parent: string | null = null, notes = '') {
    await database.db
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,title,title_key,notes,search_text,provider_position,revision) VALUES (?,'a',?,?,?,?,?,?,?,?,1)",
      )
      .bind(id, list, parent, 'google-' + id, id, id, notes, id, id)
      .run();
  }
  async function ready(target = service, input = selection) {
    let summary = await target.begin(input);
    for (let index = 0; index < 100 && summary.state === 'capturing'; index++)
      summary = await target.captureNext('a', input.id);
    expect(summary.state).toBe('ready');
    return summary;
  }
  async function download(target = service, id = selection.id) {
    let cursor: string | undefined,
      json = '';
    do {
      const page = await target.queries.downloadPage('a', id, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(new TextEncoder().encode(page.chunk).byteLength).toBeLessThanOrEqual(65536);
      json += page.chunk;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return parseWorkspaceArchive(new TextEncoder().encode(json));
  }
  return {
    ...database,
    service,
    options,
    queries,
    task,
    ready,
    download,
    listTemplates,
    snapshots,
    history,
    metadata,
    setSchedules: (items: TemplateScheduleSummary[]) => {
      scheduleItems = items;
    },
  };
}

describe('bounded workspace archive generation', () => {
  it('captures an exact credential-free archive through public owners and downloads it incrementally', async () => {
    const f = await fixture();
    await f.task('root', 'list-a', null, "=literal\r\n'notes");
    await f.task('child', 'list-a', 'root');
    await f.task('outside', 'list-z');
    await f.db
      .prepare(
        "INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES ('label','a','reading','reading','#123456')",
      )
      .run();
    await f.db
      .prepare(
        "INSERT INTO tasks_task_labels(account_id,task_id,label_id) VALUES ('a','root','label')",
      )
      .run();
    await f.db
      .prepare(
        "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES ('a','child','outside')",
      )
      .run();
    const before = await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n');
    const summary = await f.ready();
    expect(ArchiveExportSummarySchema.safeParse(summary).success).toBe(true);
    const archive = await f.download();
    expect(archive.header.source.googleSubject).toBe('subject-a');
    expect(archive.header.includesTaskSnapshots).toBe(true);
    const lists = archive.records.filter((record) => record.kind === 'list'),
      tasks = archive.records.filter((record) => record.kind === 'task');
    expect(lists).toHaveLength(2);
    expect(lists[0]?.key).not.toBe(lists[1]?.key);
    expect(tasks.find((task) => task.snapshot?.title === 'root')?.snapshot?.notes).toBe(
      "=literal\r\n'notes",
    );
    expect(
      tasks.find((task) => task.snapshot?.title === 'child')?.dependencies[0]?.provider.id,
    ).toBe('google-outside');
    expect(JSON.stringify(archive)).not.toMatch(
      /grant_ciphertext|refreshToken|clientSecret|session_key|owner_subject/,
    );
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(before);
  });
  it('keeps a selected board inside its scope while preserving addresses for outside dependencies', async () => {
    const f = await fixture();
    await f.task('selected', 'list-z');
    await f.task('outside', 'list-a');
    await f.db
      .prepare(
        "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES ('a','selected','outside')",
      )
      .run();
    const input = { ...selection, boardId: 'custom' };
    await f.ready(f.service, input);
    const archive = await f.download();
    expect(archive.records.filter((record) => record.kind === 'board')).toHaveLength(1);
    const tasks = archive.records.filter((record) => record.kind === 'task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.dependencies[0]?.provider.id).toBe('google-outside');
    expect(
      archive.records.some(
        (record) => record.kind === 'task' && record.snapshot?.title === 'outside',
      ),
    ).toBe(false);
  });
  it('omits task snapshots in metadata mode and rejects download before the whole archive is ready', async () => {
    const f = await fixture();
    await f.task('one', 'list-a', null, 'private note');
    await f.service.begin({ ...selection, includeTaskSnapshots: false });
    await expect(f.service.queries.downloadPage('a', selection.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    await f.ready(f.service, { ...selection, includeTaskSnapshots: false });
    const archive = await f.download();
    expect(archive.records.find((record) => record.kind === 'task')).not.toHaveProperty('snapshot');
    expect(JSON.stringify(archive)).not.toContain('private note');
  });
  it('binds export replay and download cursors to the exact account and selection', async () => {
    const f = await fixture();
    await f.ready();
    await expect(f.service.begin({ ...selection, boardId: 'custom' })).rejects.toMatchObject({
      code: 'conflict',
    });
    const first = await f.service.queries.downloadPage('a', selection.id, { limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    await expect(
      f.service.queries.downloadPage('b', selection.id, { cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      f.service.queries.downloadPage('a', selection.id, { cursor: 'invalid' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await f.service.queries.list('a', { limit: 1 })).items[0]?.id).toBe(selection.id);
  });
  it('exports immutable template content and pinned schedule versions without merging equal names', async () => {
    const f = await fixture();
    await f.task('source');
    const context = {
      operationId: 'save-template',
      stepKey: 'capture',
      origin: 'owner' as const,
      recordedAt: new Date(now).toISOString(),
      saveDay: '2026-11-02',
      zone: 'UTC',
    };
    const first = await f.listTemplates.create(
      'a',
      { name: 'routine', listId: 'list-a', listRevision: 0 },
      context,
    );
    await f.db
      .prepare(
        "UPDATE tasks_tasks SET title='new version',title_key='new version',revision=revision+1 WHERE id='source'",
      )
      .run();
    const second = await f.listTemplates.replace(
      'a',
      first.id,
      { listId: 'list-a', listRevision: 0 },
      first.revision,
      context,
    );
    f.setSchedules([
      {
        id: 'schedule',
        accountId: 'a',
        template: { kind: 'list', id: first.id, contentRevision: 1 },
        boardId: 'custom',
        timing: { frequency: 'weekly', weekday: 1, zone: 'UTC', startsOn: '2026-11-02' },
        useRelativeDates: true,
        listPrefix: 'weekly ',
        state: 'active',
        pauseReason: null,
        revision: 0,
        nextRunAt: null,
        lastClaimedDay: null,
        lastResolvedDay: null,
        catchUpRequired: false,
        activeRunId: null,
      },
    ]);
    expect(second.contentRevision).toBe(2);
    await f.ready();
    const archive = await f.download();
    const templates = archive.records.filter((record) => record.kind === 'template');
    expect(templates.map((template) => template.contentRevision).sort()).toEqual([1, 2]);
    const schedule = archive.records.find((record) => record.kind === 'schedule');
    expect(schedule?.wasActive).toBe(true);
    expect(
      templates.find((template) => template.key === schedule?.templateKey)?.contentRevision,
    ).toBe(1);
    const contents = archive.records.filter((record) => record.kind === 'template_task');
    expect(contents.map((record) => record.value.title).sort()).toEqual(['new version', 'source']);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks_template_snapshot_pins WHERE owner_key LIKE 'archive-export:%'",
        )
        .first('n'),
    ).toBe(0);
  });
  it('keeps unavailable paused schedule definitions with explicit unmatched references', async () => {
    const f = await fixture();
    f.setSchedules([
      {
        id: 'unmatched',
        accountId: 'a',
        template: { kind: 'list', id: 'deleted-template', contentRevision: 1 },
        boardId: 'deleted-board',
        timing: { frequency: 'monthly', dayOfMonth: 5, zone: 'UTC', startsOn: '2026-11-02' },
        useRelativeDates: false,
        listPrefix: '',
        state: 'paused',
        pauseReason: 'destination_removed',
        revision: 1,
        nextRunAt: null,
        lastClaimedDay: null,
        lastResolvedDay: null,
        catchUpRequired: true,
        activeRunId: null,
      },
    ]);
    const summary = await f.ready();
    expect(summary.unmatchedSchedules).toBe(1);
    const archive = await f.download(),
      schedule = archive.records.find((record) => record.kind === 'schedule');
    expect(schedule?.unmatchedReferences).toEqual({ board: true, template: true });
    expect(schedule?.wasActive).toBe(false);
  });
  it('retains history identity/time/provenance and remaps its resource references', async () => {
    const f = await fixture();
    await f.task('one');
    const event = {
      id: 'historical-event',
      accountId: 'a',
      taskId: 'one',
      listId: 'list-a',
      origin: 'owner' as const,
      dedupKey: 'original-dedup',
      recordedAt: new Date(now - 1000).toISOString(),
      taskTitle: 'one',
      listTitle: 'work',
      kind: 'task_moved' as const,
      summary: {
        operationId: 'original-operation',
        stepKey: 'original-step',
        from: { listId: 'list-z', parentId: null },
        to: { listId: 'list-a', parentId: null },
      },
    };
    await f.history.record(event);
    await f.history.record({
      ...event,
      id: 'expired',
      dedupKey: 'expired',
      recordedAt: new Date(now - 91 * 86400000).toISOString(),
    });
    await f.ready();
    const archive = await f.download(),
      histories = archive.records.filter((record) => record.kind === 'history');
    expect(histories).toHaveLength(1);
    expect(histories[0]?.event).toMatchObject({
      id: 'historical-event',
      dedupKey: 'original-dedup',
      accountId: 'a1',
      recordedAt: event.recordedAt,
      summary: { operationId: 'original-operation', stepKey: 'original-step' },
    });
    expect(histories[0]?.event.listId).toMatch(/^list_[a-f0-9]{64}$/);
    if (histories[0]?.event.kind === 'task_moved')
      expect(histories[0].event.summary.from.listId).toMatch(/^list_[a-f0-9]{64}$/);
  });
  it('aborts before download if task dependencies change during capture', async () => {
    const f = await fixture();
    await f.task('one');
    await f.task('two');
    await f.service.begin(selection);
    while ((await f.service.queries.get('a', selection.id)).phase !== 'tasks')
      await f.service.captureNext('a', selection.id);
    await f.service.captureNext('a', selection.id); // captures the graph revision before task pages.
    await f.metadata.patchTask(
      'a',
      'one',
      { blockedBy: ['two'] },
      1,
      {
        operationId: 'edit-dependencies',
        stepKey: 'edit',
        origin: 'owner',
        recordedAt: new Date(now).toISOString(),
      },
      0,
    );
    await f.service.captureNext('a', selection.id);
    await expect(f.service.captureNext('a', selection.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await f.service.queries.get('a', selection.id)).state).toBe('failed');
    await expect(f.service.queries.downloadPage('a', selection.id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('fails oversized generation instead of returning a truncated archive', async () => {
    const f = await fixture();
    await f.service.begin(selection);
    await f.db
      .prepare('UPDATE transfer_archive_exports SET bytes=? WHERE id=?')
      .bind(20 * 1024 * 1024, selection.id)
      .run();
    await expect(f.service.captureNext('a', selection.id)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect((await f.service.queries.get('a', selection.id)).state).toBe('failed');
    await expect(f.service.queries.downloadPage('a', selection.id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('expires file payloads and removes account exports in an exact bounded row budget', async () => {
    const f = await fixture();
    await f.task('one', 'list-a', null, 'archive payload');
    await f.ready();
    expect(await f.service.cleanup(1, now + 2 * 86400000)).toBe(1);
    expect((await f.service.queries.get('a', selection.id)).downloadAvailable).toBe(false);
    await expect(f.service.queries.downloadPage('a', selection.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    await f.db.prepare("UPDATE accounts_connections SET state='disconnected' WHERE id='a'").run();
    const before =
      Number(
        await f.db.prepare('SELECT COUNT(*) AS n FROM transfer_archive_export_records').first('n'),
      ) +
      Number(
        await f.db.prepare('SELECT COUNT(*) AS n FROM transfer_archive_export_jobs').first('n'),
      ) +
      1;
    let done = false,
      deleted = 0;
    while (!done) {
      const result = await f.service.removeAccountSlice('a', 2);
      expect(result.deleted).toBeLessThanOrEqual(2);
      deleted += result.deleted;
      done = result.done;
    }
    expect(deleted).toBe(before);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(1);
  });
  it('rejects a mixed-time dependency address that disagrees with an included task mapping', async () => {
    const f = await fixture();
    await f.task('aa');
    await f.task('bb');
    await f.db
      .prepare(
        "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES ('a','aa','bb')",
      )
      .run();
    await f.service.begin(selection);
    while ((await f.service.queries.get('a', selection.id)).phase !== 'tasks')
      await f.service.captureNext('a', selection.id);
    await f.service.captureNext('a', selection.id);
    await f.service.captureNext('a', selection.id);
    await f.db
      .prepare(
        "UPDATE tasks_tasks SET list_id='list-z',provider_id='moved-google-bb',revision=revision+1 WHERE id='bb'",
      )
      .run();
    let caught: unknown;
    for (
      let index = 0;
      index < 100 && (await f.service.queries.get('a', selection.id)).state === 'capturing';
      index++
    ) {
      try {
        await f.service.captureNext('a', selection.id);
      } catch (error) {
        caught = error;
        break;
      }
    }
    expect(caught).toMatchObject({ code: 'conflict' });
    expect((await f.service.queries.get('a', selection.id)).state).toBe('failed');
  });
  it('makes progress with a one-row removal budget while a snapshot pin is active', async () => {
    const f = await fixture();
    await f.task('source');
    await f.listTemplates.create(
      'a',
      { name: 'routine', listId: 'list-a', listRevision: 0 },
      {
        operationId: 'save',
        stepKey: 'save',
        origin: 'owner',
        recordedAt: new Date(now).toISOString(),
        saveDay: '2026-11-02',
        zone: 'UTC',
      },
    );
    await f.service.begin(selection);
    for (
      let index = 0;
      index < 100 &&
      !(await f.db
        .prepare(
          "SELECT 1 FROM tasks_template_snapshot_pins WHERE owner_key LIKE 'archive-export:%'",
        )
        .first());
      index++
    )
      await f.service.captureNext('a', selection.id);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks_template_snapshot_pins WHERE owner_key LIKE 'archive-export:%'",
        )
        .first('n'),
    ).toBe(1);
    await f.db.prepare("UPDATE accounts_connections SET state='disconnected' WHERE id='a'").run();
    const first = await f.service.removeAccountSlice('a', 1);
    expect(first.deleted).toBe(1);
    let done = first.done;
    for (let index = 0; index < 100 && !done; index++) {
      const result = await f.service.removeAccountSlice('a', 1);
      expect(result.deleted).toBeLessThanOrEqual(1);
      done = result.done;
    }
    expect(done).toBe(true);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks_template_snapshot_pins WHERE owner_key LIKE 'archive-export:%'",
        )
        .first('n'),
    ).toBe(0);
  });
  it('allows metadata archives over100 lists while rejecting the same task-snapshot scope before download', async () => {
    const f = await fixture();
    for (let index = 0; index < 99; index++) {
      const id = 'additional-' + index;
      await f.db
        .prepare(
          "INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key,last_synced_at,tasks_complete_at,completed_complete_at) VALUES (?,'a',?,?,?,?,?,?)",
        )
        .bind(id, 'google-' + id, id, id, now, now, now)
        .run();
      await f.db
        .prepare(
          "INSERT INTO boards_memberships(account_id,list_id,board_id,color,position) VALUES ('a',?,'main','#abcdef',?)",
        )
        .bind(id, index + 1)
        .run();
    }
    const metadataSelection = { ...selection, includeTaskSnapshots: false };
    expect((await f.ready(f.service, metadataSelection)).listCount).toBe(101);
    expect((await f.download()).records.filter((record) => record.kind === 'list')).toHaveLength(
      101,
    );
    const snapshotId = 'snapshot-0123456789abcdef';
    await f.service.begin({ ...selection, id: snapshotId });
    let failure: unknown;
    for (
      let index = 0;
      index < 100 && (await f.service.queries.get('a', snapshotId)).state === 'capturing';
      index++
    ) {
      try {
        await f.service.captureNext('a', snapshotId);
      } catch (error) {
        failure = error;
        break;
      }
    }
    expect(failure).toMatchObject({ code: 'validation_failed' });
    expect((await f.service.queries.get('a', snapshotId)).state).toBe('failed');
    await expect(f.service.queries.downloadPage('a', snapshotId)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
