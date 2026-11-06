import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  demoTasks,
  selectDemoTasks,
  toggleDemoTask,
  toggleDemoTaskStar,
  type DemoScope,
  type DemoTask,
} from './demo-model';
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

function DemoTaskActions({
  task,
  onToggle,
  onToggleStar,
}: {
  task: DemoTask;
  onToggle: (id: string) => void;
  onToggleStar: (id: string) => void;
}) {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => menu.current?.hidePopover();
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.visualViewport?.addEventListener('scroll', close);
    window.visualViewport?.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.visualViewport?.removeEventListener('scroll', close);
      window.visualViewport?.removeEventListener('resize', close);
    };
  }, [open]);
  return (
    <div className="demo-task__actions">
      <button
        className="demo-task__star"
        type="button"
        aria-label={`${task.starred ? 'unstar' : 'star'} ${task.title}`}
        aria-pressed={!!task.starred}
        title={task.starred ? 'remove star' : 'star task'}
        onClick={() => onToggleStar(task.id)}
      >
        <DemoIcon name="star" size={14} />
      </button>
      <button
        ref={trigger}
        className="demo-task__menu"
        type="button"
        popoverTarget={menuId}
        aria-label={`options for ${task.title}`}
        aria-expanded={open}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const viewport = window.visualViewport;
          const top = viewport?.offsetTop ?? 0;
          const left = viewport?.offsetLeft ?? 0;
          setPosition({
            top: Math.max(
              top + 8,
              Math.min(rect.bottom + 4, top + (viewport?.height ?? window.innerHeight) - 60),
            ),
            left: Math.max(
              left + 8,
              Math.min(rect.right - 170, left + (viewport?.width ?? window.innerWidth) - 178),
            ),
          });
        }}
      >
        <DemoIcon name="more" size={15} />
      </button>
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        className="demo-task-options"
        role="group"
        aria-label={`options for ${task.title}`}
        style={position}
        onToggle={(event) => setOpen(event.currentTarget.matches(':popover-open'))}
      >
        <button
          type="button"
          onClick={() => {
            menu.current?.hidePopover();
            trigger.current?.focus({ preventScroll: true });
            onToggle(task.id);
          }}
        >
          <DemoIcon name="check" size={15} />
          {task.completed ? 'reopen task' : 'complete task'}
        </button>
      </div>
    </div>
  );
}

