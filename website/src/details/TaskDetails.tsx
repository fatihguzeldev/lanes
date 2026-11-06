import { useId, useLayoutEffect, useRef, useState } from 'react';
import { TaskCard } from './TaskCard';
import { WorkbenchIcon } from './WorkbenchIcon';
import { usePreviewTaskEditor } from './usePreviewTaskEditor';
import { workbenchTasks, type WorkbenchTask } from './workbench-data';
import './TaskDetails.css';

export function TaskDetails() {
  const [tasks, setTasks] = useState<WorkbenchTask[]>(() =>
    workbenchTasks.map((task, index) => ({
      ...task,
      id: `details-${task.id}`,
      blockedBy: [],
      ...(index
        ? {
            notes: '',
            labels: [],
            priority: 'none' as const,
            day: '',
            time: '',
            subtasks: [],
            starred: false,
          }
        : {}),
    })),
  );
  const frame = useRef<HTMLDivElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const completedId = useId();
  const [completedOpen, setCompletedOpen] = useState(true);
  const editor = usePreviewTaskEditor(tasks, (id, patch) =>
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, ...patch } : task))),
  );
  const open = tasks.filter((task) => !task.completed);
  const completed = tasks.filter((task) => task.completed);
  const showingCompleted = completedOpen || completed.some((task) => task.id === editor.editingId);
  const card = (task: WorkbenchTask) => (
    <TaskCard
      key={task.id}
      task={task}
      tasks={tasks}
      editor={editor}
      initialExpanded={task.id === tasks[0]!.id}
    />
  );
  useLayoutEffect(() => {
    const previous = focused.current;
    if (
      !previous ||
      (previous.isConnected && previous.getClientRects().length) ||
      document.activeElement !== document.body
    )
      return;
    const taskId = previous.closest<HTMLElement>('[data-task-id]')?.dataset.taskId;
    const sameTask = taskId
      ? frame.current?.querySelector<HTMLElement>(
          `[data-task-id="${CSS.escape(taskId)}"] .workbench-check`,
        )
      : null;
    const target =
      (sameTask?.getClientRects().length ? sameTask : null) ||
      [
        ...(frame.current?.querySelectorAll<HTMLElement>(
          '.workbench-check, .task-story__completed > button',
        ) ?? []),
      ].find((control) => control.getClientRects().length) ||
      frame.current;
    if (target?.getClientRects().length) target.focus({ preventScroll: true });
    focused.current = null;
  }, [tasks, editor.editingId, showingCompleted]);

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
          <span>{open.length}</span>
        </header>
        <div role="list" aria-label="task details">
          {open.map(card)}
        </div>
        {completed.length > 0 && (
          <div className="task-story__completed">
            <button
              type="button"
              aria-expanded={showingCompleted}
              aria-controls={completedId}
              onClick={() => editor.navigate(() => setCompletedOpen(!showingCompleted))}
            >
              <WorkbenchIcon name={showingCompleted ? 'down' : 'right'} size={12} />
              completed<span>{completed.length}</span>
            </button>
            <div
              id={completedId}
              hidden={!showingCompleted}
              role="list"
              aria-label="completed task details"
            >
              {completed.map(card)}
            </div>
          </div>
        )}
      </div>
      {editor.dialogs}
    </section>
  );
}
