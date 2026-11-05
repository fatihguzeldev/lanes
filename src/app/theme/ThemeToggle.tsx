import { Icon } from '../../shared/ui/icon/Icon';
import type { ResolvedTheme } from './theme';

export function ThemeToggle({
  theme,
  onTheme,
  labelled = false,
}: {
  theme: ResolvedTheme;
  onTheme: (theme: ResolvedTheme) => void;
  labelled?: boolean;
}) {
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `switch to ${next} theme`;
  return (
    <button
      type="button"
      className={labelled ? 'workspace__utility-button' : 'workspace__icon-button'}
      aria-label={label}
      title={label}
      onClick={() => onTheme(next)}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      {labelled && <span>{next} theme</span>}
    </button>
  );
}