function DemoTaskItem({
  task,
  onToggle,
  onToggleStar,
  row = false,
}: {
  task: DemoTask;
  onToggle: (id: string) => void;
  onToggleStar: (id: string) => void;
  row?: boolean;
}) {
  return (
    <article
      className={
        'demo-task' + (task.completed ? ' demo-task--done' : '') + (row ? ' demo-task--row' : '')
      }
      role="listitem"
      data-task-id={task.id}
    >
      <div className="demo-task__main">
        <div className="demo-task__top">
          <button
            className="demo-task__check"
            type="button"
            role="checkbox"
            aria-checked={task.completed}
            aria-label={(task.completed ? 'reopen ' : 'complete ') + task.title}
            onClick={() => onToggle(task.id)}
          >
            {task.completed && <DemoIcon name="check" size={11} />}
          </button>
          <span className="demo-task__title">{task.title}</span>
          <DemoTaskActions task={task} onToggle={onToggle} onToggleStar={onToggleStar} />
        </div>
        {task.note && <p className="demo-task__note">{task.note}</p>}
        {!task.completed && (task.day !== null || task.label) && (
          <div className="demo-task__meta">
            {task.day !== null && (
              <span
                className={'demo-task__date' + (task.day < 3 ? ' demo-task__date--overdue' : '')}
              >
                <DemoIcon name={task.day === 3 ? 'sun' : 'calendar'} size={12} />
                {
                  [
                    'mon, nov 9',
                    'tue, nov 10',
                    'wed, nov 11',
                    'today',
                    'tomorrow',
                    'sat, nov 14',
                    'sun, nov 15',
                  ][task.day]
                }
                {task.time && ' · ' + task.time}
                {task.day < 3 && <span className="visually-hidden">overdue</span>}
              </span>
            )}
            {task.label && (
              <span className="demo-task__tag">
                <i aria-hidden="true" />
                {task.label}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function DemoColumn({
  list,
  tasks,
  onToggle,
  onToggleStar,
  row,
}: {
  list: DemoTask['list'];
  tasks: DemoTask[];
  onToggle: (id: string) => void;
  onToggleStar: (id: string) => void;
  row: boolean;
}) {
  const [expanded, setExpanded] = useState(list === 'done');
  const column = useRef<HTMLElement>(null);
  const pendingFocus = useRef<{ control: HTMLButtonElement; taskId: string; index: number } | null>(
    null,
  );
  const completedId = useId();
  const open = tasks.filter((task) => !task.completed);
  const completed = tasks.filter((task) => task.completed);
  const visibleControls = () =>
    Array.from(
      column.current?.querySelectorAll<HTMLButtonElement>('.demo-task__check') ?? [],
    ).filter((button) => button.getClientRects().length > 0);
  const updateTask = (id: string, update: (id: string) => void) => {
    const controls = visibleControls();
    const active = column.current?.ownerDocument.activeElement;
    const control = active instanceof HTMLButtonElement ? active : null;
    if (control?.closest<HTMLElement>('[data-task-id]')?.dataset.taskId === id) {
      pendingFocus.current = {
        control,
        taskId: id,
        index: controls.findIndex(
          (button) => button.closest<HTMLElement>('[data-task-id]')?.dataset.taskId === id,
        ),
      };
    }
    update(id);
  };
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    pendingFocus.current = null;
    if (!request || request.control.isConnected) return;
    const controls = visibleControls();
    const sameTask = controls.find(
      (button) => button.closest<HTMLElement>('[data-task-id]')?.dataset.taskId === request.taskId,
    );
    const target =
      sameTask ??
      controls[request.index] ??
      controls.at(-1) ??
      column.current?.querySelector<HTMLButtonElement>('.demo-completed__toggle') ??
      column.current;
    target?.focus({ preventScroll: true });
  }, [tasks]);
  return (
    <section ref={column} className="demo-column" aria-label={list + ' task list'} tabIndex={-1}>
      <header className="demo-column__header">
        <span className="demo-column__symbol">
          <DemoIcon name="list" size={18} />
        </span>
        <h3>{list}</h3>
        <span className="demo-column__count">{open.length}</span>
      </header>
      <div role="list" aria-label={'open tasks in ' + list}>
        {open.map((task) => (
          <DemoTaskItem
            task={task}
            key={task.id}
            onToggle={(id) => updateTask(id, onToggle)}
            onToggleStar={(id) => updateTask(id, onToggleStar)}
            row={row}
          />
        ))}
      </div>
      {open.length === 0 && completed.length === 0 && (
        <p className="demo-column__empty">no matching tasks.</p>
      )}
      {completed.length > 0 && (
        <div className="demo-completed">
          <button
            type="button"
            className="demo-completed__toggle"
            aria-expanded={expanded}
            aria-controls={completedId}
            onClick={() => setExpanded((value) => !value)}
          >
            <DemoIcon name={expanded ? 'down' : 'right'} size={12} />
            completed<span>{completed.length}</span>
          </button>
          <div
            id={completedId}
            hidden={!expanded}
            role="list"
            aria-label={'completed tasks in ' + list}
          >
            {completed.map((task) => (
              <DemoTaskItem
                key={task.id}
                task={task}
                onToggle={(id) => updateTask(id, onToggle)}
                onToggleStar={(id) => updateTask(id, onToggleStar)}
                row={row}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function DemoBoard({
  tasks,
  onToggle,
  onToggleStar,
  view,
}: {
  tasks: DemoTask[];
  onToggle: (id: string) => void;
  onToggleStar: (id: string) => void;
  view: 'board' | 'list';
}) {
  return (
    <div
      className={'demo-board' + (view === 'list' ? ' demo-board--list' : '')}
      role="region"
      aria-label={view === 'list' ? 'task lists' : 'task board'}
      tabIndex={0}
    >
      {(['ideas', 'in progress', 'done'] as const).map((list) => (
        <DemoColumn
          key={list}
          list={list}
          tasks={tasks.filter((task) => task.list === list)}
          onToggle={onToggle}
          onToggleStar={onToggleStar}
          row={view === 'list'}
        />
      ))}
    </div>
  );
}

function DemoCalendar({ tasks }: { tasks: DemoTask[] }) {
  return (
    <div className="demo-calendar">
      <p className="demo-calendar__period">nov 9 – nov 15, 2026</p>
      <div className="demo-calendar__scroll" role="region" tabIndex={0} aria-label="week calendar">
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
                <td className={day === 3 ? 'demo-calendar__today' : ''} key={day}>
                  <span className="demo-calendar__number">{day + 9}</span>
                  {tasks
                    .filter((task) => task.day === day && !task.completed)
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
  const [tasks, setTasks] = useState(demoTasks);
  const [scope, setScope] = useState<DemoScope>('all');
  const [query, setQuery] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  );
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
  const toggle = (id: string) => setTasks((current) => toggleDemoTask(current, id));
  const toggleStar = (id: string) => setTasks((current) => toggleDemoTaskStar(current, id));
  const closeNavigation = () => {
    pendingNavigationFocus.current = compact && navigationOpen;
    setNavigationOpen(false);
  };
  const selectScope = (next: DemoScope) => {
    setScope(next);
    closeNavigation();
  };
  const closeSearch = () => {
    pendingSearchFocus.current = 'trigger';
    setSearchOpen(false);
    setQuery('');
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
      navigationTrigger.current?.focus({ preventScroll: true });
    } else if (document.activeElement === navigationClose.current)
      navigation.current
        ?.querySelector<HTMLButtonElement>('nav button')
        ?.focus({ preventScroll: true });
  }, [compact, navigationOpen]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)');
    const resize = () => {
      setCompact(media.matches);
      if (media.matches && document.activeElement === searchInput.current) setSearchOpen(true);
      if (!media.matches && document.activeElement === searchTrigger.current)
        searchInput.current?.focus({ preventScroll: true });
    };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);

  return (
    <div className="workspace-showcase">
      <div className="demo-view-controls" role="group" aria-label="preview layout">
        {(['board', 'list', 'calendar'] as const).map((layout) => (
          <button
            type="button"
            key={layout}
            aria-pressed={view === layout}
            onClick={() => setView(layout)}
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
              <span>a little side project</span>
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
              <h2>{scope === 'all' ? 'a little side project' : scope}</h2>
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
                  onChange={(event) => setQuery(event.target.value)}
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
          </header>
          <div className="demo-content" data-view={view}>
            {view === 'calendar' ? (
              <DemoCalendar tasks={visible} />
            ) : (
              <DemoBoard tasks={visible} onToggle={toggle} onToggleStar={toggleStar} view={view} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
