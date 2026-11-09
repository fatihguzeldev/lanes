import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AccountPreferenceCommandSchema } from '../../modules/accounts/contracts/preferences';
import { assertLocalWritable } from '../../modules/accounts/server/connections/access';
import { createAccountServices } from '../../modules/accounts/server/create-services';
import { BoardCommandSchema } from '../../modules/boards/contracts/commands';
import {
  TemplateCommandSchema,
  templateResultIds,
} from '../../modules/boards/contracts/template-commands';
import { BoardService } from '../../modules/boards/server/boards/service';
import { HistoryService } from '../../modules/history/server/events/event-store';
import { OperationIdSchema } from '../../modules/operations/contracts/receipt';
import { MetadataCommandSchema } from '../../modules/tasks/contracts/metadata-commands';
import { accountToday } from '../../modules/tasks/model/planning';
import { TaskMetadataService } from '../../modules/tasks/server/metadata/tasks';
import { AppError } from '../../shared/contracts/errors';
import type { Configuration } from '../configuration/env';
import { createOperationStore } from './operation-store';
import type { CommitTemplateWrites, TemplateOwners } from './template-services';

export const LocalSubmissionSchema = z
  .object({
    operationId: OperationIdSchema,
    command: z.union([
      BoardCommandSchema,
      AccountPreferenceCommandSchema,
      MetadataCommandSchema,
      TemplateCommandSchema,
    ]),
  })
  .strict();
export type LocalSubmission = z.infer<typeof LocalSubmissionSchema>;

