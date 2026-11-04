import { Icon } from '../ui/Icon';
import type { ResolvedTheme } from './theme';

export function ThemeToggle({
  theme,
  onTheme,
}: {
  theme: ResolvedTheme;
  onTheme: (theme: ResolvedTheme) => void;
}) {
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `switch to ${next} theme`;
  return (
    <button
      type="button"
      className="workspace__icon-button"
      aria-label={label}
      title={label}
      onClick={() => onTheme(next)}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}
