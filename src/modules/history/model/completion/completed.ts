import { Temporal } from '@js-temporal/polyfill';
import type { Task } from '../../../tasks/contracts';
import { accountToday } from '../../../tasks/planning';
import type {
  CompletedGroup,
  CompletedGroupKey,
  CompletedOptions,
  CompletedTaskItem,
  CompletionSummary,
  HistoryDayGroup,
  HistoryEvent,
} from '../../contracts/events';

const identity = (accountId: string, id: string): string => JSON.stringify([accountId, id]);
const text = (value: string): string => value.normalize('NFC').toLowerCase();
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function completion(
  value: string | null,
  zone: string,
): { day: string; milliseconds: number } | null {
  if (!value) return null;
  try {
    const instant = Temporal.Instant.from(value);
    return {
      day: instant.toZonedDateTimeISO(zone).toPlainDate().toString(),
      milliseconds: instant.epochMilliseconds,
    };
  } catch {
    return null;
  }
}

function selectedTasks(
  tasks: readonly Task[],
  options: CompletedOptions,
  ordered = true,
): CompletedTaskItem[] {
  const index = new Map<string, Task>();
  for (const task of tasks) {
    const key = identity(task.accountId, task.id);
    const old = index.get(key);
    if (!old || task.revision > old.revision) index.set(key, task);
  }
  const lists = new Map(
    (options.lists ?? [])
      .filter((list) => list.accountId === options.accountId)
      .map((list) => [list.id, list]),
  );
  const query = text(options.query ?? '').trim();
  const items: CompletedTaskItem[] = [];
  const times = new Map<string, number>();
  for (const task of index.values()) {
    if (
      task.accountId !== options.accountId ||
      !task.completed ||
      (options.listIds && !options.listIds.includes(task.listId))
    )
      continue;
    const candidate = task.parentId
      ? index.get(identity(task.accountId, task.parentId))
      : undefined;
    const parent = candidate?.listId === task.listId ? candidate : null;
    const list = lists.get(task.listId) ?? null;
    if (
      query &&
      !text([task.title, parent?.title ?? '', list?.title ?? ''].join('\n')).includes(query)
    )
      continue;
    const instant = completion(task.completedAt, options.zone);
    items.push({ task, parent, list, completedDay: instant?.day ?? null });
    if (instant) times.set(task.id, instant.milliseconds);
  }
  if (!ordered) return items;
  return items.sort((a, b) => {
    const left = times.get(a.task.id) ?? -Infinity;
    const right = times.get(b.task.id) ?? -Infinity;
    const order = right - left;
    return (Number.isNaN(order) ? 0 : order) || compare(b.task.id, a.task.id);
  });
}

/** Counts only the supplied selection; its pagination and provider coverage belong to the caller. */
export function groupCompletedTasks(
  tasks: readonly Task[],
  options: CompletedOptions,
): CompletedGroup[] {
  const today = Temporal.PlainDate.from(accountToday(options.zone, options.now));
  const yesterday = today.subtract({ days: 1 }).toString();
  const start = today.subtract({ days: (today.dayOfWeek - options.weekStart + 7) % 7 }).toString();
  const todayString = today.toString();
  const groups = new Map<CompletedGroupKey, CompletedTaskItem[]>();
  for (const item of selectedTasks(tasks, options)) {
    const day = item.completedDay;
    const key: CompletedGroupKey =
      day === null
        ? 'unknown_time'
        : day > todayString
          ? 'future'
          : day === todayString
            ? 'today'
            : day === yesterday
              ? 'yesterday'
              : day >= start
                ? 'this_week'
                : 'earlier';
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return (
    ['today', 'yesterday', 'this_week', 'earlier', 'unknown_time', 'future'] as const
  ).flatMap((key) => {
    const items = groups.get(key);
    return items ? [{ key, items }] : [];
  });
}

/** This is current completed state, not a count of historical completion events. */
export function sevenDayCompletionSummary(
  tasks: readonly Task[],
  options: CompletedOptions,
): CompletionSummary {
  const today = Temporal.PlainDate.from(accountToday(options.zone, options.now));
  const days = Array.from({ length: 7 }, (_, index) => ({
    day: today.subtract({ days: 6 - index }).toString(),
    count: 0,
    lists: [] as { listId: string; count: number }[],
  }));
  const byDay = new Map(days.map((day) => [day.day, day]));
  const listOrder = new Map(
    (options.lists ?? [])
      .filter((list) => list.accountId === options.accountId)
      .map((list, index) => [list.id, index]),
  );
  let unknownTimeCount = 0,
    outsideWindowCount = 0;
  for (const item of selectedTasks(tasks, options, false)) {
    if (!item.completedDay) {
      unknownTimeCount++;
      continue;
    }
    const day = byDay.get(item.completedDay);
    if (!day) {
      outsideWindowCount++;
      continue;
    }
    day.count++;
    const list = day.lists.find((list) => list.listId === item.task.listId);
    if (list) list.count++;
    else day.lists.push({ listId: item.task.listId, count: 1 });
  }
  for (const day of days)
    day.lists.sort(
      (a, b) =>
        (listOrder.get(a.listId) ?? Infinity) - (listOrder.get(b.listId) ?? Infinity) ||
        compare(a.listId, b.listId),
    );
  return {
    days,
    total: days.reduce((sum, day) => sum + day.count, 0),
    unknownTimeCount,
    outsideWindowCount,
    countingRule: 'current_completed_tasks_including_subtasks',
  };
}

export function groupHistoryEventsByDay(
  events: readonly HistoryEvent[],
  options: { accountId: string; zone: string },
): HistoryDayGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, HistoryEvent[]>();
  const ordered = [...events]
    .filter((event) => event.accountId === options.accountId)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || compare(b.id, a.id));
  for (const event of ordered) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const day = Temporal.Instant.from(event.recordedAt)
      .toZonedDateTimeISO(options.zone)
      .toPlainDate()
      .toString();
    const group = groups.get(day);
    if (group) group.push(event);
    else groups.set(day, [event]);
  }
  return [...groups].map(([day, events]) => ({ day, events }));
}