/** Joins local owner commands to their durable receipt without moving their rules here. */
export async function submitLocalCommand(
  db: D1Database,
  config: Configuration,
  request: Request,
  accountId: string,
  ownerSubject: string,
  input: LocalSubmission,
  now = Date.now(),
  dependencies: { templateOwners?: (commitWrites: CommitTemplateWrites) => TemplateOwners } = {},
) {
  const submission = LocalSubmissionSchema.parse(input),
    command = submission.command;
  const operations = createOperationStore(db);
  const resourceKey =
    'templateId' in command
      ? `template:${command.templateId}`
      : 'scheduleId' in command
        ? `schedule:${command.scheduleId}`
        : 'boardId' in command && command.kind !== 'list.placement'
          ? `board:${command.boardId}`
          : 'listId' in command
            ? `list:${command.listId}`
            : 'taskId' in command
              ? `task:${command.taskId}`
              : 'labelId' in command
                ? `label:${command.labelId}`
                : 'jobId' in command
                  ? `label-job:${command.jobId}`
                  : command.kind === 'account.preferences'
                    ? `account:${accountId}:preferences`
                    : `create:${submission.operationId}`;
  const operation = await operations.admit(
    {
      id: submission.operationId,
      accountId,
      ownerSubject,
      kind: command.kind,
      resourceKey,
      input: command,
      steps: [{ key: 'change', kind: command.kind, input: command }],
    },
    now,
  );
  if (operation.state === 'succeeded') return operations.queries.summary(operation.id, accountId);
  await assertLocalWritable(db, accountId);
  const claimId = crypto.randomUUID();
  const step = await operations.claimNext(operation.id, claimId, now);
  if (!step) return operations.queries.summary(operation.id, accountId);
  const commitWrites = (writes: D1PreparedStatement[]) =>
    operations.commitLocalStep(
      operation.id,
      step.key,
      claimId,
      {
        kind: command.kind,
        ...(command.kind === 'board.create' ? { boardId: `board:${operation.id}` } : {}),
      },
      writes,
      now,
    );
  const templates = dependencies.templateOwners?.(commitWrites);
  const boards = new BoardService(db, {
    assertLocalWritable: (id) => assertLocalWritable(db, id),
    commitWrites,
    onDeleteWrites: (account, board) => templates?.schedules.pauseBoardWrites(account, board) ?? [],
  });
  const metadata = new TaskMetadataService(db, { commitWrites, history: new HistoryService(db) });
  const context = {
    operationId: operation.id,
    stepKey: step.key,
    origin: 'owner' as const,
    recordedAt: new Date(now).toISOString(),
  };
  try {
    if (command.kind.startsWith('template.')) {
      if (!templates)
        throw new AppError(
          'installation_unavailable',
          'template commands are not wired to their receipt owner.',
          503,
        );
      const account = await createAccountServices(db, config).connections.getConnectionSummary(
        request,
        accountId,
      );
      const templateContext = {
        ...context,
        saveDay: accountToday(account.planningZone, new Date(now).toISOString()),
        zone: account.planningZone,
      };
      const admitted = templateResultIds(operation.id);
      switch (command.kind) {
        case 'template.list.create':
          await templates.listTemplates.create(accountId, command.input, templateContext, admitted);
          break;
        case 'template.board.create':
          await templates.boardTemplates.create(
            accountId,
            command.input,
            templateContext,
            admitted,
          );
          break;
        case 'template.list.update':
          await templates.listTemplates.update(
            accountId,
            command.templateId,
            command.input,
            command.revision,
            templateContext,
          );
          break;
        case 'template.board.update':
          await templates.boardTemplates.update(
            accountId,
            command.templateId,
            command.input,
            command.revision,
            templateContext,
          );
          break;
        case 'template.list.replace':
          await templates.listTemplates.replace(
            accountId,
            command.templateId,
            command.input,
            command.revision,
            templateContext,
            admitted.snapshotId,
          );
          break;
        case 'template.board.replace':
          await templates.boardTemplates.replace(
            accountId,
            command.templateId,
            command.input,
            command.revision,
            templateContext,
            admitted.snapshotId,
          );
          break;
        case 'template.list.delete':
          await templates.listTemplates.delete(
            accountId,
            command.templateId,
            command.revision,
            templateContext,
          );
          break;
        case 'template.board.delete':
          await templates.boardTemplates.delete(
            accountId,
            command.templateId,
            command.revision,
            templateContext,
          );
          break;
        case 'template.list.gallery':
          await templates.listTemplates.saveGallery(
            accountId,
            command.galleryId,
            templateContext,
            admitted,
          );
          break;
        case 'template.board.gallery':
          await templates.boardTemplates.saveGallery(
            accountId,
            command.galleryId,
            templateContext,
            admitted,
          );
          break;
        case 'template.schedule.create':
          await templates.schedules.create(accountId, command.input, context, admitted.scheduleId);
          break;
        case 'template.schedule.update':
          await templates.schedules.update(
            accountId,
            command.scheduleId,
            command.input,
            command.revision,
            context,
          );
          break;
        case 'template.schedule.pause':
          await templates.schedules.pause(accountId, command.scheduleId, command.revision, context);
          break;
        case 'template.schedule.resume':
          await templates.schedules.resume(
            accountId,
            command.scheduleId,
            command.revision,
            command.catchUp,
            context,
          );
          break;
        case 'template.schedule.delete':
          await templates.schedules.delete(
            accountId,
            command.scheduleId,
            command.revision,
            context,
          );
          break;
      }
    }
    switch (command.kind) {
      case 'board.create':
        await boards.createBoard(accountId, command.input, `board:${operation.id}`);
        break;
      case 'board.update':
        await boards.updateBoard(accountId, command.boardId, command.input, command.revision);
        break;
      case 'board.reorder':
        await boards.reorderBoard(accountId, command.boardId, command.revision, command.position);
        break;
      case 'board.delete':
        await boards.deleteBoard(accountId, command.boardId, command.revision);
        break;
      case 'list.placement':
        await boards.moveList(
          accountId,
          command.listId,
          command.boardId,
          command.revision,
          command.position,
        );
        break;
      case 'list.appearance':
        await boards.updateListAppearance(
          accountId,
          command.listId,
          command.color,
          command.revision,
        );
        break;
      case 'account.preferences':
        await createAccountServices(db, config, {
          now: () => now,
          commitPreferences: commitWrites,
        }).connections.updatePreferences(request, accountId, command.input);
        break;
      case 'task.patch':
        await metadata.patchTask(
          accountId,
          command.taskId,
          command.patch,
          command.expectedRevision,
          context,
          command.expectedGraphRevision,
        );
        break;
      case 'label.create':
        await metadata.labels.createLabel(
          accountId,
          command.input,
          context,
          `label:${operation.id}`,
        );
        break;
      case 'label.update':
        await metadata.labels.updateLabel(
          accountId,
          command.labelId,
          command.input,
          command.expectedRevision,
          context,
        );
        break;
      case 'label.delete.start':
        await metadata.labelDeletions.startLabelDeletion(
          accountId,
          command.labelId,
          command.expectedRevision,
          context,
          `label-delete:${operation.id}`,
        );
        break;
      case 'label.delete.continue':
        await metadata.labelDeletions.continueLabelDeletion(
          accountId,
          command.jobId,
          context,
          command.limit,
        );
        break;
    }
    if ((await operations.getStep(operation.id, step.key))?.state === 'claimed')
      await commitWrites([]);
  } catch (error) {
    // A failed local transaction cannot have sent a provider write. Its unchanged input remains inspectable.
    if ((await operations.getStep(operation.id, step.key))?.state === 'claimed') {
      const code = error instanceof AppError ? error.code : 'storage_unavailable';
      const transient = ['storage_unavailable', 'provider_unavailable', 'rate_limited'].includes(
        code,
      );
      await operations
        .releaseUndispatched(
          operation.id,
          step.key,
          claimId,
          { code, ...(transient ? { retryAt: now + 5_000 } : { state: 'failed' as const }) },
          now,
        )
        .catch(() => {});
    }
    throw error;
  }
  return operations.queries.summary(operation.id, accountId);
}
