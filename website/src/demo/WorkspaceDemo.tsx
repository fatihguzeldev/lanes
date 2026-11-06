import { useState, type ReactNode } from 'react';
import { demoTasks, toggleDemoTask, type DemoTask } from './demo-model';
import './WorkspaceDemo.css';

type View = 'Board' | 'List' | 'Calendar';
type IconName = 'board' | 'list' | 'calendar' | 'star' | 'check' | 'sun' | 'repeat' | 'reset';

function DemoIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    board: (
      <>
        <rect x="3" y="4" width="5" height="16" rx="1" />
        <rect x="10" y="4" width="5" height="11" rx="1" />
        <rect x="17" y="4" width="4" height="14" rx="1" />
      </>
    ),
    list: (
      <>
        <path d="M9 6h12M9 12h12M9 18h12" />
        <path d="M3 6h1M3 12h1M3 18h1" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2" />
      </>
    ),
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" />,
    check: <path d="m5 12 4 4L19 6" />,
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" />
      </>
    ),
    repeat: (
      <>
        <path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3" />
      </>
    ),
    reset: (
      <>
        <path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function DemoTaskItem({
  task,
  onToggle,
  compact = false,
}: {
  task: DemoTask;
  onToggle: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`demo-task${task.completed ? ' demo-task--done' : ''}${compact ? ' demo-task--compact' : ''}`}
    >
      <label className="demo-task__label">
        <input type="checkbox" checked={task.completed} onChange={() => onToggle(task.id)} />
        <span className="demo-task__check" aria-hidden="true">
          <DemoIcon name="check" />
        </span>
        <span className="demo-task__title">{task.title}</span>
        {task.starred && (
          <span className="demo-task__star" aria-label="Starred">
            <DemoIcon name="star" />
          </span>
        )}
      </label>
      {!compact && task.note && <p className="demo-task__note">{task.note}</p>}
      {!compact && task.label && (
        <span className={`demo-task__tag${task.label === 'Today' ? ' demo-task__tag--today' : ''}`}>
          {task.label === 'Today' && <DemoIcon name="sun" />}
          {task.label}
        </span>
      )}
    </div>
  );
}

function DemoBoard({ tasks, onToggle }: { tasks: DemoTask[]; onToggle: (id: string) => void }) {
  return (
    <div className="demo-board" aria-label="Task board" tabIndex={0}>
      {(['Ideas', 'In progress', 'Done'] as const).map((list) => (
        <section className="demo-column" key={list} aria-label={`${list} task list`}>
          <header className="demo-column__header">
            <h3>{list}</h3>
            <span>{tasks.filter((task) => task.list === list).length}</span>
          </header>
          <div>
            {tasks
              .filter((task) => task.list === list)
              .map((task) => (
                <DemoTaskItem key={task.id} task={task} onToggle={onToggle} />
              ))}
          </div>
          <div className="demo-column__end" aria-hidden="true">
            <span>+</span> A little room for what’s next
          </div>
        </section>
      ))}
    </div>
  );
}

function DemoList({ tasks, onToggle }: { tasks: DemoTask[]; onToggle: (id: string) => void }) {
  return (
    <div className="demo-list" aria-label="Task list">
      <div className="demo-list__header">
        <span>Your tasks, one at a time</span>
        <span>List</span>
      </div>
      {tasks.map((task) => (
        <div className="demo-list__row" key={task.id}>
          <DemoTaskItem task={task} onToggle={onToggle} compact />
          <span className="demo-list__source">{task.list}</span>
        </div>
      ))}
    </div>
  );
}

function DemoCalendar({ tasks, onToggle }: { tasks: DemoTask[]; onToggle: (id: string) => void }) {
  return (
    <div
      className="demo-calendar"
      tabIndex={0}
      aria-label="Sample calendar for November 9 to 13, 2026"
    >
      <div className="demo-calendar__title">
        <span>November 2026</span>
        <span>A week with room to breathe</span>
      </div>
      <div className="demo-calendar__week">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((day, index) => (
          <div className="demo-calendar__day" key={day}>
            <div className="demo-calendar__date">
              <span>{day}</span>
              <strong>{index + 9}</strong>
            </div>
            <div className="demo-calendar__events">
              {tasks
                .filter((task) => task.day === index)
                .map((task) => (
                  <div key={task.id} className="demo-calendar__event">
                    <time>{task.time}</time>
                    <DemoTaskItem task={task} onToggle={onToggle} compact />
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WorkspaceDemo() {
  const [view, setView] = useState<View>('Board');
  const [tasks, setTasks] = useState(demoTasks);
  const completed = tasks.filter((task) => task.completed).length;
  const changed = tasks.some((task, index) => task.completed !== demoTasks[index]?.completed);
  const toggle = (id: string) => setTasks((current) => toggleDemoTask(current, id));

  return (
    <div
      className="workspace-demo"
      aria-label="Interactive Lanes sample workspace"
      data-slot="workspace"
    >
      <aside className="demo-sidebar" aria-label="Sample workspace navigation">
        <div className="demo-sidebar__brand">
          <span className="demo-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>lanes</span>
        </div>
        <div className="demo-account">
          <span className="demo-account__avatar" aria-hidden="true">
            <DemoIcon name="sun" />
          </span>
          <span>
            Personal<span className="demo-account__detail">Your everyday things</span>
          </span>
          <span className="demo-account__chevron" aria-hidden="true">
            ⌄
          </span>
        </div>
        <div className="demo-sidebar__shortcuts" aria-hidden="true">
          <span>
            <DemoIcon name="sun" />
            Today
          </span>
          <span>
            <DemoIcon name="star" />
            Starred
          </span>
        </div>
        <p className="demo-sidebar__heading">Your boards</p>
        <div className="demo-sidebar__board demo-sidebar__board--selected">
          <DemoIcon name="board" />
          <span>A little side project</span>
        </div>
        <div className="demo-sidebar__board">
          <DemoIcon name="board" />
          <span>Life, lately</span>
        </div>
        <div className="demo-sidebar__board">
          <DemoIcon name="board" />
          <span>Weekend plans</span>
        </div>
        <div className="demo-sidebar__bottom">
          <DemoIcon name="repeat" />
          <span>Your Google Tasks workspace</span>
        </div>
      </aside>
      <div className="demo-workspace">
        <header className="demo-toolbar">
          <div className="demo-toolbar__project">
            <span className="demo-toolbar__project-icon">
              <DemoIcon name="board" />
            </span>
            <span>A little side project</span>
          </div>
          <div className="demo-view-switch" role="group" aria-label="Preview layout">
            {(['Board', 'List', 'Calendar'] as const).map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={view === name}
                onClick={() => setView(name)}
              >
                <DemoIcon name={name.toLowerCase() as 'board' | 'list' | 'calendar'} />
                <span>{name}</span>
              </button>
            ))}
          </div>
        </header>
        <div className="demo-content" data-view={view}>
          {view === 'Board' && <DemoBoard tasks={tasks} onToggle={toggle} />}
          {view === 'List' && <DemoList tasks={tasks} onToggle={toggle} />}
          {view === 'Calendar' && <DemoCalendar tasks={tasks} onToggle={toggle} />}
        </div>
        <div className="demo-status">
          <span>
            <DemoIcon name="check" />
            <span aria-live="polite">
              {completed} of {tasks.length} little things, done.
            </span>
          </span>
          <button
            type="button"
            className="demo-reset"
            onClick={() => setTasks(demoTasks)}
            disabled={!changed}
          >
            <DemoIcon name="reset" />
            Reset preview
          </button>
        </div>
      </div>
    </div>
  );
}
