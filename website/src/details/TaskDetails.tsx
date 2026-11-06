import { useState } from 'react';
import { TaskCard } from './TaskCard';
import { WorkbenchIcon } from './WorkbenchIcon';
import { usePreviewTaskEditor } from './usePreviewTaskEditor';
import { workbenchTasks } from './workbench-data';
import './TaskDetails.css';

export function TaskDetails() {
  const [tasks, setTasks] = useState(workbenchTasks);
  const task = tasks[0]!;
  const editor = usePreviewTaskEditor(tasks, (id, patch) =>
    setTasks((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item))),
  );

  return (
    <section className="details-section" aria-labelledby="details-title">
      <header className="details-intro">
        <h2 id="details-title">a task is rarely just a title.</h2>
      </header>
      <div className="details-workbench product-preview">
        <div className="details-task-list" role="list" aria-label="in progress tasks">
          <header className="details-list-heading">
            <span className="details-list-heading__symbol">
              <WorkbenchIcon name="list" size={18} />
            </span>
            <h3>in progress</h3>
          </header>
          {task.completed && <h4 className="details-completed-heading">completed</h4>}
          <TaskCard task={task} tasks={tasks} editor={editor} initialExpanded />
        </div>
      </div>
      {editor.dialogs}
    </section>
  );
}
