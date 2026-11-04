import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../tests/sqlite-d1';
import { HistoryService } from '../../../history/server';
import { OperationStore } from '../operations';
import {
  GoogleTasksClient,
  type GoogleTaskDTO,
  type GoogleTaskListDTO,
  type GoogleTasksFetch,
} from '../provider';
import { TaskCommandService } from './provider-commands';
import { TaskMetadataService } from '../metadata';
import { TaskProjectionStore } from '../projection';
import { TaskQueries } from '../queries/tasks';
import type { ProviderCommandInput } from '../../provider-command-contract';
import { RepeatRuleSchema } from '../../planning-contract';

const initial = Date.parse('2026-11-02T12:00:00Z');
const operationId = `${initial}:resolutiontest01`;
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});

async function fixture() {
  const database = testDatabase();
  closes.push(database.close);
  const { db } = database;
  await seedAccount(db, 'a', initial);
  await seedAccount(db, 'other', initial);
  for (const [id, provider] of [
    ['source', 'google-source'],
    ['destination', 'google-destination'],
  ])
    await db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at)VALUES(?,?,?,?,1,?,?)',
      )
      .bind(id, 'a', provider, id, initial, initial)
      .run();
  let now = initial;
  const history = new HistoryService(db, { now: () => now });
  const projection = new TaskProjectionStore(db, { history, now: () => now });
  const original: GoogleTaskDTO = {
    id: 'original',
    title: 'original title',
    notes: 'keep notes',
    status: 'needsAction',
    etag: 'original-v1',
    position: '1',
  };
  await db.batch(
    (
      await projection.prepareConfirmedWrites('a', 'source', [original], {
        knownTaskIds: new Map([['original', 'task']]),
      })
    ).writes,
  );
  const provider = new Map<string, GoogleTaskDTO>([['google-source:original', original]]);
  const providerLists = new Map<string, GoogleTaskListDTO>([
    ['google-source', { id: 'google-source', title: 'source', etag: 'source-list-v1' }],
  ]);
  const calls: { method: string; path: string }[] = [];
  let beforeProviderRead: (() => Promise<void>) | undefined;
  const transport: GoogleTasksFetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname });
    const parts = url.pathname.split('/').map(decodeURIComponent),
      listId = parts[4]!,
      taskId = parts[6]!;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (parts[3] === 'users' && parts[5] === 'lists') {
      const list = providerLists.get(parts[6]!);
      if (method === 'GET')
        return list
          ? Response.json(list)
          : Response.json({ error: { code: 404 } }, { status: 404 });
      if (method === 'POST') {
        const created = { id: 'created-list', title: String(body.title), etag: 'created-list-v1' };
        providerLists.set(created.id, created);
        return Response.json(created);
      }
      if (method === 'PATCH' && list) {
        const updated = { ...list, title: String(body.title), etag: 'updated-list' };
        providerLists.set(list.id, updated);
        return Response.json(updated);
      }
    }
    const key = `${listId}:${taskId}`,
      current = provider.get(key);
    if (method === 'GET' && beforeProviderRead) {
      const callback = beforeProviderRead;
      beforeProviderRead = undefined;
      await callback();
    }
    if (method === 'GET')
      return current
        ? Response.json(current)
        : Response.json({ error: { code: 404 } }, { status: 404 });
    if (method === 'PATCH' && current) {
      const value = { ...current, ...body, etag: 'patched-v2' } as GoogleTaskDTO;
      for (const field of ['due', 'completed'] as const)
        if (value[field] === null) delete value[field];
      provider.set(key, value);
      return Response.json(value);
    }
    if (method === 'DELETE') {
      provider.delete(key);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && parts.at(-1) === 'tasks') {
      const value = {
        id: 'created',
        status: 'needsAction',
        etag: 'created-v1',
        position: '2',
        ...body,
      } as GoogleTaskDTO;
      for (const field of ['due', 'completed'] as const)
        if (value[field] === null) delete value[field];
      provider.set(`${listId}:created`, value);
      return Response.json(value);
    }
    if (method === 'POST' && parts.at(-1) === 'move' && current) {
      const value: GoogleTaskDTO = { ...current, id: 'moved', etag: 'moved-v2' };
      provider.delete(key);
      provider.set(`${url.searchParams.get('destinationTasklist')}:moved`, value);
      return Response.json(value);
    }
    throw new Error('unexpected test provider request');
  };
  const client = new GoogleTasksClient({ accessToken: 'test-token', fetch: transport });
  const lostClient = new GoogleTasksClient({
    accessToken: 'test-token',
    fetch: async (input, init) => {
      const response = await transport(input, init);
      if (init?.method && init.method !== 'GET')
        throw new Error('response lost after Google accepted');
      return response;
    },
  });
  const operations = new OperationStore(db),
    queries = new TaskQueries(db);
  const metadata = new TaskMetadataService(db, {
    history,
    commitWrites: (writes) => db.batch(writes),
  });
  const options = {
    operations,
    projection,
    history,
    metadata,
    queries,
    now: () => now,
    clientFor: async () => client,
    validateBoardTarget: async () => {},
    placementWrites: () => [],
  };
  const service = new TaskCommandService(db, options);
  const lost = new TaskCommandService(db, { ...options, clientFor: async () => lostClient });
  async function uncertain(command: ProviderCommandInput) {
    await lost.prepare({ operationId, accountId: 'a', ownerSubject: 'owner', command });
    expect((await lost.advance('a', operationId)).operation.state).toBe('uncertain');
    now += 31_000;
  }
  return {
    ...database,
    provider,
    providerLists,
    projection,
    operations,
    queries,
    service,
    options,
    beforeProviderRead: (callback: () => Promise<void>) => {
      beforeProviderRead = callback;
    },
    lost,
    uncertain,
    calls,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

it('explicitly keeps conflicting current provider values and stops the captured intent without applying its metadata', async () => {
  const f = await fixture();
  await f.uncertain({
    kind: 'task.edit',
    taskId: 'task',
    revision: 1,
    patch: { title: 'intended title', priority: 'high' },
  });
  const originalClaim = (await f.operations.getStep(operationId, 'step-0'))!.claimId!;
  f.provider.set('google-source:original', {
    ...f.provider.get('google-source:original')!,
    title: 'changed in Google',
    etag: 'external-v3',
  });
  const before = await f.service.resolutions.preview('a', operationId, {});
  expect(before).toMatchObject({ canConfirm: false, canKeepProviderCurrent: true });
  const preview = await f.service.resolutions.preview('a', operationId, {
    decision: 'keep_provider_current',
  });
  expect(preview).toMatchObject({ canConfirm: true, decision: 'keep_provider_current' });
  await f.service.resolutions.confirm('a', operationId, {
    decision: 'keep_provider_current',
    previewHash: preview.previewHash,
    confirm: true,
  });
  expect(await f.operations.get(operationId, 'a')).toMatchObject({
    state: 'partial',
    finished: true,
  });
  expect(await f.queries.getTask('a', 'task')).toMatchObject({
    title: 'changed in Google',
    priority: 'none',
    notes: 'keep notes',
  });
  expect((await f.service.advance('a', operationId)).advanced).toBe(false);
  expect(f.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  const callsBeforeReplay = f.calls.length;
  await f.service.resolutions.confirm('a', operationId, {
    decision: 'keep_provider_current',
    previewHash: preview.previewHash,
    confirm: true,
  });
  expect(f.calls).toHaveLength(callsBeforeReplay);
  await expect(
    f.operations.recordResponse(
      operationId,
      'step-0',
      originalClaim,
      { id: 'original', title: 'late original receipt' },
      initial + 32_000,
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
});

it('keeps an already retained create candidate and its metadata without merging identities or emitting owner creation history', async () => {
  const f = await fixture();
  await f.uncertain({
    kind: 'task.create',
    listId: 'source',
    listRevision: 1,
    title: 'created title',
    priority: 'high',
  });
  const candidate = f.provider.get('google-source:created')!;
  await f.db.batch(
    (
      await f.projection.prepareConfirmedWrites('a', 'source', [candidate], {
        knownTaskIds: new Map([['created', 'retained']]),
      })
    ).writes,
  );
  await f.db
    .prepare(
      "UPDATE tasks_tasks SET starred=1,priority='low',revision=revision+1 WHERE id='retained'",
    )
    .run();
  const preview = await f.service.resolutions.preview('a', operationId, {
    candidateId: 'created',
    decision: 'keep_provider_current',
  });
  expect(preview).toMatchObject({
    canConfirm: true,
    candidate: { alreadyRetained: true, retainedId: 'retained' },
  });
  await f.service.resolutions.confirm('a', operationId, {
    candidateId: 'created',
    decision: 'keep_provider_current',
    previewHash: preview.previewHash,
    confirm: true,
    confirmIdentity: true,
  });
  expect(await f.queries.getTask('a', 'retained')).toMatchObject({
    starred: true,
    priority: 'low',
  });
  expect(
    await f.db
      .prepare("SELECT COUNT(*)AS n FROM tasks_tasks WHERE provider_id='created'")
      .first('n'),
  ).toBe(1);
  expect(
    await f.db
      .prepare(
        "SELECT COUNT(*)AS n FROM history_events WHERE origin='owner' AND kind='task_created'",
      )
      .first('n'),
  ).toBe(0);
  expect(await f.operations.get(operationId, 'a')).toMatchObject({
    state: 'partial',
    finished: true,
  });
  expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});

it('retains source move metadata after exact source absence and keeps a separate retained destination identity', async () => {
  const f = await fixture();
  await f.db.prepare("UPDATE tasks_tasks SET priority='high',starred=1 WHERE id='task'").run();
  await f.uncertain({
    kind: 'task.move',
    taskId: 'task',
    revision: 1,
    listId: 'destination',
    listRevision: 1,
  });
  await f.db.batch(
    (
      await f.projection.prepareConfirmedWrites(
        'a',
        'destination',
        [f.provider.get('google-destination:moved')!],
        { knownTaskIds: new Map([['moved', 'destination-task']]) },
      )
    ).writes,
  );
  const preview = await f.service.resolutions.preview('a', operationId, {
    candidateId: 'moved',
    decision: 'keep_provider_current',
  });
  expect(preview.canConfirm).toBe(true);
  await f.service.resolutions.confirm('a', operationId, {
    candidateId: 'moved',
    decision: 'keep_provider_current',
    previewHash: preview.previewHash,
    confirm: true,
    confirmIdentity: true,
  });
  expect(await f.queries.getTask('a', 'task')).toMatchObject({
    priority: 'high',
    starred: true,
    listId: 'source',
    provider: { missing: true },
    capabilities: { canEdit: false },
  });
  expect(await f.queries.getTask('a', 'destination-task')).toMatchObject({
    listId: 'destination',
    priority: 'none',
  });
  expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  expect(await f.operations.get(operationId, 'a')).toMatchObject({
    finished: true,
    state: 'partial',
  });
});

it('rejects changed readback or local metadata after preview and refuses disconnected resolution', async () => {
  const f = await fixture();
  await f.uncertain({
    kind: 'task.edit',
    taskId: 'task',
    revision: 1,
    patch: { title: 'new title' },
  });
  const preview = await f.service.resolutions.preview('a', operationId, {
    decision: 'keep_provider_current',
  });
  await f.db
    .prepare("UPDATE tasks_tasks SET priority='high',revision=revision+1 WHERE id='task'")
    .run();
  await expect(
    f.service.resolutions.confirm('a', operationId, {
      decision: 'keep_provider_current',
      previewHash: preview.previewHash,
      confirm: true,
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  const fresh = await f.service.resolutions.preview('a', operationId, {
    decision: 'keep_provider_current',
  });
  f.provider.set('google-source:original', {
    ...f.provider.get('google-source:original')!,
    etag: 'different',
  });
  await expect(
    f.service.resolutions.confirm('a', operationId, {
      decision: 'keep_provider_current',
      previewHash: fresh.previewHash,
      confirm: true,
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await f.db.prepare("UPDATE accounts_connections SET state='disconnected' WHERE id='a'").run();
  const before = f.calls.length;
  await expect(
    f.service.resolutions.preview('a', operationId, { decision: 'keep_provider_current' }),
  ).rejects.toMatchObject({ code: 'reconnect_required' });
  expect(f.calls).toHaveLength(before);
});

it('preserves a recorded receipt when fresh authoritative state is kept instead of the captured intent', async () => {
  const f = await fixture();
  await f.uncertain({
    kind: 'task.edit',
    taskId: 'task',
    revision: 1,
    patch: { title: 'intended' },
  });
  const issued = (await f.operations.getStep(operationId, 'step-0'))!;
  const response = f.provider.get('google-source:original')!;
  await f.operations.recordResponse(
    operationId,
    issued.key,
    issued.claimId!,
    response,
    initial + 31_000,
  );
  await f.operations.pauseRepair(
    operationId,
    issued.key,
    issued.claimId!,
    { code: 'conflict' },
    initial + 31_000,
  );
  f.provider.set('google-source:original', {
    ...response,
    title: 'current after receipt',
    etag: 'later',
  });
  const preview = await f.service.resolutions.preview('a', operationId, {
    decision: 'keep_provider_current',
  });
  await f.service.resolutions.confirm('a', operationId, {
    decision: 'keep_provider_current',
    previewHash: preview.previewHash,
    confirm: true,
  });
  expect((await f.operations.getStep(operationId, issued.key))?.response).toEqual(response);
  expect(await f.queries.getTask('a', 'task')).toMatchObject({ title: 'current after receipt' });
  expect(await f.operations.get(operationId, 'a')).toMatchObject({
    finished: true,
    state: 'partial',
  });
});

it('keeps provider task identity scoped to its exact list when another list reuses an opaque id', async () => {
  const f = await fixture();
  await f.uncertain({
    kind: 'task.create',
    listId: 'source',
    listRevision: 1,
    title: 'created title',
  });
  await f.db.batch(
    (
      await f.projection.prepareConfirmedWrites(
        'a',
        'destination',
        [f.provider.get('google-source:created')!],
        { knownTaskIds: new Map([['created', 'same-id-other-list']]) },
      )
    ).writes,
  );
  expect(
    await f.service.resolutions.preview('a', operationId, { candidateId: 'created' }),
  ).toMatchObject({ canConfirm: true, candidate: { alreadyRetained: false, retainedId: null } });
});

it('requires the original claim to expire and blocks paused provider access before making a readback', async () => {
  const f = await fixture();
  await f.uncertain({
    kind: 'task.edit',
    taskId: 'task',
    revision: 1,
    patch: { title: 'intended' },
  });
  const step = (await f.operations.getStep(operationId, 'step-0'))!;
  await f.operations.recordResponse(
    operationId,
    step.key,
    step.claimId!,
    f.provider.get('google-source:original')!,
    initial + 31_000,
  );
  const before = f.calls.length;
  await expect(
    f.service.resolutions.preview('a', operationId, { decision: 'keep_provider_current' }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(f.calls).toHaveLength(before);
  f.tick(31_000);
  await f.db
    .prepare("UPDATE accounts_connections SET state='reconnect_required' WHERE id='a'")
    .run();
  await expect(
    f.service.resolutions.preview('a', operationId, { decision: 'keep_provider_current' }),
  ).rejects.toMatchObject({ code: 'reconnect_required' });
  expect(f.calls).toHaveLength(before);
});

it('clears a previous recurrence pause only when an explicit schedule edit is locally confirmed', async () => {
  const f = await fixture();
  await f.db
    .prepare(
      "INSERT INTO tasks_schedule_pauses(account_id,task_id,rule_json,reason,paused_at,provider_version)VALUES('a','task','{}','provider_day_removed',?,'old-version')",
    )
    .bind(initial)
    .run();
  await f.service.prepare({
    operationId,
    accountId: 'a',
    ownerSubject: 'owner',
    command: {
      kind: 'task.edit',
      taskId: 'task',
      revision: 1,
      patch: { title: 'unrelated rename' },
    },
  });
  expect((await f.service.advance('a', operationId)).operation.state).toBe('succeeded');
  expect(
    await f.db
      .prepare("SELECT COUNT(*)AS n FROM tasks_schedule_pauses WHERE task_id='task'")
      .first('n'),
  ).toBe(1);
  const current = await f.queries.getTask('a', 'task');
  const removeId = `${initial}:removeoldpause01`;
  await f.service.prepare({
    operationId: removeId,
    accountId: 'a',
    ownerSubject: 'owner',
    command: {
      kind: 'task.edit',
      taskId: 'task',
      revision: current.revision,
      patch: { repeatRule: null },
    },
  });
  expect((await f.service.advance('a', removeId)).operation.state).toBe('succeeded');
  expect(
    await f.db
      .prepare("SELECT COUNT(*)AS n FROM tasks_schedule_pauses WHERE task_id='task'")
      .first('n'),
  ).toBe(0);
});

it('retains a paused rule when an explicit provider schedule change is still uncertain', async () => {
  const f = await fixture();
  await f.db
    .prepare(
      "INSERT INTO tasks_schedule_pauses(account_id,task_id,rule_json,reason,paused_at,provider_version)VALUES('a','task','{}','provider_day_removed',?,'old-version')",
    )
    .bind(initial)
    .run();
  await f.uncertain({
    kind: 'task.edit',
    taskId: 'task',
    revision: 1,
    patch: { scheduledDay: '2026-11-04' },
  });
  expect(
    await f.db
      .prepare("SELECT COUNT(*)AS n FROM tasks_schedule_pauses WHERE task_id='task'")
      .first('n'),
  ).toBe(1);
});

it('keeps both observed move addresses when the original source still exists instead of declaring it absent', async () => {
  const f = await fixture();
  await f.uncertain({
    kind: 'task.move',
    taskId: 'task',
    revision: 1,
    listId: 'destination',
    listRevision: 1,
  });
  f.provider.set('google-source:original', {
    id: 'original',
    title: 'source still here',
    notes: 'source notes',
    status: 'needsAction',
    etag: 'source-current',
  });
  const preview = await f.service.resolutions.preview('a', operationId, {
    candidateId: 'moved',
    decision: 'keep_provider_current',
  });
  await f.service.resolutions.confirm('a', operationId, {
    candidateId: 'moved',
    decision: 'keep_provider_current',
    previewHash: preview.previewHash,
    confirm: true,
    confirmIdentity: true,
  });
  expect(await f.queries.getTask('a', 'task')).toMatchObject({
    title: 'source still here',
    listId: 'source',
    provider: { missing: false },
  });
  expect(
    await f.db
      .prepare("SELECT COUNT(*)AS n FROM tasks_tasks WHERE account_id='a' AND deleted_at IS NULL")
      .first('n'),
  ).toBe(2);
});

it('confirms exact provider absence through deletion adoption and never offers absent content as current state', async () => {
  const f = await fixture();
  await f.uncertain({ kind: 'task.delete', taskId: 'task', revision: 1, confirm: true });
  expect(
    await f.service.resolutions.preview('a', operationId, { decision: 'keep_provider_current' }),
  ).toMatchObject({ canConfirm: false, canKeepProviderCurrent: false, candidate: null });
  const preview = await f.service.resolutions.preview('a', operationId, {});
  expect(preview.canConfirm).toBe(true);
  await f.service.resolutions.confirm('a', operationId, {
    previewHash: preview.previewHash,
    confirm: true,
  });
  expect((await f.service.advance('a', operationId)).operation.state).toBe('succeeded');
  expect(f.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
});

it('keeps a retained list candidate and invalidates inventory before releasing its old reservation', async () => {
  const f = await fixture();
  await f.uncertain({ kind: 'list.create', title: 'created list title', boardId: 'main' });
  expect(
    await f.service.resolutions.preview('a', operationId, {
      candidateId: 'created-list',
      decision: 'keep_provider_current',
    }),
  ).toMatchObject({ canConfirm: false, canKeepProviderCurrent: false });
  await f.db
    .prepare(
      "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision)VALUES('retained-list','a','created-list','already retained title',4)",
    )
    .run();
  const preview = await f.service.resolutions.preview('a', operationId, {
    candidateId: 'created-list',
    decision: 'keep_provider_current',
  });
  expect(preview).toMatchObject({
    canConfirm: true,
    candidate: { retainedId: 'retained-list', alreadyRetained: true },
  });
  await f.service.resolutions.confirm('a', operationId, {
    candidateId: 'created-list',
    decision: 'keep_provider_current',
    previewHash: preview.previewHash,
    confirm: true,
    confirmIdentity: true,
  });
  expect(
    await f.db
      .prepare("SELECT id,title,revision FROM tasks_lists WHERE provider_id='created-list'")
      .first(),
  ).toMatchObject({ id: 'retained-list', title: 'created list title', revision: 5 });
  expect(await f.operations.listCapacity('a', initial + 31_000)).toMatchObject({
    known: null,
    reserved: 0,
    available: null,
    stale: true,
  });
  expect(await f.operations.get(operationId, 'a')).toMatchObject({
    state: 'partial',
    finished: true,
  });
  expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});

it('permits ordinary historical reopening after assigning a rule but still requires policy for a retained occurrence even after rule removal', async () => {
  const f = await fixture();
  const rule = RepeatRuleSchema.parse({ frequency: 'daily', anchorDay: '2026-11-02', zone: 'UTC' });
  await f.db
    .prepare(
      "UPDATE tasks_tasks SET completed=1,completed_at=?,scheduled_day='2026-11-02',repeat_rule_json=? WHERE id='task'",
    )
    .bind(new Date(initial).toISOString(), JSON.stringify(rule))
    .run();
  f.provider.set('google-source:original', {
    ...f.provider.get('google-source:original')!,
    status: 'completed',
    completed: new Date(initial).toISOString(),
    due: '2026-11-02T00:00:00Z',
  });
  await expect(
    f.service.prepare({
      operationId,
      accountId: 'a',
      ownerSubject: 'owner',
      command: { kind: 'task.reopen', taskId: 'task', revision: 1 },
    }),
  ).resolves.toMatchObject({ state: 'accepted' });
  expect((await f.service.advance('a', operationId)).operation.state).toBe('succeeded');
  const g = await fixture();
  await g.db
    .prepare(
      "UPDATE tasks_tasks SET completed=1,completed_at=?,occurrence_id='retained-occurrence',series_id='retained-series',repeat_rule_json=NULL WHERE id='task'",
    )
    .bind(new Date(initial).toISOString())
    .run();
  await expect(
    g.service.prepare({
      operationId,
      accountId: 'a',
      ownerSubject: 'owner',
      command: { kind: 'task.reopen', taskId: 'task', revision: 1 },
    }),
  ).rejects.toMatchObject({
    code: 'validation_failed',
    fields: { recurrence: 'preview_required' },
  });
  expect(g.calls).toHaveLength(0);
});

it('requires parent recurrence policy for child reopening only when the completed parent has an actual occurrence', async () => {
  for (const occurrenceId of [null, 'retained-occurrence']) {
    const f = await fixture();
    const child: GoogleTaskDTO = {
      id: 'child',
      title: 'child',
      parent: 'original',
      status: 'completed',
      completed: new Date(initial).toISOString(),
      etag: 'child-v1',
    };
    await f.db.batch(
      (
        await f.projection.prepareConfirmedWrites('a', 'source', [child], {
          knownTaskIds: new Map([['child', 'child']]),
        })
      ).writes,
    );
    await f.db
      .prepare(
        "UPDATE tasks_tasks SET completed=1,completed_at=?,occurrence_id=?,repeat_rule_json=NULL WHERE id='task'",
      )
      .bind(new Date(initial).toISOString(), occurrenceId)
      .run();
    f.provider.set('google-source:child', child);
    const request = {
      operationId,
      accountId: 'a',
      ownerSubject: 'owner',
      command: { kind: 'task.reopen' as const, taskId: 'child', revision: 1 },
    };
    if (occurrenceId)
      await expect(f.service.prepare(request)).rejects.toMatchObject({
        code: 'validation_failed',
        fields: { recurrence: 'preview_required', parentId: 'task' },
      });
    else await expect(f.service.prepare(request)).resolves.toMatchObject({ state: 'accepted' });
    expect(f.calls).toHaveLength(0);
  }
});

it('rolls back a stopped intent if local metadata races its final atomic projection fence', async () => {
  const f = await fixture();
  await f.uncertain({
    kind: 'task.edit',
    taskId: 'task',
    revision: 1,
    patch: { title: 'intended' },
  });
  const preview = await f.service.resolutions.preview('a', operationId, {
    decision: 'keep_provider_current',
  });
  const stop = f.operations.stopRecordedIntent.bind(f.operations);
  f.operations.stopRecordedIntent = async (input, writes, now) => {
    await f.db
      .prepare("UPDATE tasks_tasks SET priority='high',revision=revision+1 WHERE id='task'")
      .run();
    return stop(input, writes, now);
  };
  await expect(
    f.service.resolutions.confirm('a', operationId, {
      decision: 'keep_provider_current',
      previewHash: preview.previewHash,
      confirm: true,
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.operations.get(operationId, 'a')).toMatchObject({
    finished: false,
    state: 'uncertain',
  });
  expect(await f.queries.getTask('a', 'task')).toMatchObject({
    title: 'original title',
    priority: 'high',
  });
  expect(await f.operations.findStoppedIntent(operationId, 'a')).toBe(null);
});

it('rejects a different returned resource identity rather than projecting it from the selected address', async () => {
  const f = await fixture();
  await f.uncertain({
    kind: 'task.edit',
    taskId: 'task',
    revision: 1,
    patch: { title: 'intended' },
  });
  f.provider.set('google-source:original', {
    ...f.provider.get('google-source:original')!,
    id: 'another-resource',
  });
  await expect(
    f.service.resolutions.preview('a', operationId, { decision: 'keep_provider_current' }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.operations.get(operationId, 'a')).toMatchObject({
    finished: false,
    state: 'uncertain',
  });
});

async function completedReopenFixture(child: boolean) {
  const f = await fixture();
  if (child) {
    const value: GoogleTaskDTO = {
      id: 'child',
      title: 'child',
      parent: 'original',
      status: 'completed',
      completed: new Date(initial).toISOString(),
      etag: 'child-v1',
    };
    await f.db.batch(
      (
        await f.projection.prepareConfirmedWrites('a', 'source', [value], {
          knownTaskIds: new Map([['child', 'child']]),
        })
      ).writes,
    );
    f.provider.set('google-source:child', value);
  }
  await f.db
    .prepare(
      "UPDATE tasks_tasks SET completed=1,completed_at=?,scheduled_day='2026-11-02',repeat_rule_json=? WHERE id='task'",
    )
    .bind(
      new Date(initial).toISOString(),
      JSON.stringify(
        RepeatRuleSchema.parse({ frequency: 'daily', anchorDay: '2026-11-02', zone: 'UTC' }),
      ),
    )
    .run();
  f.provider.set('google-source:original', {
    ...f.provider.get('google-source:original')!,
    status: 'completed',
    completed: new Date(initial).toISOString(),
    due: '2026-11-02T00:00:00Z',
  });
  return {
    ...f,
    request: {
      operationId,
      accountId: 'a',
      ownerSubject: 'owner',
      command: { kind: 'task.reopen' as const, taskId: child ? 'child' : 'task', revision: 1 },
    },
    assignOccurrence: () =>
      f.db
        .prepare(
          "UPDATE tasks_tasks SET series_id='late-series',occurrence_id='late-occurrence' WHERE id='task'",
        )
        .run(),
  };
}
for (const child of [false, true]) {
  it(`fences occurrence admission after the ordinary ${child ? 'parent and child' : 'task'} reopen read before atomic capture`, async () => {
    const f = await completedReopenFixture(child);
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>((done) => {
        ready = done;
      }),
      released = new Promise<void>((done) => {
        release = done;
      });
    let hold = true;
    const db = new Proxy(f.db, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: Parameters<typeof target.batch>[0]) => {
            if (hold) {
              hold = false;
              ready();
              await released;
            }
            return target.batch(statements);
          };
        return Reflect.get(target, key);
      },
    });
    const service = new TaskCommandService(db, f.options),
      pending = service.prepare(f.request);
    await started;
    await f.assignOccurrence();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'conflict' });
    release();
    await rejected;
    expect(f.calls).toHaveLength(0);
    expect(await f.db.prepare('SELECT COUNT(*)AS n FROM tasks_command_plans').first('n')).toBe(0);
    expect(await f.queries.getTask('a', 'task')).toMatchObject({
      completed: true,
      revision: 1,
      occurrenceId: 'late-occurrence',
    });
  });
  it(`fences occurrence admission during provider preflight before ordinary ${child ? 'parent and child' : 'task'} reopen dispatch`, async () => {
    const f = await completedReopenFixture(child);
    await f.service.prepare(f.request);
    f.beforeProviderRead(async () => {
      await f.assignOccurrence();
    });
    const result = await f.service.advance('a', operationId);
    expect(result.operation).toMatchObject({ state: 'failed', finished: true });
    expect(f.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    expect((await f.operations.summary(operationId, 'a'))?.error?.code).toBe('validation_failed');
    expect(await f.queries.getTask('a', 'task')).toMatchObject({
      completed: true,
      revision: 1,
      occurrenceId: 'late-occurrence',
    });
  });
}
