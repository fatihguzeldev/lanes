import { Icon, type IconName } from '../ui/Icon';
import { Popover } from '../ui/Popover';
import type { Theme } from './theme';
import './ThemeMenu.css';

const icons: Record<Theme, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };

export function ThemeMenu({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  return (
    <Popover
      label={`theme: ${theme}`}
      trigger={<Icon name={icons[theme]} />}
      triggerClassName="workspace__icon-button"
      className="theme-menu"
      align="end"
    >
      {(close) => (
        <div className="popover__menu">
          {(['system', 'light', 'dark'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="popover__item"
              aria-pressed={theme === value}
              onClick={() => {
                onTheme(value);
                close();
              }}
            >
              <Icon name={icons[value]} size={15} />
              {value}
              {theme === value && <Icon name="check" size={14} className="theme-menu__check" />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
