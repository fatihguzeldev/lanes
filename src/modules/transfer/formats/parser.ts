import { z } from 'zod';
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_LISTS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  TransferParseError,
  importFields,
} from '../contracts/parsing';
import type {
  ImportCell,
  ImportField,
  ImportFormat,
  ImportIssue,
  ImportOptions,
  ImportPreview,
  ImportTable,
  NormalizedImportTask,
} from '../contracts/parsing';
import { normalizeImportTables } from './normalize';
export { normalizeImportTables } from './normalize';

/** RFC 4180 quoting; no delimiter guessing and no formula evaluation. */
export function parseDelimitedText(source: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [],
    row: string[] = [];
  let field = '',
    quoted = false,
    closed = false,
    started = false;
  const pushField = () => {
    if (row.length >= MAX_TABLE_COLUMNS)
      throw new TransferParseError('table_too_large', 'select at most 256 columns.');
    row.push(field);
    field = '';
    closed = false;
    started = false;
  };
  const pushRow = () => {
    pushField();
    if (rows.length >= MAX_TABLE_ROWS)
      throw new TransferParseError('table_too_large', 'select at most 10,000 source rows.');
    rows.push(row.splice(0));
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
    } else if (char === delimiter) pushField();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      pushRow();
    } else if (char === '"') {
      if (started || closed)
        throw new TransferParseError(
          'delimited_invalid',
          'a quote must start a quoted field. check the source row near ' + (rows.length + 1) + '.',
        );
      quoted = true;
      started = true;
    } else {
      if (closed)
        throw new TransferParseError(
          'delimited_invalid',
          'unexpected text after a closing quote near row ' + (rows.length + 1) + '.',
        );
      field += char;
      started = true;
    }
    if (field.length > 1_048_576)
      throw new TransferParseError(
        'cell_too_large',
        'one source cell exceeds 1 mib. split or narrow the selected data.',
      );
  }
  if (quoted)
    throw new TransferParseError(
      'delimited_invalid',
      'a quoted field is not closed near row ' + (rows.length + 1) + '.',
    );
  if (field || row.length || started || closed) pushRow();
  return rows;
}
function decode(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return value.replace(/^\ufeff/, '');
  } catch {
    throw new TransferParseError(
      'encoding_unsupported',
      'this text file must use utf-8. export or convert it to utf-8 and try again.',
    );
  }
}
function textTables(source: string): ImportTable[] {
  const header = ['source_key', 'parent_key', 'Task', 'Notes', 'Completed'];
  const tables: ImportTable[] = [];
  let table: ImportTable = { name: 'imported tasks', rows: [header], rowNumbers: [1] };
  tables.push(table);
  let topKey = '',
    lastRow: ImportCell[] | null = null,
    childIndent: number | null = null,
    pendingBlank = 0,
    counter = 0;
  const lines = source.matchAll(/([^\r\n]*)(?:\r\n|\n|\r|$)/g);
  let index = -1;
  for (const matched of lines) {
    if (matched[0] === '') break;
    index++;
    if (index >= MAX_TABLE_ROWS)
      throw new TransferParseError(
        'table_too_large',
        'text imports may contain at most 10,000 source lines. select a smaller source.',
      );
    const line = matched[1]!;
    if (!line.trim()) {
      pendingBlank++;
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      table = {
        name: heading[1]!.trim(),
        rows: [header],
        startRow: index + 1,
        rowNumbers: [index + 1],
      };
      tables.push(table);
      topKey = '';
      lastRow = null;
      childIndent = null;
      pendingBlank = 0;
      continue;
    }
    const bullet = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*)$/);
    const indent = (line.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '    ').length;
    if (!bullet && indent > 0) {
      if (!lastRow)
        throw new TransferParseError(
          'notes_without_task',
          'line ' + (index + 1) + ' contains an indented note without a preceding task.',
        );
      lastRow[3] =
        String(lastRow[3] ?? '') +
        (lastRow[3] ? '\n'.repeat(pendingBlank + 1) : '') +
        line.trimStart();
      pendingBlank = 0;
      continue;
    }
    const title = bullet ? bullet[3]! : line.trim(),
      completed = bullet?.[2]?.toLowerCase() === 'x';
    let parent = '';
    if (bullet && indent > 0) {
      if (!topKey)
        throw new TransferParseError(
          'parent_missing',
          'line ' + (index + 1) + ' has a subtask without a top-level parent.',
        );
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent)
        throw new TransferParseError(
          'hierarchy_too_deep',
          'line ' +
            (index + 1) +
            ' has unsupported deeper or inconsistent task nesting. promote it or make it a direct subtask.',
        );
      parent = topKey;
    }
    const key = 'text-' + ++counter;
    const row: ImportCell[] = [key, parent, title, '', completed];
    table.rows.push(row);
    table.rowNumbers?.push(index + 1);
    lastRow = row;
    if (!parent) {
      topKey = key;
      childIndent = null;
    }
    pendingBlank = 0;
  }
  return tables.filter((value) => value.rows.length > 1);
}
const takeoutTask = z.object({
  kind: z.literal('tasks#task').optional(),
  id: z.string().min(1).max(2048),
  title: z.string().optional(),
  notes: z.string().optional(),
  parent: z.string().max(2048).optional(),
  due: z.string().optional(),
  status: z.enum(['needsAction', 'completed']).optional(),
  completed: z.string().optional(),
  deleted: z.boolean().optional(),
  position: z.string().optional(),
});
const takeoutSchema = z.object({
  kind: z.literal('tasks#taskLists'),
  items: z
    .array(
      z.object({
        kind: z.enum(['tasks#tasks', 'tasks#taskList']).optional(),
        id: z.string().min(1).max(2048),
        title: z.string(),
        items: z.array(takeoutTask).optional(),
      }),
    )
    .max(MAX_IMPORT_LISTS),
});
function checkJsonWork(source: string): void {
  let quoted = false,
    escaped = false,
    depth = 0,
    containers = 0;
  for (const char of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      depth++;
      containers++;
      if (depth > 32 || containers > 50_000)
        throw new TransferParseError(
          'takeout_too_complex',
          'this json exceeds the supported nesting or record-work bound. select a smaller known Takeout task export.',
        );
    } else if (char === '}' || char === ']') depth--;
  }
}
function takeoutTables(source: string): { tables: ImportTable[]; issues: ImportIssue[] } {
  checkJsonWork(source);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new TransferParseError(
      'takeout_invalid',
      'Tasks.json is not valid json. export it again or convert the task table to csv.',
    );
  }
  const parsed = takeoutSchema.safeParse(value);
  if (
    !parsed.success ||
    (value && typeof value === 'object' && ('version' in value || 'schemaVersion' in value))
  )
    throw new TransferParseError(
      'takeout_schema_unsupported',
      'this is not a supported Google Takeout Tasks.json taskLists export. use its known taskLists/items schema or convert to the documented csv columns.',
    );
  const issues: ImportIssue[] = [];
  let sourceOffset = 0;
  const tables = parsed.data.items.map((list) => {
    const startRow = sourceOffset + 1;
    sourceOffset += (list.items?.length ?? 0) + 1;
    const rowNumbers = [startRow];
    const rows: ImportCell[][] = [
      [
        'source_key',
        'parent_key',
        'Task',
        'Notes',
        'Completed',
        'completed_at',
        'scheduled_day',
        'order',
      ],
    ];
    const siblings = new Map<string, number>();
    const ordered = [...(list.items ?? [])].sort((a, b) =>
      a.position !== undefined && b.position !== undefined
        ? a.position < b.position
          ? -1
          : a.position > b.position
            ? 1
            : 0
        : 0,
    );
    for (const [index, task] of ordered.entries()) {
      const source = { sheet: list.title, row: startRow + index + 1 };
      if (task.deleted) {
        issues.push({
          severity: 'warning',
          code: 'takeout_deleted_skipped',
          message: 'a source task marked deleted is excluded.',
          source,
        });
        continue;
      }
      let day = task.due ?? '';
      if (/^\d{4}-\d{2}-\d{2}T/.test(day)) day = day.slice(0, 10);
      const parent = task.parent ?? '',
        order = siblings.get(parent) ?? 0;
      siblings.set(parent, order + 1);
      rowNumbers.push(source.row);
      rows.push([
        JSON.stringify([list.id, task.id]),
        parent ? JSON.stringify([list.id, parent]) : '',
        task.title ?? '',
        task.notes ?? '',
        task.status === 'completed' || (task.status === undefined && !!task.completed),
        task.completed ?? '',
        day,
        order,
      ]);
    }
    return { name: list.title, rows, startRow, rowNumbers };
  });
  return { tables, issues };
}
export async function parseImportFile(
  file: { name: string; bytes: Uint8Array },
  options: ImportOptions = {},
): Promise<ImportPreview> {
  if (!(file.bytes instanceof Uint8Array))
    throw new TransferParseError(
      'file_invalid',
      'read the selected file as bytes before previewing.',
    );
  if (file.bytes.byteLength > MAX_IMPORT_FILE_BYTES)
    throw new TransferParseError(
      'file_too_large',
      'a file may contain at most 20 mib. select a smaller export.',
    );
  const extension = file.name.toLowerCase().split('.').at(-1);
  const format = options.format ?? ((extension === 'json' ? 'takeout' : extension) as ImportFormat);
  if (!['csv', 'tsv', 'txt', 'md', 'takeout', 'xlsx', 'xls', 'ods', 'numbers'].includes(format))
    throw new TransferParseError(
      'format_unsupported',
      'choose csv, tsv, txt, md, Tasks.json, xlsx, xls, ods or numbers. arbitrary zip files are not supported.',
    );
  if (['xlsx', 'xls', 'ods', 'numbers'].includes(format)) {
    const { readWorkbook } = await import('./workbook');
    const workbook = await readWorkbook(
      file.bytes,
      format as 'xlsx' | 'xls' | 'ods' | 'numbers',
      options.selections,
    );
    const preview = normalizeImportTables(workbook.tables, format, options);
    preview.sheets = workbook.sheets;
    preview.issues.unshift(...workbook.issues);
    return preview;
  }
  const source = decode(file.bytes);
  if (format === 'takeout') {
    const parsed = takeoutTables(source),
      preview = normalizeImportTables(parsed.tables, format, {
        ...options,
        groupBy: options.groupBy ?? 'sheet',
      });
    preview.issues.unshift(...parsed.issues);
    return preview;
  }
  if (format === 'txt' || format === 'md')
    return normalizeImportTables(textTables(source), format, {
      ...options,
      groupBy: options.groupBy ?? 'sheet',
    });
  return normalizeImportTables(
    [
      {
        name: file.name.replace(/\.[^.]+$/, '') || 'imported tasks',
        rows: parseDelimitedText(source, format === 'tsv' ? '\t' : ','),
      },
    ],
    format,
    options,
  );
}

