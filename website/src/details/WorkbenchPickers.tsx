import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { WorkbenchIcon } from './WorkbenchIcon';
import { workbenchLabels, type WorkbenchTask } from './workbench-data';
import './WorkbenchPickers.css';

function WorkbenchPopover({
  label,
  className,
  trigger,
  assigned = false,
  children,
}: {
  label: string;
  className: string;
  trigger: ReactNode;
  assigned?: boolean;
  children(close: () => void): ReactNode;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!open || !anchor || !panel) return;
    let restoreFocus = true;
    const position = () => {
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 12;
      const top = (viewport?.offsetTop ?? 0) + 12;
      const width = Math.max(0, (viewport?.width ?? window.innerWidth) - 24);
      const height = Math.max(0, (viewport?.height ?? window.innerHeight) - 24);
      panel.style.maxWidth = `${width}px`;
      panel.style.maxHeight = `${height}px`;
      const bounds = panel.getBoundingClientRect();
      const anchorBounds = anchor.getBoundingClientRect();
      const below = Math.max(0, top + height - anchorBounds.bottom - 6);
      const above = Math.max(0, anchorBounds.top - top - 6);
      const upwards = bounds.height > below && above > below;
      const maxHeight = Math.min(height, upwards ? above : below);
      const panelHeight = Math.min(bounds.height, maxHeight);
      panel.style.left = `${Math.max(left, Math.min(anchorBounds.left, left + width - bounds.width))}px`;
      panel.style.top = `${Math.max(top, Math.min(upwards ? anchorBounds.top - panelHeight - 6 : anchorBounds.bottom + 6, top + height - panelHeight))}px`;
      panel.style.maxHeight = `${maxHeight}px`;
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.contains(event.target) &&
        !anchor.contains(event.target)
      )
        restoreFocus = false;
    };
    const focusOutside = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !panel.contains(event.target) &&
        !anchor.contains(event.target)
      ) {
        restoreFocus = false;
        panel.hidePopover();
      }
    };
    const toggled = (event: Event) => {
      if ((event as ToggleEvent).newState === 'closed') setOpen(false);
    };
    panel.addEventListener('toggle', toggled);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', focusOutside);
    panel.showPopover();
    position();
    panel.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      panel.removeEventListener('toggle', toggled);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', focusOutside);
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      if (panel.matches(':popover-open')) panel.hidePopover();
      if (
        restoreFocus &&
        anchor.isConnected &&
        (document.activeElement === document.body ||
          document.activeElement === anchor ||
          panel.contains(document.activeElement))
      )
        anchor.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`workbench-tool workbench-pickers__trigger${assigned ? ' workbench-priority--assigned' : ''}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={id}
          popover="auto"
          role="dialog"
          aria-label={label}
          className={`workbench-pickers__panel ${className}`}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </>
  );
}

export function WorkbenchLabelPicker({
  selected,
  onToggle,
}: {
  selected: readonly string[];
  onToggle(id: string): void;
}) {
  const [query, setQuery] = useState('');
  const matching = workbenchLabels.filter((label) =>
    label.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <WorkbenchPopover
      label="labels"
      className="workbench-pickers__labels"
      trigger={<WorkbenchIcon name="tag" />}
    >
      {() => (
        <>
          <input
            className="workbench-pickers__search"
            type="search"
            aria-label="search labels"
            placeholder="find a label"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          <div className="workbench-pickers__choices" role="group" aria-label="available labels">
            {matching.map((label) => {
              const checked = selected.includes(label.id);
              return (
                <button
                  key={label.id}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={label.name}
                  onClick={() => onToggle(label.id)}
                >
                  <span
                    className="workbench-pickers__dot"
                    style={{ backgroundColor: label.color }}
                  />
                  <span>{label.name}</span>
                  {checked && <WorkbenchIcon name="check" />}
                </button>
              );
            })}
            {!matching.length && <p>no matching labels.</p>}
          </div>
        </>
      )}
    </WorkbenchPopover>
  );
}

export function WorkbenchPriorityPicker({
  value,
  onChange,
}: {
  value: WorkbenchTask['priority'];
  onChange(value: WorkbenchTask['priority']): void;
}) {
  return (
    <WorkbenchPopover
      label={value === 'none' ? 'priority' : `${value} priority`}
      className="workbench-pickers__priority"
      trigger={<WorkbenchIcon name="flag" />}
      assigned={value !== 'none'}
    >
      {(close) => (
        <div className="workbench-pickers__menu" role="group" aria-label="task priority">
          {(['none', 'low', 'medium', 'high'] as const).map((priority) => (
            <button
              key={priority}
              type="button"
              aria-pressed={priority === value}
              onClick={() => {
                onChange(priority);
                close();
              }}
            >
              <WorkbenchIcon name="flag" />
              <span>{priority === 'none' ? 'no priority' : priority}</span>
              {priority === value && <WorkbenchIcon name="check" />}
            </button>
          ))}
        </div>
      )}
    </WorkbenchPopover>
  );
}
