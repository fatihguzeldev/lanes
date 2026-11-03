import { Temporal } from '@js-temporal/polyfill';
import type { Task } from '../../tasks/contracts';
import { sortTasks } from '../../tasks/model';

export type CalendarMode = 'month' | 'week';
export type CalendarScope = 'board' | 'account';
export interface CalendarDaySelection {
  accountId: string;
  scheduledDay: string | null;
}
export interface CalendarCreateIntent extends CalendarDaySelection {
  listId: string;
}

/** A destination remains bound to the account and board whose list page was read. */
export function calendarCreateIntent(
  accountId: string,
  boardId: string,
  list: { id: string; accountId: string; boardId: string },
  scheduledDay: string | null,
): CalendarCreateIntent | null {
  return list.accountId === accountId && list.boardId === boardId
    ? { accountId, listId: list.id, scheduledDay }
    : null;
}
export interface CalendarDay {
  date: string;
  day: number;
  weekday: number;
  inMonth: boolean;
}
export interface CalendarRange {
  from: string;
  to: string;
}
export interface CalendarBucket {
  dateOnly: Task[];
  timed: Task[];
}
export interface CalendarTaskGroups {
  byDay: Map<string, CalendarBucket>;
  unscheduled: Task[];
}
export interface CalendarTaskQuery extends CalendarRange {
  accountId: string;
  matchedTaskIds?: ReadonlySet<string> | undefined;
}

export function calendarGrid(
  cursorDay: string,
  mode: CalendarMode,
  weekStart: 1 | 7,
): CalendarDay[][] {
  const cursor = Temporal.PlainDate.from(cursorDay);
  const periodStart = mode === 'month' ? cursor.with({ day: 1 }) : cursor;
  const offset = (periodStart.dayOfWeek - weekStart + 7) % 7;
  const first = periodStart.subtract({ days: offset });
  const count = mode === 'week' ? 7 : Math.ceil((offset + cursor.daysInMonth) / 7) * 7;
  const rows: CalendarDay[][] = [];
  for (let index = 0; index < count; index += 7) {
    rows.push(
      Array.from({ length: 7 }, (_, weekday) => {
        const date = first.add({ days: index + weekday });
        return {
          date: date.toString(),
          day: date.day,
          weekday: date.dayOfWeek,
          inMonth: date.year === cursor.year && date.month === cursor.month,
        };
      }),
    );
  }
  return rows;
}

export function calendarRange(
  cursorDay: string,
  mode: CalendarMode,
  weekStart: 1 | 7,
): CalendarRange {
  const days = calendarGrid(cursorDay, mode, weekStart).flat();
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) throw new RangeError('a calendar period must contain calendar days');
  return { from: first.date, to: last.date };
}

export function moveCalendarCursor(
  cursorDay: string,
  mode: CalendarMode,
  direction: -1 | 1,
): string {
  const cursor = Temporal.PlainDate.from(cursorDay);
  return mode === 'month'
    ? cursor.with({ day: 1 }).add({ months: direction }).toString()
    : cursor.add({ days: direction * 7 }).toString();
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function groupCalendarTasks(
  tasks: readonly Task[],
  query: CalendarTaskQuery,
): CalendarTaskGroups {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (
      task.accountId !== query.accountId ||
      (query.matchedTaskIds && !query.matchedTaskIds.has(task.id))
    )
      continue;
    const previous = byId.get(task.id);
    if (!previous || previous.revision < task.revision) byId.set(task.id, task);
  }
  const manual = sortTasks(
    [...byId.values()].sort((a, b) => compareText(a.listId, b.listId)),
    'manual',
  );
  const ranks = new Map(manual.map((task, index) => [task.id, index]));
  const byDay = new Map<string, CalendarBucket>();
  const unscheduled: Task[] = [];
  for (const task of manual) {
    if (!task.scheduledDay) {
      unscheduled.push(task);
      continue;
    }
    if (task.scheduledDay < query.from || task.scheduledDay > query.to) continue;
    let bucket = byDay.get(task.scheduledDay);
    if (!bucket) {
      bucket = { dateOnly: [], timed: [] };
      byDay.set(task.scheduledDay, bucket);
    }
    if (task.scheduledTime) bucket.timed.push(task);
    else bucket.dateOnly.push(task);
  }
  for (const bucket of byDay.values())
    bucket.timed.sort(
      (a, b) =>
        compareText(a.scheduledTime ?? '', b.scheduledTime ?? '') ||
        (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0),
    );
  return {
    byDay: new Map([...byDay.entries()].sort(([left], [right]) => compareText(left, right))),
    unscheduled,
  };
}
