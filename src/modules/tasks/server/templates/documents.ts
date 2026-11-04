import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import { assertLocalWritable, localWriteGuard } from '../../../accounts/server/connections/access';

import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import {
  TemplateDocumentHeaderSchema,
  TemplateDocumentSchema,
  TemplateListSchema,
  TemplateTaskSchema,
  type SnapshotSummary,
  type TemplateDocument,
  type TemplateDocumentHeader,
  type TemplateList,
  type TemplateTask,
} from '../../contracts/template';
import type { ListSnapshotStore } from './lists';
import type { MetadataContext } from '../metadata/context';
import {
  CapturedDependencyValidator,
  type DependencyValidationProgress,
} from '../commands/dependency-validation';
export interface TemplateDocumentSealResult {
  snapshotId: string;
  sealed: boolean;
  validation: DependencyValidationProgress;
  snapshot: SnapshotSummary | null;
}
const id = ResourceIdSchema.max(1024);
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const value = schema.safeParse(input);
  if (!value.success)
    throw new AppError('validation_failed', 'check the declarative template data', 422);
  return value.data;
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => [key, canonical(value)]),
        )
      : value;
const encoded = (value: unknown) => JSON.stringify(canonical(value));
function bounded(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536)
    throw new AppError(
      'validation_failed',
      'one declarative snapshot chunk may contain at most 64 kib',
      422,
    );
}
function guard(db: D1Database, condition: string, bindings: unknown[]): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
    .bind(...bindings);
}
interface HeaderRow {
  id: string;
  account_id: string;
  sealed: number;
  header_json: string;
}
export interface TemplateDocumentOptions {
  snapshots: ListSnapshotStore;
  commitWrites(writes: D1PreparedStatement[]): Promise<unknown>;
}
/** Gallery/archive data is declarative and bounded. No provider ids or executable fields enter this store. */
export class TemplateDocumentStore {
  constructor(
    private readonly db: D1Database,
    private readonly options: TemplateDocumentOptions,
  ) {}
  private async row(accountId: string, snapshotId: string): Promise<HeaderRow> {
    parse(id, accountId);
    parse(id, snapshotId);
    const row = await this.db
      .prepare(
        'SELECT snapshot.id,snapshot.account_id,snapshot.sealed,document.header_json FROM tasks_template_snapshots snapshot JOIN tasks_template_documents document ON document.snapshot_id=snapshot.id WHERE snapshot.account_id=? AND snapshot.id=?',
      )
      .bind(accountId, snapshotId)
      .first<HeaderRow>();
    if (!row)
      throw new AppError('not_found', 'this declarative snapshot capture is not available', 404);
    return row;
  }
  private headerWrite(
    accountId: string,
    snapshotId: string,
    header: z.output<typeof TemplateDocumentHeaderSchema>,
    time: number,
    sealed: boolean,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        'INSERT INTO tasks_template_snapshots(id,account_id,schema_version,sealed,date_mode,save_day,zone,list_count,task_count,context_parent_count,completed_included_count,omitted_dependency_count,source_dated_count,source_timed_count,source_repeat_count,created_at) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        snapshotId,
        accountId,
        Number(sealed),
        header.dateMode,
        header.saveDay,
        header.zone,
        header.listCount,
        header.taskCount,
        header.contextParentCount,
        header.completedIncludedCount,
        header.omittedDependencyCount,
        header.sourceDatedCount ?? 0,
        header.sourceTimedCount ?? 0,
        header.sourceRepeatCount ?? 0,
        time,
      );
  }
  async begin(
    accountId: string,
    input: unknown,
    context: MetadataContext,
    admittedId: string = crypto.randomUUID(),
  ): Promise<{
    snapshotId: string;
  }> {
    const header = parse(TemplateDocumentHeaderSchema, input);
    parse(id, admittedId);
    await assertLocalWritable(this.db, accountId);
    bounded(header);
    const prior = await this.db
      .prepare(
        'SELECT header_json FROM tasks_template_documents document JOIN tasks_template_snapshots snapshot ON snapshot.id=document.snapshot_id WHERE snapshot.account_id=? AND document.snapshot_id=?',
      )
      .bind(accountId, admittedId)
      .first<{
        header_json: string;
      }>();
    if (prior) {
      if (prior.header_json !== encoded(header))
        throw new AppError(
          'conflict',
          'this snapshot identity already has different document input',
          409,
        );
      await this.options.commitWrites([localWriteGuard(this.db, accountId)]);
      return { snapshotId: admittedId };
    }
    await this.options.commitWrites([
      localWriteGuard(this.db, accountId),
      this.headerWrite(accountId, admittedId, header, Date.parse(context.recordedAt), false),
      this.db
        .prepare(
          'INSERT INTO tasks_template_documents(snapshot_id,header_json,created_at) VALUES (?,?,?)',
        )
        .bind(admittedId, encoded(header), Date.parse(context.recordedAt)),
      this.options.snapshots.pinWrite(accountId, admittedId, `document:${admittedId}`),
    ]);
    return { snapshotId: admittedId };
  }
  private stagingGuard(accountId: string, snapshotId: string): D1PreparedStatement {
    return guard(
      this.db,
      'EXISTS (SELECT 1 FROM tasks_template_snapshots WHERE account_id=? AND id=? AND sealed=0)',
      [accountId, snapshotId],
    );
  }
  private listWrites(snapshotId: string, lists: TemplateList[]): D1PreparedStatement[] {
    return lists.map((list) =>
      this.db
        .prepare(
          'INSERT INTO tasks_template_lists(snapshot_id,item_key,position,title,color) VALUES (?,?,?,?,?)',
        )
        .bind(snapshotId, list.key, list.position, list.title, list.color),
    );
  }
  private taskWrites(snapshotId: string, tasks: TemplateTask[]): D1PreparedStatement[] {
    return tasks.map((task) =>
      this.db
        .prepare(
          'INSERT INTO tasks_template_nodes(snapshot_id,item_key,position,list_key,parent_key,content_json) VALUES (?,?,?,?,?,?)',
        )
        .bind(snapshotId, task.key, task.position, task.listKey, task.parentKey, encoded(task)),
    );
  }
  private labelWrites(snapshotId: string, tasks: TemplateTask[]): D1PreparedStatement[] {
    const definitions = new Map<
      string,
      {
        nameKey: string;
        name: string;
        color: string;
      }
    >();
    for (const task of tasks)
      for (const label of task.labels) {
        const nameKey = label.name.normalize('NFC').toLowerCase(),
          prior = definitions.get(nameKey);
        if (prior && prior.color !== label.color)
          throw new AppError(
            'validation_failed',
            'one reusable label name cannot have conflicting colors',
            422,
          );
        if (!prior)
          definitions.set(nameKey, {
            nameKey,
            name: label.name.normalize('NFC'),
            color: label.color,
          });
      }
    if (!definitions.size) return [];
    const values = JSON.stringify([...definitions.values()]);
    return [
      guard(
        this.db,
        `NOT EXISTS (SELECT 1 FROM json_each(?) selected JOIN tasks_template_label_definitions existing ON existing.snapshot_id=? AND existing.name_key=json_extract(selected.value,'$.nameKey') WHERE existing.color<>json_extract(selected.value,'$.color'))`,
        [values, snapshotId],
      ),
      this.db
        .prepare(
          `INSERT INTO tasks_template_label_definitions(snapshot_id,name_key,name,color) SELECT ?,json_extract(value,'$.nameKey'),json_extract(value,'$.name'),json_extract(value,'$.color') FROM json_each(?) WHERE 1 ON CONFLICT(snapshot_id,name_key) DO NOTHING`,
        )
        .bind(snapshotId, values),
    ];
  }
  async appendLists(accountId: string, snapshotId: string, input: unknown): Promise<void> {
    const row = await this.row(accountId, snapshotId),
      header = parse(TemplateDocumentHeaderSchema, JSON.parse(row.header_json)),
      lists = parse(z.array(TemplateListSchema).min(1).max(10), input);
    bounded(lists);
    await assertLocalWritable(this.db, accountId);
    if (
      lists.some((list) => list.position >= header.listCount) ||
      new Set(lists.map((list) => list.key)).size !== lists.length ||
      new Set(lists.map((list) => list.position)).size !== lists.length
    )
      throw new AppError('validation_failed', 'use each declared list key/position once', 422);
    const prior = (
      await this.db
        .prepare(
          'SELECT item_key,position,title,color FROM tasks_template_lists WHERE snapshot_id=? AND item_key IN (SELECT value FROM json_each(?))',
        )
        .bind(snapshotId, JSON.stringify(lists.map((value) => value.key)))
        .all<{
          item_key: string;
          position: number;
          title: string;
          color: string;
        }>()
    ).results;
    const fresh = lists.filter((list) => {
      const old = prior.find((value) => value.item_key === list.key);
      if (!old) return true;
      if (
        encoded(list) !==
        encoded({ key: old.item_key, position: old.position, title: old.title, color: old.color })
      )
        throw new AppError('conflict', 'this template list key already has different content', 409);
      return false;
    });
    if (!fresh.length) {
      await this.options.commitWrites([localWriteGuard(this.db, accountId)]);
      return;
    }
    if (row.sealed) throw new AppError('conflict', 'this template snapshot is immutable', 409);
    await this.options.commitWrites([
      localWriteGuard(this.db, accountId),
      this.stagingGuard(accountId, snapshotId),
      guard(this.db, 'NOT EXISTS(SELECT 1 FROM tasks_template_validation WHERE snapshot_id=?)', [
        snapshotId,
      ]),
      ...this.listWrites(snapshotId, fresh),
    ]);
  }
  async appendTasks(accountId: string, snapshotId: string, input: unknown): Promise<void> {
    const row = await this.row(accountId, snapshotId),
      header = parse(TemplateDocumentHeaderSchema, JSON.parse(row.header_json)),
      tasks = parse(z.array(TemplateTaskSchema).min(1).max(10), input);
    bounded(tasks);
    await assertLocalWritable(this.db, accountId);
    if (
      header.dateMode === 'none' &&
      tasks.some((task) => task.dayOffset !== null || task.scheduledTime || task.timeZone)
    )
      throw new AppError(
        'validation_failed',
        'a no-date snapshot cannot carry active dates or times',
        422,
      );
    if (
      tasks.some((task) => task.position >= header.taskCount) ||
      new Set(tasks.map((task) => task.key)).size !== tasks.length ||
      new Set(tasks.map((task) => task.position)).size !== tasks.length
    )
      throw new AppError('validation_failed', 'use each declared task key/position once', 422);
    const prior = (
      await this.db
        .prepare(
          'SELECT item_key,content_json FROM tasks_template_nodes WHERE snapshot_id=? AND item_key IN (SELECT value FROM json_each(?))',
        )
        .bind(snapshotId, JSON.stringify(tasks.map((value) => value.key)))
        .all<{
          item_key: string;
          content_json: string;
        }>()
    ).results;
    const fresh = tasks.filter((task) => {
      const old = prior.find((value) => value.item_key === task.key);
      if (!old) return true;
      if (old.content_json !== encoded(task))
        throw new AppError('conflict', 'this template task key already has different content', 409);
      return false;
    });
    if (!fresh.length) {
      await this.options.commitWrites([localWriteGuard(this.db, accountId)]);
      return;
    }
    if (row.sealed) throw new AppError('conflict', 'this template snapshot is immutable', 409);
    await this.options.commitWrites([
      localWriteGuard(this.db, accountId),
      this.stagingGuard(accountId, snapshotId),
      guard(this.db, 'NOT EXISTS(SELECT 1 FROM tasks_template_validation WHERE snapshot_id=?)', [
        snapshotId,
      ]),
      ...this.labelWrites(snapshotId, fresh),
      ...this.taskWrites(snapshotId, fresh),
    ]);
  }
  private invalidReferences(snapshotId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `SELECT 1 AS invalid FROM tasks_template_nodes task LEFT JOIN tasks_template_nodes parent ON parent.snapshot_id=task.snapshot_id AND parent.item_key=task.parent_key WHERE task.snapshot_id=? AND ((task.parent_key IS NOT NULL AND (parent.item_key IS NULL OR parent.parent_key IS NOT NULL OR parent.list_key<>task.list_key)) OR EXISTS (SELECT 1 FROM json_each(task.content_json,'$.dependencyKeys') dependency LEFT JOIN tasks_template_nodes blocker ON blocker.snapshot_id=task.snapshot_id AND blocker.item_key=dependency.value WHERE blocker.item_key IS NULL OR blocker.item_key=task.item_key))
 LIMIT 1`,
      )
      .bind(snapshotId);
  }
  async validationReady(accountId: string, snapshotId: string): Promise<boolean> {
    await this.row(accountId, snapshotId);
    return (
      (await this.db
        .prepare(
          `SELECT 1 FROM tasks_template_snapshots snapshot LEFT JOIN tasks_template_validation validation ON validation.snapshot_id=snapshot.id
      WHERE snapshot.account_id=? AND snapshot.id=? AND (snapshot.sealed=1 OR validation.stage='ready')`,
        )
        .bind(accountId, snapshotId)
        .first()) !== null
    );
  }
  async validate(accountId: string, snapshotId: string): Promise<DependencyValidationProgress> {
    const row = await this.row(accountId, snapshotId),
      header = parse(TemplateDocumentHeaderSchema, JSON.parse(row.header_json));
    if (row.sealed)
      return {
        stage: 'ready',
        checkedTasks: header.taskCount,
        totalTasks: header.taskCount,
        remainingTasks: 0,
      };
    await assertLocalWritable(this.db, accountId);
    const validator = new CapturedDependencyValidator(this.db, 'template');
    if (!(await validator.started(snapshotId, accountId))) {
      const lists = await this.db
          .prepare(
            'SELECT COUNT(*) AS n,MIN(position) AS first,MAX(position) AS last FROM tasks_template_lists WHERE snapshot_id=?',
          )
          .bind(snapshotId)
          .first<{
            n: number;
            first: number | null;
            last: number | null;
          }>(),
        tasks = await this.db
          .prepare(
            "SELECT COUNT(*) AS n,MIN(position) AS first,MAX(position) AS last,COALESCE(SUM(json_extract(content_json,'$.dayOffset') IS NOT NULL),0) AS dated,COALESCE(SUM(json_extract(content_json,'$.scheduledTime') IS NOT NULL),0) AS timed,COALESCE(SUM(json_extract(content_json,'$.repeatPreset') IS NOT NULL),0) AS repeated FROM tasks_template_nodes WHERE snapshot_id=?",
          )
          .bind(snapshotId)
          .first<{
            n: number;
            first: number | null;
            last: number | null;
            dated: number;
            timed: number;
            repeated: number;
          }>();
      if (
        lists?.n !== header.listCount ||
        tasks?.n !== header.taskCount ||
        (header.listCount > 0 && (lists.first !== 0 || lists.last !== header.listCount - 1)) ||
        (header.taskCount > 0 && (tasks.first !== 0 || tasks.last !== header.taskCount - 1))
      )
        throw new AppError(
          'conflict',
          'capture the whole declarative snapshot before sealing it',
          409,
        );
      if (await this.invalidReferences(snapshotId).first())
        throw new AppError(
          'validation_failed',
          'the template has missing, cross-list, cyclic or deeper references',
          422,
        );
      const dated = Math.max(header.sourceDatedCount ?? 0, tasks.dated),
        timed = Math.max(header.sourceTimedCount ?? 0, tasks.timed),
        repeated = Math.max(header.sourceRepeatCount ?? 0, tasks.repeated);
      if (
        dated > header.taskCount ||
        timed > dated ||
        repeated > header.taskCount ||
        header.contextParentCount > header.taskCount ||
        header.completedIncludedCount > header.taskCount
      )
        throw new AppError(
          'validation_failed',
          'the declared snapshot counts disagree with its content',
          422,
        );
      await validator.initialize(snapshotId, accountId, header.taskCount, [
        this.stagingGuard(accountId, snapshotId),
        guard(
          this.db,
          '(SELECT COUNT(*) FROM tasks_template_lists WHERE snapshot_id=?)=? AND (SELECT COUNT(*) FROM tasks_template_nodes WHERE snapshot_id=?)=?',
          [snapshotId, header.listCount, snapshotId, header.taskCount],
        ),
        this.db
          .prepare(
            'UPDATE tasks_template_snapshots SET source_dated_count=?,source_timed_count=?,source_repeat_count=? WHERE account_id=? AND id=? AND sealed=0',
          )
          .bind(dated, timed, repeated, accountId, snapshotId),
      ]);
    }
    return validator.advance(snapshotId, accountId);
  }
  async seal(accountId: string, snapshotId: string): Promise<TemplateDocumentSealResult> {
    const validation = await this.validate(accountId, snapshotId);
    if (validation.stage !== 'ready')
      return { snapshotId, sealed: false, validation, snapshot: null };
    const row = await this.row(accountId, snapshotId);
    if (row.sealed) {
      await this.options.commitWrites([localWriteGuard(this.db, accountId)]);
      return {
        snapshotId,
        sealed: true,
        validation,
        snapshot: await this.options.snapshots.get(accountId, snapshotId),
      };
    }
    await this.options.commitWrites([
      localWriteGuard(this.db, accountId),
      this.stagingGuard(accountId, snapshotId),
      guard(
        this.db,
        "EXISTS(SELECT 1 FROM tasks_template_validation WHERE snapshot_id=? AND account_id=? AND stage='ready' AND checked_tasks=total_tasks)",
        [snapshotId, accountId],
      ),
      this.db
        .prepare('UPDATE tasks_template_snapshots SET sealed=1 WHERE account_id=? AND id=?')
        .bind(accountId, snapshotId),
    ]);
    return {
      snapshotId,
      sealed: true,
      validation,
      snapshot: await this.options.snapshots.get(accountId, snapshotId),
    };
  }
  /** Cleanup capability: releases only bounded document staging pins, never installed version/run pins. */
  async releaseCapturePins(accountId: string, snapshotIds: readonly string[]): Promise<number> {
    parse(id, accountId);
    parse(z.array(id).max(10), snapshotIds);
    if (!snapshotIds.length) return 0;
    const results = await this.db.batch(
      snapshotIds.map((snapshotId) =>
        this.options.snapshots.releasePinWrite(accountId, snapshotId, `document:${snapshotId}`),
      ),
    );
    return results.reduce((sum, result) => sum + result.meta.changes, 0);
  }
  async release(accountId: string, snapshotId: string): Promise<void> {
    await this.row(accountId, snapshotId);
    await assertLocalWritable(this.db, accountId);
    await this.options.commitWrites([
      localWriteGuard(this.db, accountId),
      this.options.snapshots.releasePinWrite(accountId, snapshotId, `document:${snapshotId}`),
    ]);
  }
  /** Small bundled gallery entries fit one local receipt; larger archives use the chunked methods. */
  prepareSmall(
    accountId: string,
    input: TemplateDocument,
    context: MetadataContext,
    admittedId: string = crypto.randomUUID(),
  ): {
    snapshotId: string;
    writes: D1PreparedStatement[];
  } {
    const document = parse(TemplateDocumentSchema, input);
    parse(id, accountId);
    parse(id, admittedId);
    bounded(document);
    if (document.lists.length > 10 || document.tasks.length > 10)
      throw new AppError(
        'validation_failed',
        'use chunked capture for a larger reusable snapshot',
        422,
      );
    if (
      document.header.listCount !== document.lists.length ||
      document.header.taskCount !== document.tasks.length ||
      document.lists.some((list, index) => list.position !== index) ||
      document.tasks.some((task, index) => task.position !== index)
    )
      throw new AppError(
        'validation_failed',
        'gallery counts and order must match their declarative content',
        422,
      );
    if (
      document.header.dateMode === 'none' &&
      document.tasks.some((task) => task.dayOffset !== null || task.scheduledTime || task.timeZone)
    )
      throw new AppError(
        'validation_failed',
        'a no-date gallery entry cannot carry active dates or times',
        422,
      );
    const listKeys = new Set(document.lists.map((value) => value.key)),
      tasks = new Map(document.tasks.map((value) => [value.key, value]));
    if (listKeys.size !== document.lists.length || tasks.size !== document.tasks.length)
      throw new AppError('validation_failed', 'use unique gallery identities', 422);
    for (const task of document.tasks) {
      const parent = task.parentKey ? tasks.get(task.parentKey) : null;
      if (
        !listKeys.has(task.listKey) ||
        (task.parentKey && (!parent || parent.parentKey || parent.listKey !== task.listKey)) ||
        task.dependencyKeys.some((key) => !tasks.has(key) || key === task.key)
      )
        throw new AppError(
          'validation_failed',
          'gallery references must remain inside the captured set',
          422,
        );
      const seen = new Set<string>(),
        visit = (key: string): void => {
          if (key === task.key)
            throw new AppError('validation_failed', 'gallery dependencies cannot cycle', 422);
          if (seen.has(key)) return;
          seen.add(key);
          for (const blocker of tasks.get(key)!.dependencyKeys) visit(blocker);
        };
      for (const key of task.dependencyKeys) visit(key);
    }
    const header = {
      ...document.header,
      sourceDatedCount:
        document.header.sourceDatedCount ??
        document.tasks.filter((task) => task.dayOffset !== null).length,
      sourceTimedCount:
        document.header.sourceTimedCount ??
        document.tasks.filter((task) => task.scheduledTime).length,
      sourceRepeatCount:
        document.header.sourceRepeatCount ??
        document.tasks.filter((task) => task.repeatPreset).length,
    };
    return {
      snapshotId: admittedId,
      writes: [
        localWriteGuard(this.db, accountId),
        this.headerWrite(accountId, admittedId, header, Date.parse(context.recordedAt), true),
        ...this.listWrites(admittedId, document.lists),
        ...this.labelWrites(admittedId, document.tasks),
        ...this.taskWrites(admittedId, document.tasks),
      ],
    };
  }
}
