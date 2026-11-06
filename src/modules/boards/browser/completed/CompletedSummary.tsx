import type { CompletionSummary } from '../../../history/model/completion/types';
import { Icon } from '../../../../shared/ui/icon/Icon';

interface Props {
  summary: CompletionSummary;
  today: string;
  listName(id: string): string;
}
const dayName = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' });

export function CompletedSummary({ summary, today, listName }: Props) {
  const byList = new Map<string, number>();
  for (const day of summary.days)
    for (const list of day.lists)
      byList.set(list.listId, (byList.get(list.listId) ?? 0) + list.count);
  return (
    <section className="completed-workspace__summary" aria-label="seven day completion summary">
      <div className="completed-workspace__summary-heading">
        <h3>last 7 days</h3>
        <span title="current completed tasks, including subtasks">
          <strong>{summary.total}</strong> completed
        </span>
      </div>
      <ol aria-label="daily completion counts">
        {summary.days.map((day) => (
          <li
            key={day.day}
            aria-current={day.day === today ? 'date' : undefined}
            data-counted={day.count > 0 || undefined}
          >
            <span>{dayName.format(new Date(day.day + 'T12:00:00Z')).toLowerCase()}</span>
            <strong>{day.count}</strong>
            <time dateTime={day.day}>{day.day.slice(5).replace('-', '/')}</time>
          </li>
        ))}
      </ol>
      {byList.size > 0 && (
        <details className="completed-workspace__breakdown">
          <summary>
            <Icon name="list" size={13} />
            <span>by list</span>
            <Icon name="down" size={12} />
          </summary>
          <ul>
            {[...byList].map(([id, count]) => (
              <li key={id}>
                <span>{listName(id)}</span>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.unknownTimeCount > 0 && (
        <p className="completed-workspace__summary-note">
          {summary.unknownTimeCount} tasks have no completion time and are outside the daily
          summary.
        </p>
      )}
    </section>
  );
}
