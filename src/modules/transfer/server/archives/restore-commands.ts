import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import { type ArchiveRecord } from '../../contracts/archive';
import { canonicalJson } from '../identity/content-hash';
import { type ArchiveRow } from './archive-store';
import type { ArchiveRestoreOptions } from './restore-dependencies';
import { conflict, type ActionRow, type LocalAction } from './restore-state';

/** Captures each local intent and commits its owner writes with the same receipt. */
export class ArchiveRestoreCommands {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: Pick<
      ArchiveRestoreOptions,
      'operations' | 'accounts' | 'ownerFactory' | 'history' | 'store' | 'now'
    >,
  ) {
    this.now = options.now ?? Date.now;
  }
  async capture(row: ArchiveRow, key: string, phase: string, input: unknown): Promise<ActionRow> {
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

  async apply(row: ArchiveRow, action: ActionRow): Promise<boolean> {
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
        await owners.metadata.labels.createLabel(row.account_id, input.input, context, input.id);
      else if (input.kind === 'label.update')
        await owners.metadata.labels.updateLabel(
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
}
