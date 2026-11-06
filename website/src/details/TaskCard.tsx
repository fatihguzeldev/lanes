import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { WorkbenchEditor } from './WorkbenchEditor';
import { WorkbenchIcon } from './WorkbenchIcon';
import { workbenchLabels, type WorkbenchTask } from './workbench-data';
import type { PreviewTaskEditor } from './usePreviewTaskEditor';
import './TaskCard.css';

type Props = {
  task: WorkbenchTask;
  tasks: readonly WorkbenchTask[];
  editor: PreviewTaskEditor;
  initialExpanded?: boolean;
  focusOnEdit?: boolean;
  showcaseKey?: string;
};
const date = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function TaskCard({
  task,
  tasks,
  editor,
  initialExpanded = false,
  focusOnEdit = true,
  showcaseKey,
}: Props) {
  const checklistId = useId();
  const [expanded, setExpanded] = useState(initialExpanded);
  const titleButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const editing = editor.editingId === task.id;
  const labels = workbenchLabels.filter((label) => task.labels.includes(label.id));
  const blockers = tasks.filter((item) => task.blockedBy.includes(item.id) && !item.completed);
  const hasMetadata = !!(task.day || labels.length || blockers.length || task.subtasks.length);
  useLayoutEffect(() => {
    if (wasEditing.current && !editing) {
      setExpanded(true);
      if (focusOnEdit && document.activeElement === document.body)
        titleButton.current?.focus({ preventScroll: true });
    }
    wasEditing.current = editing;
  }, [editing, focusOnEdit]);

  return (
    <article className="details-task" role="listitem" data-task-id={task.id}>
      {editing && editor.draft ? (
        <WorkbenchEditor
          task={task}
          tasks={tasks}
          draft={editor.draft}
          onDraftChange={editor.patch}
          dirty={editor.dirty}
          focusOnMount={focusOnEdit}
          onCompletionChange={(completed) => editor.complete(task, completed)}
          onSubtaskChange={(index, completed) => editor.completeSubtask(task, index, completed)}
          onClose={editor.close}
          onSave={editor.save}
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
                onClick={() => editor.complete(task, !task.completed)}
              >
                {task.completed && <WorkbenchIcon name="check" />}
              </button>
              <button
                ref={titleButton}
                className={`details-task__title${task.completed ? ' is-completed' : ''}`}
                type="button"
                onClick={() => editor.open(task)}
              >
                <span data-showcase-key={showcaseKey}>{task.title}</span>
              </button>
              {task.priority !== 'none' && (
                <span className={`details-task__priority details-task__priority--${task.priority}`}>
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
                onClick={() => editor.star(task, !task.starred)}
              >
                <WorkbenchIcon name="star" />
              </button>
            </div>
            {task.notes.trim() && <p className="details-task__notes">{task.notes}</p>}
            {hasMetadata && (
              <div className="details-task__meta">
                {task.day && (
                  <span>
                    <WorkbenchIcon name="calendar" />
                    {date.format(new Date(`${task.day}T12:00:00Z`)).toLowerCase()}
                    {task.time && ` · ${task.time}`}
                  </span>
                )}
                {labels.map((label) => (
                  <span
                    className="details-task__label"
                    style={{ '--label-color': label.color } as CSSProperties}
                    key={label.id}
                  >
                    <span className="workbench-label-dot" />
                    {label.name}
                  </span>
                ))}
                {blockers.length > 0 && (
                  <span
                    className="details-task__blocked"
                    title={blockers.map((item) => item.title).join(', ')}
                  >
                    <WorkbenchIcon name="link" />
                    {blockers.length} {blockers.length === 1 ? 'blocker' : 'blockers'}
                  </span>
                )}
                {task.subtasks.length > 0 && (
                  <button
                    className="details-task__subtasks-toggle"
                    type="button"
                    aria-label={`subtasks of ${task.title}`}
                    aria-expanded={expanded}
                    aria-controls={checklistId}
                    onClick={() => setExpanded((current) => !current)}
                  >
                    <WorkbenchIcon name="subtasks" />
                    {task.subtasks.filter((child) => child.completed).length}/{task.subtasks.length}
                  </button>
                )}
              </div>
            )}
          </div>
          {task.subtasks.length > 0 && (
            <div className="details-task__children" id={checklistId} hidden={!expanded}>
              {task.subtasks.map((child, index) => (
                <label className="workbench-subtask" key={child.title}>
                  <input
                    type="checkbox"
                    checked={child.completed}
                    onChange={(event) => editor.completeSubtask(task, index, event.target.checked)}
                  />
                  <span>{child.title}</span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}
