import type { SVGProps } from 'react';

const paths = {
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M18 6 6 18',
  check: 'm5 12 4 4L19 6',
  sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  calendar: 'M4 6h16v14H4ZM8 3v6M16 3v6M4 11h16',
  star: 'm12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9Z',
  board: 'M4 5h6v14H4ZM14 5h6v9h-6Z',
  list: 'M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01',
  search: 'M16 16l5 5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  filter: 'M4 6h16M7 12h10M10 18h4',
  sort: 'M8 4v16M4 16l4 4 4-4M15 5h5M15 10h4M15 15h3',
  down: 'm7 10 5 5 5-5',
  right: 'm9 6 6 6-6 6',
  left: 'm15 6-6 6 6 6',
  up: 'm7 14 5-5 5 5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  work: 'M4 7h16v13H4ZM8 7V4h8v3M4 12h16M10 12v2h4v-2',
  pen: 'm5 16-1 4 4-1L20 7l-3-3Zm9-9 3 3',
  book: 'M12 6c-4-3-8-2-9-1v14c3-2 6-2 9 0 3-2 6-2 9 0V5c-3-2-6-1-9 1Zm0 0v13',
  leaf: 'M19 4C9 3 3 7 5 15c5 5 15 1 14-11ZM4 21 15 10',
  history: 'M4 8a9 9 0 1 1-1 7M4 3v5h5M12 7v5l3 2',
  template: 'M8 8h12v12H8ZM16 4H4v12',
  arrow: 'M4 12h16M15 7l5 5-5 5',
  help: 'M9 8a3 3 0 1 1 5 2c-1.5 1-2 1.5-2 3M12 17h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  subtasks: 'M4 5h2v2H4ZM4 11h2v2H4ZM4 17h2v2H4ZM10 6h10M10 12h10M10 18h10',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  sync: 'M19 5v5h-5M5 19v-5h5M19 10a7 7 0 0 0-12-5M5 14a7 7 0 0 0 12 5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  download: 'M12 3v12M7 10l5 5 5-5M4 17v4h16v-4',
  upload: 'M12 16V3M7 8l5-5 5 5M4 17v4h16v-4',
  settings:
    'M9.35 4.72L9.75 2.26L14.25 2.26L14.65 4.72L16.98 6.06L19.31 5.18L21.56 9.08L19.63 10.65L19.63 13.35L21.56 14.92L19.31 18.82L16.98 17.94L14.65 19.28L14.25 21.74L9.75 21.74L9.35 19.28L7.02 17.94L4.69 18.82L2.44 14.92L4.37 13.35L4.37 10.65L2.44 9.08L4.69 5.18L7.02 6.06ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  monitor: 'M3 4h18v12H3ZM8 21h8M12 16v5',
  cloud: 'M6 18a4 4 0 0 1-1-7.87 6 6 0 0 1 11.8-1.05A4.5 4.5 0 1 1 18 18Z',
  'cloud-check': 'M5 18a4 4 0 0 1 0-8 6 6 0 0 1 11.8-.92A4.5 4.5 0 0 1 21 15M9 18l3 3 6-7',
  'cloud-off': 'm3 3 18 18M6 18a4 4 0 0 1-1-7.87M8.3 6a6 6 0 0 1 8.5 3.08A4.5 4.5 0 0 1 21 16.8',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11',
  lock: 'M6 10h12v11H6ZM8 10V7a4 4 0 0 1 8 0v3',
  warning: 'M12 3 2 21h20ZM12 9v5M12 17h.01',
  link: 'm9 15 6-6M8 16H6a4 4 0 0 1-3-7l4-4a4 4 0 0 1 6 0M16 8h2a4 4 0 0 1 3 7l-4 4a4 4 0 0 1-6 0',
  grip: 'M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01',
  external: 'M14 4h6v6M20 4 10 14M20 14v6H4V4h6',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  logout: 'M10 4H4v16h6M10 12h11M17 8l4 4-4 4',
  copy: 'M8 8h13v13H8ZM16 3H3v13',
} as const;

export type IconName = keyof typeof paths;
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  title?: string;
}

export function Icon({ name, size = 18, title, className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      className={['icon', className].filter(Boolean).join(' ')}
      {...props}
    >
      {title && <title>{title}</title>}
      <path d={paths[name]} />
    </svg>
  );
}
