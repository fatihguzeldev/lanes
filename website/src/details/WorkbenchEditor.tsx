import { useId, useState, type CSSProperties } from 'react';
import { WorkbenchIcon } from './WorkbenchIcon';
import { workbenchLabels, type WorkbenchTask } from './workbench-data';

export function WorkbenchEditor({
  task,
  onChange,
}: {
  task: WorkbenchTask;
  onChange(patch: Partial<WorkbenchTask>): void;
}) {
  const uid = useId();
  const [section, setSection] = useState<'schedule' | 'subtasks' | null>('schedule');
  const [menu, setMenu] = useState<'labels' | 'priority' | null>(null);
  const toggleLabel = (id: string) =>
    onChange({
      labels: task.labels.includes(id)
        ? task.labels.filter((value) => value !== id)
        : [...task.labels, id],
    });

  return (
    <div className="workbench-editor">
      <div className="workbench-editor__context">in progress</div>
      <div className="workbench-editor__heading">
        <label className="workbench-check workbench-check--completion">
          <input
            type="checkbox"
            aria-label={`complete ${task.title}`}
            checked={task.completed}
            onChange={(event) => onChange({ completed: event.target.checked })}
          />
          <span aria-hidden="true">
            <WorkbenchIcon name="check" />
          </span>
        </label>
        <textarea
          className="workbench-editor__title"
          rows={1}
          aria-label="task title"
          value={task.title}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </div>
      <textarea
        className="workbench-editor__notes"
        rows={3}
        aria-label="notes"
        value={task.notes}
        onChange={(event) => onChange({ notes: event.target.value })}
      />
      <div
        className="workbench-editor__toolbox"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setMenu(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !menu) return;
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-picker="${menu}"]`)?.focus();
          setMenu(null);
        }}
      >
        <div className="workbench-editor__tools" role="group" aria-label="task details">
          <button
            type="button"
            aria-label="schedule"
            title="schedule"
            aria-expanded={section === 'schedule'}
            onClick={() => {
              setSection(section === 'schedule' ? null : 'schedule');
              setMenu(null);
            }}
          >
            <WorkbenchIcon name="calendar" />
          </button>
          <button
            type="button"
            aria-label="labels"
            title="labels"
            data-picker="labels"
            aria-expanded={menu === 'labels'}
            onClick={() => setMenu(menu === 'labels' ? null : 'labels')}
          >
            <WorkbenchIcon name="tag" />
          </button>
          <button
            type="button"
            className={task.priority !== 'none' ? 'workbench-priority--assigned' : ''}
            aria-label={`${task.priority} priority`}
            title={`${task.priority} priority`}
            data-picker="priority"
            aria-expanded={menu === 'priority'}
            onClick={() => setMenu(menu === 'priority' ? null : 'priority')}
          >
            <WorkbenchIcon name="flag" />
          </button>
          <button
            type="button"
            aria-label="subtasks"
            title="subtasks"
            aria-expanded={section === 'subtasks'}
            onClick={() => {
              setSection(section === 'subtasks' ? null : 'subtasks');
              setMenu(null);
            }}
          >
            <WorkbenchIcon name="subtasks" />
          </button>
          <button
            type="button"
            aria-label={task.starred ? 'remove star' : 'star task'}
            title={task.starred ? 'remove star' : 'star task'}
            aria-pressed={task.starred}
            onClick={() => onChange({ starred: !task.starred })}
          >
            <WorkbenchIcon name="star" />
          </button>
        </div>
        {menu && (
          <div
            className="workbench-picker"
            role="group"
            aria-label={menu === 'priority' ? 'task priority' : 'available labels'}
          >
            {menu === 'priority'
              ? (['none', 'low', 'medium', 'high'] as const).map((priority) => (
                  <button
                    key={priority}
                    type="button"
                    aria-pressed={task.priority === priority}
                    onClick={() => onChange({ priority })}
                  >
                    <WorkbenchIcon name="flag" />
                    <span>{priority === 'none' ? 'no priority' : priority}</span>
                    {task.priority === priority && <WorkbenchIcon name="check" />}
                  </button>
                ))
              : workbenchLabels.map((label) => (
                  <button
                    key={label.id}
                    type="button"
                    aria-pressed={task.labels.includes(label.id)}
                    onClick={() => toggleLabel(label.id)}
                  >
                    <span
                      className="workbench-label-dot"
                      style={{ '--label-color': label.color } as CSSProperties}
                    />
                    <span>{label.name}</span>
                    {task.labels.includes(label.id) && <WorkbenchIcon name="check" />}
                  </button>
                ))}
          </div>
        )}
      </div>
      <div className="workbench-editor__labels" aria-label="selected labels">
        {workbenchLabels
          .filter((label) => task.labels.includes(label.id))
          .map((label) => (
            <button
              type="button"
              className="workbench-label"
              key={label.id}
              aria-label={`remove ${label.name}`}
              style={{ '--label-color': label.color } as CSSProperties}
              onClick={() => toggleLabel(label.id)}
            >
              <span className="workbench-label-dot" />
              {label.name}
              <WorkbenchIcon name="close" />
            </button>
          ))}
      </div>
      <div className="workbench-editor__section">
        {section === 'schedule' && (
          <section aria-labelledby={`${uid}-schedule`}>
            <h3 id={`${uid}-schedule`}>
              <WorkbenchIcon name="calendar" />
              schedule
            </h3>
            <div className="workbench-schedule">
              <label>
                day
                <input
                  type="date"
                  value={task.day}
                  onChange={(event) => onChange({ day: event.target.value })}
                />
              </label>
              <label>
                time
                <input
                  type="time"
                  value={task.time}
                  onChange={(event) => onChange({ time: event.target.value })}
                />
              </label>
              <p>
                time zone<span>europe / istanbul</span>
              </p>
            </div>
          </section>
        )}
        {section === 'subtasks' && (
          <fieldset className="workbench-subtasks">
            <legend>
              <WorkbenchIcon name="subtasks" />
              subtasks
            </legend>
            {task.subtasks.map((subtask, index) => (
              <label className="workbench-check" key={subtask.title}>
                <input
                  type="checkbox"
                  checked={subtask.completed}
                  onChange={(event) =>
                    onChange({
                      subtasks: task.subtasks.map((item, position) =>
                        position === index ? { ...item, completed: event.target.checked } : item,
                      ),
                    })
                  }
                />
                <span aria-hidden="true">
                  <WorkbenchIcon name="check" />
                </span>
                <span>{subtask.title}</span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
    </div>
  );
}
