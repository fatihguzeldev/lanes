import type { ComponentProps, ReactNode, Ref } from 'react';
import type { Board } from '../../modules/boards/contracts/board';
import { WorkspaceViewMenu } from '../../modules/boards/browser/view/WorkspaceViewMenu';
import { Skeleton } from '../../shared/ui/skeleton/Skeleton';
import { Icon } from '../../shared/ui/icon/Icon';
import { Select } from '../../shared/ui/select/Select';
import './WorkspaceToolbar.css';

interface Props {
  navigationTrigger: Ref<HTMLButtonElement>;
  onOpenNavigation(): void;
  awaitingBoard: boolean;
  quick: 'all' | 'today' | 'starred';
  searchScope: 'board' | 'account';
  search: string;
  board: Board | null;
  onBoardOptions(anchor: HTMLButtonElement): void;
  query: string;
  searchRef: Ref<HTMLInputElement>;
  onQuery(value: string): void;
  onScope(value: 'board' | 'account'): void;
  viewMenu: ComponentProps<typeof WorkspaceViewMenu>;
  controls: ReactNode;
}
export function WorkspaceToolbar({
  navigationTrigger,
  onOpenNavigation,
  awaitingBoard,
  quick,
  searchScope,
  search,
  board,
  onBoardOptions,
  query,
  searchRef,
  onQuery,
  onScope,
  viewMenu,
  controls,
}: Props) {
  return (
    <header className="workspace__topbar">
      <div className="workspace__title">
        <button
          ref={navigationTrigger}
          className="workspace__mobile-menu"
          aria-label="open navigation"
          onClick={onOpenNavigation}
        >
          <Icon name="menu" />
        </button>
        <h1
          aria-busy={awaitingBoard || undefined}
          aria-label={
            awaitingBoard && quick === 'all' && !(searchScope === 'account' && search)
              ? 'loading board'
              : undefined
          }
        >
          {quick === 'today'
            ? 'today'
            : quick === 'starred'
              ? 'starred'
              : searchScope === 'account' && search
                ? 'search results'
                : (board?.title ??
                  (awaitingBoard ? <Skeleton className="workspace-skeleton__title" /> : 'boards'))}
        </h1>
        {awaitingBoard && quick === 'all' && !(searchScope === 'account' && search) && (
          <span className="workspace__icon-button" aria-hidden="true">
            <Icon name="more" />
          </span>
        )}
        {board && quick === 'all' && !(searchScope === 'account' && search) && (
          <button
            className="workspace__icon-button"
            aria-label={`options for ${board.title}`}
            onClick={(event) => {
              onBoardOptions(event.currentTarget);
            }}
          >
            <Icon name="more" />
          </button>
        )}
      </div>
      <div className="workspace__search-controls">
        <label className="workspace__search">
          <Icon name="search" size={16} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="search tasks"
            aria-label="search tasks"
          />
          <kbd>/</kbd>
        </label>
        {query && (
          <Select
            aria-label="search scope"
            value={searchScope}
            className="workspace__search-scope"
            onChange={(value) => onScope(value as 'board' | 'account')}
            options={[
              { value: 'board', label: 'this board' },
              { value: 'account', label: 'all boards' },
            ]}
          />
        )}
        <WorkspaceViewMenu {...viewMenu} />
      </div>
      <div className="workspace__global-controls">{controls}</div>
    </header>
  );
}
