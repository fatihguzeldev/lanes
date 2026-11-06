export type DemoTask = {
  id: string;
  title: string;
  list: 'ideas' | 'in progress' | 'done';
  completed: boolean;
  label?: string;
  note?: string;
  day: number;
  time: string;
  starred?: boolean;
};

export const demoTasks: DemoTask[] = [
  {
    id: 'small-start',
    title: 'sketch the first version',
    list: 'ideas',
    completed: false,
    note: 'keep it to a single page.',
    label: 'someday',
    day: 0,
    time: '09:00',
  },
  {
    id: 'walk',
    title: 'take the long way home',
    list: 'ideas',
    completed: false,
    day: 2,
    time: '17:00',
  },
  {
    id: 'playlist',
    title: 'make a playlist for late nights',
    list: 'ideas',
    completed: false,
    day: 4,
    time: '15:00',
  },
  {
    id: 'make-room',
    title: 'try the board layout',
    list: 'in progress',
    completed: false,
    label: 'making things',
    starred: true,
    day: 1,
    time: '10:00',
  },
  {
    id: 'website',
    title: 'build the project website',
    list: 'in progress',
    completed: false,
    note: 'one page to show what it does.',
    label: 'today',
    day: 3,
    time: '11:00',
  },
  {
    id: 'first-step',
    title: 'register a domain',
    list: 'done',
    completed: true,
    day: 0,
    time: '11:00',
  },
  {
    id: 'perfect',
    title: 'pick a name',
    list: 'done',
    completed: true,
    day: 2,
    time: '09:00',
  },
];

export function toggleDemoTask(tasks: DemoTask[], id: string): DemoTask[] {
  return tasks.map((task) => (task.id === id ? { ...task, completed: !task.completed } : task));
}
