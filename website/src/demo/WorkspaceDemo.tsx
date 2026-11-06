import { useId, useLayoutEffect, useRef, useState } from 'react';
import {
  demoAccounts,
  demoToday,
  demoWeek,
  demoWorkspaces,
  selectDemoTasks,
  updateDemoTask,
  type DemoAccountId,
  type DemoScope,
  type DemoTask,
} from './demo-model';
import { DemoAccountMenu } from './DemoAccountMenu';
import { TaskCard } from '../details/TaskCard';
import { usePreviewTaskEditor, type PreviewTaskEditor } from '../details/usePreviewTaskEditor';
import './WorkspaceDemo.css';

type View = 'board' | 'list' | 'calendar';
const icons = {
  board: 'M4 5h6v14H4ZM14 5h6v9h-6Z',
  list: 'M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01',
  calendar: 'M4 6h16v14H4ZM8 3v6M16 3v6M4 11h16',
  star: 'm12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9Z',
  check: 'm5 12 4 4L19 6',
  sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  search: 'M16 16l5 5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  down: 'm7 10 5 5 5-5',
  left: 'm15 6-6 6 6 6',
  right: 'm9 6 6 6-6 6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  close: 'm6 6 12 12M18 6 6 18',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
};

function DemoIcon({ name, size = 16 }: { name: keyof typeof icons; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3.2 : name === 'board' || name === 'list' ? 2 : 1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={icons[name]} />
    </svg>
  );
}

