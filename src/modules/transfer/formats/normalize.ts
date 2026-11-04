import { z } from 'zod';
import { CreateTaskSchema, LabelInputSchema, PrioritySchema } from '../../tasks/contracts/task';
import {
  CalendarDateSchema,
  RepeatRuleSchema,
  TaskScheduleSchema,
} from '../../tasks/contracts/planning';
import {
  MAX_IMPORT_LISTS,
  MAX_IMPORT_TASKS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  TransferParseError,
} from '../contracts/parsing';
import type {
  ImportCell,
  ImportField,
  ImportFormat,
  ImportIssue,
  ImportMapping,
  ImportOptions,
  ImportPreview,
  ImportSource,
  ImportTable,
  NormalizedImportTask,
} from '../contracts/parsing';

const timestamp = z.iso.datetime({ offset: true });
const aliases: Record<string, ImportField> = {
  task: 'task',
  title: 'task',
  tasktitle: 'task',
  subtask: 'subtask',
  subtasktitle: 'subtask',
  notes: 'notes',
  note: 'notes',
  description: 'notes',
  list: 'list',
  listtitle: 'list',
  tasklist: 'list',
  sourcekey: 'source_key',
  parentkey: 'parent_key',
  duedate: 'scheduled_day',
  due: 'scheduled_day',
  scheduledday: 'scheduled_day',
  scheduleddate: 'scheduled_day',
  scheduledtime: 'scheduled_time',
  time: 'scheduled_time',
  timezone: 'time_zone',
  zone: 'time_zone',
  completed: 'completed',
  done: 'completed',
  completedat: 'completed_at',
  completiontime: 'completed_at',
  priority: 'priority',
  labels: 'labels',
  starred: 'starred',
  star: 'starred',
  repeatrule: 'repeat_rule',
  dependencies: 'dependencies',
  order: 'order',
};
const string = (value: ImportCell | undefined): string => (value == null ? '' : String(value));
interface Draft {
  task: NormalizedImportTask;
  source: ImportSource;
  rawKey: string;
  rawParent: string;
  rawDependencies: string[];
}
function checkOptions(options: ImportOptions): void {
  if (
    options.headerRow !== undefined &&
    (!Number.isInteger(options.headerRow) ||
      options.headerRow < 1 ||
      options.headerRow > MAX_TABLE_ROWS)
  )
    throw new TransferParseError(
      'header_row_invalid',
      'choose a header row from the selected table.',
    );
  if (
    options.mapping &&
    Object.entries(options.mapping).some(
      ([field, column]) =>
        !Object.values(aliases).includes(field as ImportField) ||
        !Number.isInteger(column) ||
        column < 0 ||
        column >= MAX_TABLE_COLUMNS,
    )
  )
    throw new TransferParseError(
      'mapping_invalid',
      'mapped columns must be valid zero-based table indexes.',
    );
  if (options.mappingBySheet) {
    if (
      options.mappingBySheet.length > 100 ||
      new Set(options.mappingBySheet.map((entry) => entry.sheet)).size !==
        options.mappingBySheet.length
    )
      throw new TransferParseError(
        'mapping_invalid',
        'choose each worksheet mapping once, within100 worksheets.',
      );
    for (const entry of options.mappingBySheet) {
      if (typeof entry.sheet !== 'string' || !entry.sheet || entry.sheet.length > 4096)
        throw new TransferParseError('mapping_invalid', 'choose a known worksheet name.');
      checkOptions({
        mapping: entry.fields,
        ...(entry.headerRow === undefined ? {} : { headerRow: entry.headerRow }),
      });
    }
  }
  if (
    options.dateConvention &&
    !['iso', 'day-first', 'month-first'].includes(options.dateConvention)
  )
    throw new TransferParseError(
      'date_convention_invalid',
      'choose iso, day-first or month-first dates.',
    );
  if (options.groupBy && !['sheet', 'list-column', 'single'].includes(options.groupBy))
    throw new TransferParseError(
      'grouping_invalid',
      'choose worksheet, list-column or single-list grouping.',
    );
}
export function normalizeImportTables(
  tables: readonly ImportTable[],
  format: ImportFormat,
  options: ImportOptions = {},
): ImportPreview {
  checkOptions(options);
  const preview: ImportPreview = {
    version: 1,
    format,
    lists: [],
    tasks: [],
    mapping: [],
    columns: [],
    issues: [],
    skippedBlankRows: 0,
    skippedCompletedTasks: 0,
    parentContextCount: 0,
    sheets: [],
  };
  const drafts: Draft[] = [],
    groupKeys = new Map<string, string>();
  const issue = (
    severity: ImportIssue['severity'],
    code: string,
    message: string,
    source?: ImportSource,
    field?: string,
    taskKey?: string,
  ) => {
    if (preview.issues.length >= 10_000)
      throw new TransferParseError(
        'too_many_issues',
        'this source produces more than 10,000 diagnostics. correct the source or select a smaller subset.',
      );
    preview.issues.push({
      severity,
      code,
      message,
      ...(source ? { source } : {}),
      ...(field ? { field } : {}),
      ...(taskKey ? { taskKey } : {}),
    });
  };
  const listFor = (
    table: ImportTable,
    tableIndex: number,
    value: string,
    hasList: boolean,
  ): string => {
    const grouping =
      options.destination === 'existing'
        ? 'single'
        : (options.groupBy ?? (hasList ? 'list-column' : 'sheet'));
    const title =
      grouping === 'single'
        ? options.singleListTitle?.trim() ||
          (options.destination === 'existing' ? 'existing list' : 'imported tasks')
        : grouping === 'list-column'
          ? value.trim() || table.name
          : table.name;
    const group = grouping === 'sheet' ? 'sheet:' + tableIndex : grouping + ':' + title;
    let key = groupKeys.get(group);
    if (!key) {
      if (preview.lists.length >= MAX_IMPORT_LISTS)
        throw new TransferParseError(
          'too_many_lists',
          'this selection creates more than 100 lists. select a smaller subset before importing.',
        );
      key = 'l' + (preview.lists.length + 1);
      groupKeys.set(group, key);
      preview.lists.push({ key, title });
      if (!CreateTaskSchema.shape.title.safeParse(title).success)
        issue('error', 'list_title_invalid', 'the list title must contain 1–1,024 characters.');
    }
    return key;
  };
  for (const [tableIndex, table] of tables.entries()) {
    if (
      table.rows.length > MAX_TABLE_ROWS ||
      table.rows.some((row) => row.length > MAX_TABLE_COLUMNS)
    )
      throw new TransferParseError(
        'table_too_large',
        'select at most 10,000 rows and 256 columns for one table.',
      );
    if (preview.issues.length + (table.cellIssues?.length ?? 0) > 10_000)
      throw new TransferParseError(
        'too_many_issues',
        'this source produces more than 10,000 diagnostics. select a smaller subset.',
      );
    preview.issues.push(...(table.cellIssues ?? []));
    const sheetMapping = options.mappingBySheet?.find((entry) => entry.sheet === table.name),
      explicitMapping = sheetMapping?.fields ?? options.mapping;
    const headerIndex = (sheetMapping?.headerRow ?? options.headerRow ?? 1) - 1,
      header = table.rows[headerIndex] ?? [];
    const fields: ImportMapping = explicitMapping ? { ...explicitMapping } : {};
    if (!explicitMapping)
      for (const [column, value] of header.entries()) {
        const normalized = string(value)
          .trim()
          .toLowerCase()
          .replace(/[\s_\-]+/g, '');
        const field = Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined;
        if (!field) continue;
        if (fields[field] !== undefined)
          issue(
            'error',
            'ambiguous_header',
            'more than one column maps to ' + field + '. choose the intended column.',
            {
              sheet: table.name,
              row: table.rowNumbers?.[headerIndex] ?? (table.startRow ?? 1) + headerIndex,
              column: column + 1,
            },
            field,
          );
        else fields[field] = column;
      }
    preview.mapping.push({ sheet: table.name, fields, headerRow: headerIndex + 1 });
    preview.columns!.push({
      sheet: table.name,
      headers: header.slice(0, MAX_TABLE_COLUMNS).map((value) => String(value ?? '').slice(0, 256)),
    });
    if (fields.task === undefined) {
      issue(
        'error',
        'mapping_required',
        'map the task title column before importing.',
        {
          sheet: table.name,
          row: table.rowNumbers?.[headerIndex] ?? (table.startRow ?? 1) + headerIndex,
        },
        'task',
      );
      continue;
    }
    if (format === 'takeout') listFor(table, tableIndex, '', fields.list !== undefined);
    if (
      fields.subtask !== undefined &&
      (fields.source_key !== undefined || fields.parent_key !== undefined)
    )
      issue(
        'error',
        'legacy_reference_conflict',
        'map either explicit source/parent keys or the legacy subtask-title column. their hierarchy rules cannot be combined.',
        {
          sheet: table.name,
          row: table.rowNumbers?.[headerIndex] ?? (table.startRow ?? 1) + headerIndex,
        },
        'subtask',
      );
    const canonical =
      fields.source_key !== undefined &&
      fields.parent_key !== undefined &&
      fields.repeat_rule !== undefined &&
      fields.dependencies !== undefined;
    let legacyRun = '',
      legacyParent: Draft | null = null,
      warnedLegacy = false,
      warnedExisting = false;
    const add = (
      row: ImportCell[],
      source: ImportSource,
      overrideTitle?: string,
      overrideParent?: string,
      overrideRawKey?: string,
    ): Draft | null => {
      const cell = (field: ImportField): string => {
        const column = fields[field];
        let value = column === undefined ? '' : string(row[column]);
        if (canonical && /^'(?:'|[=+\-@\s\p{Cc}])/u.test(value)) {
          value = value.slice(1);
          issue(
            'warning',
            'csv_text_escape',
            'a documented csv text-escape apostrophe was removed. review the imported text.',
            { ...source, ...(column === undefined ? {} : { column: column + 1 }) },
            field,
          );
        }
        return value;
      };
      const title = (overrideTitle ?? cell('task')).trim();
      if (!title) {
        preview.skippedBlankRows++;
        return null;
      }
      if (drafts.length >= (options.skipCompleted ? MAX_TABLE_ROWS : MAX_IMPORT_TASKS))
        throw new TransferParseError(
          'too_many_tasks',
          'this selection contains more than 2,000 tasks including subtasks. select a smaller subset before importing.',
        );
      const key = 't' + (drafts.length + 1),
        rawKey = overrideRawKey ?? (cell('source_key') || '@row:' + tableIndex + ':' + source.row);
      const warn = (code: string, message: string, field: ImportField) =>
        issue('warning', code, message, source, field, key);
      const error = (code: string, message: string, field: ImportField) =>
        issue('error', code, message, source, field, key);
      const listValue = cell('list');
      if (options.destination === 'existing' && listValue && !warnedExisting) {
        warnedExisting = true;
        warn(
          'list_grouping_ignored',
          'the mapped list column cannot change the explicitly selected existing destination.',
          'list',
        );
      }
      const boolean = (field: ImportField, fallback = false): boolean => {
        const value = cell(field).trim().toLowerCase();
        if (!value) return fallback;
        if (['true', '1', 'yes', 'x', 'completed', 'done'].includes(value)) return true;
        if (['false', '0', 'no', 'open', 'needsaction'].includes(value)) return false;
        warn(
          'unknown_boolean',
          'this value is not an explicit supported boolean. accept the warning to omit it.',
          field,
        );
        return fallback;
      };
      const structured = (field: ImportField): unknown => {
        const value = cell(field).trim();
        if (!value) return null;
        try {
          if (value.length > 32_768) throw new Error();
          return JSON.parse(value) as unknown;
        } catch {
          error('invalid_structure', 'use valid bounded json for this structured field.', field);
          return null;
        }
      };
      let scheduledDay: string | null = null;
      const day = cell('scheduled_day').trim();
      if (day) {
        if (CalendarDateSchema.safeParse(day).success) scheduledDay = day;
        else {
          const numeric = day.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
          if (numeric && (!options.dateConvention || options.dateConvention === 'iso'))
            warn(
              'date_convention_required',
              'choose one day/month convention for numeric dates before accepting their omission.',
              'scheduled_day',
            );
          else if (numeric) {
            const month = options.dateConvention === 'day-first' ? numeric[2] : numeric[1],
              date = options.dateConvention === 'day-first' ? numeric[1] : numeric[2];
            const iso = numeric[3] + '-' + month!.padStart(2, '0') + '-' + date!.padStart(2, '0');
            if (CalendarDateSchema.safeParse(iso).success) scheduledDay = iso;
            else
              warn(
                'invalid_date',
                'this calendar date is invalid. correct it or accept omitting the date.',
                'scheduled_day',
              );
          } else
            warn(
              'invalid_date',
              'use an iso calendar day, or select a convention for numeric dates.',
              'scheduled_day',
            );
        }
      }
      const repeatRaw = structured('repeat_rule');
      let repeatRule = null;
      if (repeatRaw !== null) {
        const result = RepeatRuleSchema.safeParse(repeatRaw);
        if (result.success) repeatRule = result.data;
        else
          error(
            'invalid_repeat_rule',
            'correct the structured repeat rule before importing.',
            'repeat_rule',
          );
      }
      const scheduleInput = {
        scheduledDay,
        scheduledTime: cell('scheduled_time').trim() || null,
        timeZone: cell('time_zone').trim() || null,
        repeatRule,
      };
      const schedule = TaskScheduleSchema.safeParse(scheduleInput);
      if (!schedule.success && repeatRule)
        error(
          'invalid_repeat_schedule',
          'a structured repeat rule needs a compatible scheduled day and zone.',
          'repeat_rule',
        );
      if (!schedule.success)
        warn(
          'invalid_schedule',
          'the local time, zone or repeat rule is incomplete or invalid. correct it or accept importing the day without those fields.',
          'scheduled_time',
        );
      let completedAt: string | null = null;
      const completedText = cell('completed_at').trim();
      if (completedText) {
        if (timestamp.safeParse(completedText).success) completedAt = completedText;
        else
          warn(
            'invalid_completion_time',
            'the original completion timestamp is unreadable and will remain unknown.',
            'completed_at',
          );
      }
      const completed = boolean(
        'completed',
        fields.completed === undefined && completedAt !== null,
      );
      if (!completed && completedAt) {
        warn(
          'completion_time_without_completion',
          'an open task cannot retain a completion timestamp.',
          'completed_at',
        );
        completedAt = null;
      }
      let priority: NormalizedImportTask['priority'] = 'none';
      const priorityText = cell('priority').trim().toLowerCase();
      if (priorityText) {
        const checked = PrioritySchema.safeParse(priorityText);
        if (checked.success) priority = checked.data;
        else
          warn(
            'unknown_priority',
            'choose none, low, medium or high; accepting this warning uses none.',
            'priority',
          );
      }
      const labelsText = cell('labels').trim();
      let labels: string[] = [];
      if (labelsText) {
        const raw = labelsText.startsWith('[')
          ? structured('labels')
          : labelsText
              .split(/[,;]/)
              .map((value) => value.trim())
              .filter(Boolean);
        const checked = z.array(LabelInputSchema.shape.name).max(20).safeParse(raw);
        if (
          checked.success &&
          new Set(checked.data.map((value) => value.toLowerCase())).size === checked.data.length
        )
          labels = checked.data;
        else
          error(
            'labels_invalid',
            'use at most 20 distinct label names, each 1–64 characters.',
            'labels',
          );
      }
      const dependenciesRaw = structured('dependencies');
      let rawDependencies: string[] = [];
      if (dependenciesRaw !== null) {
        const checked = z.array(z.string().min(1).max(2048)).max(50).safeParse(dependenciesRaw);
        if (checked.success) rawDependencies = checked.data;
        else
          error(
            'dependencies_invalid',
            'dependencies must be an array of at most 50 input-local keys.',
            'dependencies',
          );
      }
      const notes = cell('notes');
      if (!CreateTaskSchema.shape.title.safeParse(title).success)
        error('title_too_long', 'use a nonblank task title of at most 1,024 characters.', 'task');
      if (!CreateTaskSchema.shape.notes.safeParse(notes).success)
        error('notes_too_long', 'use at most 8,192 characters in notes.', 'notes');
      const orderText = cell('order').trim(),
        parsedOrder = Number(orderText);
      let order = drafts.length;
      if (orderText) {
        if (Number.isSafeInteger(parsedOrder) && parsedOrder >= 0) order = parsedOrder;
        else
          warn(
            'invalid_order',
            'this order is invalid; the source row order will be used.',
            'order',
          );
      }
      const task: NormalizedImportTask = {
        key,
        listKey: listFor(table, tableIndex, listValue, fields.list !== undefined),
        parentKey: null,
        title,
        notes,
        completed,
        completedAt,
        ...(schedule.success
          ? schedule.data
          : { scheduledDay, scheduledTime: null, timeZone: null, repeatRule: null }),
        labels,
        priority,
        starred: boolean('starred'),
        dependencies: [],
        order,
      };
      const draft = {
        task,
        source,
        rawKey,
        rawParent: overrideParent ?? cell('parent_key'),
        rawDependencies,
      };
      drafts.push(draft);
      return draft;
    };
    const excluded = new Set(
      options.excludedRows
        ?.filter((value) => value.sheet === table.name)
        .flatMap((value) => [...value.rows]) ?? [],
    );
    for (let index = headerIndex + 1; index < table.rows.length; index++) {
      const row = table.rows[index]!,
        source = {
          sheet: table.name,
          row: table.rowNumbers?.[index] ?? (table.startRow ?? 1) + index,
        };
      if (excluded.has(source.row)) continue;
      const parentTitle = string(row[fields.task]).trim(),
        childTitle = fields.subtask === undefined ? '' : string(row[fields.subtask]).trim();
      if (fields.subtask !== undefined && (parentTitle || childTitle)) {
        if (!warnedLegacy) {
          warnedLegacy = true;
          issue(
            'warning',
            'legacy_parent_runs',
            'a contiguous run of the same parent title within one list is grouped. later equal titles create distinct parents.',
            source,
          );
        }
        const run = JSON.stringify([
          string(fields.list === undefined ? table.name : row[fields.list]),
          parentTitle,
        ]);
        if (!parentTitle) {
          issue(
            'error',
            'legacy_parent_missing',
            'a legacy subtask row needs its parent title.',
            source,
            'task',
          );
          continue;
        }
        if (run !== legacyRun || !legacyParent) {
          legacyRun = run;
          const parentRow = childTitle
            ? row.map((value, column) =>
                column === fields.task || column === fields.list ? value : '',
              )
            : row;
          legacyParent = add(
            parentRow,
            source,
            parentTitle,
            '',
            '@legacy:' + tableIndex + ':' + source.row,
          );
        }
        if (childTitle && legacyParent)
          add(
            row,
            source,
            childTitle,
            legacyParent.rawKey,
            '@child:' + tableIndex + ':' + source.row,
          );
      } else {
        legacyRun = '';
        legacyParent = null;
        add(row, source);
      }
    }
  }
  const raw = new Map<string, Draft[]>();
  for (const draft of drafts) raw.set(draft.rawKey, [...(raw.get(draft.rawKey) ?? []), draft]);
  for (const [key, values] of raw)
    if (values.length > 1)
      for (const draft of values)
        issue(
          'error',
          'duplicate_source_key',
          'each input-local source key must identify one row: ' + key.slice(0, 100),
          draft.source,
          'source_key',
          draft.task.key,
        );
  for (const draft of drafts) {
    if (draft.rawParent) {
      const matches = raw.get(draft.rawParent);
      if (matches?.length !== 1)
        issue(
          'error',
          'parent_missing_or_ambiguous',
          'the parent key must identify one included source task.',
          draft.source,
          'parent_key',
          draft.task.key,
        );
      else draft.task.parentKey = matches[0]!.task.key;
    }
    for (const reference of draft.rawDependencies) {
      const matches = raw.get(reference);
      if (matches?.length !== 1)
        issue(
          'error',
          'dependency_missing_or_ambiguous',
          'each dependency must identify one included source task.',
          draft.source,
          'dependencies',
          draft.task.key,
        );
      else if (matches[0]!.task.key === draft.task.key)
        issue(
          'error',
          'self_dependency',
          'a task cannot depend on itself.',
          draft.source,
          'dependencies',
          draft.task.key,
        );
      else if (draft.task.dependencies.includes(matches[0]!.task.key))
        issue(
          'error',
          'duplicate_dependency',
          'use each dependency once.',
          draft.source,
          'dependencies',
          draft.task.key,
        );
      else draft.task.dependencies.push(matches[0]!.task.key);
    }
  }
  const byKey = new Map(drafts.map((draft) => [draft.task.key, draft]));
  for (const draft of drafts)
    if (draft.task.parentKey) {
      const parent = byKey.get(draft.task.parentKey)!;
      if (parent.task.key === draft.task.key || parent.task.parentKey)
        issue(
          'error',
          'hierarchy_invalid',
          'hierarchy has a cycle, self-parent or more than one subtask level.',
          draft.source,
          'parent_key',
          draft.task.key,
        );
      if (parent.task.listKey !== draft.task.listKey)
        issue(
          'error',
          'parent_cross_list',
          'a parent must belong to the same imported list.',
          draft.source,
          'parent_key',
          draft.task.key,
        );
      if (draft.task.repeatRule)
        issue(
          'error',
          'nested_repeat_rule',
          'a nested subtask cannot repeat independently.',
          draft.source,
          'repeat_rule',
          draft.task.key,
        );
    }
  const dependencyState = new Map<string, number>();
  const visit = (key: string): boolean => {
    if (dependencyState.get(key) === 1) return false;
    if (dependencyState.get(key) === 2) return true;
    dependencyState.set(key, 1);
    for (const dependency of byKey.get(key)?.task.dependencies ?? [])
      if (include.has(dependency) && !visit(dependency)) return false;
    dependencyState.set(key, 2);
    return true;
  };
  const include = new Set(
    drafts
      .filter((draft) => !options.skipCompleted || !draft.task.completed)
      .map((draft) => draft.task.key),
  );
  if (options.skipCompleted)
    for (const draft of drafts)
      if (
        include.has(draft.task.key) &&
        draft.task.parentKey &&
        !include.has(draft.task.parentKey)
      ) {
        const parent = byKey.get(draft.task.parentKey);
        if (parent) {
          include.add(parent.task.key);
          parent.task.completed = false;
          parent.task.completedAt = null;
          preview.parentContextCount++;
          issue(
            'warning',
            'completed_parent_context',
            'a completed parent is included as open context for an included child.',
            parent.source,
            'completed',
            parent.task.key,
          );
        }
      }
  if (include.size > MAX_IMPORT_TASKS)
    throw new TransferParseError(
      'too_many_tasks',
      'this selection contains more than 2,000 tasks including parent context and subtasks. select a smaller subset.',
    );
  preview.skippedCompletedTasks = drafts.length - include.size;
  preview.issues = preview.issues.filter((issue) => !issue.taskKey || include.has(issue.taskKey));
  preview.tasks = drafts
    .filter((draft) => include.has(draft.task.key))
    .map((draft) => {
      const omitted = draft.task.dependencies.filter((key) => !include.has(key));
      if (omitted.length)
        issue(
          'warning',
          'dependency_excluded',
          'dependencies outside the included set were omitted.',
          draft.source,
          'dependencies',
          draft.task.key,
        );
      return {
        ...draft.task,
        dependencies: draft.task.dependencies.filter((key) => include.has(key)),
      };
    });
  if (preview.tasks.some((task) => !visit(task.key)))
    issue('error', 'dependency_cycle', 'the imported dependency graph contains a cycle.');
  const keys = new Map(preview.tasks.map((task, index) => [task.key, 't' + (index + 1)]));
  preview.tasks = preview.tasks.map((task) => ({
    ...task,
    key: keys.get(task.key)!,
    parentKey: task.parentKey ? (keys.get(task.parentKey) ?? null) : null,
    dependencies: task.dependencies.map((key) => keys.get(key)!),
  }));
  preview.issues = preview.issues.map((issue) =>
    issue.taskKey ? { ...issue, taskKey: keys.get(issue.taskKey) ?? issue.taskKey } : issue,
  );
  return preview;
}
