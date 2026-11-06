export type WorkbenchTask = {
  id: string;
  title: string;
  notes: string;
  priority: 'none' | 'low' | 'medium' | 'high';
  labels: string[];
  day: string;
  time: string;
  starred: boolean;
  completed: boolean;
  subtasks: { title: string; completed: boolean }[];
};

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
    starred: false,
    completed: false,
    subtasks: [
      { title: 'gather the useful changes', completed: false },
      { title: 'write a first draft', completed: false },
      { title: 'read it once more', completed: false },
    ],
  },
];
