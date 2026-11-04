import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../../shared/contracts/errors';
import { localWriteGuard } from '../../../../accounts/server/connections/access';
import {
  ArchiveChoiceChunkSchema,
  type ArchiveField,
  type ArchiveMatch,
  type ArchiveRecord,
  type ArchiveRestorePreview,
} from '../../../contracts/archive';
import { canonicalJson } from '../../integrity';
import { type ArchiveRecordRow, type ArchiveRow, type ArchiveSummary } from '../import/store';
import type { ArchiveRestoreOptions } from './dependencies';
import { ArchiveRestoreSource } from './source';
import { conflict } from './state';

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Matches current owner values and freezes the explicit incoming-field choices. */
export class ArchiveRestoreSelection {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: Pick<
      ArchiveRestoreOptions,
      'store' | 'accounts' | 'boards' | 'ownerFactory' | 'queries' | 'snapshotReader' | 'now'
    >,
    private readonly sources: ArchiveRestoreSource,
  ) {
    this.now = options.now ?? Date.now;
  }
  private async matched(row: ArchiveRow, record: ArchiveRecord): Promise<ArchiveMatch> {
    const base: ArchiveMatch = {
      key: record.key,
      kind: record.kind,
      status: 'matched',
      message: 'the destination values already match or are preserved.',
      fields: [],
      blockedFields: {},
      changes: {},
      defaultIncomingFields: [],
    };
    const change = (field: ArchiveField, current: unknown, incoming: unknown) => {
      base.fields.push(field);
      if (!equal(current, incoming)) base.changes[field] = { current, incoming };
    };
    const missing = (message: string) => ({ ...base, status: 'unmatched' as const, message });
    if (record.kind === 'board') {
      const id = await this.sources.targetBoard(row, record.key);
      let current;
      try {
        current = await this.options.boards.queries.getBoard(row.account_id, id);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
      }
      base.destinationId = id;
      if (!current) {
        base.status = 'new';
        base.message = 'create this lanes board without changing any google resource.';
        base.fields = ['name', 'appearance', 'order'];
        base.defaultIncomingFields = [...base.fields];
        return base;
      }
      base.destinationRevision = current.revision;
      change('name', current.title, record.title);
      change(
        'appearance',
        { emoji: current.emoji, color: current.color, backgroundUrl: current.backgroundUrl },
        { emoji: record.emoji, color: record.color, backgroundUrl: record.backgroundUrl },
      );
      change('order', current.position, record.position);
    } else if (record.kind === 'list') {
      const found = (
        await this.options.snapshotReader.matchResources(row.account_id, {
          lists: [record.providerId],
        })
      ).lists[0];
      if (!found)
        return missing(
          'this exact provider list was not found under the mapped google subject; metadata restore never creates it.',
        );
      const placement = await this.options.boards.queries.getMembership(row.account_id, found.id);
      base.destinationId = found.id;
      base.destinationRevision = placement.revision;
      change(
        'placement',
        { boardId: placement.boardId, position: placement.position },
        {
          boardId: await this.sources.targetBoard(row, record.boardKey),
          position: record.position,
        },
      );
      change('appearance', placement.color, record.color);
      if (
        found.isDefault &&
        (await this.sources.targetBoard(row, record.boardKey)) !==
          (await this.options.boards.queries.getMainBoard(row.account_id)).id
      )
        base.blockedFields.placement =
          'the google default list must remain on this account main board.';
    } else if (record.kind === 'label') {
      const found = (
        await this.options.queries.labels.readLabelsByNames(row.account_id, [record.name])
      )[0];
      base.destinationId =
        found?.id ?? (await this.sources.stable(row, record.key, 'archive-label'));
      if (!found) {
        base.status = 'new';
        base.fields = ['definition'];
        base.defaultIncomingFields = ['definition'];
        base.message = 'create the missing account label definition.';
        return base;
      }
      base.destinationRevision = found.revision;
      change(
        'definition',
        { name: found.name, color: found.color },
        { name: record.name, color: record.color },
      );
    } else if (record.kind === 'task') {
      const found = (
        await this.options.snapshotReader.matchResources(row.account_id, {
          tasks: [{ id: record.provider.id, listId: record.provider.listId }],
        })
      ).tasks[0];
      if (!found)
        return missing(
          'this exact provider task/list address was not verified under the mapped google subject. matching titles are insufficient.',
        );
      base.destinationId = found.id;
      base.destinationRevision = found.revision;
      const labels = await this.options.queries.labels.readLabelsByIds(
        row.account_id,
        found.labelIds,
      );
      change(
        'labels',
        labels.map((label) => label.name.normalize('NFC').toLowerCase()).sort(),
        record.labels.map((label) => label.name.normalize('NFC').toLowerCase()).sort(),
      );
      change('priority', found.priority, record.priority);
      change('starred', found.starred, record.starred);
      const refs = await this.options.snapshotReader.matchReferenceAddresses(
        row.account_id,
        record.dependencies.map((dependency) => ({
          id: dependency.provider.id,
          listId: dependency.provider.listId,
        })),
      );
      base.dependencyIds = refs.map((reference) => reference.id);
      base.missingDependencyCount = record.dependencies.length - refs.length;
      change('dependencies', [...found.blockedBy].sort(), [...base.dependencyIds].sort());
      if (base.missingDependencyCount)
        base.blockedFields.dependencies = `${base.missingDependencyCount} provider dependency references are unmatched. explicitly accept their omission before selecting this field.`;
      change(
        'time',
        { time: found.scheduledTime, zone: found.timeZone },
        { time: record.scheduledTime, zone: record.timeZone },
      );
      change('repeat', found.repeatRule, record.repeatRule);
      if (record.scheduledDay !== found.scheduledDay) {
        base.blockedFields.time =
          'the current google scheduled day differs from the archived day; metadata restore cannot change a provider-owned day.';
        base.blockedFields.repeat = base.blockedFields.time;
      }
      if (found.parentId && record.repeatRule)
        base.blockedFields.repeat =
          'the current task is a subtask and cannot repeat independently.';
    } else if (record.kind === 'template') {
      const id = await this.sources.stable(row, record.key, 'archive-template');
      base.destinationId = id;
      const owners = this.options.ownerFactory(async () => {
        throw new AppError('forbidden', 'preview cannot commit owner writes.', 403);
      });
      let current;
      try {
        current =
          record.templateKind === 'list'
            ? await owners.listTemplates?.get(row.account_id, id)
            : await owners.boardTemplates?.get(row.account_id, id);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
      }
      if (!current) {
        base.status = 'new';
        base.fields = ['definition'];
        base.defaultIncomingFields = ['definition'];
        base.message = 'restore this declarative template as a new reusable definition.';
        return base;
      }
      base.destinationRevision = current.revision;
      change(
        'definition',
        {
          name: current.name,
          description: current.description,
          contentRevision: current.contentRevision,
        },
        {
          name: record.name,
          description: record.description,
          contentRevision: record.contentRevision,
        },
      );
      if (!base.changes.definition)
        base.changes.definition = {
          current: 'an installed template already occupies this archive identity',
          incoming:
            'the captured declarative body; selecting it explicitly replaces the reusable version',
        };
    } else if (record.kind === 'schedule') {
      if (record.unmatchedReferences?.template || record.unmatchedReferences?.board)
        return missing(
          'this paused schedule definition has an unmatched archived target/template. map valid targets explicitly before restoring it.',
        );
      base.destinationId = await this.sources.stable(row, record.key, 'archive-schedule');
      const owners = this.options.ownerFactory(async () => {
        throw new AppError('forbidden', 'preview cannot commit owner writes.', 403);
      });
      let current;
      try {
        current = await owners.schedules?.get(row.account_id, base.destinationId);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
      }
      if (!current) {
        base.status = 'new';
        base.fields = ['definition'];
        base.defaultIncomingFields = ['definition'];
        base.message =
          'restore this schedule paused until its authorization, target and catch-up choice are confirmed.';
        return base;
      }
      base.destinationRevision = current.revision;
      change(
        'definition',
        {
          timing: current.timing,
          useRelativeDates: current.useRelativeDates,
          listPrefix: current.listPrefix,
        },
        {
          timing: record.timing,
          useRelativeDates: record.useRelativeDates,
          listPrefix: record.listPrefix,
        },
      );
    } else if (record.kind === 'history') {
      base.status = 'new';
      base.fields = ['history'];
      base.defaultIncomingFields = ['history'];
      base.message = 'preserve the historical identity/time; normal90-day retention still applies.';
    } else {
      base.message = 'declarative content is selected with its owning template definition.';
    }
    if (Object.keys(base.changes).length) {
      base.status = 'conflict';
      base.message = 'keep the current values by default; select the incoming fields explicitly.';
    }
    return base;
  }

  async preview(id: string, accountId: string): Promise<ArchiveRestorePreview> {
    const archive = await this.options.store.get(id, accountId),
      row = await this.options.store.row(id, accountId);
    const counts = {
      pending: row.expected_records - row.match_count,
      matched: row.matched_count,
      new_records: row.new_count,
      conflicts: row.conflict_count,
      unmatched: row.unmatched_count,
      selected: row.selected_count,
      restored: row.restored_count,
      skipped: row.skipped_count,
    };
    const current = await this.options.accounts.identity(accountId);
    return {
      archive,
      pendingMatches: counts?.pending ?? 0,
      matched: counts?.matched ?? 0,
      newRecords: counts?.new_records ?? 0,
      conflicts: counts?.conflicts ?? 0,
      unmatched: counts?.unmatched ?? 0,
      selected: counts?.selected ?? 0,
      restored: counts?.restored ?? 0,
      skipped: counts?.skipped ?? 0,
      preferences: {
        current: {
          planningZone: current.planningZone,
          weekStart: current.weekStart,
          revision: current.revision,
        },
        incoming: {
          planningZone: archive.header.source.planningZone,
          weekStart: archive.header.source.weekStart,
        },
        selected: !!row.preferences_incoming,
      },
    };
  }

  async previewNext(id: string, accountId: string): Promise<ArchiveRestorePreview> {
    const row = await this.options.store.row(id, accountId);
    if (row.mode !== 'restore_metadata' || row.state !== 'preview')
      throw conflict('validate a metadata-restore archive before previewing destination matches.');
    const saved = await this.db
      .prepare(
        'SELECT * FROM transfer_archive_records WHERE archive_id=? AND match_json IS NULL ORDER BY position LIMIT 1',
      )
      .bind(id)
      .first<ArchiveRecordRow>();
    if (!saved) return this.preview(id, accountId);
    const match = await this.matched(row, JSON.parse(saved.input_json) as ArchiveRecord);
    await this.db.batch([
      localWriteGuard(this.db, accountId),
      this.options.store.guard(
        "EXISTS(SELECT 1 FROM transfer_archives WHERE id=? AND state='preview')",
        [id],
      ),
      this.options.store.guard(
        'EXISTS(SELECT 1 FROM transfer_archive_records WHERE archive_id=? AND item_key=? AND match_json IS NULL)',
        [id, saved.item_key],
      ),
      this.db
        .prepare(
          'UPDATE transfer_archive_records SET match_json=?,fields_json=?,incoming=? WHERE archive_id=? AND item_key=? AND match_json IS NULL',
        )
        .bind(
          canonicalJson(match),
          JSON.stringify(match.defaultIncomingFields),
          Number(match.defaultIncomingFields.length > 0),
          id,
          saved.item_key,
        ),
      this.db
        .prepare(
          `UPDATE transfer_archives SET revision=revision+1,match_count=match_count+1,${{ matched: 'matched_count', new: 'new_count', conflict: 'conflict_count', unmatched: 'unmatched_count' }[match.status]}=${{ matched: 'matched_count', new: 'new_count', conflict: 'conflict_count', unmatched: 'unmatched_count' }[match.status]}+1,selected_count=selected_count+?,updated_at=? WHERE id=?`,
        )
        .bind(Number(match.defaultIncomingFields.length > 0), this.now(), id),
    ]);
    return this.preview(id, accountId);
  }

  async choose(id: string, accountId: string, input: unknown): Promise<ArchiveRestorePreview> {
    const choices = ArchiveChoiceChunkSchema.safeParse(input);
    if (!choices.success)
      throw new AppError(
        'validation_failed',
        'choose at most10 known archive records and explicit incoming fields.',
        422,
      );
    const row = await this.options.store.row(id, accountId);
    if (row.state !== 'preview')
      throw conflict('make incoming field choices before confirming metadata restore.');
    const writes: D1PreparedStatement[] = [];
    let selectedDelta = 0;
    for (const choice of choices.data) {
      const record = await this.db
        .prepare(
          'SELECT match_json,incoming FROM transfer_archive_records WHERE archive_id=? AND item_key=?',
        )
        .bind(id, choice.key)
        .first<{ match_json: string | null; incoming: number }>();
      if (!record?.match_json) throw conflict('preview this record before selecting its fields.');
      const match = JSON.parse(record.match_json) as ArchiveMatch;
      if (
        choice.fields.some(
          (field) =>
            !match.fields.includes(field) ||
            (match.blockedFields[field] &&
              !(field === 'dependencies' && choice.acceptOmittedReferences)),
        )
      )
        throw new AppError(
          'validation_failed',
          'one selected field is unmatched or incompatible; retain it or explicitly accept omitted dependency references.',
          422,
        );
      selectedDelta += Number(choice.fields.length > 0) - Number(record.incoming);
      writes.push(
        this.db
          .prepare(
            'UPDATE transfer_archive_records SET fields_json=?,incoming=?,accept_omitted=? WHERE archive_id=? AND item_key=?',
          )
          .bind(
            JSON.stringify(choice.fields),
            Number(choice.fields.length > 0),
            Number(choice.acceptOmittedReferences),
            id,
            choice.key,
          ),
      );
    }
    await this.db.batch([
      localWriteGuard(this.db, accountId),
      this.options.store.guard(
        "EXISTS(SELECT 1 FROM transfer_archives WHERE id=? AND state='preview' AND revision=?)",
        [id, row.revision],
      ),
      ...writes,
      this.db
        .prepare(
          'UPDATE transfer_archives SET revision=revision+1,selected_count=selected_count+?,updated_at=? WHERE id=?',
        )
        .bind(selectedDelta, this.now(), id),
    ]);
    return this.preview(id, accountId);
  }

  async choosePreferences(
    id: string,
    accountId: string,
    selected: boolean,
  ): Promise<ArchiveRestorePreview> {
    const row = await this.options.store.row(id, accountId);
    if (row.state !== 'preview') throw conflict();
    const current = await this.options.accounts.identity(accountId);
    await this.db.batch([
      localWriteGuard(this.db, accountId),
      this.options.store.guard(
        "EXISTS(SELECT 1 FROM transfer_archives WHERE id=? AND state='preview' AND revision=?)",
        [id, row.revision],
      ),
      this.db
        .prepare(
          'UPDATE transfer_archives SET preferences_incoming=?,preferences_revision=?,revision=revision+1,updated_at=? WHERE id=?',
        )
        .bind(Number(selected), current.revision, this.now(), id),
    ]);
    return this.preview(id, accountId);
  }

  async confirm(
    id: string,
    accountId: string,
    input: { previewHash: string; revision: number },
  ): Promise<ArchiveSummary> {
    const row = await this.options.store.row(id, accountId),
      preview = await this.preview(id, accountId);
    if (row.state === 'restoring' || row.state === 'finished') return preview.archive;
    if (
      row.mode !== 'restore_metadata' ||
      row.state !== 'preview' ||
      row.preview_hash !== input.previewHash ||
      row.revision !== input.revision ||
      preview.pendingMatches
    )
      throw conflict('finish every match and confirm the current field choices before restoring.');
    const identity = await this.options.accounts.identity(accountId);
    if (identity.googleSubject !== JSON.parse(row.header_json).source.googleSubject)
      throw conflict('the mapped google subject changed.');
    await this.db.batch([
      localWriteGuard(this.db, accountId),
      this.options.store.guard(
        "EXISTS(SELECT 1 FROM transfer_archives WHERE id=? AND state='preview' AND revision=?)",
        [id, row.revision],
      ),
      this.db
        .prepare(
          "UPDATE transfer_archive_records SET incoming=1,fields_json='[\"definition\"]' WHERE archive_id=? AND kind IN('template_list','template_task') AND json_extract(input_json,'$.templateKey') IN(SELECT item_key FROM transfer_archive_records WHERE archive_id=? AND kind='template' AND incoming=1)",
        )
        .bind(id, id),
      this.db
        .prepare(
          "UPDATE transfer_archive_records SET restore_state='skipped' WHERE archive_id=? AND incoming=0",
        )
        .bind(id),
      this.db
        .prepare(
          "UPDATE transfer_archives SET state='restoring',selected_count=(SELECT COUNT(*)FROM transfer_archive_records WHERE archive_id=transfer_archives.id AND incoming=1),skipped_count=(SELECT COUNT(*)FROM transfer_archive_records WHERE archive_id=transfer_archives.id AND incoming=0),updated_at=? WHERE id=?",
        )
        .bind(this.now(), id),
    ]);
    return this.options.store.get(id, accountId);
  }
}
