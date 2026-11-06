import { useId, useLayoutEffect, useRef, useState } from 'react';
import { TaskCard } from './TaskCard';
import { WorkbenchIcon } from './WorkbenchIcon';
import { usePreviewTaskEditor } from './usePreviewTaskEditor';
import { workbenchTasks, type WorkbenchTask } from './workbench-data';
import './TaskDetails.css';

export function TaskDetails() {
  const [tasks, setTasks] = useState<WorkbenchTask[]>(() =>
    workbenchTasks.map((task) => ({
      ...task,
      id: `details-${task.id}`,
      blockedBy: task.blockedBy.map((id) => `details-${id}`),
    })),
  );
  const frame = useRef<HTMLDivElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const completedId = useId();
  const [completedOpen, setCompletedOpen] = useState(true);
  const editor = usePreviewTaskEditor(tasks, (id, patch) =>
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, ...patch } : task))),
  );
  const task = tasks[0]!;
  const card = <TaskCard task={task} tasks={tasks} editor={editor} initialExpanded />;
  useLayoutEffect(() => {
    const previous = focused.current;
    if (
      !previous ||
      (previous.isConnected && previous.getClientRects().length) ||
      document.activeElement !== document.body
    )
      return;
    const target =
      [
        ...(frame.current?.querySelectorAll<HTMLElement>(
          '.workbench-check, .task-story__completed > button',
        ) ?? []),
      ].find((control) => control.getClientRects().length) || frame.current;
    if (target?.getClientRects().length) target.focus({ preventScroll: true });
    focused.current = null;
  }, [task.completed, editor.editingId, completedOpen]);

  return (
    <section
      className="task-story container"
      aria-labelledby="task-story-title"
      onFocusCapture={(event) => {
        focused.current = event.target as HTMLElement;
      }}
    >
      <h2 id="task-story-title">a task is rarely just a title.</h2>
      <div ref={frame} tabIndex={-1} className="task-story__frame product-preview">
        <header className="task-story__header">
          <WorkbenchIcon name="list" size={18} />
          <h3>in progress</h3>
          <span>{task.completed ? 0 : 1}</span>
        </header>
        {!task.completed ? (
          <div role="list" aria-label="task details">
            {card}
          </div>
        ) : (
          <div className="task-story__completed">
            <button
              type="button"
              aria-expanded={completedOpen}
              aria-controls={completedId}
              onClick={() => editor.navigate(() => setCompletedOpen(!completedOpen))}
            >
              <WorkbenchIcon name={completedOpen ? 'down' : 'right'} size={12} />
              completed<span>1</span>
            </button>
            <div
              id={completedId}
              hidden={!completedOpen}
              role="list"
              aria-label="completed task details"
            >
              {card}
            </div>
          </div>
        )}
      </div>
      {editor.dialogs}
    </section>
  );
}
