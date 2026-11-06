import { useState } from 'react';
import { TaskCard } from './TaskCard';
import { WorkbenchIcon } from './WorkbenchIcon';
import { usePreviewTaskEditor } from './usePreviewTaskEditor';
import { workbenchTasks, type WorkbenchTask } from './workbench-data';
import './TaskDetails.css';

export function TaskDetails() {
  const [tasks, setTasks] = useState<WorkbenchTask[]>([
    { ...workbenchTasks[0]!, id: 'details-website' },
  ]);
  const [completedOpen, setCompletedOpen] = useState(true);
  const editor = usePreviewTaskEditor(tasks, (id, patch) =>
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, ...patch } : task))),
  );
  const task = tasks[0]!;
  const card = <TaskCard task={task} tasks={tasks} editor={editor} initialExpanded />;

  return (
    <section className="task-story container" aria-labelledby="task-story-title">
      <h2 id="task-story-title">a task is rarely just a title.</h2>
      <div className="task-story__frame product-preview">
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
              onClick={() => editor.navigate(() => setCompletedOpen(!completedOpen))}
            >
              <WorkbenchIcon name={completedOpen ? 'down' : 'right'} size={12} />
              completed<span>1</span>
            </button>
            {completedOpen && (
              <div role="list" aria-label="completed task details">
                {card}
              </div>
            )}
          </div>
        )}
      </div>
      {editor.dialogs}
    </section>
  );
}
