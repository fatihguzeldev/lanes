import { useState, type CSSProperties } from 'react';
import type { Label } from '../../contracts/task';
import type { LabelPickerPage } from './useLabels';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { Popover } from '../../../../shared/ui/popover/Popover';
import { Tooltip } from '../../../../shared/ui/tooltip/Tooltip';
import './TaskLabelPicker.css';

interface Props {
  labels: readonly Label[];
  page?: LabelPickerPage | undefined;
  selected: readonly string[];
  disabled: boolean;
  deleting?: ReadonlySet<string> | undefined;
  onToggle(id: string): void;
  onManage?: ((anchor: HTMLElement, create?: boolean) => void) | undefined;
}
export function TaskLabelPicker({
  labels,
  page,
  selected,
  disabled,
  deleting,
  onToggle,
  onManage,
}: Props) {
  const [query, setQuery] = useState('');
  const matching = labels.filter((label) =>
    label.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Tooltip label="labels">
      <Popover
        label="labels"
        disabled={disabled}
        trigger={<Icon name="tag" size={16} />}
        className="task-label-picker"
      >
        {(close, anchor) => (
          <>
            <input
              className="task-label-picker__search"
              type="search"
              aria-label="search labels"
              placeholder="find a label"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
            />
            <div className="task-label-picker__choices" role="group" aria-label="available labels">
              {matching.map((label) => {
                const checked = selected.includes(label.id);
                const deletingLabel = deleting?.has(label.id);
                return (
                  <button
                    key={label.id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={label.name}
                    disabled={disabled || (!checked && (selected.length >= 20 || deletingLabel))}
                    onClick={() => onToggle(label.id)}
                  >
                    <span
                      className="task-label-picker__dot"
                      style={{ backgroundColor: label.color }}
                    />
                    <span>{label.name}</span>
                    {deletingLabel && <small>deleting</small>}
                    {checked && <Icon name="check" size={14} />}
                  </button>
                );
              })}
              {!matching.length && !page?.nextCursor && page?.status !== 'loading' && (
                <p>{labels.length ? 'no matching labels.' : 'no labels yet.'}</p>
              )}
            </div>
            {page?.status === 'loading' && (
              <p className="task-label-picker__limit" role="status">
                loading labels…
              </p>
            )}
            {page?.error && (
              <p className="task-label-picker__limit" role="alert">
                {page.error}{' '}
                <button type="button" onClick={() => void page.reload()}>
                  retry
                </button>
              </p>
            )}
            {page?.nextCursor && (
              <button
                type="button"
                className="task-label-picker__manage"
                disabled={page.status === 'loading'}
                onClick={() => void page.loadMore()}
              >
                more labels
              </button>
            )}
            {selected.length >= 20 && (
              <p className="task-label-picker__limit">remove a label to add another.</p>
            )}
            {onManage && (
              <button
                type="button"
                className="task-label-picker__manage"
                onClick={() => {
                  close();
                  onManage(anchor, !labels.length);
                }}
              >
                <Icon name={labels.length ? 'sliders' : 'plus'} size={14} />
                {labels.length ? 'edit labels' : 'new label'}
              </button>
            )}
          </>
        )}
      </Popover>
    </Tooltip>
  );
}

export function TaskLabelChips({
  labels,
  selected,
  disabled,
  onToggle,
}: Omit<Props, 'deleting' | 'onManage' | 'page'>) {
  if (!selected.length) return null;
  return (
    <div className="task-label-chips" aria-label="selected labels">
      {selected.map((id) => {
        const label = labels.find((item) => item.id === id);
        return (
          <button
            key={id}
            type="button"
            aria-label={`remove ${label?.name ?? 'unloaded label'}`}
            style={{ '--label-color': label?.color ?? 'var(--green)' } as CSSProperties}
            disabled={disabled}
            onClick={() => onToggle(id)}
          >
            <span className="task-label-picker__dot" />
            <span>{label?.name ?? 'label not loaded'}</span>
            <Icon name="close" size={11} />
          </button>
        );
      })}
    </div>
  );
}