/** Every data row is independently formatable for paged export. Apostrophes escape formula/control prefixes and themselves. */
const quote = (value: string): string =>
  /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
function csvText(value: string): string {
  return /^[=+\-@'\s\p{Cc}]/u.test(value) ? "'" + value : value;
}
export function formatCsvHeader(): string {
  return importFields.filter((field) => field !== 'subtask').join(',') + '\r\n';
}
export type CsvTaskRecord = Omit<
  NormalizedImportTask,
  'key' | 'listKey' | 'parentKey' | 'dependencies'
> & {
  key: string;
  listKey: string;
  parentKey: string | null;
  dependencies: string[];
};
export function formatCsvTask(task: CsvTaskRecord, listTitle: string): string {
  const fields: Record<Exclude<ImportField, 'subtask'>, string> = {
    source_key: task.key,
    parent_key: task.parentKey ?? '',
    list: csvText(listTitle),
    task: csvText(task.title),
    notes: csvText(task.notes),
    scheduled_day: task.scheduledDay ?? '',
    scheduled_time: task.scheduledTime ?? '',
    time_zone: task.timeZone ?? '',
    completed: String(task.completed),
    completed_at: task.completedAt ?? '',
    priority: task.priority,
    labels: JSON.stringify(task.labels),
    starred: String(task.starred),
    repeat_rule: task.repeatRule === null ? '' : JSON.stringify(task.repeatRule),
    dependencies: JSON.stringify(task.dependencies),
    order: String(task.order),
  };
  return (
    importFields
      .filter((field): field is Exclude<ImportField, 'subtask'> => field !== 'subtask')
      .map((field) => quote(fields[field]))
      .join(',') + '\r\n'
  );
}
