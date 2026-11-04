import type { D1Database } from '@cloudflare/workers-types';
import { assertLocalWritable } from '../../../accounts/server/connections/access';
import type { HistoryEventInput } from '../../../history/contracts/events';
import type { ProviderCommand } from '../../../tasks/contracts/provider-commands';
import {
  type ArchiveField,
  type ArchiveHeader,
  type ArchiveMatch,
  type ArchiveRecord,
} from '../../contracts/archive';
import { type ArchiveRecordRow, type ArchiveRow, type ArchiveSummary } from './archive-store';
import { ArchiveRestoreCommands } from './restore-commands';
import type { ArchiveRestoreOptions } from './restore-dependencies';
import { ArchiveRestoreSelection } from './restore-selection';
import { ArchiveRestoreSource } from './restore-source';
import { conflict, type ActionRow, type LocalAction } from './restore-state';

/** Restore applies only lanes-owned fields through their owners. Provider content is never created/deleted here. */
export class ArchiveRestoreService {
  readonly selection: ArchiveRestoreSelection;
  private readonly sources: ArchiveRestoreSource;
  private readonly local: ArchiveRestoreCommands;
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: ArchiveRestoreOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.sources = new ArchiveRestoreSource(db, options.boards.queries);
    this.selection = new ArchiveRestoreSelection(db, options, this.sources);
    this.local = new ArchiveRestoreCommands(db, options);
  }

  private async finishRecord(row: ArchiveRow, key: string) {
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE transfer_archives SET restored_count=restored_count+CASE WHEN EXISTS(SELECT 1 FROM transfer_archive_records WHERE archive_id=? AND item_key=? AND restore_state<>'restored')THEN 1 ELSE 0 END,updated_at=? WHERE id=?",
        )
        .bind(row.id, key, this.now(), row.id),
      this.db
        .prepare(
          "UPDATE transfer_archive_records SET restore_state='restored' WHERE archive_id=? AND item_key=?",
        )
        .bind(row.id, key),
    ]);
  }
  async advanceNext(): Promise<ArchiveSummary | null> {
    const row = await this.db
      .prepare(
        `SELECT id,account_id FROM transfer_archives archive WHERE (state='restoring' AND paused=0)
          OR (state='cancelled' AND EXISTS(SELECT 1 FROM transfer_archive_actions action WHERE action.archive_id=archive.id AND action.state='pending'))
          ORDER BY work_order,created_at,id LIMIT 1`,
      )
      .first<{ id: string; account_id: string }>();
    if (!row) return null;
    await this.db
      .prepare(
        'UPDATE transfer_archives SET work_order=(SELECT COALESCE(MAX(work_order),0)+1 FROM transfer_archives)WHERE id=?',
      )
      .bind(row.id)
      .run();
    return this.advance(row.id, row.account_id);
  }
  async resume(id: string, accountId: string): Promise<ArchiveSummary> {
    await assertLocalWritable(this.db, accountId);
    await this.options.store.row(id, accountId);
    await this.db.prepare('UPDATE transfer_archives SET paused=0 WHERE id=?').bind(id).run();
    return this.options.store.get(id, accountId);
  }
  async cancel(id: string, accountId: string): Promise<ArchiveSummary> {
    const row = await this.options.store.row(id, accountId);
    if (row.state === 'finished') return this.options.store.get(id, accountId);
    if (row.state !== 'cancelled')
      await this.db
        .prepare(
          "UPDATE transfer_archives SET state='cancelled',paused=1,finished_at=COALESCE(finished_at,?),updated_at=? WHERE id=?",
        )
        .bind(this.now(), this.now(), id)
        .run();
    const actions = (
      await this.db
        .prepare(
          "SELECT item_key,phase,operation_id FROM transfer_archive_actions WHERE archive_id=? AND state='pending' ORDER BY item_key,phase LIMIT 5",
        )
        .bind(id)
        .all<{ item_key: string; phase: string; operation_id: string }>()
    ).results;
    for (const action of actions) {
      let operation = await this.options.operations.get(action.operation_id, accountId);
      if (operation && !operation.finished) {
        await this.options.operations.cancel(action.operation_id, accountId, this.now());
        operation = await this.options.operations.get(action.operation_id, accountId);
      }
      if (!operation || operation.finished)
        await this.db
          .prepare(
            "UPDATE transfer_archive_actions SET state='cancelled' WHERE archive_id=? AND item_key=? AND phase=? AND state='pending'",
          )
          .bind(id, action.item_key, action.phase)
          .run();
    }
    return this.options.store.get(id, accountId);
  }
  async advance(id: string, accountId: string): Promise<ArchiveSummary> {
    const row = await this.options.store.row(id, accountId);
    if (row.state === 'cancelled') return this.cancel(id, accountId);
    if (row.state !== 'restoring' || row.paused) return this.options.store.get(id, accountId);
    await assertLocalWritable(this.db, accountId);
    const readyTemplate = await this.db
      .prepare(
        `SELECT parent.* FROM transfer_archive_records parent WHERE parent.archive_id=? AND parent.kind='template' AND parent.incoming=1 AND parent.restore_state='prepared' AND NOT EXISTS(SELECT 1 FROM transfer_archive_records child WHERE child.archive_id=parent.archive_id AND child.kind IN('template_list','template_task') AND json_extract(child.input_json,'$.templateKey')=parent.item_key AND child.incoming=1 AND child.restore_state='pending') ORDER BY parent.position LIMIT 1`,
      )
      .bind(id)
      .first<ArchiveRecordRow>();
    if (readyTemplate) {
      await this.finishTemplate(row, readyTemplate);
      return this.options.store.get(id, accountId);
    }
    const saved = await this.db
      .prepare(
        `SELECT * FROM transfer_archive_records WHERE archive_id=? AND incoming=1 AND restore_state='pending' ORDER BY restore_priority,position LIMIT 1`,
      )
      .bind(id)
      .first<ArchiveRecordRow>();
    if (saved) {
      const record = JSON.parse(saved.input_json) as ArchiveRecord,
        match = JSON.parse(saved.match_json!) as ArchiveMatch,
        fields = JSON.parse(saved.fields_json) as ArchiveField[];
      await this.advanceRecord(row, saved, record, match, fields);
      return this.options.store.get(id, accountId);
    }
    const prepared = await this.db
      .prepare(
        "SELECT * FROM transfer_archive_records WHERE archive_id=? AND kind='template' AND restore_state='prepared' ORDER BY position LIMIT 1",
      )
      .bind(id)
      .first<ArchiveRecordRow>();
    if (prepared) {
      await this.finishTemplate(row, prepared);
      return this.options.store.get(id, accountId);
    }
    if (row.preferences_incoming) {
      const header = JSON.parse(row.header_json) as ArchiveHeader;
      await this.local.apply(
        row,
        await this.local.capture(row, 'preferences', 'apply', {
          kind: 'preferences',
          input: {
            revision: row.preferences_revision,
            planningZone: header.source.planningZone,
            weekStart: header.source.weekStart,
          },
        }),
      );
      await this.db
        .prepare('UPDATE transfer_archives SET preferences_incoming=0 WHERE id=?')
        .bind(id)
        .run();
      return this.options.store.get(id, accountId);
    }
    await this.db
      .prepare(
        "UPDATE transfer_archives SET state='finished',finished_at=?,updated_at=? WHERE id=?",
      )
      .bind(this.now(), this.now(), id)
      .run();
    return this.options.store.get(id, accountId);
  }
  private async advanceRecord(
    row: ArchiveRow,
    saved: ArchiveRecordRow,
    record: ArchiveRecord,
    match: ArchiveMatch,
    fields: ArchiveField[],
  ): Promise<void> {
    if (record.kind === 'task') {
      await this.restoreTask(row, saved, record, match, fields);
      return;
    }
    if (record.kind === 'template') {
      const snapshotId = await this.sources.stable(
        row,
        record.key + ':' + row.id,
        'archive-snapshot',
      );
      await this.local.apply(
        row,
        await this.local.capture(row, record.key, 'begin', {
          kind: 'document.begin',
          snapshotId,
          input: record.header,
        }),
      );
      await this.db
        .prepare(
          "UPDATE transfer_archive_records SET restore_state='prepared' WHERE archive_id=? AND item_key=?",
        )
        .bind(row.id, record.key)
        .run();
      return;
    }
    if (record.kind === 'template_list' || record.kind === 'template_task') {
      const snapshotId = await this.sources.stable(
        row,
        record.templateKey + ':' + row.id,
        'archive-snapshot',
      );
      await this.local.apply(
        row,
        await this.local.capture(row, record.key, 'content', {
          kind: record.kind === 'template_list' ? 'document.lists' : 'document.tasks',
          snapshotId,
          input: [record.value],
        }),
      );
      await this.finishRecord(row, record.key);
      return;
    }
    if (record.kind === 'board') {
      const base: LocalAction =
        match.status === 'new'
          ? {
              kind: 'board.create',
              id: match.destinationId,
              input: {
                title: record.title,
                emoji: record.emoji,
                color: record.color,
                backgroundUrl: record.backgroundUrl,
              },
            }
          : {
              kind: 'board.update',
              id: match.destinationId,
              revision: match.destinationRevision,
              input: {
                ...(fields.includes('name') ? { title: record.title } : {}),
                ...(fields.includes('appearance')
                  ? {
                      emoji: record.emoji,
                      color: record.color,
                      backgroundUrl: record.backgroundUrl,
                    }
                  : {}),
              },
            };
      if (match.status === 'new' || fields.includes('name') || fields.includes('appearance'))
        await this.local.apply(row, await this.local.capture(row, record.key, 'appearance', base));
      if (fields.includes('order'))
        await this.local.apply(
          row,
          await this.local.capture(row, record.key, 'order', {
            kind: 'board.order',
            id: match.destinationId,
            revision:
              match.status === 'new'
                ? 0
                : match.destinationRevision! +
                  (fields.includes('name') || fields.includes('appearance') ? 1 : 0),
            position: record.position,
          }),
        );
    } else if (record.kind === 'list') {
      let revision = match.destinationRevision!;
      if (fields.includes('placement')) {
        await this.local.apply(
          row,
          await this.local.capture(row, record.key, 'placement', {
            kind: 'list.placement',
            id: match.destinationId,
            targetId: await this.sources.targetBoard(row, record.boardKey),
            revision,
            position: record.position,
          }),
        );
        revision++;
      }
      if (fields.includes('appearance'))
        await this.local.apply(
          row,
          await this.local.capture(row, record.key, 'appearance', {
            kind: 'list.appearance',
            id: match.destinationId,
            revision,
            input: record.color,
          }),
        );
    } else if (record.kind === 'label')
      await this.local.apply(
        row,
        await this.local.capture(row, record.key, 'definition', {
          kind: match.status === 'new' ? 'label.create' : 'label.update',
          id: match.destinationId,
          ...(match.destinationRevision !== undefined
            ? { revision: match.destinationRevision }
            : {}),
          input: { name: record.name, color: record.color },
        }),
      );
    else if (record.kind === 'schedule') {
      const template = await this.sources.read(row, record.templateKey);
      if (template.kind !== 'template') throw conflict();
      const templateId = await this.sources.stable(row, template.key, 'archive-template'),
        owners = this.options.ownerFactory(async () => {
          throw conflict();
        });
      const current =
        template.templateKind === 'list'
          ? await owners.listTemplates?.get(row.account_id, templateId)
          : await owners.boardTemplates?.get(row.account_id, templateId);
      if (!current) throw conflict('restore the selected template before its paused schedule.');
      const boardId = await this.sources.targetBoard(row, record.boardKey),
        board = await this.options.boards.queries.getBoard(row.account_id, boardId);
      const input = {
        template: {
          kind: template.templateKind,
          id: templateId,
          contentRevision: current.contentRevision,
        },
        boardId,
        boardRevision: board.revision,
        timing: record.timing,
        useRelativeDates: record.useRelativeDates,
        listPrefix: record.listPrefix,
      };
      if (match.status === 'new')
        await this.local.apply(
          row,
          await this.local.capture(row, record.key, 'create', {
            kind: 'schedule.create',
            id: match.destinationId,
            input,
          }),
        );
      else {
        await this.local.apply(
          row,
          await this.local.capture(row, record.key, 'pause', {
            kind: 'schedule.pause',
            id: match.destinationId,
            revision: match.destinationRevision,
          }),
        );
        await this.local.apply(
          row,
          await this.local.capture(row, record.key, 'update', {
            kind: 'schedule.update',
            id: match.destinationId,
            revision: match.destinationRevision! + 1,
            input,
          }),
        );
      }
    } else if (record.kind === 'history') {
      const event = await this.remapHistory(row, record);
      await this.local.apply(
        row,
        await this.local.capture(row, record.key, 'history', { kind: 'history', event }),
      );
    }
    await this.finishRecord(row, record.key);
  }
  private async restoreTask(
    row: ArchiveRow,
    saved: ArchiveRecordRow,
    record: Extract<ArchiveRecord, { kind: 'task' }>,
    match: ArchiveMatch,
    fields: ArchiveField[],
  ): Promise<void> {
    const labels = fields.includes('labels') ? record.labels : [],
      existing = await this.options.queries.labels.readLabelsByNames(
        row.account_id,
        labels.map((label) => label.name),
      );
    for (const label of labels) {
      if (
        existing.some(
          (value) =>
            value.name.normalize('NFC').toLowerCase() === label.name.normalize('NFC').toLowerCase(),
        )
      )
        continue;
      const id = await this.sources.stable(
        row,
        'label-name:' + label.name.normalize('NFC').toLowerCase(),
        'archive-label',
      );
      await this.local.apply(
        row,
        await this.local.capture(row, record.key, 'label:' + label.key, {
          kind: 'label.create',
          id,
          input: { name: label.name, color: label.color },
        }),
      );
      return;
    }
    const patch: Record<string, unknown> = {};
    if (fields.includes('labels'))
      patch.labelIds = labels.map(
        (label) =>
          existing.find(
            (value) =>
              value.name.normalize('NFC').toLowerCase() ===
              label.name.normalize('NFC').toLowerCase(),
          )!.id,
      );
    if (fields.includes('priority')) patch.priority = record.priority;
    if (fields.includes('starred')) patch.starred = record.starred;
    if (fields.includes('dependencies')) patch.blockedBy = match.dependencyIds ?? [];
    if (fields.includes('time')) {
      patch.scheduledTime = record.scheduledTime;
      patch.timeZone = record.timeZone;
    }
    if (fields.includes('repeat')) patch.repeatRule = record.repeatRule;
    if (!Object.keys(patch).length) {
      await this.finishRecord(row, record.key);
      return;
    }
    const metadata = this.options.ownerFactory(async () => {
      throw conflict();
    }).metadata;
    const existingAction = await this.db
      .prepare(
        "SELECT * FROM transfer_archive_actions WHERE archive_id=? AND item_key=? AND phase='task'",
      )
      .bind(row.id, record.key)
      .first<ActionRow>();
    const action =
      existingAction ??
      (await this.local.capture(row, record.key, 'task', {
        kind: 'task',
        command: {
          kind: 'task.edit',
          taskId: match.destinationId,
          revision: match.destinationRevision,
          patch,
          ...(fields.includes('dependencies')
            ? { expectedGraphRevision: await metadata.getGraphRevision(row.account_id) }
            : {}),
        },
      }));
    const input = JSON.parse(action.input_json) as { command: ProviderCommand };
    await this.options.commands.capture.prepare({
      operationId: action.operation_id,
      accountId: row.account_id,
      ownerSubject: row.owner_subject,
      command: input.command,
    });
    const result = await this.options.commands.advance(row.account_id, action.operation_id);
    if (result.operation.finished) {
      if (result.operation.state !== 'succeeded') throw conflict();
      await this.db
        .prepare(
          "UPDATE transfer_archive_actions SET state='confirmed' WHERE archive_id=? AND item_key=? AND phase='task'",
        )
        .bind(row.id, record.key)
        .run();
      await this.finishRecord(row, record.key);
    }
  }
  private async finishTemplate(row: ArchiveRow, saved: ArchiveRecordRow) {
    const record = JSON.parse(saved.input_json) as Extract<ArchiveRecord, { kind: 'template' }>,
      match = JSON.parse(saved.match_json!) as ArchiveMatch,
      snapshotId = await this.sources.stable(row, record.key + ':' + row.id, 'archive-snapshot');
    if (
      !(await this.local.apply(
        row,
        await this.local.capture(row, record.key, 'seal', { kind: 'document.seal', snapshotId }),
      ))
    )
      return;
    await this.local.apply(
      row,
      await this.local.capture(row, record.key, 'install', {
        kind: 'template.install',
        snapshotId,
        templateId: match.destinationId,
        source: record,
        ...(match.destinationRevision !== undefined ? { revision: match.destinationRevision } : {}),
      }),
    );
    await this.finishRecord(row, record.key);
  }
  private async remapHistory(
    row: ArchiveRow,
    record: Extract<ArchiveRecord, { kind: 'history' }>,
  ): Promise<HistoryEventInput> {
    const event = structuredClone(record.event),
      keys = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === 'string') keys.add(value);
      else if (Array.isArray(value)) for (const item of value) collect(item);
      else if (value && typeof value === 'object')
        for (const item of Object.values(value)) collect(item);
    };
    collect(event);
    const mappings = (
      await this.db
        .prepare(
          'SELECT item_key,match_json FROM transfer_archive_records WHERE archive_id=? AND item_key IN(SELECT value FROM json_each(?))',
        )
        .bind(row.id, JSON.stringify([...keys]))
        .all<{ item_key: string; match_json: string | null }>()
    ).results;
    const matches = new Map(
      mappings
        .filter((value) => value.match_json)
        .map((value) => [value.item_key, JSON.parse(value.match_json!) as ArchiveMatch]),
    );
    const map = async (key: string | null, prefix: string): Promise<string | null> =>
      key === null
        ? null
        : (matches.get(key)?.destinationId ?? (await this.sources.stable(row, key, prefix)));
    event.accountId = row.account_id;
    event.taskId = await map(event.taskId, 'historical-task');
    event.listId = await map(event.listId, 'historical-list');
    if ('from' in event.summary && 'to' in event.summary) {
      event.summary.from.listId = (await map(event.summary.from.listId, 'historical-list'))!;
      event.summary.from.parentId = await map(event.summary.from.parentId, 'historical-task');
      event.summary.to.listId = (await map(event.summary.to.listId, 'historical-list'))!;
      event.summary.to.parentId = await map(event.summary.to.parentId, 'historical-task');
    }
    if (event.kind === 'labels_changed' || event.kind === 'dependencies_changed') {
      const prefix = event.kind === 'labels_changed' ? 'historical-label' : 'historical-task';
      event.summary.before = await Promise.all(
        event.summary.before.map(async (key) => (await map(key, prefix))!),
      );
      event.summary.after = await Promise.all(
        event.summary.after.map(async (key) => (await map(key, prefix))!),
      );
    }
    if (event.kind === 'task_deleted')
      event.summary.parentId = await map(event.summary.parentId, 'historical-task');
    if ('sourceTaskId' in event.summary && event.summary.sourceTaskId)
      event.summary.sourceTaskId = (await map(event.summary.sourceTaskId, 'historical-task'))!;
    if ('sourceAccountId' in event.summary && event.summary.sourceAccountId)
      event.summary.sourceAccountId =
        event.summary.sourceAccountId === 'a1'
          ? row.account_id
          : (await map(event.summary.sourceAccountId, 'historical-account'))!;
    return event;
  }
}
