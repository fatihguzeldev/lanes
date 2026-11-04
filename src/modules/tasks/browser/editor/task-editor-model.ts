import {
  CreateTaskSchema,
  TaskPatchSchema,
  type CreateTask,
  type Priority,
  type Task,
  type TaskPatch,
} from '../../contracts/task';
import { RepeatRuleSchema, type RepeatRule } from '../../contracts/planning';

export interface EditorDraftOptions {
  accountId: string;
  listId: string;
  timeZone: string;
  weekStart: 1 | 7;
  parentId: string | null;
  initialDay?: string | null | undefined;
}
export interface TaskEditorDraft {
  title: string;
  notes: string;
  scheduledDay: string;
  scheduledTime: string;
  timeZone: string;
  repeatEnabled: boolean;
  repeatFrequency: RepeatRule['frequency'];
  repeatInterval: string;
  repeatZone: string;
  repeatWeekStart: 1 | 7;
  repeatWeekdays: number[];
  repeatEnd: 'never' | 'date' | 'count';
  repeatEndDay: string;
  repeatCount: string;
  labelIds: string[];
  priority: Priority;
  starred: boolean;
  blockedBy: string[];
}
export type EditorSubmission =
  | { ok: true; kind: 'create'; input: CreateTask }
  | { ok: true; kind: 'edit'; patch: TaskPatch }
  | { ok: true; kind: 'unchanged' }
  | { ok: false; fields: Record<string, string> };

export function createEditorDraft(task: Task | null, options: EditorDraftOptions): TaskEditorDraft {
  const rule = task?.repeatRule;
  const scheduledDay = task ? (task.scheduledDay ?? '') : (options.initialDay ?? '');
  const day = new Date(`${scheduledDay}T12:00:00Z`).getUTCDay();
  return {
    title: task?.title ?? '',
    notes: task?.notes ?? '',
    scheduledDay,
    scheduledTime: task?.scheduledTime ?? '',
    timeZone: task?.timeZone ?? options.timeZone,
    repeatEnabled: !!rule,
    repeatFrequency: rule?.frequency ?? 'daily',
    repeatInterval: String(rule?.interval ?? 1),
    repeatZone: rule?.zone ?? options.timeZone,
    repeatWeekStart: rule?.weekStart ?? options.weekStart,
    repeatWeekdays: [...(rule?.weekdays ?? [day === 0 ? 7 : Number.isNaN(day) ? 1 : day])],
    repeatEnd: rule?.end.type ?? 'never',
    repeatEndDay: rule?.end.type === 'date' ? rule.end.day : '',
    repeatCount: rule?.end.type === 'count' ? String(rule.end.count) : '10',
    labelIds: [...(task?.labelIds ?? [])],
    priority: task?.priority ?? 'none',
    starred: task?.starred ?? false,
    blockedBy: [...(task?.blockedBy ?? [])],
  };
}

