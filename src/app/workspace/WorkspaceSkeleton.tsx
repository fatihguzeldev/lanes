import './WorkspaceNavigation.css';
import './WorkspaceToolbar.css';
import '../../modules/accounts/browser/identity/AccountMenu.css';
import { Skeleton } from '../../shared/ui/skeleton/Skeleton';
import { Brand } from '../../shared/ui/brand/Brand';
import { Icon } from '../../shared/ui/icon/Icon';
import { BoardSkeleton } from '../../modules/boards/browser/board/BoardSkeleton';
import { BoardNavigationSkeleton } from '../../modules/boards/browser/navigation/BoardNavigation';
import type { ResolvedTheme } from '../theme/theme';
import { useWorkspaceHeader } from './useWorkspaceHeader';
import './Workspace.css';
import './WorkspaceSkeleton.css';

export function WorkspaceSkeleton({
  theme = 'light',
  accountInitial = null,
}: {
  theme?: ResolvedTheme;
  accountInitial?: string | null;
}) {
  const header = useWorkspaceHeader();
  return (
    <div
      className="workspace workspace-skeleton"
      role="status"
      aria-label="loading workspace"
      aria-busy="true"
    >
      <aside className="workspace__sidebar" aria-hidden="true" inert>
        <div className="workspace__sidebar-heading">
          <Brand />
        </div>
        <nav className="workspace__navigation">
          <button type="button" tabIndex={-1}>
            <Icon name="sun" size={16} />
            today
          </button>
          <button type="button" tabIndex={-1}>
            <Icon name="star" size={16} />
            starred
          </button>
        </nav>
        <BoardNavigationSkeleton />
      </aside>
      <main className="workspace__main" aria-hidden="true" inert>
        <header ref={header} className="workspace__topbar">
          <div className="workspace__title">
            <button type="button" tabIndex={-1} className="workspace__mobile-menu">
              <Icon name="menu" />
            </button>
            <h1>
              <Skeleton className="workspace-skeleton__title" />
            </h1>
            <button type="button" tabIndex={-1} className="workspace__icon-button">
              <Icon name="more" />
            </button>
          </div>
          <div className="workspace__search-controls">
            <label className="workspace__search">
              <Icon name="search" size={16} />
              <input placeholder="search tasks" readOnly tabIndex={-1} />
              <kbd>/</kbd>
            </label>
            <button type="button" tabIndex={-1} className="workspace__icon-button">
              <Icon name="filter" size={16} />
            </button>
          </div>
          <div className="workspace__global-controls">
            <button type="button" tabIndex={-1} className="workspace__icon-button">
              <Icon name="cloud" />
            </button>
            <button type="button" tabIndex={-1} className="workspace__icon-button">
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button type="button" tabIndex={-1} className="workspace__icon-button">
              <Icon name="settings" />
            </button>
            <button type="button" tabIndex={-1} className="account-menu__trigger">
              <span className="account-menu__avatar">{accountInitial}</span>
            </button>
          </div>
        </header>
        <div className="board-surface">
          <div className="board-surface__scroll">
            <BoardSkeleton showAddList />
          </div>
        </div>
      </main>
    </div>
  );
}
