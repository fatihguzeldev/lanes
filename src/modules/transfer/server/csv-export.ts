import { z } from 'zod';
import { AppError } from '../../../shared/contracts/errors';
import { type Label, type TaskList } from '../../tasks/contracts/task';
import { ResourceIdSchema } from '../../../shared/contracts/identity';
import type { TaskExportQueryInput } from '../../tasks/contracts/query';
import type { TaskQueries } from '../../tasks/server/queries/tasks';
import {
  CsvExportRequestSchema,
  type CsvExportPage,
  type CsvExportRequest,
} from '../export-contract';
import { formatCsvHeader, formatCsvTask, type CsvTaskRecord } from '../parser';
import { importFields, type ImportCell } from '../parse-contract';

export interface TaskCsvExportOptions {
  queries: Pick<TaskQueries, 'exportPage' | 'exportMembership' | 'readLabelsByIds'>;
  readLists: (accountId: string, ids: readonly string[]) => Promise<TaskList[]>;
  now?: () => number;
}
export type RawTaskExportPage = Omit<CsvExportPage, 'chunk' | 'formulaEscapeExplanation'> & {
  rows: ImportCell[][];
};
const cursorSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().length(64),
    generatedAt: z.iso.datetime(),
    order: z.number().int().nonnegative().safe(),
    providerCursor: z.string().min(1).max(32_768),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
const invalidCursor = () =>
  new AppError(
    'validation_failed',
    'this export cursor does not belong to the selected account, export, or scope',
    422,
  );
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(canonical(value))),
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** A reference belongs to one explicit export; it cannot address a live provider resource. */
export async function exportLocalTaskKey(
  exportId: string,
  accountId: string,
  taskId: string,
): Promise<string> {
  return 't' + (await digest(['lanes-csv-v1', exportId, accountId, taskId]));
}
function encodeCursor(value: Cursor): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
function decodeCursor(value: string | undefined, fingerprint: string): Cursor | null {
  if (value === undefined) return null;
  try {
    if (!value || value.length > 48_000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const base64 = value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const decoded: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
      ),
    );
    const cursor = cursorSchema.parse(decoded);
    if (cursor.fingerprint !== fingerprint) throw new Error();
    return cursor;
  } catch {
    throw invalidCursor();
  }
}
function chunks<T>(values: readonly T[]): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += 100)
    output.push(values.slice(index, index + 100));
  return output;
}
const formulaEscapeExplanation =
  'text cells beginning with =, +, -, @, whitespace, a control character, or an apostrophe receive one leading apostrophe. the importer shows and removes this csv text escape; use the lanes archive for exact-text backup.';
const consistencyExplanation =
  'this export reads retained projection pages. provider or workspace edits during download can produce a mixed-time snapshot; it is not a transactionally consistent google backup.';

/** Stateless download pages; Tasks owns selection, hierarchy, and reference membership. */
export class TaskCsvExportService {
  constructor(private readonly options: TaskCsvExportOptions) {}

  async page(
    accountId: string,
    input: CsvExportRequest,
    cursorValue?: string,
  ): Promise<CsvExportPage> {
    const { rows: _rows, ...page } = await this.readPage(accountId, input, cursorValue, false);
    return page;
  }

  /** Raw export cells retain exact text. Only use this with a RAW provider write. */
  async rawPage(
    accountId: string,
    input: CsvExportRequest,
    cursorValue?: string,
  ): Promise<RawTaskExportPage> {
    const {
      chunk: _chunk,
      formulaEscapeExplanation: _escape,
      ...page
    } = await this.readPage(accountId, input, cursorValue, true);
    return page;
  }

