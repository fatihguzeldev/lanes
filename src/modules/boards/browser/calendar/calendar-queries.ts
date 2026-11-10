import type { TaskFilter, TaskSort } from '../../../tasks/contracts/task';
import type { TaskQueryInput } from '../../../tasks/contracts/query';
import { addCalendarDays } from '../../../tasks/model/planning';
import type { CalendarRange, CalendarScope } from './calendar-model';

interface CalendarQueryOptions {
  accountId: string;
  boardId: string;
  scope: CalendarScope;
  range: CalendarRange;
  today: string;
  filter: TaskFilter;
  query: string;
  sort: TaskSort;
}
export function buildCalendarQueries(options: CalendarQueryOptions): {
  dated: TaskQueryInput | null;
  unscheduled: TaskQueryInput | null;
} {
  const { scheduled, ...rest } = options.filter;
  const base: TaskQueryInput = {
    ...(options.scope === 'board' ? { boardId: options.boardId } : {}),
    query: options.query,
    sort: options.sort,
  };
  let from = options.range.from;
  let to = options.range.to;
  if (scheduled?.kind === 'range') {
    from = from > scheduled.from ? from : scheduled.from;
    to = to < scheduled.to ? to : scheduled.to;
  }
  if (scheduled?.kind === 'today') {
    from = from > options.today ? from : options.today;
    to = to < options.today ? to : options.today;
  }
  if (scheduled?.kind === 'overdue') {
    const yesterday = addCalendarDays(options.today, -1);
    to = to < yesterday ? to : yesterday;
  }
  const dated =
    scheduled?.kind === 'none' ||
    from > to ||
    (scheduled?.kind === 'overdue' && rest.completion === 'completed')
      ? null
      : {
          ...base,
          filter: {
            ...rest,
            ...(scheduled?.kind === 'overdue' ? { completion: 'open' as const } : {}),
            scheduled: { kind: 'range' as const, from, to },
          },
        };
  const unscheduled =
    scheduled && scheduled.kind !== 'none'
      ? null
      : { ...base, filter: { ...rest, scheduled: { kind: 'none' as const } } };
  return { dated, unscheduled };
}
