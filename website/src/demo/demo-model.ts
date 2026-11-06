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
    title: 'Start with something small',
    list: 'Ideas',
    completed: false,
    note: 'The idea that keeps coming back.',
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
    title: 'Make a playlist for the process',
    list: 'Ideas',
    completed: false,
    day: 4,
    time: '15:00',
  },
  {
    id: 'make-room',
    title: 'Make room for the good ideas',
    list: 'In progress',
    completed: false,
    label: 'Making things',
    starred: true,
    day: 1,
    time: '10:00',
  },
  {
    id: 'website',
    title: 'Give the side project a home',
    list: 'In progress',
    completed: false,
    note: 'A little corner of the internet.',
    label: 'Today',
    day: 3,
    time: '11:00',
  },
  {
    id: 'first-step',
    title: 'Take the first step',
    list: 'Done',
    completed: true,
    day: 0,
    time: '11:00',
  },
  {
    id: 'perfect',
    title: 'Let go of perfect',
    list: 'Done',
    completed: true,
    day: 2,
    time: '09:00',
  },
];

export function toggleDemoTask(tasks: DemoTask[], id: string): DemoTask[] {
  return tasks.map((task) => (task.id === id ? { ...task, completed: !task.completed } : task));
}
