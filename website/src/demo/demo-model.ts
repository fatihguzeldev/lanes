import { workbenchLabels, workbenchTasks, type WorkbenchTask } from '../details/workbench-data';

export type DemoTask = WorkbenchTask & { list: string };
export type DemoAccountId = 'personal' | 'work';
export type DemoScope = 'all' | 'today' | 'starred';
export type DemoWorkspace = Record<DemoAccountId, DemoTask[]>;

export const demoToday = '2026-11-12';
export const demoWeek = Array.from(
  { length: 7 },
  (_, day) => `2026-11-${String(day + 9).padStart(2, '0')}`,
);

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

export const demoAccounts = {
  personal: {
    id: 'personal',
    displayName: 'fatih',
    email: 'fatih@personal.example',
    board: 'a little side project',
    lists: ['in progress', 'ideas', 'done'],
  },
  work: {
    id: 'work',
    displayName: 'fatih',
    email: 'fatih@work.example',
    board: 'the next release',
    lists: ['in progress', 'up next', 'done'],
  },
} satisfies Record<
  DemoAccountId,
  {
    id: DemoAccountId;
    displayName: string;
    email: string;
    board: string;
    lists: string[];
  }
>;

export const demoTasks: DemoTask[] = [
  { ...workbenchTasks[0]!, list: 'in progress' },
  task('walkthrough', 'record a short walkthrough', 'in progress', {
    day: '2026-11-13',
    time: '14:00',
    labels: ['launch'],
  }),
  task('small-start', 'sketch the first version', 'ideas', {
    notes: 'keep it to a single page.',
    labels: ['design'],
  }),
  task('playlist', 'make a playlist for late nights', 'ideas'),
  task('first-step', 'register a domain', 'done', { completed: true }),
  task('perfect', 'pick a name', 'done', { completed: true }),
];

export const demoWorkspaces: DemoWorkspace = {
  personal: demoTasks,
  work: [
    task('release', 'ship the next version', 'in progress', {
      notes: 'review the changes, update the changelog, and tag v1.0.',
      day: demoToday,
      time: '16:00',
      labels: ['launch'],
      priority: 'high',
      starred: true,
      subtasks: [
        { title: 'review the pull requests', completed: true },
        { title: 'write the changelog', completed: false },
        { title: 'tag the release', completed: false },
      ],
    }),
    task('feedback', 'read through the feedback', 'in progress', { labels: ['design'] }),
    task('welcome', 'polish the welcome screen', 'up next', { labels: ['design'] }),
    task('docs', 'update the setup guide', 'up next', { labels: ['writing'] }),
    task('checks', 'run the release checks', 'done', { completed: true }),
  ],
};

export function updateDemoTask(
  workspace: DemoWorkspace,
  account: DemoAccountId,
  id: string,
  patch: Partial<WorkbenchTask>,
): DemoWorkspace {
  return {
    ...workspace,
    [account]: workspace[account].map((item) => (item.id === id ? { ...item, ...patch } : item)),
  };
}

export function selectDemoTasks(tasks: DemoTask[], scope: DemoScope, query: string): DemoTask[] {
  const search = query.trim().normalize('NFC').toLocaleLowerCase();
  return tasks.filter((item) => {
    if (scope !== 'all' && item.completed) return false;
    if (scope === 'today' && item.day !== demoToday) return false;
    if (scope === 'starred' && !item.starred) return false;
    const labels = workbenchLabels
      .filter((label) => item.labels.includes(label.id))
      .map((label) => label.name);
    return [item.title, item.notes, item.list, ...labels].some((text) =>
      text.normalize('NFC').toLocaleLowerCase().includes(search),
    );
  });
}
