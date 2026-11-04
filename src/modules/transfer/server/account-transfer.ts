import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../contracts/errors';
import { assertProviderWritable } from '../../accounts/access';
import { ResourceIdSchema, type Label } from '../../tasks/contracts';
import { OperationIdSchema } from '../../tasks/operation-contract';
import type { TaskSnapshotReader } from '../../tasks/server/queries/snapshot-reader';
import type { Board } from '../../boards/contracts';
import type { ImportSummary } from '../server-contract';
import type { TransferImportService } from './imports';
import { canonicalJson, transferDigest } from './content-hash';
const id = ResourceIdSchema.max(1024);
const schema = z
  .object({
    id: OperationIdSchema,
    ownerSubject: id,
    sourceAccountId: id,
    destinationAccountId: id,
    listIds: z.array(id).min(1).max(100),
    includeCompleted: z.boolean().default(true),
  })
  .strict()
  .refine(
    (input) => input.sourceAccountId !== input.destinationAccountId,
    'choose distinct source and destination accounts',
  );
interface Capture {
  import_id: string;
  source_account_id: string;
  snapshot_id: string;
  list_position: number;
  task_position: number;
  task_cursor: string | null;
  omitted_dependencies: number;
  completed_context: number;
  color_conflicts: number;
  state: 'capturing' | 'ready';
}
export interface AccountTransferOptions {
  snapshots: TaskSnapshotReader;
  imports: TransferImportService;
  destinationMainBoard(accountId: string): Promise<Board>;
  labelsByNames(accountId: string, names: string[]): Promise<Label[]>;
  now?: () => number;
}
/** A transfer freezes a source read. Its only write path is the ordinary import copy. */
export class AccountTransferService {
  constructor(
    private readonly db: D1Database,
    private readonly options: AccountTransferOptions,
  ) {}
  async begin(input: z.input<typeof schema>): Promise<ImportSummary> {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'choose distinct connected accounts and at most100 source lists.',
        422,
      );
    const selected = parsed.data,
      requestHash = await transferDigest(canonicalJson(selected));
    const prior = await this.db
      .prepare('SELECT request_hash FROM transfer_account_captures WHERE import_id=?')
      .bind(selected.id)
      .first<{ request_hash: string | null }>();
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new AppError(
          'conflict',
          'this transfer identity belongs to a different captured source selection.',
          409,
        );
      return this.options.imports.get(selected.id, selected.destinationAccountId);
    }
    let existing: ImportSummary | undefined;
    try {
      existing = await this.options.imports.get(selected.id, selected.destinationAccountId);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
    }
    if (!existing) {
      const issued = Number(selected.id.slice(0, 13)),
        now = this.options.now?.() ?? Date.now();
      if (issued > now + 300000 || now - issued > 86400000)
        throw new AppError('conflict', 'this unrecorded transfer identity has expired.', 409);
      await assertProviderWritable(this.db, selected.destinationAccountId);
    }
    const snapshot = await this.options.snapshots.capture({
      id: 'transfer:' + selected.id,
      accountId: selected.sourceAccountId,
      listIds: selected.listIds,
      includeCompleted: selected.includeCompleted,
    });
    const board =
      existing?.destination.kind === 'new'
        ? {
            id: existing.destination.boardId,
            revision: existing.destination.boardRevision,
            isMain: true,
            accountId: selected.destinationAccountId,
          }
        : await this.options.destinationMainBoard(selected.destinationAccountId);
    if (!board.isMain || board.accountId !== selected.destinationAccountId)
      throw new AppError(
        'installation_unavailable',
        'the destination account main board could not be verified.',
        503,
      );
    const result = await this.options.imports.begin({
      id: selected.id,
      ownerSubject: selected.ownerSubject,
      accountId: selected.destinationAccountId,
      source: { kind: 'account', accountId: selected.sourceAccountId, snapshotId: snapshot.id },
      destination: {
        kind: 'new',
        boardId: board.id,
        ...(board.revision === undefined ? {} : { boardRevision: board.revision }),
      },
      totalLists: snapshot.lists.length,
      totalTasks: snapshot.taskCount,
      issueCount: null,
      parentContextCount: snapshot.contextParentCount,
    });
    await this.db
      .prepare(
        'INSERT INTO transfer_account_captures(import_id,source_account_id,snapshot_id,request_hash) VALUES(?,?,?,?) ON CONFLICT(import_id) DO NOTHING',
      )
      .bind(selected.id, selected.sourceAccountId, snapshot.id, requestHash)
      .run();
    return result;
  }
  async captureNext(importId: string, accountId: string): Promise<ImportSummary> {
    const summary = await this.options.imports.get(importId, accountId);
    if (summary.source.kind !== 'account')
      throw new AppError('not_found', 'this import is not an account transfer.', 404);
    const row = await this.db
      .prepare('SELECT * FROM transfer_account_captures WHERE import_id=?')
      .bind(importId)
      .first<Capture>();
    if (!row || row.state === 'ready' || summary.state !== 'staging') return summary;
    const snapshot = await this.options.snapshots.get(row.snapshot_id, row.source_account_id);
    if (row.list_position < snapshot.lists.length) {
      const lists = snapshot.lists.slice(row.list_position, row.list_position + 10);
      await this.options.imports.append(importId, accountId, {
        lists: lists.map((list) => ({
          position: list.position,
          value: { key: list.key, title: list.title },
        })),
      });
      await this.db
        .prepare(
          'UPDATE transfer_account_captures SET list_position=? WHERE import_id=? AND list_position=?',
        )
        .bind(row.list_position + lists.length, importId, row.list_position)
        .run();
      return this.options.imports.get(importId, accountId);
    }
    if (row.task_position < snapshot.taskCount) {
      const page = await this.options.snapshots.page(
        row.snapshot_id,
        row.source_account_id,
        row.task_cursor ? { cursor: row.task_cursor } : {},
      );
      const sourceNames = [
          ...new Set(page.items.flatMap((item) => item.labels.map((label) => label.name))),
        ],
        destinationLabels: Label[] = [];
      for (let offset = 0; offset < sourceNames.length; offset += 100)
        destinationLabels.push(
          ...(await this.options.labelsByNames(accountId, sourceNames.slice(offset, offset + 100))),
        );
      const conflicts = new Set(
        page.items.flatMap((item) =>
          item.labels
            .filter((label) =>
              destinationLabels.some(
                (destination) =>
                  destination.name.toLowerCase() === label.name.toLowerCase() &&
                  destination.color !== label.color,
              ),
            )
            .map((label) => label.name.toLowerCase()),
        ),
      );
      const records = page.items.map((item) => {
        if (item.task.unsupportedHierarchy || item.task.provider.missing)
          throw new AppError(
            'validation_failed',
            'refresh or correct unsupported source hierarchy before copying this selection.',
            422,
          );
        return {
          position: item.position,
          labelDefinitions: item.labels.map((label) => ({ name: label.name, color: label.color })),
          value: {
            key: item.key,
            listKey: item.listKey,
            parentKey: item.parentKey,
            title: item.task.title,
            notes: item.task.notes,
            completed: item.contextOnly ? false : item.task.completed,
            completedAt: item.contextOnly ? null : item.task.completedAt,
            scheduledDay: item.task.scheduledDay,
            scheduledTime: item.task.scheduledTime,
            timeZone: item.task.timeZone,
            repeatRule: item.task.repeatRule,
            labels: item.labels.map((label) => label.name),
            priority: item.task.priority,
            starred: item.task.starred,
            dependencies: item.dependencyKeys,
            order: item.position,
          },
        };
      });
      await this.options.imports.append(importId, accountId, { tasks: records });
      await this.db
        .prepare(
          'UPDATE transfer_account_captures SET task_position=?,task_cursor=?,omitted_dependencies=omitted_dependencies+?,completed_context=completed_context+?,color_conflicts=color_conflicts+? WHERE import_id=? AND task_position=?',
        )
        .bind(
          row.task_position + records.length,
          page.nextCursor,
          page.items.reduce((sum, item) => sum + item.omittedDependencyCount, 0),
          page.items.filter((item) => item.contextOnly).length,
          conflicts.size,
          importId,
          row.task_position,
        )
        .run();
      return this.options.imports.get(importId, accountId);
    }
    const issues = [];
    if (row.omitted_dependencies)
      issues.push({
        severity: 'warning' as const,
        code: 'outside_dependencies',
        message: `${row.omitted_dependencies} dependency references outside the selected source lists will be omitted; source edges remain unchanged.`,
      });
    if (row.color_conflicts)
      issues.push({
        severity: 'warning' as const,
        code: 'label_color_conflicts',
        message:
          'some destination label names have different colors. the destination colors will be preserved; review the captured definitions before confirmation.',
      });
    if (row.completed_context)
      issues.push({
        severity: 'warning' as const,
        code: 'parent_context',
        message: `${row.completed_context} completed parents are included as open context for their selected open children.`,
      });
    if (issues.length)
      await this.options.imports.append(importId, accountId, {
        issues: issues.map((value, position) => ({ position, value })),
      });
    const result = await this.options.imports.sealPreview(
      importId,
      accountId,
      await this.options.snapshots.prepareCaptureGuards(row.snapshot_id, row.source_account_id),
    );
    if (result.state === 'preview')
      await this.db
        .prepare("UPDATE transfer_account_captures SET state='ready' WHERE import_id=?")
        .bind(importId)
        .run();
    return result;
  }
}
