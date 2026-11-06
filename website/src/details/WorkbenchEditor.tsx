import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { WorkbenchIcon } from './WorkbenchIcon';
import { WorkbenchLabelPicker, WorkbenchPriorityPicker } from './WorkbenchPickers';
import {
  canBlockWorkbenchTask,
  workbenchLabels,
  type WorkbenchDraft,
  type WorkbenchTask,
} from './workbench-data';

type Props = {
  task: WorkbenchTask;
  tasks: WorkbenchTask[];
  draft: WorkbenchDraft;
  dirty: boolean;
  focusOnMount: boolean;
  onDraftChange(patch: Partial<WorkbenchDraft>): void;
  onCompletionChange(completed: boolean): void;
  onSubtaskChange(index: number, completed: boolean): void;
  onClose(): void;
  onSave(): void;
};

export function WorkbenchEditor({
  task,
  tasks,
  draft,
  dirty,
  focusOnMount,
  onDraftChange,
  onCompletionChange,
  onSubtaskChange,
  onClose,
  onSave,
}: Props) {
  const title = useRef<HTMLTextAreaElement>(null);
  const notes = useRef<HTMLTextAreaElement>(null);
  const labelsTool = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<'schedule' | 'dependencies' | 'checklist' | null>(
    focusOnMount ? null : 'checklist',
  );
  const [dependencyQuery, setDependencyQuery] = useState('');
  const [clearConfirmed, setClearConfirmed] = useState(false);
  const clearingTime = !!task.day && !!task.time && !draft.day;
  const canSave = dirty && !!draft.title.trim() && (!clearingTime || clearConfirmed);
  const toggleLabel = (id: string) =>
    onDraftChange({
      labels: draft.labels.includes(id)
        ? draft.labels.filter((value) => value !== id)
        : [...draft.labels, id],
    });

  useLayoutEffect(() => {
    if (focusOnMount) {
      title.current?.focus({ preventScroll: true });
      title.current?.select();
    }
  }, [focusOnMount]);
  useLayoutEffect(() => {
    const inputs = [title.current, notes.current].filter(
      (input): input is HTMLTextAreaElement => !!input,
    );
    const widths = new Map<Element, number>();
    const resize = (input: HTMLTextAreaElement) => {
      input.style.height = '0px';
      input.style.height = `${input.scrollHeight}px`;
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width === widths.get(entry.target)) continue;
        widths.set(entry.target, entry.contentRect.width);
        resize(entry.target as HTMLTextAreaElement);
      }
    });
    for (const input of inputs) {
      resize(input);
      widths.set(input, input.getBoundingClientRect().width);
      observer.observe(input);
    }
    return () => observer.disconnect();
  }, [draft.title, draft.notes]);

  return (
    <form
      className="workbench-editor"
      aria-label={`edit ${task.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSave();
      }}
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          (event.target instanceof Element && event.target.closest('[popover]'))
        )
          return;
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <button
        className="workbench-editor__close"
        type="button"
        aria-label="close task"
        onClick={onClose}
      >
        <WorkbenchIcon name="close" />
      </button>
      <button
        className="workbench-check workbench-editor__completion"
        type="button"
        role="checkbox"
        aria-checked={task.completed}
        aria-label={`${task.completed ? 'reopen' : 'complete'} ${task.title}`}
        onClick={() => onCompletionChange(!task.completed)}
      >
        {task.completed && <WorkbenchIcon name="check" />}
      </button>
      <textarea
        ref={title}
        className="workbench-editor__title"
        rows={1}
        aria-label="task title"
        value={draft.title}
        onChange={(event) => onDraftChange({ title: event.target.value })}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (canSave) onSave();
          }
        }}
      />
      <textarea
        ref={notes}
        className="workbench-editor__notes"
        rows={2}
        aria-label="notes"
        value={draft.notes}
        onChange={(event) => onDraftChange({ notes: event.target.value })}
      />
      <div className="workbench-editor__tools" role="group" aria-label="task details">
        <button
          className="workbench-tool"
          type="button"
          aria-label="schedule"
          title="schedule"
          aria-expanded={section === 'schedule'}
          onClick={() => setSection(section === 'schedule' ? null : 'schedule')}
        >
          <WorkbenchIcon name="calendar" />
        </button>
        <div ref={labelsTool} className="workbench-editor__label-tool">
          <WorkbenchLabelPicker selected={draft.labels} onToggle={toggleLabel} />
        </div>
        <WorkbenchPriorityPicker
          value={draft.priority}
          onChange={(priority) => onDraftChange({ priority })}
        />
        <button
          className="workbench-tool"
          type="button"
          aria-label="dependencies"
          title="dependencies"
          aria-expanded={section === 'dependencies'}
          onClick={() => setSection(section === 'dependencies' ? null : 'dependencies')}
        >
          <WorkbenchIcon name="link" />
        </button>
        <button
          className="workbench-tool"
          type="button"
          aria-label="checklist"
          title="checklist"
          aria-expanded={section === 'checklist'}
          onClick={() => setSection(section === 'checklist' ? null : 'checklist')}
        >
          <WorkbenchIcon name="subtasks" />
        </button>
        <button
          className="workbench-tool"
          type="button"
          aria-label={draft.starred ? 'remove star' : 'star task'}
          title={draft.starred ? 'remove star' : 'star task'}
          aria-pressed={draft.starred}
          onClick={() => onDraftChange({ starred: !draft.starred })}
        >
          <WorkbenchIcon name="star" />
        </button>
      </div>
      {draft.labels.length > 0 && (
        <div className="workbench-editor__labels" aria-label="selected labels">
          {draft.labels.map((id) => {
            const label = workbenchLabels.find((item) => item.id === id)!;
            return (
              <button
                type="button"
                className="workbench-label"
                key={id}
                aria-label={`remove ${label.name}`}
                style={{ '--label-color': label.color } as CSSProperties}
                onClick={(event) => {
                  const button = event.currentTarget;
                  if (button.ownerDocument.activeElement === button) {
                    const sibling = button.nextElementSibling ?? button.previousElementSibling;
                    (sibling instanceof HTMLButtonElement
                      ? sibling
                      : labelsTool.current?.querySelector('button')
                    )?.focus({ preventScroll: true });
                  }
                  toggleLabel(id);
                }}
              >
                <span className="workbench-label-dot" />
                <span>{label.name}</span>
                <WorkbenchIcon name="close" />
              </button>
            );
          })}
        </div>
      )}
      {section === 'schedule' && (
        <section className="workbench-editor__section" aria-label="schedule">
          <h3>
            <WorkbenchIcon name="calendar" />
            schedule
          </h3>
          <div className="workbench-schedule">
            <label>
              day
              <input
                type="date"
                value={draft.day}
                onChange={(event) => {
                  onDraftChange({
                    day: event.target.value,
                    ...(!event.target.value ? { time: '' } : {}),
                  });
                  setClearConfirmed(false);
                }}
              />
            </label>
            <label>
              time <span className="workbench-optional">optional</span>
              <input
                type="time"
                value={draft.time}
                disabled={!draft.day}
                onChange={(event) => onDraftChange({ time: event.target.value })}
              />
            </label>
            {draft.time && (
              <label className="workbench-schedule__zone">
                time zone
                <select
                  aria-label="scheduled time zone"
                  value={draft.timeZone}
                  onChange={(event) => onDraftChange({ timeZone: event.target.value })}
                >
                  <option value="Europe/Istanbul">europe/istanbul</option>
                  <option value="Europe/London">europe/london</option>
                  <option value="America/New_York">america/new_york</option>
                  <option value="UTC">utc</option>
                </select>
              </label>
            )}
          </div>
          {clearingTime && (
            <label className="workbench-clear-schedule">
              <input
                type="checkbox"
                checked={clearConfirmed}
                onChange={(event) => setClearConfirmed(event.target.checked)}
              />
              clear the time when removing this day.
            </label>
          )}
        </section>
      )}
      {section === 'dependencies' && (
        <section className="workbench-editor__section" aria-label="dependencies">
          <h3>
            <WorkbenchIcon name="link" />
            blocked by{' '}
            <span>
              {draft.blockedBy.length ? `${draft.blockedBy.length}/50` : 'add a dependency'}
            </span>
          </h3>
          {draft.blockedBy.map((id) => {
            const blocker = tasks.find((item) => item.id === id)!;
            return (
              <div className="workbench-blocker" key={id}>
                <WorkbenchIcon name={blocker.completed ? 'check' : 'link'} />
                <span>
                  {blocker.title}
                  <small>{blocker.completed ? 'completed · no longer blocks' : 'open'}</small>
                </span>
                <button
                  className="workbench-tool"
                  type="button"
                  aria-label={`remove ${blocker.title}`}
                  onClick={() =>
                    onDraftChange({ blockedBy: draft.blockedBy.filter((value) => value !== id) })
                  }
                >
                  <WorkbenchIcon name="close" />
                </button>
              </div>
            );
          })}
          <label className="workbench-dependency-search">
            search this board
            <input
              type="search"
              placeholder="find a task…"
              value={dependencyQuery}
              onChange={(event) => setDependencyQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
            />
          </label>
          <div className="workbench-dependencies">
            {tasks
              .filter(
                (item) =>
                  item.id !== task.id &&
                  canBlockWorkbenchTask(tasks, task.id, item.id) &&
                  !draft.blockedBy.includes(item.id) &&
                  item.title.toLowerCase().includes(dependencyQuery.toLowerCase()),
              )
              .map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => onDraftChange({ blockedBy: [...draft.blockedBy, item.id] })}
                >
                  <WorkbenchIcon name="plus" />
                  <span>{item.title}</span>
                  <small>this list</small>
                </button>
              ))}
          </div>
        </section>
      )}
      {section === 'checklist' && (
        <section className="workbench-editor__section" aria-label="subtasks">
          <h3>
            <WorkbenchIcon name="subtasks" />
            subtasks<span>{task.subtasks.length}</span>
          </h3>
          <div className="workbench-subtasks">
            {task.subtasks.map((subtask, index) => (
              <label className="workbench-subtask" key={subtask.title}>
                <input
                  type="checkbox"
                  checked={subtask.completed}
                  onChange={(event) => onSubtaskChange(index, event.target.checked)}
                />
                <span>{subtask.title}</span>
              </label>
            ))}
          </div>
        </section>
      )}
      <footer className="workbench-editor__footer">
        <button type="button" className="workbench-editor__cancel" onClick={onClose}>
          cancel
        </button>
        <button type="submit" className="workbench-editor__save" disabled={!canSave}>
          save
          <WorkbenchIcon name="arrow" />
        </button>
      </footer>
    </form>
  );
}