/** A retained rule enters the draft only after an explicit owner choice; dates and other edits stay put. */
export function restorePausedRepeatRule(draft: TaskEditorDraft, rule: RepeatRule): TaskEditorDraft {
  return {
    ...draft,
    repeatEnabled: true,
    repeatFrequency: rule.frequency,
    repeatInterval: String(rule.interval),
    repeatZone: rule.zone,
    repeatWeekStart: rule.weekStart,
    repeatWeekdays: [...rule.weekdays],
    repeatEnd: rule.end.type,
    repeatEndDay: rule.end.type === 'date' ? rule.end.day : '',
    repeatCount: rule.end.type === 'count' ? String(rule.end.count) : '10',
  };
}
function equivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameSet(left: string[] | number[], right: string[] | number[]): boolean {
  return equivalent([...left].sort(), [...right].sort());
}
function repeatConfig(draft: TaskEditorDraft) {
  return {
    frequency: draft.repeatFrequency,
    interval: Number(draft.repeatInterval),
    zone: draft.repeatZone,
    weekStart: draft.repeatWeekStart,
    weekdays: draft.repeatFrequency === 'weekly' ? [...draft.repeatWeekdays].sort() : [],
    end:
      draft.repeatEnd === 'date'
        ? { type: 'date', day: draft.repeatEndDay }
        : draft.repeatEnd === 'count'
          ? { type: 'count', count: Number(draft.repeatCount) }
          : { type: 'never' },
  };
}
function ruleFromDraft(draft: TaskEditorDraft, task: Task | null): unknown {
  if (!draft.scheduledDay || !draft.repeatEnabled) return null;
  const config = repeatConfig(draft);
  if (task?.repeatRule) {
    const { anchorDay: _anchor, ...existing } = task.repeatRule;
    if (
      draft.scheduledDay === task.scheduledDay &&
      equivalent(config, {
        ...existing,
        weekdays: existing.frequency === 'weekly' ? [...existing.weekdays].sort() : [],
      })
    )
      return task.repeatRule;
  }
  return { ...config, anchorDay: draft.scheduledDay };
}
function schedule(draft: TaskEditorDraft, task: Task | null, options: EditorDraftOptions) {
  const scheduledDay = draft.scheduledDay || null;
  const scheduledTime = scheduledDay ? draft.scheduledTime || null : null;
  const unchangedZoneWithoutTime =
    task && task.scheduledTime === null && draft.timeZone === (task.timeZone ?? options.timeZone);
  return {
    scheduledDay,
    scheduledTime,
    timeZone: scheduledTime
      ? draft.timeZone
      : scheduledDay && unchangedZoneWithoutTime
        ? task.timeZone
        : null,
    repeatRule: ruleFromDraft(draft, task),
  };
}
export function editorDraftIsDirty(
  draft: TaskEditorDraft,
  task: Task | null,
  options: EditorDraftOptions,
): boolean {
  const original = createEditorDraft(task, options);
  for (const field of Object.keys(original) as (keyof TaskEditorDraft)[]) {
    if (field === 'labelIds' || field === 'blockedBy' || field === 'repeatWeekdays') {
      if (!sameSet(draft[field], original[field])) return true;
    } else if (draft[field] !== original[field]) return true;
  }
  return false;
}
export function prepareEditorSubmission(
  draft: TaskEditorDraft,
  options: EditorDraftOptions & { task: Task | null },
): EditorSubmission {
  const task = options.task;
  if (task && (task.accountId !== options.accountId || task.listId !== options.listId))
    return {
      ok: false,
      fields: {
        accountId: 'this editor belongs to a different account or list; open the task again',
      },
    };
  if (!draft.scheduledDay && !task?.scheduledDay && (draft.repeatEnabled || draft.scheduledTime))
    return { ok: false, fields: { scheduledDay: 'choose a day before adding time or repetition' } };
  const nextSchedule = schedule(draft, task, options);
  if (!task) {
    const parsed = CreateTaskSchema.safeParse({
      accountId: options.accountId,
      listId: options.listId,
      parentId: options.parentId,
      title: draft.title,
      notes: draft.notes,
      ...nextSchedule,
      labelIds: draft.labelIds,
      priority: draft.priority,
      starred: draft.starred,
      blockedBy: draft.blockedBy,
    });
    return parsed.success
      ? { ok: true, kind: 'create', input: parsed.data }
      : {
          ok: false,
          fields: Object.fromEntries(
            parsed.error.issues.map((issue) => [issue.path.join('.') || 'input', issue.message]),
          ),
        };
  }
  const patch: Record<string, unknown> = {};
  if (draft.title !== task.title) patch.title = draft.title;
  if (draft.notes !== task.notes) patch.notes = draft.notes;
  for (const field of ['scheduledDay', 'scheduledTime', 'timeZone', 'repeatRule'] as const) {
    if (!equivalent(nextSchedule[field], task[field])) patch[field] = nextSchedule[field];
  }
  if (!sameSet(draft.labelIds, task.labelIds)) patch.labelIds = draft.labelIds;
  if (draft.priority !== task.priority) patch.priority = draft.priority;
  if (draft.starred !== task.starred) patch.starred = draft.starred;
  if (!sameSet(draft.blockedBy, task.blockedBy)) patch.blockedBy = draft.blockedBy;
  const fields: Record<string, string> = {};
  const providerFields = [
    'title',
    'notes',
    'scheduledDay',
    'scheduledTime',
    'timeZone',
    'repeatRule',
  ];
  if (
    providerFields.some((field) => field in patch) &&
    (!task.capabilities.canEdit || task.unsupportedHierarchy)
  )
    fields.input = task.capabilities.restriction ?? 'google does not permit this task edit';
  if ('notes' in patch && !task.capabilities.canEditNotes)
    fields.notes = 'google does not allow notes to be edited on this assigned task';
  if (patch.repeatRule && task.parentId)
    fields.repeatRule = 'a subtask cannot repeat independently';
  if (patch.repeatRule) {
    const parsed = RepeatRuleSchema.safeParse(patch.repeatRule);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        fields[`repeatRule.${issue.path.join('.')}`] = issue.message;
  }
  if (Object.keys(fields).length) return { ok: false, fields };
  if (!Object.keys(patch).length) return { ok: true, kind: 'unchanged' };
  const parsed = TaskPatchSchema.safeParse(patch);
  return parsed.success
    ? { ok: true, kind: 'edit', patch: parsed.data }
    : {
        ok: false,
        fields: Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.') || 'input', issue.message]),
        ),
      };
}

/** An explicit reapplication keeps only the owner's changed fields over a fresh base. */
export function rebaseEditorDraft(
  draft: TaskEditorDraft,
  previous: Task,
  latest: Task,
  options: EditorDraftOptions,
): TaskEditorDraft {
  if (
    previous.id !== latest.id ||
    previous.accountId !== latest.accountId ||
    previous.listId !== latest.listId
  )
    throw new Error('a draft cannot be rebased onto another task, account or list');
  const before = createEditorDraft(previous, options),
    next = createEditorDraft(latest, options);
  const scheduling = [
    'scheduledDay',
    'scheduledTime',
    'timeZone',
    'repeatEnabled',
    'repeatFrequency',
    'repeatInterval',
    'repeatZone',
    'repeatWeekStart',
    'repeatWeekdays',
    'repeatEnd',
    'repeatEndDay',
    'repeatCount',
  ] as const;
  const changed = (field: keyof TaskEditorDraft): boolean => {
    if (field === 'labelIds' || field === 'blockedBy' || field === 'repeatWeekdays')
      return !sameSet(draft[field], before[field]);
    return draft[field] !== before[field];
  };
  for (const field of Object.keys(next) as (keyof TaskEditorDraft)[]) {
    if (changed(field))
      Object.assign(next, {
        [field]: Array.isArray(draft[field]) ? [...draft[field]] : draft[field],
      });
  }
  // Clearing the owner's day is an intentional clear of the schedule as a whole.
  if (changed('scheduledDay') && draft.scheduledDay === '')
    for (const field of scheduling) Object.assign(next, { [field]: draft[field] });
  return next;
}
