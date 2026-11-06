const paths = {
  calendar: 'M4 6h16v14H4ZM8 3v6M16 3v6M4 11h16',
  tag: 'M20 13 12 21 3 12V3h9l8 8a1.4 1.4 0 0 1 0 2ZM7.5 7.5h.01',
  flag: 'M5 21V3h14l-3 4 3 4H5',
  subtasks: 'M4 5h2v2H4ZM4 11h2v2H4ZM4 17h2v2H4ZM10 6h10M10 12h10M10 18h10',
  star: 'm12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9Z',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M18 6 6 18',
  list: 'M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01',
} as const;

export function WorkbenchIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
