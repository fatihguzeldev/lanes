import { Skeleton } from '../../shared/ui/skeleton/Skeleton';
import { Brand } from '../../shared/ui/brand/Brand';
import { Icon } from '../../shared/ui/icon/Icon';
import { BoardSkeleton } from '../../modules/boards/components/BoardSkeleton';
import { BoardNavigationSkeleton } from '../../modules/boards/client/BoardNavigation';
import type { ResolvedTheme } from '../theme/theme';
import './Workspace.css';
import './WorkspaceSkeleton.css';

export function WorkspaceSkeleton({ theme = 'light' }: { theme?: ResolvedTheme }) {
  return (
    <div
      className="workspace workspace-skeleton"
      role="status"
      aria-label="loading workspace"
      aria-busy="true"
    >
      <aside className="workspace__sidebar" aria-hidden="true">
        <Brand />
        <div className="workspace__navigation">
          <div>
            <Icon name="sun" size={16} />
            today
          </div>
          <div>
            <Icon name="star" size={16} />
            starred
          </div>
        </div>
        <BoardNavigationSkeleton />
      </aside>
      <main className="workspace__main" aria-hidden="true">
        <header className="workspace__topbar">
          <div className="workspace__title">
            <span className="workspace__mobile-menu">
              <Icon name="menu" />
            </span>
            <Skeleton className="workspace-skeleton__title" />
            <span className="workspace__icon-button">
              <Icon name="more" />
            </span>
          </div>
          <div className="workspace__search-controls">
            <span className="workspace__search">
              <Icon name="search" size={16} />
              <span className="workspace-skeleton__search-label">search tasks</span>
              <kbd>/</kbd>
            </span>
            <span className="workspace__icon-button">
              <Icon name="filter" size={16} />
            </span>
          </div>
          <div className="workspace__global-controls">
            <span className="workspace__icon-button">
              <Icon name="cloud" />
            </span>
            <span className="workspace__icon-button">
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </span>
            <span className="workspace__icon-button">
              <Icon name="settings" />
            </span>
            <span className="workspace__icon-button workspace__account-trigger">
              <span className="workspace__avatar" />
            </span>
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