function DemoColumn({
  list,
  tasks,
  allTasks,
  editor,
  focalId,
}: {
  list: string;
  tasks: DemoTask[];
  allTasks: DemoTask[];
  editor: PreviewTaskEditor;
  focalId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const column = useRef<HTMLElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const completedId = useId();
  const open = tasks.filter((task) => !task.completed);
  const completed = tasks.filter((task) => task.completed);
  const showingCompleted = expanded || completed.some((task) => task.id === editor.editingId);
  useLayoutEffect(() => {
    if (completed.some((task) => task.id === editor.editingId)) setExpanded(true);
    const previous = focused.current;
    if (
      !previous ||
      (previous.isConnected && previous.getClientRects().length) ||
      document.activeElement !== document.body
    )
      return;
    const taskId = previous.closest<HTMLElement>('[data-task-id]')?.dataset.taskId;
    const sameTask =
      taskId &&
      column.current?.querySelector<HTMLElement>(
        `[data-task-id="${CSS.escape(taskId)}"] .workbench-check`,
      );
    const target =
      sameTask ||
      column.current?.querySelector<HTMLElement>('.demo-completed__toggle') ||
      column.current;
    target?.focus({ preventScroll: true });
    focused.current = null;
  }, [tasks, editor.editingId]);
  const card = (task: DemoTask) => (
    <TaskCard
      key={task.id}
      task={task}
      tasks={allTasks}
      editor={editor}
      initialExpanded={task.id === focalId}
    />
  );
  return (
    <section
      ref={column}
      className="demo-column"
      aria-label={list + ' task list'}
      tabIndex={-1}
      onFocusCapture={(event) => {
        focused.current = event.target as HTMLElement;
      }}
    >
      <header className="demo-column__header">
        <span className="demo-column__symbol">
          <DemoIcon name="list" size={18} />
        </span>
        <h3>{list}</h3>
        <span className="demo-column__count">{open.length}</span>
      </header>
      <div role="list" aria-label={'open tasks in ' + list}>
        {open.map(card)}
      </div>
      {completed.length > 0 && (
        <div className="demo-completed">
          <button
            type="button"
            className="demo-completed__toggle"
            aria-expanded={showingCompleted}
            aria-controls={completedId}
            onClick={() => {
              if (showingCompleted && completed.some((task) => task.id === editor.editingId))
                editor.navigate(() => setExpanded(false));
              else setExpanded(!showingCompleted);
            }}
          >
            <DemoIcon name={showingCompleted ? 'down' : 'right'} size={12} />
            completed<span>{completed.length}</span>
          </button>
          <div
            id={completedId}
            hidden={!showingCompleted}
            role="list"
            aria-label={'completed tasks in ' + list}
          >
            {completed.map(card)}
          </div>
        </div>
      )}
    </section>
  );
}

function DemoBoard({
  tasks,
  allTasks,
  lists,
  editor,
  view,
  focalId,
}: {
  tasks: DemoTask[];
  allTasks: DemoTask[];
  lists: string[];
  editor: PreviewTaskEditor;
  view: 'board' | 'list';
  focalId: string;
}) {
  return (
    <div
      className={'demo-board' + (view === 'list' ? ' demo-board--list' : '')}
      role="region"
      aria-label={view === 'list' ? 'task lists' : 'task board'}
      tabIndex={0}
    >
      {tasks.length === 0 ? (
        <p className="demo-empty" role="status">
          no tasks found.
        </p>
      ) : (
        lists.map((list) => (
          <DemoColumn
            key={list}
            list={list}
            tasks={tasks.filter((task) => task.list === list)}
            allTasks={allTasks}
            editor={editor}
            focalId={focalId}
          />
        ))
      )}
    </div>
  );
}

function DemoCalendar({ tasks }: { tasks: DemoTask[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const area = scroller.current;
    const today = area?.querySelector<HTMLElement>('.demo-calendar__today');
    if (!area || !today) return;
    const day = today.getBoundingClientRect();
    area.scrollLeft +=
      day.left - area.getBoundingClientRect().left - (area.clientWidth - day.width) / 2;
  }, []);
  return (
    <div className="demo-calendar">
      <p className="demo-calendar__period">nov 9 – nov 15, 2026</p>
      <div
        ref={scroller}
        className="demo-calendar__scroll"
        role="region"
        tabIndex={0}
        aria-label="week calendar"
      >
        <table className="demo-calendar__table">
          <thead>
            <tr>
              {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => (
                <th scope="col" key={day}>
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {Array.from({ length: 7 }, (_, day) => (
                <td className={demoWeek[day] === demoToday ? 'demo-calendar__today' : ''} key={day}>
                  <span className="demo-calendar__number">{day + 9}</span>
                  {tasks
                    .filter((task) => task.day === demoWeek[day] && !task.completed)
                    .map((task) => (
                      <article
                        className="demo-calendar__event"
                        key={task.id}
                        data-task-id={task.id}
                      >
                        <div className="demo-calendar__event-top">
                          <span>{task.title}</span>
                          {task.starred && (
                            <span className="demo-calendar__star" role="img" aria-label="starred">
                              <DemoIcon name="star" size={11} />
                            </span>
                          )}
                        </div>
                        {task.time && (
                          <p className="demo-calendar__time">
                            <DemoIcon name="clock" size={11} />
                            <time>{task.time}</time>
                          </p>
                        )}
                        <p className="demo-calendar__list">{task.list}</p>
                      </article>
                    ))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function WorkspaceDemo() {
  const [view, setView] = useState<View>('board');
  const [accountId, setAccountId] = useState<DemoAccountId>('personal');
  const [workspaces, setWorkspaces] = useState(demoWorkspaces);
  const account = demoAccounts[accountId];
  const tasks = workspaces[accountId];
  const editor = usePreviewTaskEditor(tasks, (id, patch) =>
    setWorkspaces((current) => updateDemoTask(current, accountId, id, patch)),
  );
  const [scope, setScope] = useState<DemoScope>('all');
  const [query, setQuery] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const preview = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(true);
  const measuredCompact = useRef(true);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const navigationClose = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const pendingNavigationFocus = useRef(false);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const pendingSearchFocus = useRef<'input' | 'trigger' | null>(null);
  const navigationId = useId();
  const searchId = useId();
  const searching = searchOpen || Boolean(query);
  const visible = selectDemoTasks(tasks, scope, query);
  const closeNavigation = () => {
    pendingNavigationFocus.current = compact && navigationOpen;
    setNavigationOpen(false);
  };
  const selectScope = (next: DemoScope) => {
    closeNavigation();
    editor.navigate(() => setScope(next));
  };
  const closeSearch = () => {
    editor.navigate(() => {
      pendingSearchFocus.current = 'trigger';
      setSearchOpen(false);
      setQuery('');
    });
  };
  useLayoutEffect(() => {
    const pending = pendingSearchFocus.current;
    pendingSearchFocus.current = null;
    if (!pending) return;
    const target = pending === 'input' || !compact ? searchInput.current : searchTrigger.current;
    target?.focus({ preventScroll: true });
  }, [searchOpen, query, compact]);
  useLayoutEffect(() => {
    if (compact && navigationOpen) navigationClose.current?.focus({ preventScroll: true });
    else if (pendingNavigationFocus.current) {
      pendingNavigationFocus.current = false;
      const target = compact
        ? navigationTrigger.current
        : navigation.current?.querySelector<HTMLButtonElement>('nav button');
      target?.focus({ preventScroll: true });
    } else if (document.activeElement === navigationClose.current)
      navigation.current
        ?.querySelector<HTMLButtonElement>('nav button')
        ?.focus({ preventScroll: true });
  }, [compact, navigationOpen]);
  useLayoutEffect(() => {
    const surface = preview.current;
    if (!surface) return;
    const resize = (width: number) => {
      const next = width <= 768;
      if (next === measuredCompact.current) return;
      measuredCompact.current = next;
      const active = document.activeElement;
      if (next && active === searchInput.current) setSearchOpen(true);
      if (!next && active === searchTrigger.current) pendingSearchFocus.current = 'input';
      if (!next && active === navigationClose.current) pendingNavigationFocus.current = true;
      setCompact(next);
    };
    resize(surface.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) resize(entry.contentRect.width);
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={preview} className="workspace-showcase">
      <div className="demo-view-controls" role="group" aria-label="preview layout">
        {(['board', 'list', 'calendar'] as const).map((layout) => (
          <button
            type="button"
            key={layout}
            aria-pressed={view === layout}
            onClick={() => editor.navigate(() => setView(layout))}
          >
            <DemoIcon name={layout} size={15} />
            {layout}
          </button>
        ))}
      </div>
      <div
        className={
          'workspace-demo product-preview' + (navigationOpen ? ' workspace-demo--nav-open' : '')
        }
        aria-label="interactive lanes workspace"
        data-slot="workspace"
        onKeyDown={(event) => {
          if (navigationOpen && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeNavigation();
          }
        }}
      >
        <button
          className="demo-navigation-backdrop"
          type="button"
          aria-label="close workspace navigation"
          tabIndex={-1}
          hidden={!compact || !navigationOpen}
          onClick={closeNavigation}
        />
        <aside
          ref={navigation}
          className="demo-sidebar"
          id={navigationId}
          aria-label="workspace navigation"
          onKeyDown={(event) => {
            if (!compact || !navigationOpen || event.key !== 'Tab') return;
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
            );
            const target = event.shiftKey ? buttons.at(-1) : buttons[0];
            const boundary = event.shiftKey ? buttons[0] : buttons.at(-1);
            if (document.activeElement === boundary) {
              event.preventDefault();
              target?.focus();
            }
          }}
        >
          <button
            ref={navigationClose}
            type="button"
            className="demo-sidebar__close"
            aria-label="close workspace navigation"
            onClick={closeNavigation}
          >
            <DemoIcon name="close" />
          </button>
          <nav className="demo-shortcuts" aria-label="quick views">
            <button
              type="button"
              aria-pressed={scope === 'today'}
              onClick={() => selectScope('today')}
            >
              <DemoIcon name="sun" />
              today
            </button>
            <button
              type="button"
              aria-pressed={scope === 'starred'}
              onClick={() => selectScope('starred')}
            >
              <DemoIcon name="star" />
              starred
            </button>
          </nav>
          <p className="demo-sidebar__heading">your boards</p>
          <nav className="demo-boards" aria-label="boards">
            <button type="button" aria-pressed={scope === 'all'} onClick={() => selectScope('all')}>
              <span className="demo-boards__symbol">
                <DemoIcon name="board" size={18} />
              </span>
              <span>{account.board}</span>
            </button>
          </nav>
        </aside>
        <div className="demo-workspace" inert={compact && navigationOpen}>
          <header className={'demo-toolbar' + (searching ? ' demo-toolbar--searching' : '')}>
            <div className="demo-toolbar__title">
              <button
                ref={navigationTrigger}
                type="button"
                className="demo-navigation-toggle"
                aria-label="open workspace navigation"
                aria-expanded={navigationOpen}
                aria-controls={navigationId}
                onClick={() => (navigationOpen ? closeNavigation() : setNavigationOpen(true))}
              >
                <DemoIcon name="menu" />
              </button>
              <h2>{scope === 'all' ? account.board : scope}</h2>
            </div>
            <div className="demo-search-controls" id={searchId}>
              <button
                className="demo-search-back"
                type="button"
                aria-label="close preview search"
                onClick={closeSearch}
              >
                <DemoIcon name="left" />
              </button>
              <label className="demo-search">
                <DemoIcon name="search" />
                <input
                  ref={searchInput}
                  type="search"
                  enterKeyHint="search"
                  placeholder="search tasks"
                  aria-label="search preview tasks"
                  value={query}
                  onFocus={() => {
                    if (compact) setSearchOpen(true);
                  }}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    editor.navigate(() => setQuery(value));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      closeSearch();
                    }
                  }}
                />
              </label>
            </div>
            <button
              ref={searchTrigger}
              className="demo-search-launch"
              type="button"
              aria-label="search preview tasks"
              aria-expanded={searching}
              aria-controls={searchId}
              onClick={() => {
                pendingSearchFocus.current = 'input';
                setSearchOpen(true);
              }}
            >
              <DemoIcon name="search" />
            </button>
            <DemoAccountMenu
              account={account}
              accounts={Object.values(demoAccounts)}
              onSelect={(id) => {
                if (id === accountId || (id !== 'personal' && id !== 'work')) return;
                editor.navigate(() => {
                  setAccountId(id);
                  setScope('all');
                  setQuery('');
                  setSearchOpen(false);
                });
              }}
            />
          </header>
          <div className="demo-content" data-view={view}>
            <div key={accountId + view}>
              {view === 'calendar' ? (
                <DemoCalendar tasks={visible} />
              ) : (
                <DemoBoard
                  tasks={visible}
                  allTasks={tasks}
                  lists={account.lists}
                  editor={editor}
                  view={view}
                  focalId={tasks[0]!.id}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      {editor.dialogs}
    </div>
  );
}
