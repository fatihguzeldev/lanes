import { z } from 'zod';
import { CreateTaskSchema, LabelInputSchema, PrioritySchema } from '../tasks/contracts';
import { TaskScheduleSchema } from '../tasks/planning-contract';

export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_IMPORT_TASKS = 2000;
export const MAX_IMPORT_LISTS = 100;
export const MAX_TABLE_ROWS = 10_000;
export const MAX_TABLE_COLUMNS = 256;
export const ImportFormatSchema = z.enum([
  'csv',
  'tsv',
  'txt',
  'md',
  'takeout',
  'xlsx',
  'xls',
  'ods',
  'numbers',
]);
export type ImportFormat = z.infer<typeof ImportFormatSchema>;
export const importFields = [
  'source_key',
  'parent_key',
  'list',
  'task',
  'subtask',
  'notes',
  'scheduled_day',
  'scheduled_time',
  'time_zone',
  'completed',
  'completed_at',
  'priority',
  'labels',
  'starred',
  'repeat_rule',
  'dependencies',
  'order',
] as const;
export type ImportField = (typeof importFields)[number];
export type ImportMapping = Partial<Record<ImportField, number>>;
export interface ImportSource {
  sheet: string;
  row: number;
  column?: number;
}
export interface ImportIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  source?: ImportSource;
  field?: string;
  taskKey?: string;
}
export type ImportCell = string | number | boolean | null;
export interface ImportTable {
  name: string;
  rows: ImportCell[][];
  /** 1-based original worksheet row of rows[0]. */
  startRow?: number;
  /** Original rows when a text parser removes note lines between task records. */
  rowNumbers?: number[];
  cellIssues?: ImportIssue[];
}
export interface WorkbookSelection {
  sheet: string;
  range?: string;
}
export interface WorkbookTables {
  tables: ImportTable[];
  sheets: { name: string; range: string }[];
  issues: ImportIssue[];
}
export interface ImportOptions {
  format?: ImportFormat;
  /** 1-based row within the selected table. Defaults to its first row. */
  headerRow?: number;
  /** Column indexes are 0-based. An explicit mapping replaces automatic header recognition. */
  mapping?: ImportMapping;
  mappingBySheet?: readonly { sheet: string; fields: ImportMapping; headerRow?: number }[];
  dateConvention?: 'iso' | 'day-first' | 'month-first';
  groupBy?: 'sheet' | 'list-column' | 'single';
  singleListTitle?: string;
  /** Existing destination identity is supplied to admission separately, never trusted from a file. */
  destination?: 'new' | 'existing';
  skipCompleted?: boolean;
  selections?: readonly WorkbookSelection[];
  excludedRows?: readonly { sheet: string; rows: readonly number[] }[];
}
const localTaskKey = z.string().regex(/^t[1-9]\d{0,3}$/);
const localListKey = z.string().regex(/^l[1-9]\d{0,2}$/);
export const NormalizedImportTaskSchema = TaskScheduleSchema.safeExtend({
  key: localTaskKey,
  listKey: localListKey,
  parentKey: localTaskKey.nullable(),
  title: CreateTaskSchema.shape.title,
  notes: CreateTaskSchema.shape.notes,
  completed: z.boolean(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  labels: z
    .array(LabelInputSchema.shape.name)
    .max(20)
    .refine(
      (value) =>
        new Set(value.map((name) => name.normalize('NFC').toLowerCase())).size === value.length,
      'use each label once',
    ),
  priority: PrioritySchema,
  starred: z.boolean(),
  dependencies: z
    .array(localTaskKey)
    .max(50)
    .refine((value) => new Set(value).size === value.length, 'use each dependency once'),
  order: z.number().int().nonnegative().safe(),
})
  .strict()
  .superRefine((task, context) => {
    if (task.parentKey && task.repeatRule)
      context.addIssue({
        code: 'custom',
        path: ['repeatRule'],
        message: 'a nested subtask cannot repeat independently',
      });
    if (!task.completed && task.completedAt)
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'an open task cannot have a completion timestamp',
      });
  });
export type NormalizedImportTask = z.infer<typeof NormalizedImportTaskSchema>;
export const NormalizedImportListSchema = z
  .object({ key: localListKey, title: CreateTaskSchema.shape.title })
  .strict();
export type NormalizedImportList = z.infer<typeof NormalizedImportListSchema>;
export const NormalizedImportPlanSchema = z
  .object({
    version: z.literal(1),
    lists: z.array(NormalizedImportListSchema).max(MAX_IMPORT_LISTS),
    tasks: z.array(NormalizedImportTaskSchema).max(MAX_IMPORT_TASKS),
  })
  .strict()
  .superRefine((plan, context) => {
    const lists = new Set(plan.lists.map((list) => list.key));
    const tasks = new Map(plan.tasks.map((task) => [task.key, task]));
    if (lists.size !== plan.lists.length || tasks.size !== plan.tasks.length)
      context.addIssue({ code: 'custom', message: 'input-local identities must be unique' });
    for (const [index, task] of plan.tasks.entries()) {
      const issue = (field: string, message: string) =>
        context.addIssue({ code: 'custom', path: ['tasks', index, field], message });
      if (!lists.has(task.listKey)) issue('listKey', 'the selected list is missing');
      if (task.parentKey) {
        const parent = tasks.get(task.parentKey);
        if (!parent) issue('parentKey', 'the parent is missing');
        else if (parent.key === task.key || parent.parentKey)
          issue('parentKey', 'only one level of subtasks is supported');
        else if (parent.listKey !== task.listKey)
          issue('parentKey', 'the parent belongs to another list');
      }
      for (const key of task.dependencies)
        if (!tasks.has(key) || key === task.key)
          issue('dependencies', 'dependencies must reference another included task');
    }
    const state = new Map<string, number>();
    const visit = (key: string): boolean => {
      if (state.get(key) === 1) return false;
      if (state.get(key) === 2) return true;
      state.set(key, 1);
      for (const dependency of tasks.get(key)?.dependencies ?? [])
        if (tasks.has(dependency) && !visit(dependency)) return false;
      state.set(key, 2);
      return true;
    };
    if (plan.tasks.some((task) => !visit(task.key)))
      context.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'dependencies contain a cycle',
      });
  });
export type NormalizedImportPlan = z.infer<typeof NormalizedImportPlanSchema>;
export interface ImportPreview extends NormalizedImportPlan {
  format: ImportFormat;
  mapping: { sheet: string; fields: ImportMapping; headerRow: number }[];
  columns?: { sheet: string; headers: string[] }[];
  issues: ImportIssue[];
  skippedBlankRows: number;
  skippedCompletedTasks: number;
  parentContextCount: number;
  sheets: { name: string; range: string }[];
}
export class TransferParseError extends Error {
  readonly name = 'TransferParseError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
