import type { HistoryEvent } from '../contracts';
import type { IconName } from '../../../ui/Icon';
import { addCalendarDays } from '../../tasks/planning';

export function describeHistoryEvent(event: HistoryEvent): {
  action: string;
  detail: string;
  icon: IconName;
} {
  switch (event.kind) {
    case 'task_created':
      return {
        action: 'created',
        detail:
          event.summary.source && event.summary.source !== 'direct'
            ? `from ${event.summary.source}`
            : '',
        icon: 'plus',
      };
    case 'task_completed':
      return { action: 'completed', detail: '', icon: 'check' };
    case 'task_reopened':
      return { action: 'reopened', detail: '', icon: 'history' };
    case 'task_moved':
      return {
        action: 'moved',
        detail:
          event.summary.from.listId !== event.summary.to.listId
            ? 'to another list'
            : event.summary.to.parentId
              ? 'under a parent task'
              : 'to the top level',
        icon: 'arrow',
      };
    case 'task_deleted':
      return {
        action: 'deleted',
        detail: event.summary.knownSubtaskCount
          ? `with ${event.summary.knownSubtaskCount} known subtasks`
          : '',
        icon: 'trash',
      };
    case 'list_deleted':
      return {
        action: 'deleted list',
        detail: `${event.summary.knownTaskCount} observed tasks`,
        icon: 'trash',
      };
    case 'scheduled_day_changed':
      return {
        action: event.summary.after ? 'changed date' : 'removed date',
        detail: `${event.summary.before ?? 'unscheduled'} → ${event.summary.after ?? 'unscheduled'}`,
        icon: 'calendar',
      };
    case 'scheduled_time_changed':
      return {
        action: 'changed time',
        detail: `${event.summary.before.time ?? 'any time'} → ${event.summary.after.time ?? 'any time'}${event.summary.after.zone ? ` · ${event.summary.after.zone}` : ''}`,
        icon: 'clock',
      };
    case 'repeat_rule_changed':
      return {
        action: event.summary.after ? 'changed repetition' : 'stopped repetition',
        detail: event.summary.after
          ? `every ${event.summary.after.interval} · ${event.summary.after.frequency}`
          : '',
        icon: 'sync',
      };
    case 'labels_changed':
      return {
        action: 'changed labels',
        detail: `${event.summary.before.length} → ${event.summary.after.length} labels`,
        icon: 'list',
      };
    case 'priority_changed':
      return {
        action: 'changed priority',
        detail: `${event.summary.before} → ${event.summary.after}`,
        icon: 'up',
      };
    case 'star_changed':
      return { action: event.summary.after ? 'starred' : 'removed star', detail: '', icon: 'star' };
    case 'dependencies_changed':
      return {
        action: 'changed dependencies',
        detail: `${event.summary.before.length} → ${event.summary.after.length} blockers`,
        icon: 'link',
      };
  }
}
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'today';
  if (day === addCalendarDays(today, -1)) return 'yesterday';
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'long',
    year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
    timeZone: 'UTC',
  })
    .format(new Date(day + 'T12:00:00Z'))
    .toLowerCase();
}
