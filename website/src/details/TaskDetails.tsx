import { useState, type CSSProperties } from 'react';
import { WorkbenchEditor } from './WorkbenchEditor';
import { WorkbenchIcon } from './WorkbenchIcon';
import { workbenchLabels, workbenchTasks, type WorkbenchTask } from './workbench-data';
import './TaskDetails.css';

export function TaskDetails() {
  const [tasks, setTasks] = useState(workbenchTasks);
  const [selected, setSelected] = useState('website');
  const task = tasks.find((item) => item.id === selected) ?? tasks[0]!;
  const changeTask = (id: string, patch: Partial<WorkbenchTask>) =>
    setTasks((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  return (
    <section className="details-section container" aria-labelledby="details-title">
      <header className="details-intro">
        <h2 id="details-title">a task is rarely just a title.</h2>
      </header>
      <div className="details-workbench product-preview">
        <div className="details-task-list" aria-label="side project tasks">
          <div className="details-task-list__context">
            <WorkbenchIcon name="list" />
            side project
          </div>
          <h3>in progress</h3>
          {tasks.map((item) => (
            <article
              className={`details-task${item.id === selected ? ' details-task--selected' : ''}`}
              key={item.id}
            >
              <div className="details-task__top">
                <label className="workbench-check workbench-check--completion">
                  <input
                    type="checkbox"
                    aria-label={`complete ${item.title}`}
                    checked={item.completed}
                    onChange={(event) => changeTask(item.id, { completed: event.target.checked })}
                  />
                  <span aria-hidden="true">
                    <WorkbenchIcon name="check" />
                  </span>
                </label>
                <button
                  className={`details-task__title${item.completed ? ' is-completed' : ''}`}
                  type="button"
                  aria-pressed={item.id === selected}
                  onClick={() => setSelected(item.id)}
                >
                  {item.title}
                </button>
                {item.starred && (
                  <span className="details-task__star" role="img" aria-label="starred">
                    <WorkbenchIcon name="star" />
                  </span>
                )}
                {item.priority !== 'none' && (
                  <span
                    className={`details-task__priority details-task__priority--${item.priority}`}
                    title={`${item.priority} priority`}
                  >
                    <span aria-hidden="true">
                      {item.priority === 'high' ? '!!' : item.priority === 'medium' ? '!' : '↓'}
                    </span>
                    <span className="visually-hidden">{item.priority} priority</span>
                  </span>
                )}
              </div>
              <div className="details-task__meta">
                {workbenchLabels
                  .filter((label) => item.labels.includes(label.id))
                  .map((label) => (
                    <span
                      className="details-task__label"
                      style={{ '--label-color': label.color } as CSSProperties}
                      key={label.id}
                    >
                      <span className="workbench-label-dot" />
                      {label.name}
                    </span>
                  ))}
                <span>
                  <WorkbenchIcon name="subtasks" />
                  {item.subtasks.filter((child) => child.completed).length}/{item.subtasks.length}
                </span>
              </div>
              {selected === item.id && (
                <div className="details-task__children">
                  {item.subtasks.map((child, index) => (
                    <label className="workbench-check" key={child.title}>
                      <input
                        type="checkbox"
                        checked={child.completed}
                        onChange={(event) =>
                          changeTask(item.id, {
                            subtasks: item.subtasks.map((subtask, position) =>
                              position === index
                                ? { ...subtask, completed: event.target.checked }
                                : subtask,
                            ),
                          })
                        }
                      />
                      <span aria-hidden="true">
                        <WorkbenchIcon name="check" />
                      </span>
                      <span>{child.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
        <WorkbenchEditor
          key={task.id}
          task={task}
          onChange={(patch) => changeTask(task.id, patch)}
        />
      </div>
    </section>
  );
}
