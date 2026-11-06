import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { WorkbenchEditor } from './WorkbenchEditor';
import { WorkbenchIcon } from './WorkbenchIcon';
import {
  workbenchDraft,
  setWorkbenchCompletion,
  setWorkbenchSubtaskCompletion,
  workbenchLabels,
  workbenchTasks,
  type WorkbenchDraft,
  type WorkbenchTask,
} from './workbench-data';
import './TaskDetails.css';

export function TaskDetails() {
  const [tasks, setTasks] = useState(workbenchTasks);
  const [selected, setSelected] = useState<string | null>('website');
  const [draft, setDraft] = useState(() => workbenchDraft(workbenchTasks[0]!));
  const [pendingSelection, setPendingSelection] = useState<string | null>();
  const [focusEditor, setFocusEditor] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [pendingCompletion, setPendingCompletion] = useState<WorkbenchTask | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const completionConfirm = useRef<HTMLDialogElement>(null);
  const titles = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string | null>(null);
  const pendingRestoreFocus = useRef(true);
  const task = tasks.find((item) => item.id === selected);
  const dirty = !!task && JSON.stringify(draft) !== JSON.stringify(workbenchDraft(task));
  const orderedTasks = [
    ...tasks.filter((item) => !item.completed),
    ...tasks.filter((item) => item.completed),
  ];
  const changeTask = (id: string, patch: Partial<WorkbenchTask>) =>
    setTasks((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  function completeTask(item: WorkbenchTask, completed: boolean) {
    if (
      completed &&
      (item.subtasks.some((child) => !child.completed) ||
        item.blockedBy.some((id) => !tasks.find((candidate) => candidate.id === id)?.completed))
    ) {
      setPendingCompletion(item);
      return;
    }
    setTasks((current) =>
      current.map((value) =>
        value.id === item.id ? setWorkbenchCompletion(value, completed) : value,
      ),
    );
  }
  function completeSubtask(id: string, index: number, completed: boolean) {
    setTasks((current) =>
      current.map((value) =>
        value.id === id ? setWorkbenchSubtaskCompletion(value, index, completed) : value,
      ),
    );
  }

  function selectTask(id: string | null, restoreFocus = true) {
    returnFocus.current = selected && restoreFocus ? selected : null;
    const next = tasks.find((item) => item.id === id);
    if (next) setDraft(workbenchDraft(next));
    setFocusEditor(true);
    setSelected(id);
  }
  function requestSelection(id: string | null, restoreFocus = true) {
    if (id === selected) return;
    if (dirty) {
      pendingRestoreFocus.current = restoreFocus;
      setPendingSelection(id);
    } else selectTask(id, restoreFocus);
  }

  useLayoutEffect(() => {
    if (selected || !returnFocus.current) return;
    titles.current.get(returnFocus.current)?.focus({ preventScroll: true });
    returnFocus.current = null;
  }, [selected]);

  useEffect(() => {
    if (pendingSelection !== undefined) confirm.current?.showModal();
    else confirm.current?.close();
  }, [pendingSelection]);

  useEffect(() => {
    if (pendingCompletion) completionConfirm.current?.showModal();
    else completionConfirm.current?.close();
  }, [pendingCompletion]);

  useEffect(() => {
    if (!task) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        event.button !== 0 ||
        !(target instanceof Element) ||
        editor.current?.contains(target) ||
        target.closest('[popover]:popover-open, dialog[open], .details-task__title')
      )
        return;
      requestSelection(null, false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  });

  return (
    <section className="details-section container" aria-labelledby="details-title">
      <header className="details-intro">
        <h2 id="details-title">a task is rarely just a title.</h2>
      </header>
      <div className="details-workbench product-preview">
        <div className="details-task-list" aria-label="in progress tasks">
          <header className="details-list-heading">
            <WorkbenchIcon name="list" />
            <h3>in progress</h3>
            <span>{tasks.filter((item) => !item.completed).length}</span>
          </header>
          {orderedTasks.map((item, index) => (
            <Fragment key={item.id}>
              {item.completed && (index === 0 || !orderedTasks[index - 1]?.completed) && (
                <h4 className="details-completed-heading">
                  completed <span>{tasks.filter((value) => value.completed).length}</span>
                </h4>
              )}
              <article className="details-task" key={item.id}>
                {item.id === selected ? (
                  <div ref={editor}>
                    <WorkbenchEditor
                      key={item.id}
                      task={item}
                      tasks={tasks}
                      draft={draft}
                      onDraftChange={(patch: Partial<WorkbenchDraft>) =>
                        setDraft((current) => ({ ...current, ...patch }))
                      }
                      dirty={dirty}
                      focusOnMount={focusEditor}
                      onCompletionChange={(completed) => completeTask(item, completed)}
                      onSubtaskChange={(index, completed) =>
                        completeSubtask(item.id, index, completed)
                      }
                      onClose={() => requestSelection(null)}
                      onSave={() => {
                        changeTask(item.id, { ...draft, title: draft.title.trim() });
                        selectTask(null);
                      }}
                    />
                  </div>
                ) : (
                  <>
                    <div className="details-task__main">
                      <div className="details-task__top">
                        <button
                          className="workbench-check"
                          type="button"
                          role="checkbox"
                          aria-checked={item.completed}
                          aria-label={`${item.completed ? 'reopen' : 'complete'} ${item.title}`}
                          onClick={() => completeTask(item, !item.completed)}
                        >
                          {item.completed && <WorkbenchIcon name="check" />}
                        </button>
                        <button
                          ref={(element) => {
                            if (element) titles.current.set(item.id, element);
                            else titles.current.delete(item.id);
                          }}
                          className={`details-task__title${item.completed ? ' is-completed' : ''}`}
                          type="button"
                          onClick={() => requestSelection(item.id)}
                        >
                          {item.title}
                        </button>
                        {item.priority !== 'none' && (
                          <span
                            className={`details-task__priority details-task__priority--${item.priority}`}
                          >
                            <span aria-hidden="true">
                              {item.priority === 'high'
                                ? '!!'
                                : item.priority === 'medium'
                                  ? '!'
                                  : '↓'}
                            </span>
                            <span className="visually-hidden">{item.priority} priority</span>
                          </span>
                        )}
                        <button
                          type="button"
                          className="details-task__star"
                          aria-label={`${item.starred ? 'unstar' : 'star'} ${item.title}`}
                          aria-pressed={item.starred}
                          onClick={() => changeTask(item.id, { starred: !item.starred })}
                        >
                          <WorkbenchIcon name="star" />
                        </button>
                      </div>
                      <p className="details-task__notes">{item.notes}</p>
                      <div className="details-task__meta">
                        {item.day && (
                          <span>
                            <WorkbenchIcon name="calendar" />
                            {new Intl.DateTimeFormat('en', {
                              month: 'short',
                              day: 'numeric',
                              timeZone: 'UTC',
                            })
                              .format(new Date(`${item.day}T12:00:00Z`))
                              .toLowerCase()}
                            {item.time && ` · ${item.time}`}
                          </span>
                        )}
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
                        <button
                          className="details-task__subtasks-toggle"
                          type="button"
                          aria-label={`subtasks of ${item.title}`}
                          aria-expanded={expanded.includes(item.id)}
                          onClick={() =>
                            setExpanded((current) =>
                              current.includes(item.id)
                                ? current.filter((id) => id !== item.id)
                                : [...current, item.id],
                            )
                          }
                        >
                          <WorkbenchIcon name="subtasks" />
                          {item.subtasks.filter((child) => child.completed).length}/
                          {item.subtasks.length}
                        </button>
                      </div>
                    </div>
                    {expanded.includes(item.id) && (
                      <div className="details-task__children">
                        {item.subtasks.map((child, index) => (
                          <label className="workbench-subtask" key={child.title}>
                            <input
                              type="checkbox"
                              checked={child.completed}
                              onChange={(event) =>
                                completeSubtask(item.id, index, event.target.checked)
                              }
                            />
                            <span>{child.title}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </article>
            </Fragment>
          ))}
        </div>
      </div>
      <dialog
        ref={confirm}
        className="workbench-confirm"
        aria-labelledby="workbench-confirm-title"
        onCancel={(event) => {
          event.preventDefault();
          setPendingSelection(undefined);
        }}
      >
        <h2 id="workbench-confirm-title">leave this draft?</h2>
        <p>your unsaved changes will be discarded.</p>
        <div>
          <button type="button" onClick={() => setPendingSelection(undefined)}>
            keep editing
          </button>
          <button
            type="button"
            onClick={() => {
              const next = pendingSelection ?? null;
              confirm.current?.close();
              setPendingSelection(undefined);
              selectTask(next, pendingRestoreFocus.current);
            }}
          >
            discard draft
          </button>
        </div>
      </dialog>
      <dialog
        ref={completionConfirm}
        className="workbench-confirm"
        aria-labelledby="workbench-completion-title"
        onCancel={(event) => {
          event.preventDefault();
          setPendingCompletion(null);
        }}
      >
        <h2 id="workbench-completion-title">complete this task?</h2>
        {pendingCompletion && (
          <p>
            {pendingCompletion.subtasks.filter((child) => !child.completed).length} open subtasks
            will also be completed.
            {pendingCompletion.blockedBy.some(
              (id) => !tasks.find((item) => item.id === id)?.completed,
            ) && ' this task still has open blockers.'}
          </p>
        )}
        <div>
          <button type="button" onClick={() => setPendingCompletion(null)}>
            cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!pendingCompletion) return;
              const id = pendingCompletion.id;
              completionConfirm.current?.close();
              setPendingCompletion(null);
              setTasks((current) =>
                current.map((item) => (item.id === id ? setWorkbenchCompletion(item, true) : item)),
              );
            }}
          >
            complete task
          </button>
        </div>
      </dialog>
    </section>
  );
}