  private async readPage(
    accountId: string,
    input: CsvExportRequest,
    cursorValue: string | undefined,
    raw: boolean,
  ): Promise<CsvExportPage & { rows: ImportCell[][] }> {
    if (!ResourceIdSchema.max(1024).safeParse(accountId).success)
      throw new AppError('validation_failed', 'select a connected account for this export', 422);
    const parsed = CsvExportRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'check the export scope and explicitly choose whether to include completed tasks',
        422,
      );
    const request = parsed.data,
      { limit: _limit, ...selection } = request;
    const fingerprint = await digest({ accountId, selection });
    const cursor = decodeCursor(cursorValue, fingerprint);
    const generatedAt =
      cursor?.generatedAt ?? new Date(this.options.now?.() ?? Date.now()).toISOString();
    const order = cursor?.order ?? 0;
    const context = { today: request.today, now: this.options.now?.() ?? Date.now() };
    const scope: TaskExportQueryInput = {
      ...request.scope,
      filter: { ...request.scope.filter, completion: request.includeCompleted ? 'all' : 'open' },
      sort: 'manual',
    };
    let limit = request.limit;
    for (;;) {
      const page = await this.options.queries.exportPage(
        accountId,
        { ...scope, limit, ...(cursor ? { cursor: cursor.providerCursor } : {}) },
        context,
      );
      const taskIds = new Set(page.items.map((task) => task.id));
      const referenceIds = [
        ...new Set(
          page.items.flatMap((task) => [
            ...task.blockedBy,
            ...(task.parentId ? [task.parentId] : []),
          ]),
        ),
      ];
      const selected = new Set<string>();
      for (const part of chunks(referenceIds))
        for (const id of await this.options.queries.exportMembership(
          accountId,
          scope,
          part,
          context,
        ))
          selected.add(id);
      const labelIds = [...new Set(page.items.flatMap((task) => task.labelIds))],
        labels = new Map<string, Label>();
      for (const part of chunks(labelIds))
        for (const label of await this.options.queries.readLabelsByIds(accountId, part))
          labels.set(label.id, label);
      const listIds = [...new Set(page.items.map((task) => task.listId))],
        lists = new Map(
          (await this.options.readLists(accountId, listIds)).map((list) => [list.id, list]),
        );
      if (lists.size !== listIds.length)
        throw new AppError(
          'conflict',
          'an exported list changed during download; start this export again',
          409,
        );
      const keys = new Map(
        await Promise.all(
          [...new Set([...taskIds, ...selected])].map(
            async (id) => [id, await exportLocalTaskKey(request.exportId, accountId, id)] as const,
          ),
        ),
      );
      const counts: CsvExportPage['counts'] = {
        tasks: page.items.length,
        parentContext: page.contextTaskIds.length,
        omittedDependencies: 0,
        missingParents: 0,
        missingLabels: 0,
        unsupportedHierarchy: 0,
      };
      let chunk = cursor || raw ? '' : formatCsvHeader();
      const rawRows: ImportCell[][] =
        cursor || !raw ? [] : [importFields.filter((field) => field !== 'subtask')];
      for (const [index, task] of page.items.entries()) {
        const dependencies = task.blockedBy.filter((id) => selected.has(id));
        counts.omittedDependencies += task.blockedBy.length - dependencies.length;
        const parentId = task.parentId && selected.has(task.parentId) ? task.parentId : null;
        if (task.parentId && !parentId) counts.missingParents++;
        const taskLabels = task.labelIds.flatMap((id) =>
          labels.has(id) ? [labels.get(id)!.name] : [],
        );
        counts.missingLabels += task.labelIds.length - taskLabels.length;
        if (task.unsupportedHierarchy) counts.unsupportedHierarchy++;
        const record: CsvTaskRecord = {
          key: keys.get(task.id)!,
          listKey: '',
          parentKey: parentId ? keys.get(parentId)! : null,
          title: task.title,
          notes: task.notes,
          completed: task.completed,
          completedAt: task.completedAt,
          scheduledDay: task.scheduledDay,
          scheduledTime: task.scheduledTime,
          timeZone: task.timeZone,
          repeatRule: task.repeatRule,
          labels: taskLabels,
          priority: task.priority,
          starred: task.starred,
          dependencies: dependencies.map((id) => keys.get(id)!),
          order: order + index,
        };
        if (raw)
          rawRows.push([
            record.key,
            record.parentKey ?? '',
            lists.get(task.listId)!.title,
            record.title,
            record.notes,
            record.scheduledDay ?? '',
            record.scheduledTime ?? '',
            record.timeZone ?? '',
            record.completed,
            record.completedAt ?? '',
            record.priority,
            JSON.stringify(record.labels),
            record.starred,
            record.repeatRule === null ? '' : JSON.stringify(record.repeatRule),
            JSON.stringify(record.dependencies),
            record.order,
          ]);
        else chunk += formatCsvTask(record, lists.get(task.listId)!.title);
      }
      if (new TextEncoder().encode(raw ? JSON.stringify(rawRows) : chunk).byteLength > 64 * 1024) {
        if (limit === 1)
          throw new AppError(
            'validation_failed',
            'this task exceeds one bounded csv row; use a narrower task record or an exact-text archive',
            422,
          );
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      return {
        chunk,
        rows: rawRows,
        nextCursor: page.nextCursor
          ? encodeCursor({
              version: 1,
              fingerprint,
              generatedAt,
              order: order + page.items.length,
              providerCursor: page.nextCursor,
            })
          : null,
        generatedAt,
        freshness: { source: 'retained_projection', ...page.providerCoverage },
        counts,
        formulaEscapeExplanation,
        consistencyExplanation,
      };
    }
  }
}
