import { useState } from 'react';
import {
  TaskFilterSchema,
  type Label,
  type TaskFilter,
  type TaskList,
} from '../../../tasks/contracts/task';
import { Select } from '../../../../shared/ui/select/Select';
import './TaskFilters.css';

interface Props {
  filter: TaskFilter;
  lists: readonly TaskList[];
  labels: readonly Label[];
  today: string;
  onChange: (filter: TaskFilter) => void;
  onClear: () => void;
  moreLists?: boolean;
  moreLabels?: boolean;
  onMoreLists: () => void;
  onMoreLabels: () => void;
}
export function TaskFilters({
  filter,
  lists,
  labels,
  today,
  onChange,
  onClear,
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
  const change = (next: TaskFilter) => {
    setDraft(next);
    const normalized = { ...next };
    for (const field of ['listIds', 'labelIds', 'priorities', 'dependencyStates'] as const)
      if (!normalized[field]?.length) delete normalized[field];
    if (!normalized.labelIds) delete normalized.labelMatch;
    if (normalized.completion === 'open') delete normalized.completion;
    const parsed = TaskFilterSchema.safeParse(normalized);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'check these filters.');
      return;
    }
    setError('');
    onChange(parsed.data);
  };
  const patch = (value: Partial<TaskFilter>) => change({ ...draft, ...value });
  const toggle = (
    field: 'listIds' | 'labelIds' | 'priorities' | 'dependencyStates',
    value: string,
  ) => {
    const values = (draft[field] ?? []) as string[];
    patch({
      [field]: values.includes(value)
        ? values.filter((item) => item !== value)
        : [...values, value],
    });
  };
  return (
    <div className="dialog__body task-filters">
      <label>
        completion
        <Select
          value={draft.completion ?? 'open'}
          onChange={(selectedValue) =>
            patch({ completion: selectedValue as 'open' | 'completed' | 'all' })
          }
          aria-label="completion"
          options={[
            { value: 'open', label: 'open tasks' },
            { value: 'completed', label: 'completed tasks' },
            { value: 'all', label: 'open and completed' },
          ]}
        />
      </label>
      <label>
        scheduled
        <Select
          value={draft.scheduled?.kind ?? 'any'}
          onChange={(selectedValue) => {
            const value = selectedValue;
            const next = { ...draft };
            if (value === 'any') delete next.scheduled;
            else
              next.scheduled =
                value === 'range'
                  ? { kind: 'range', from, to }
                  : { kind: value as 'today' | 'overdue' | 'none' };
            change(next);
          }}
          aria-label="scheduled"
          options={[
            { value: 'any', label: 'any day' },
            { value: 'today', label: 'today' },
            { value: 'overdue', label: 'overdue' },
            { value: 'none', label: 'no date' },
            { value: 'range', label: 'a date range' },
          ]}
        />
      </label>
      {draft.scheduled?.kind === 'range' && (
        <div className="task-filters__range">
          <label>
            from
            <input
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                patch({ scheduled: { kind: 'range', from: event.target.value, to } });
              }}
              required
            />
          </label>
          <label>
            through
            <input
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                patch({ scheduled: { kind: 'range', from, to: event.target.value } });
              }}
              required
            />
          </label>
        </div>
      )}
      <label>
        star
        <Select
          value={draft.starred === undefined ? 'any' : String(draft.starred)}
          onChange={(selectedValue) => {
            const value = selectedValue;
            const next = { ...draft };
            if (value === 'any') delete next.starred;
            else next.starred = value === 'true';
            change(next);
          }}
          aria-label="star"
          options={[
            { value: 'any', label: 'any task' },
            { value: 'true', label: 'starred' },
            { value: 'false', label: 'without a star' },
          ]}
        />
      </label>
      <details className="task-filters__advanced">
        <summary>more filters</summary>
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
            <Select
              value={draft.labelMatch ?? 'any'}
              onChange={(selectedValue) => patch({ labelMatch: selectedValue as 'any' | 'all' })}
              aria-label="match labels"
              options={[
                { value: 'any', label: 'any selected label' },
                { value: 'all', label: 'every selected label' },
              ]}
            />
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
            setDraft({});
            setError('');
          }}
        >
          clear all
        </button>
      </footer>
    </div>
  );
}
