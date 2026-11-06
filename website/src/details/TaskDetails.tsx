import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { WorkbenchEditor } from './WorkbenchEditor';
import { WorkbenchIcon } from './WorkbenchIcon';
import {
  workbenchDraft,
  setWorkbenchCompletion,
  setWorkbenchSubtaskCompletion,
  workbenchLabels,
  workbenchTasks,
  type WorkbenchTask,
} from './workbench-data';
import './TaskDetails.css';

export function TaskDetails() {
  const [tasks, setTasks] = useState(workbenchTasks);
  const task = tasks[0]!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => workbenchDraft(task));
  const [expanded, setExpanded] = useState(true);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmCompletion, setConfirmCompletion] = useState(false);
  const discardDialog = useRef<HTMLDialogElement>(null);
  const completionDialog = useRef<HTMLDialogElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(workbenchDraft(task));
  const openBlockers = tasks.filter((item) => task.blockedBy.includes(item.id) && !item.completed);
  const changeTask = (patch: Partial<WorkbenchTask>) =>
    setTasks((current) =>
      current.map((item) => (item.id === task.id ? { ...item, ...patch } : item)),
    );

  function finishEditing() {
    returnFocus.current = true;
    setExpanded(true);
    setEditing(false);
  }
  function closeEditor() {
    if (dirty) setConfirmDiscard(true);
    else finishEditing();
  }
  function completeTask(completed: boolean) {
    if (completed && (task.subtasks.some((child) => !child.completed) || openBlockers.length)) {
      setConfirmCompletion(true);
      return;
    }
    changeTask(setWorkbenchCompletion(task, completed));
  }
  function completeSubtask(index: number, completed: boolean) {
    changeTask(setWorkbenchSubtaskCompletion(task, index, completed));
  }

  useLayoutEffect(() => {
    if (editing || !returnFocus.current) return;
    titleButton.current?.focus({ preventScroll: true });
    returnFocus.current = false;
  }, [editing]);
  useEffect(() => {
    if (confirmDiscard) discardDialog.current?.showModal();
    else discardDialog.current?.close();
  }, [confirmDiscard]);
  useEffect(() => {
    if (confirmCompletion) completionDialog.current?.showModal();
    else completionDialog.current?.close();
  }, [confirmCompletion]);

  return (
    <section className="details-section" aria-labelledby="details-title">
      <header className="details-intro">
        <h2 id="details-title">a task is rarely just a title.</h2>
      </header>
      <div className="details-workbench product-preview">
        <div className="details-task-list" aria-label="in progress tasks">
          <header className="details-list-heading">
            <span className="details-list-heading__symbol">
              <WorkbenchIcon name="list" size={18} />
            </span>
            <h3>in progress</h3>
          </header>
          {task.completed && <h4 className="details-completed-heading">completed</h4>}
          <article className="details-task">
            {editing ? (
              <WorkbenchEditor
                task={task}
                tasks={tasks}
                draft={draft}
                onDraftChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                dirty={dirty}
                focusOnMount
                onCompletionChange={completeTask}
                onSubtaskChange={completeSubtask}
                onClose={closeEditor}
                onSave={() => {
                  changeTask({ ...draft, title: draft.title.trim() });
                  finishEditing();
                }}
              />
            ) : (
              <>
                <div className="details-task__main">
                  <div className="details-task__top">
                    <button
                      className="workbench-check"
                      type="button"
                      role="checkbox"
                      aria-checked={task.completed}
                      aria-label={`${task.completed ? 'reopen' : 'complete'} ${task.title}`}
                      onClick={() => completeTask(!task.completed)}
                    >
                      {task.completed && <WorkbenchIcon name="check" />}
                    </button>
                    <button
                      ref={titleButton}
                      className={`details-task__title${task.completed ? ' is-completed' : ''}`}
                      type="button"
                      onClick={() => {
                        setDraft(workbenchDraft(task));
                        setEditing(true);
                      }}
                    >
                      {task.title}
                    </button>
                    {task.priority !== 'none' && (
                      <span
                        className={`details-task__priority details-task__priority--${task.priority}`}
                      >
                        <span aria-hidden="true">
                          {task.priority === 'high' ? '!!' : task.priority === 'medium' ? '!' : '↓'}
                        </span>
                        <span className="visually-hidden">{task.priority} priority</span>
                      </span>
                    )}
                    <button
                      type="button"
                      className="details-task__star"
                      aria-label={`${task.starred ? 'unstar' : 'star'} ${task.title}`}
                      aria-pressed={task.starred}
                      onClick={() => changeTask({ starred: !task.starred })}
                    >
                      <WorkbenchIcon name="star" />
                    </button>
                  </div>
                  <p className="details-task__notes">{task.notes}</p>
                  <div className="details-task__meta">
                    {task.day && (
                      <span>
                        <WorkbenchIcon name="calendar" />
                        {new Intl.DateTimeFormat('en', {
                          month: 'short',
                          day: 'numeric',
                          timeZone: 'UTC',
                        })
                          .format(new Date(`${task.day}T12:00:00Z`))
                          .toLowerCase()}
                        {task.time && ` · ${task.time}`}
                      </span>
                    )}
                    {workbenchLabels
                      .filter((label) => task.labels.includes(label.id))
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
                    {openBlockers.length > 0 && (
                      <span
                        className="details-task__blocked"
                        title={openBlockers.map((item) => item.title).join(', ')}
                      >
                        <WorkbenchIcon name="link" />
                        {openBlockers.length} {openBlockers.length === 1 ? 'blocker' : 'blockers'}
                      </span>
                    )}
                    <button
                      className="details-task__subtasks-toggle"
                      type="button"
                      aria-label={`subtasks of ${task.title}`}
                      aria-expanded={expanded}
                      aria-controls="details-checklist"
                      onClick={() => setExpanded((current) => !current)}
                    >
                      <WorkbenchIcon name="subtasks" />
                      {task.subtasks.filter((child) => child.completed).length}/
                      {task.subtasks.length}
                    </button>
                  </div>
                </div>
                <div className="details-task__children" id="details-checklist" hidden={!expanded}>
                  {task.subtasks.map((child, index) => (
                    <label className="workbench-subtask" key={child.title}>
                      <input
                        type="checkbox"
                        checked={child.completed}
                        onChange={(event) => completeSubtask(index, event.target.checked)}
                      />
                      <span>{child.title}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </article>
        </div>
      </div>
      <dialog
        ref={discardDialog}
        className="workbench-confirm"
        aria-labelledby="workbench-confirm-title"
        onCancel={(event) => {
          event.preventDefault();
          setConfirmDiscard(false);
        }}
      >
        <h2 id="workbench-confirm-title">leave this draft?</h2>
        <p>your unsaved changes will be discarded.</p>
        <div>
          <button type="button" onClick={() => setConfirmDiscard(false)}>
            keep editing
          </button>
          <button
            type="button"
            onClick={() => {
              discardDialog.current?.close();
              setConfirmDiscard(false);
              finishEditing();
            }}
          >
            discard draft
          </button>
        </div>
      </dialog>
      <dialog
        ref={completionDialog}
        className="workbench-confirm"
        aria-labelledby="workbench-completion-title"
        onCancel={(event) => {
          event.preventDefault();
          setConfirmCompletion(false);
        }}
      >
        <h2 id="workbench-completion-title">complete this task?</h2>
        <p>
          {task.subtasks.filter((child) => !child.completed).length} open subtasks will also be
          completed.
          {openBlockers.length > 0 && ' this task still has open blockers.'}
        </p>
        <div>
          <button type="button" onClick={() => setConfirmCompletion(false)}>
            cancel
          </button>
          <button
            type="button"
            onClick={() => {
              completionDialog.current?.close();
              setConfirmCompletion(false);
              changeTask(setWorkbenchCompletion(task, true));
            }}
          >
            complete task
          </button>
        </div>
      </dialog>
    </section>
  );
}
