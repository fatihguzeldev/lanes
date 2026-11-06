export type DemoTask = {
  id: string;
  title: string;
  list: 'Ideas' | 'In progress' | 'Done';
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
    title: 'Sketch the first version',
    list: 'Ideas',
    completed: false,
    note: 'Keep it to a single page.',
    label: 'Someday',
    day: 0,
    time: '09:00',
  },
  {
    id: 'walk',
    title: 'Take the long way home',
    list: 'Ideas',
    completed: false,
    day: 2,
    time: '17:00',
  },
  {
    id: 'playlist',
    title: 'Make a playlist for late nights',
    list: 'Ideas',
    completed: false,
    day: 4,
    time: '15:00',
  },
  {
    id: 'make-room',
    title: 'Try the board layout',
    list: 'In progress',
    completed: false,
    label: 'Making things',
    starred: true,
    day: 1,
    time: '10:00',
  },
  {
    id: 'website',
    title: 'Build the project website',
    list: 'In progress',
    completed: false,
    note: 'One page to show what it does.',
    label: 'Today',
    day: 3,
    time: '11:00',
  },
  {
    id: 'first-step',
    title: 'Register a domain',
    list: 'Done',
    completed: true,
    day: 0,
    time: '11:00',
  },
  {
    id: 'perfect',
    title: 'Pick a name',
    list: 'Done',
    completed: true,
    day: 2,
    time: '09:00',
  },
];

export function toggleDemoTask(tasks: DemoTask[], id: string): DemoTask[] {
  return tasks.map((task) => (task.id === id ? { ...task, completed: !task.completed } : task));
}
