const paths = {
  calendar: 'M4 6h16v14H4ZM8 3v6M16 3v6M4 11h16',
  tag: 'M20 13 12 21 3 12V3h9l8 8a1.4 1.4 0 0 1 0 2ZM7.5 7.5h.01',
  flag: 'M5 21V3h14l-3 4 3 4H5',
  subtasks: 'M4 5h2v2H4ZM4 11h2v2H4ZM4 17h2v2H4ZM10 6h10M10 12h10M10 18h10',
  star: 'm12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9Z',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M18 6 6 18',
  list: 'M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01',
  link: 'M10 13a5 5 0 0 0 7 .3l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.3l-3 3a5 5 0 0 0 7 7l2-2',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  down: 'm7 10 5 5 5-5',
  right: 'm9 6 6 6-6 6',
} as const;

export function WorkbenchIcon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'list' ? 2 : 1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
