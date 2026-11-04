import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../shared/contracts/errors';
import { assertLocalWritable, localWriteGuard } from '../../accounts/server/connections/access';
import type { AccountsPortability } from '../../accounts/server/connections/portability';
import type { BoardService } from '../../boards/server/boards/service';
import type { BoardTemplateService } from '../../boards/server/templates/definitions';
import type { TemplateScheduleService } from '../../boards/server/templates/schedules';
import type { HistoryService } from '../../history/server/events/event-store';
import type { HistoryEventInput } from '../../history/contracts/events';
import type { TaskQueries } from '../../tasks/server/queries/tasks';
import type { TaskSnapshotReader } from '../../tasks/server/queries/snapshot-reader';
import type { TaskMetadataService } from '../../tasks/server/metadata/tasks';
import type { TemplateDocumentStore } from '../../tasks/server/templates/documents';
import type { ListTemplateService } from '../../tasks/server/templates/lists';
import type { TaskCommandService } from '../../tasks/server/commands/service';
import type { OperationStore } from '../../operations/server/journal/store';
import type { ProviderCommand } from '../../tasks/contracts/provider-commands';
import {
  ArchiveChoiceChunkSchema,
  type ArchiveField,
  type ArchiveHeader,
  type ArchiveMatch,
  type ArchiveRecord,
  type ArchiveRestorePreview,
} from '../archive-contract';
import {
  WorkspaceArchiveStore,
  type ArchiveRecordRow,
  type ArchiveRow,
  type ArchiveSummary,
} from './archive-store';
import { canonicalJson, transferDigest } from './content-hash';
export interface RestoreOwners {
  boards: BoardService;
  metadata: TaskMetadataService;
  documents?: TemplateDocumentStore;
  listTemplates?: ListTemplateService;
  boardTemplates?: BoardTemplateService;
  schedules?: TemplateScheduleService;
}
export interface ArchiveRestoreOptions {
  store: WorkspaceArchiveStore;
  accounts: AccountsPortability;
  queries: TaskQueries;
  snapshotReader: TaskSnapshotReader;
  commands: TaskCommandService;
  operations: OperationStore;
  boards: BoardService;
  history: HistoryService;
  ownerFactory: (
    commitWrites: (writes: D1PreparedStatement[]) => Promise<D1Result[]>,
  ) => RestoreOwners;
  now?: () => number;
}
interface ActionRow {
  archive_id: string;
  item_key: string;
  phase: string;
  operation_id: string;
  input_json: string;
  state: string;
  result_json: string | null;
}
type LocalAction = {
  kind: string;
  id?: string | undefined;
  revision?: number | undefined;
  input?: unknown;
  source?: ArchiveRecord;
  templateId?: string;
  snapshotId?: string;
  fields?: ArchiveField[];
  targetId?: string;
  position?: number;
  event?: HistoryEventInput;
};
const conflict = (
  message = 'the selected destination changed after preview. inspect its current values before choosing incoming data again.',
) => new AppError('conflict', message, 409);
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
/** Restore applies only lanes-owned fields through their owners. Provider content is never created/deleted here. */
export class ArchiveRestoreService {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: ArchiveRestoreOptions,
  ) {
    this.now = options.now ?? Date.now;
  }
  private async stable(row: ArchiveRow, key: string, prefix: string) {
    const header = JSON.parse(row.header_json) as ArchiveHeader;
    return (
      prefix +
      '-' +
      (await transferDigest(header.source.googleSubject + ':' + header.id + ':' + key)).slice(0, 32)
    );
  }
  private async source(row: ArchiveRow, key: string): Promise<ArchiveRecord> {
    const value = await this.db
      .prepare('SELECT input_json FROM transfer_archive_records WHERE archive_id=? AND item_key=?')
      .bind(row.id, key)
      .first<string>('input_json');
    if (!value) throw conflict('a captured archive reference is missing.');
    return JSON.parse(value) as ArchiveRecord;
  }
  private async targetBoard(row: ArchiveRow, key: string): Promise<string> {
    const board = await this.source(row, key);
    if (board.kind !== 'board') throw conflict('the captured destination is not a board.');
    return board.isMain
      ? (await this.options.boards.getMainBoard(row.account_id)).id
      : this.stable(row, key, 'archive-board');
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
      const id = await this.targetBoard(row, record.key);
      let current;
      try {
        current = await this.options.boards.getBoard(row.account_id, id);
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
      const placement = await this.options.boards.getMembership(row.account_id, found.id);
      base.destinationId = found.id;
      base.destinationRevision = placement.revision;
      change(
        'placement',
        { boardId: placement.boardId, position: placement.position },
        { boardId: await this.targetBoard(row, record.boardKey), position: record.position },
      );
      change('appearance', placement.color, record.color);
      if (
        found.isDefault &&
        (await this.targetBoard(row, record.boardKey)) !==
          (await this.options.boards.getMainBoard(row.account_id)).id
      )
        base.blockedFields.placement =
          'the google default list must remain on this account main board.';
    } else if (record.kind === 'label') {
      const found = (
        await this.options.queries.readLabelsByNames(row.account_id, [record.name])
      )[0];
      base.destinationId = found?.id ?? (await this.stable(row, record.key, 'archive-label'));
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
      const labels = await this.options.queries.readLabelsByIds(row.account_id, found.labelIds);
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
      const id = await this.stable(row, record.key, 'archive-template');
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
      base.destinationId = await this.stable(row, record.key, 'archive-schedule');
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
  private async action(
    row: ArchiveRow,
    key: string,
    phase: string,
    input: unknown,
  ): Promise<ActionRow> {
    const previous = await this.db
      .prepare(
        'SELECT * FROM transfer_archive_actions WHERE archive_id=? AND item_key=? AND phase=?',
      )
      .bind(row.id, key, phase)
      .first<ActionRow>();
    if (previous) return previous;
    const json = canonicalJson(input);
    if (new TextEncoder().encode(json).byteLength > 65536)
      throw new AppError('validation_failed', 'one restored owner command exceeds64 kib.', 413);
    const operationId = this.now() + ':' + crypto.randomUUID().replaceAll('-', '');
    await this.db
      .prepare(
        'INSERT INTO transfer_archive_actions(archive_id,item_key,phase,operation_id,input_json)VALUES(?,?,?,?,?) ON CONFLICT(archive_id,item_key,phase) DO NOTHING',
      )
      .bind(row.id, key, phase, operationId, json)
      .run();
    return (await this.db
      .prepare(
        'SELECT * FROM transfer_archive_actions WHERE archive_id=? AND item_key=? AND phase=?',
      )
      .bind(row.id, key, phase)
      .first<ActionRow>())!;
  }
  private async runLocal(row: ArchiveRow, action: ActionRow): Promise<boolean> {
    if (action.state === 'confirmed') return true;
    const input = JSON.parse(action.input_json) as LocalAction,
      operations = this.options.operations;
    if (input.kind === 'document.seal') {
      const documents = this.options.ownerFactory(async () => {
        throw conflict('document validation cannot install owner data');
      }).documents;
      if (!documents)
        throw new AppError(
          'installation_unavailable',
          'archive template documents are not wired.',
          503,
        );
      if (!(await documents.validationReady(row.account_id, input.snapshotId!))) {
        await documents.validate(row.account_id, input.snapshotId!);
        // Finish the validation slice before admitting the owner receipt. This
        // keeps its journal/installation work out of a full Kahn query budget.
        return false;
      }
    }
    const operation = await operations.admit(
      {
        id: action.operation_id,
        ownerSubject: row.owner_subject,
        accountId: row.account_id,
        kind: 'archive.restore.' + input.kind,
        resourceKey: 'archive:' + row.id + ':' + action.item_key + ':' + action.phase,
        input,
        steps: [{ key: 'restore', kind: input.kind, input }],
      },
      this.now(),
    );
    if (operation.finished) {
      if (operation.state !== 'succeeded')
        throw conflict(
          'this restore action stopped. inspect the selected destination before starting a replacement action.',
        );
      await this.db
        .prepare(
          "UPDATE transfer_archive_actions SET state='confirmed' WHERE archive_id=? AND item_key=? AND phase=?",
        )
        .bind(row.id, action.item_key, action.phase)
        .run();
      return true;
    }
    const claimId = crypto.randomUUID(),
      claim = await operations.claimNext(operation.id, claimId, this.now());
    if (!claim)
      throw new AppError(
        'provider_unavailable',
        'this restore action is already being processed. inspect it again shortly.',
        503,
        true,
      );
    let committed = false;
    const commit = async (writes: D1PreparedStatement[]) => {
      const result = await operations.commitLocalStep(
        operation.id,
        claim.key,
        claimId,
        { recordKey: action.item_key, phase: action.phase, id: input.id ?? null },
        [
          this.options.store.guard(
            "EXISTS(SELECT 1 FROM transfer_archives WHERE id=? AND state='restoring' AND paused=0)",
            [row.id],
          ),
          ...writes,
          this.db
            .prepare(
              "UPDATE transfer_archive_actions SET state='confirmed',result_json=? WHERE archive_id=? AND item_key=? AND phase=?",
            )
            .bind(JSON.stringify({ id: input.id ?? null }), row.id, action.item_key, action.phase),
        ],
        this.now(),
      );
      committed = true;
      return result;
    };
    const owners = this.options.ownerFactory(commit),
      context = {
        operationId: operation.id,
        stepKey: claim.key,
        origin: 'owner' as const,
        recordedAt: new Date(this.now()).toISOString(),
      };
    try {
      if (input.kind === 'board.create')
        await owners.boards.createBoard(row.account_id, input.input as never, input.id);
      else if (input.kind === 'board.update')
        await owners.boards.updateBoard(
          row.account_id,
          input.id!,
          input.input as never,
          input.revision!,
        );
      else if (input.kind === 'board.order')
        await owners.boards.reorderBoard(
          row.account_id,
          input.id!,
          input.revision!,
          input.position!,
        );
      else if (input.kind === 'list.placement')
        await owners.boards.moveList(
          row.account_id,
          input.id!,
          input.targetId!,
          input.revision!,
          input.position,
        );
      else if (input.kind === 'list.appearance')
        await owners.boards.updateListAppearance(
          row.account_id,
          input.id!,
          String(input.input),
          input.revision!,
        );
      else if (input.kind === 'label.create')
        await owners.metadata.createLabel(row.account_id, input.input, context, input.id);
      else if (input.kind === 'label.update')
        await owners.metadata.updateLabel(
          row.account_id,
          input.id!,
          input.input,
          input.revision!,
          context,
        );
      else if (input.kind === 'preferences')
        await commit(
          await this.options.accounts.preparePreferencesRestore(row.account_id, input.input),
        );
      else if (input.kind === 'history')
        await commit([this.options.history.eventWrite(input.event!)]);
      else if (input.kind === 'document.begin') {
        if (!owners.documents)
          throw new AppError(
            'installation_unavailable',
            'archive template documents are not wired.',
            503,
          );
        await owners.documents.begin(row.account_id, input.input, context, input.snapshotId);
      } else if (input.kind === 'document.lists') {
        if (!owners.documents)
          throw new AppError(
            'installation_unavailable',
            'archive template documents are not wired.',
            503,
          );
        await owners.documents.appendLists(row.account_id, input.snapshotId!, input.input);
      } else if (input.kind === 'document.tasks') {
        if (!owners.documents)
          throw new AppError(
            'installation_unavailable',
            'archive template documents are not wired.',
            503,
          );
        await owners.documents.appendTasks(row.account_id, input.snapshotId!, input.input);
      } else if (input.kind === 'document.seal') {
        if (!owners.documents)
          throw new AppError(
            'installation_unavailable',
            'archive template documents are not wired.',
            503,
          );
        const sealed = await owners.documents.seal(row.account_id, input.snapshotId!);
        if (!sealed.sealed)
          throw new AppError(
            'conflict',
            'finish template validation before confirming its seal.',
            409,
            true,
          );
      } else if (input.kind === 'template.install') {
        const source = input.source as Extract<ArchiveRecord, { kind: 'template' }>;
        if (source.templateKind === 'list') {
          if (!owners.listTemplates)
            throw new AppError(
              'installation_unavailable',
              'archive list templates are not wired.',
              503,
            );
          if (input.revision !== undefined)
            await owners.listTemplates.replaceFromSnapshot(
              row.account_id,
              input.templateId!,
              input.snapshotId!,
              input.revision,
              context,
            );
          else
            await owners.listTemplates.createFromSnapshot(
              row.account_id,
              input.snapshotId!,
              { name: source.name, description: source.description },
              context,
              input.templateId,
            );
        } else {
          if (!owners.boardTemplates)
            throw new AppError(
              'installation_unavailable',
              'archive board templates are not wired.',
              503,
            );
          if (input.revision !== undefined)
            await owners.boardTemplates.replaceFromSnapshot(
              row.account_id,
              input.templateId!,
              input.snapshotId!,
              input.revision,
              context,
              source.appearance!,
            );
          else
            await owners.boardTemplates.createFromSnapshot(
              row.account_id,
              input.snapshotId!,
              { name: source.name, description: source.description, appearance: source.appearance },
              context,
              input.templateId,
            );
        }
      } else if (input.kind === 'schedule.create') {
        if (!owners.schedules)
          throw new AppError('installation_unavailable', 'archive schedules are not wired.', 503);
        await owners.schedules.createPaused(row.account_id, input.input, context, input.id);
      } else if (input.kind === 'schedule.pause') {
        if (!owners.schedules)
          throw new AppError('installation_unavailable', 'archive schedules are not wired.', 503);
        await owners.schedules.pause(row.account_id, input.id!, input.revision!, context);
      } else if (input.kind === 'schedule.update') {
        if (!owners.schedules)
          throw new AppError('installation_unavailable', 'archive schedules are not wired.', 503);
        await owners.schedules.update(
          row.account_id,
          input.id!,
          input.input,
          input.revision!,
          context,
        );
      } else
        throw new AppError(
          'validation_failed',
          'this archive action is not an owned local command.',
          422,
        );
      if (!committed) await commit([]);
      return true;
    } catch (error) {
      const current = await operations.getStep(operation.id, claim.key);
      const failure =
        error instanceof AppError
          ? error
          : new AppError(
              'storage_unavailable',
              'the local restore change could not be recorded. its captured action is retained for retry.',
              503,
              true,
            );
      const retryable = failure.retryable || failure.code === 'outcome_uncertain';
      // A claimed local step has never dispatched provider work. A failed atomic
      // database commit can retry the same intent; an issued step keeps its own outcome.
      if (current?.state === 'claimed')
        await operations.releaseUndispatched(
          operation.id,
          claim.key,
          claimId,
          retryable
            ? { code: failure.code, retryAt: this.now() + 5000 }
            : { state: 'failed', code: failure.code },
          this.now(),
        );
      throw failure;
    }
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
      await this.runLocal(
        row,
        await this.action(row, 'preferences', 'apply', {
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
      const snapshotId = await this.stable(row, record.key + ':' + row.id, 'archive-snapshot');
      await this.runLocal(
        row,
        await this.action(row, record.key, 'begin', {
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
      const snapshotId = await this.stable(
        row,
        record.templateKey + ':' + row.id,
        'archive-snapshot',
      );
      await this.runLocal(
        row,
        await this.action(row, record.key, 'content', {
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
        await this.runLocal(row, await this.action(row, record.key, 'appearance', base));
      if (fields.includes('order'))
        await this.runLocal(
          row,
          await this.action(row, record.key, 'order', {
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
        await this.runLocal(
          row,
          await this.action(row, record.key, 'placement', {
            kind: 'list.placement',
            id: match.destinationId,
            targetId: await this.targetBoard(row, record.boardKey),
            revision,
            position: record.position,
          }),
        );
        revision++;
      }
      if (fields.includes('appearance'))
        await this.runLocal(
          row,
          await this.action(row, record.key, 'appearance', {
            kind: 'list.appearance',
            id: match.destinationId,
            revision,
            input: record.color,
          }),
        );
    } else if (record.kind === 'label')
      await this.runLocal(
        row,
        await this.action(row, record.key, 'definition', {
          kind: match.status === 'new' ? 'label.create' : 'label.update',
          id: match.destinationId,
          ...(match.destinationRevision !== undefined
            ? { revision: match.destinationRevision }
            : {}),
          input: { name: record.name, color: record.color },
        }),
      );
    else if (record.kind === 'schedule') {
      const template = await this.source(row, record.templateKey);
      if (template.kind !== 'template') throw conflict();
      const templateId = await this.stable(row, template.key, 'archive-template'),
        owners = this.options.ownerFactory(async () => {
          throw conflict();
        });
      const current =
        template.templateKind === 'list'
          ? await owners.listTemplates?.get(row.account_id, templateId)
          : await owners.boardTemplates?.get(row.account_id, templateId);
      if (!current) throw conflict('restore the selected template before its paused schedule.');
      const boardId = await this.targetBoard(row, record.boardKey),
        board = await this.options.boards.getBoard(row.account_id, boardId);
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
        await this.runLocal(
          row,
          await this.action(row, record.key, 'create', {
            kind: 'schedule.create',
            id: match.destinationId,
            input,
          }),
        );
      else {
        await this.runLocal(
          row,
          await this.action(row, record.key, 'pause', {
            kind: 'schedule.pause',
            id: match.destinationId,
            revision: match.destinationRevision,
          }),
        );
        await this.runLocal(
          row,
          await this.action(row, record.key, 'update', {
            kind: 'schedule.update',
            id: match.destinationId,
            revision: match.destinationRevision! + 1,
            input,
          }),
        );
      }
    } else if (record.kind === 'history') {
      const event = await this.remapHistory(row, record);
      await this.runLocal(
        row,
        await this.action(row, record.key, 'history', { kind: 'history', event }),
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
      existing = await this.options.queries.readLabelsByNames(
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
      const id = await this.stable(
        row,
        'label-name:' + label.name.normalize('NFC').toLowerCase(),
        'archive-label',
      );
      await this.runLocal(
        row,
        await this.action(row, record.key, 'label:' + label.key, {
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
      (await this.action(row, record.key, 'task', {
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
    await this.options.commands.prepare({
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
      snapshotId = await this.stable(row, record.key + ':' + row.id, 'archive-snapshot');
    if (
      !(await this.runLocal(
        row,
        await this.action(row, record.key, 'seal', { kind: 'document.seal', snapshotId }),
      ))
    )
      return;
    await this.runLocal(
      row,
      await this.action(row, record.key, 'install', {
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
        : (matches.get(key)?.destinationId ?? (await this.stable(row, key, prefix)));
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
