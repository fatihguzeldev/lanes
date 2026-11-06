export type WorkbenchTask = {
  id: string;
  title: string;
  notes: string;
  priority: 'none' | 'low' | 'medium' | 'high';
  labels: string[];
  day: string;
  time: string;
  timeZone: string;
  blockedBy: string[];
  starred: boolean;
  completed: boolean;
  subtasks: { title: string; completed: boolean }[];
};

export type WorkbenchDraft = Omit<WorkbenchTask, 'id' | 'completed' | 'subtasks'>;

export function workbenchDraft({
  id,
  completed,
  subtasks,
  ...draft
}: WorkbenchTask): WorkbenchDraft {
  return draft;
}

export function setWorkbenchCompletion(task: WorkbenchTask, completed: boolean): WorkbenchTask {
  return {
    ...task,
    completed,
    subtasks: completed
      ? task.subtasks.map((child) => ({ ...child, completed: true }))
      : task.subtasks,
  };
}

export function setWorkbenchSubtaskCompletion(
  task: WorkbenchTask,
  index: number,
  completed: boolean,
): WorkbenchTask {
  if (!task.subtasks[index]) return task;
  return {
    ...task,
    completed: completed ? task.completed : false,
    subtasks: task.subtasks.map((child, position) =>
      position === index ? { ...child, completed } : child,
    ),
  };
}

export function canBlockWorkbenchTask(
  tasks: readonly WorkbenchTask[],
  taskId: string,
  blockerId: string,
): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (!byId.has(taskId) || !byId.has(blockerId)) return false;
  const remaining = [blockerId];
  const visited = new Set<string>();
  while (remaining.length) {
    const id = remaining.pop()!;
    if (id === taskId) return false;
    if (visited.has(id)) continue;
    visited.add(id);
    remaining.push(...(byId.get(id)?.blockedBy ?? []));
  }
  return true;
}

export const workbenchLabels = [
  { id: 'design', name: 'design', color: 'var(--color-accent)' },
  { id: 'launch', name: 'launch', color: 'var(--color-rust)' },
  { id: 'writing', name: 'writing', color: 'var(--color-star)' },
];

export const workbenchTasks: WorkbenchTask[] = [
  {
    id: 'website',
    title: 'build the website',
    notes:
      'a small home for the things i’m making.\nkeep the words simple. let the workspace do the talking.',
    priority: 'high',
    labels: ['design', 'launch'],
    day: '2026-11-12',
    time: '10:00',
    timeZone: 'Europe/Istanbul',
    blockedBy: [],
    starred: true,
    completed: false,
    subtasks: [
      { title: 'find the right words', completed: true },
      { title: 'build the workspace demo', completed: false },
      { title: 'add the finishing touches', completed: false },
    ],
  },
  {
    id: 'walkthrough',
    title: 'record a short walkthrough',
    notes: 'one board, a few tasks, and a look at what happens next.\nshow the small details.',
    priority: 'medium',
    labels: ['launch'],
    day: '2026-11-13',
    time: '14:00',
    timeZone: 'Europe/Istanbul',
    blockedBy: [],
    starred: false,
    completed: false,
    subtasks: [
      { title: 'choose a few tasks to show', completed: true },
      { title: 'record the first take', completed: false },
      { title: 'trim the quiet bits', completed: false },
    ],
  },
  {
    id: 'notes',
    title: 'write the launch notes',
    notes: 'what changed, why it matters, and how to make it yours.\nleave a link to the source.',
    priority: 'low',
    labels: ['writing'],
    day: '2026-11-14',
    time: '09:00',
    timeZone: 'Europe/Istanbul',
    blockedBy: [],
    starred: false,
    completed: false,
    subtasks: [
      { title: 'gather the useful changes', completed: false },
      { title: 'write a first draft', completed: false },
      { title: 'read it once more', completed: false },
    ],
  },
];
