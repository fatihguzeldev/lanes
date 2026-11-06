import { useLayoutEffect, useRef, useState } from 'react';
import { DemoAccountMenu } from '../demo/DemoAccountMenu';
import {
  demoAccounts,
  updateDemoTask,
  type DemoAccountId,
  type DemoTask,
  type DemoWorkspace,
} from '../demo/demo-model';
import { TaskCard } from '../details/TaskCard';
import { WorkbenchIcon } from '../details/WorkbenchIcon';
import { usePreviewTaskEditor } from '../details/usePreviewTaskEditor';
import './AccountStory.css';

const accounts = {
  personal: {
    ...demoAccounts.personal,
    board: 'life, lately',
    lists: ['weekend plans', 'life admin'],
  },
  work: { ...demoAccounts.work, lists: ['in progress', 'follow up'] },
};

function task(id: string, title: string, list: string, patch: Partial<DemoTask> = {}): DemoTask {
  return {
    id,
    title,
    list,
    notes: '',
    completed: false,
    starred: false,
    labels: [],
    priority: 'none',
    day: '',
    time: '',
    timeZone: 'Europe/Istanbul',
    blockedBy: [],
    subtasks: [],
    ...patch,
  };
}

const initialWorkspaces: DemoWorkspace = {
  personal: [
    task('trail', 'find a trail for saturday', 'weekend plans', { day: '2026-11-14' }),
    task('table', 'book a table for two', 'weekend plans'),
    task('library', 'pick up the library books', 'life admin'),
    task('passport', 'renew the passport', 'life admin'),
  ],
  work: [
    task('welcome', 'polish the welcome screen', 'in progress', { labels: ['design'] }),
    task('launch-notes', 'write the launch notes', 'in progress'),
    task('feedback', 'read through the feedback', 'follow up'),
    task('release-checklist', 'check the release checklist', 'follow up'),
  ],
};

export function AccountStory() {
  const [selected, setSelected] = useState<DemoAccountId>('personal');
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const workspace = useRef<HTMLDivElement>(null);
  const focused = useRef<{
    control: HTMLElement;
    list: string | undefined;
    task: string | undefined;
    account: DemoAccountId;
  } | null>(null);
  const account = accounts[selected];
  const tasks = workspaces[selected];
  const editor = usePreviewTaskEditor(tasks, (id, patch) =>
    setWorkspaces((current) => updateDemoTask(current, selected, id, patch)),
  );
  useLayoutEffect(() => {
    const previous = focused.current;
    if (
      !previous ||
      (previous.control.isConnected && previous.control.getClientRects().length) ||
      document.activeElement !== document.body
    )
      return;
    if (previous.account !== selected || !previous.list) return;
    const column = workspace.current?.querySelector<HTMLElement>(
      `[data-account-list="${CSS.escape(previous.list)}"]`,
    );
    const sameTask = previous.task
      ? column?.querySelector<HTMLButtonElement>(
          `[data-task-id="${CSS.escape(previous.task)}"] .workbench-check`,
        )
      : null;
    const target =
      (sameTask?.getClientRects().length ? sameTask : null) ??
      column?.querySelector<HTMLButtonElement>('.account-story__completed-toggle') ??
      column;
    focused.current = null;
    target?.focus({ preventScroll: true });
  }, [tasks, selected]);
  const card = (item: DemoTask) => (
    <TaskCard key={`${selected}:${item.id}`} task={item} tasks={tasks} editor={editor} />
  );

  return (
    <section className="account-story container" aria-labelledby="accounts-title">
      <header className="account-story__intro">
        <h2 id="accounts-title">each account in its own lane.</h2>
      </header>
      <div
        ref={workspace}
        className="account-story__workspace product-preview"
        onFocusCapture={(event) => {
          const control = event.target as HTMLElement;
          focused.current = {
            control,
            list: control.closest<HTMLElement>('[data-account-list]')?.dataset.accountList,
            task: control.closest<HTMLElement>('[data-task-id]')?.dataset.taskId,
            account: selected,
          };
        }}
      >
        <header className="account-story__toolbar">
          <h3>{account.board}</h3>
          <DemoAccountMenu
            account={account}
            accounts={Object.values(accounts)}
            onSelect={(id) => {
              if (id === selected || (id !== 'personal' && id !== 'work')) return;
              editor.navigate(() => setSelected(id));
            }}
          />
        </header>
        <div className="account-story__lists">
          {account.lists.map((list) => {
            const items = tasks.filter((item) => item.list === list);
            const open = items.filter((item) => !item.completed);
            const completed = items.filter((item) => item.completed);
            const key = `${selected}:${list}`;
            const showingCompleted =
              !!expanded[key] || completed.some((item) => item.id === editor.editingId);
            const completedId = `account-${selected}-${list.replaceAll(' ', '-')}-completed`;
            return (
              <section
                className="account-story__list"
                key={key}
                aria-label={list}
                data-account-list={list}
                data-account-id={selected}
                tabIndex={-1}
              >
                <header className="account-story__list-heading">
                  <span className="account-story__list-symbol">
                    <WorkbenchIcon name="list" size={18} />
                  </span>
                  <h4>{list}</h4>
                  <span>{open.length}</span>
                </header>
                <div role="list" aria-label={`open tasks in ${list}`}>
                  {open.map(card)}
                </div>
                {completed.length > 0 && (
                  <div className="account-story__completed">
                    <button
                      type="button"
                      className="account-story__completed-toggle"
                      aria-expanded={showingCompleted}
                      aria-controls={completedId}
                      onClick={() => {
                        const toggle = () =>
                          setExpanded((current) => ({ ...current, [key]: !showingCompleted }));
                        if (completed.some((item) => item.id === editor.editingId))
                          editor.navigate(toggle);
                        else toggle();
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        width="12"
                        height="12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.65"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d={showingCompleted ? 'm7 10 5 5 5-5' : 'm9 6 6 6-6 6'} />
                      </svg>
                      completed<span>{completed.length}</span>
                    </button>
                    <div
                      id={completedId}
                      hidden={!showingCompleted}
                      role="list"
                      aria-label={`completed tasks in ${list}`}
                    >
                      {completed.map(card)}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
      {editor.dialogs}
    </section>
  );
}
