import type { ComponentProps, ReactNode } from 'react';
import { Brand } from '../../shared/ui/brand/Brand';
import { Icon } from '../../shared/ui/icon/Icon';
import { BoardNavigation } from '../../modules/boards/browser/navigation/BoardNavigation';
import type { useMobileNavigation } from './useMobileNavigation';
import './WorkspaceNavigation.css';

interface Props {
  navigation: ReturnType<typeof useMobileNavigation>;
  open: boolean;
  quick: 'all' | 'today' | 'starred';
  onQuick(value: 'today' | 'starred'): void;
  onClose(): void;
  boards: ComponentProps<typeof BoardNavigation>;
  utilities: ReactNode;
}

export function WorkspaceNavigation({
  navigation,
  open,
  quick,
  onQuick,
  onClose,
  boards,
  utilities,
}: Props) {
  return (
    <>
      <aside
        ref={navigation.drawer}
        className="workspace__sidebar"
        aria-label="workspace navigation"
        role={open ? 'dialog' : undefined}
        aria-modal={open || undefined}
      >
        <div className="workspace__sidebar-heading">
          <Brand />
          <button
            type="button"
            className="workspace__sidebar-close"
            aria-label="close navigation"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <nav className="workspace__navigation">
          <button className={quick === 'today' ? 'active' : ''} onClick={() => onQuick('today')}>
            <Icon name="sun" size={16} />
            today
          </button>
          <button
            className={quick === 'starred' ? 'active' : ''}
            onClick={() => onQuick('starred')}
          >
            <Icon name="star" size={16} />
            starred
          </button>
        </nav>
        <BoardNavigation {...boards} />
        <div className="workspace__mobile-utilities">{utilities}</div>
      </aside>
      {open && (
        <button
          className="workspace__nav-backdrop"
          aria-hidden="true"
          tabIndex={-1}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
        />
      )}
    </>
  );
}
