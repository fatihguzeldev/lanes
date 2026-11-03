import { useState } from 'react';
import {
  TaskFilterSchema,
  type Label,
  type TaskFilter,
  type TaskList,
} from '../modules/tasks/contracts';
import { Dialog } from '../ui/Dialog';
interface Props {
  filter: TaskFilter;
  lists: readonly TaskList[];
  labels: readonly Label[];
  today: string;
  onChange: (filter: TaskFilter) => void;
  onClear: () => void;
  onClose: () => void;
  moreLists?: boolean;
  moreLabels?: boolean;
  onMoreLists: () => void;
  onMoreLabels: () => void;
}
export function TaskFiltersDialog({
  filter,
  lists,
  labels,
  today,
  onChange,
  onClear,
  onClose,
  moreLists,
  moreLabels,
  onMoreLists,
  onMoreLabels,
}: Props) {
  const [draft, setDraft] = useState(filter),
    [error, setError] = useState('');
  const [from, setFrom] = useState(
      filter.scheduled?.kind === 'range' ? filter.scheduled.from : today,
    ),
    [to, setTo] = useState(filter.scheduled?.kind === 'range' ? filter.scheduled.to : today);
  const patch = (value: Partial<TaskFilter>) => setDraft((previous) => ({ ...previous, ...value }));
  const toggle = (
    field: 'listIds' | 'labelIds' | 'priorities' | 'dependencyStates',
    value: string,
  ) =>
    setDraft((previous) => {
      const values = (previous[field] ?? []) as string[];
      return {
        ...previous,
        [field]: values.includes(value)
          ? values.filter((item) => item !== value)
          : [...values, value],
      };
    });
  return (
    <Dialog title="filter your tasks" onClose={onClose}>
      <form
        className="dialog__body task-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const next = {
            ...draft,
            ...(draft.scheduled?.kind === 'range'
              ? { scheduled: { kind: 'range' as const, from, to } }
              : {}),
          };
          for (const field of ['listIds', 'labelIds', 'priorities', 'dependencyStates'] as const)
            if (!next[field]?.length) delete next[field];
          if (!next.labelIds) delete next.labelMatch;
          if (next.completion === 'open') delete next.completion;
          const parsed = TaskFilterSchema.safeParse(next);
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? 'check these filters.');
            return;
          }
          onChange(parsed.data);
          onClose();
        }}
      >
        <p>different conditions combine. within one group, any selected value can match.</p>
        <label>
          completion
          <select
            value={draft.completion ?? 'open'}
            onChange={(event) =>
              patch({ completion: event.target.value as 'open' | 'completed' | 'all' })
            }
          >
            <option value="open">open tasks</option>
            <option value="completed">completed tasks</option>
            <option value="all">open and completed</option>
          </select>
        </label>
        <label>
          scheduled
          <select
            value={draft.scheduled?.kind ?? 'any'}
            onChange={(event) => {
              const value = event.target.value;
              setDraft((previous) => {
                const next = { ...previous };
                if (value === 'any') delete next.scheduled;
                else
                  next.scheduled =
                    value === 'range'
                      ? { kind: 'range', from, to }
                      : { kind: value as 'today' | 'overdue' | 'none' };
                return next;
              });
            }}
          >
            <option value="any">any day</option>
            <option value="today">today</option>
            <option value="overdue">overdue</option>
            <option value="none">no date</option>
            <option value="range">a date range</option>
          </select>
        </label>
        {draft.scheduled?.kind === 'range' && (
          <div className="task-filters__range">
            <label>
              from
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                required
              />
            </label>
            <label>
              through
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                required
              />
            </label>
          </div>
        )}
        <label>
          star
          <select
            value={draft.starred === undefined ? 'any' : String(draft.starred)}
            onChange={(event) => {
              const value = event.target.value;
              setDraft((previous) => {
                const next = { ...previous };
                if (value === 'any') delete next.starred;
                else next.starred = value === 'true';
                return next;
              });
            }}
          >
            <option value="any">any task</option>
            <option value="true">starred</option>
            <option value="false">without a star</option>
          </select>
        </label>
        <fieldset>
          <legend>priority</legend>
          <div className="task-filters__choices">
            {(['none', 'low', 'medium', 'high'] as const).map((value) => (
              <label key={value}>
                <input
                  type="checkbox"
                  checked={draft.priorities?.includes(value) ?? false}
                  onChange={() => toggle('priorities', value)}
                />
                {value}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>dependencies</legend>
          <div className="task-filters__choices">
            {(['blocked', 'unblocked', 'unknown'] as const).map((value) => (
              <label key={value}>
                <input
                  type="checkbox"
                  checked={draft.dependencyStates?.includes(value) ?? false}
                  onChange={() => toggle('dependencyStates', value)}
                />
                {value}
              </label>
            ))}
          </div>
        </fieldset>
        <details open={!!draft.labelIds?.length}>
          <summary>labels{draft.labelIds?.length ? ` · ${draft.labelIds.length}` : ''}</summary>
          <div className="task-filters__choices">
            {labels.map((label) => (
              <label key={label.id}>
                <input
                  type="checkbox"
                  checked={draft.labelIds?.includes(label.id) ?? false}
                  disabled={
                    !draft.labelIds?.includes(label.id) && (draft.labelIds?.length ?? 0) >= 20
                  }
                  onChange={() => toggle('labelIds', label.id)}
                />
                {label.name}
              </label>
            ))}
          </div>
          {!labels.length && <p>no labels loaded.</p>}
          {moreLabels && (
            <button type="button" onClick={onMoreLabels}>
              more labels
            </button>
          )}
          <label>
            match labels
            <select
              value={draft.labelMatch ?? 'any'}
              onChange={(event) => patch({ labelMatch: event.target.value as 'any' | 'all' })}
            >
              <option value="any">any selected label</option>
              <option value="all">every selected label</option>
            </select>
          </label>
        </details>
        <details open={!!draft.listIds?.length}>
          <summary>lists{draft.listIds?.length ? ` · ${draft.listIds.length}` : ''}</summary>
          <div className="task-filters__choices">
            {lists.map((list) => (
              <label key={list.id}>
                <input
                  type="checkbox"
                  checked={draft.listIds?.includes(list.id) ?? false}
                  onChange={() => toggle('listIds', list.id)}
                />
                {list.title || 'untitled list'}
              </label>
            ))}
          </div>
          {moreLists && (
            <button type="button" onClick={onMoreLists}>
              more lists
            </button>
          )}
        </details>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button
            type="button"
            onClick={() => {
              onClear();
              onClose();
            }}
          >
            clear all
          </button>
          <button className="primary" type="submit">
            apply filters
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
