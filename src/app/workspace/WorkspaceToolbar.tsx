import type { ComponentProps, ReactNode, Ref } from 'react';
import type { Board } from '../../modules/boards/contracts/board';
import { WorkspaceViewMenu } from '../../modules/boards/browser/view/WorkspaceViewMenu';
import { Skeleton } from '../../shared/ui/skeleton/Skeleton';
import { Icon } from '../../shared/ui/icon/Icon';
import { Select } from '../../shared/ui/select/Select';
import { useWorkspaceHeader } from './useWorkspaceHeader';
import { useWorkspaceSearch } from './useWorkspaceSearch';
import './WorkspaceToolbar.css';

interface Props {
  navigationTrigger: Ref<HTMLButtonElement>;
  onOpenNavigation(): void;
  awaitingBoard: boolean;
  quick: 'all' | 'today' | 'starred';
  searchScope: 'board' | 'account';
  search: string;
  board: Board | null;
  onBoardOptions(anchor: HTMLElement): void;
  query: string;
  onQuery(value: string): void;
  onScope(value: 'board' | 'account'): void;
  viewMenu: ComponentProps<typeof WorkspaceViewMenu>;
  syncControl: ReactNode;
  desktopControls: ReactNode;
  accountControl: ReactNode;
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
  onQuery,
  onScope,
  viewMenu,
  syncControl,
  desktopControls,
  accountControl,
}: Props) {
  const header = useWorkspaceHeader();
  const taskSearch = useWorkspaceSearch(query, onQuery);
  const title =
    quick === 'today'
      ? 'today'
      : quick === 'starred'
        ? 'starred'
        : searchScope === 'account' && search
          ? 'search results'
          : (board?.title ??
            (awaitingBoard ? <Skeleton className="workspace-skeleton__title" /> : 'boards'));
  const boardActions = board && quick === 'all' && !(searchScope === 'account' && search);
  return (
    <header
      ref={header}
      className={`workspace__topbar${taskSearch.searching ? ' workspace__topbar--searching' : ''}`}
    >
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
          {title}
        </h1>
        <span className="workspace__compact-title">
          <WorkspaceViewMenu
            {...viewMenu}
            trigger={
              <>
                <span>{title}</span>
                <Icon name="down" size={14} />
              </>
            }
            label={`view options for ${typeof title === 'string' ? title : 'board'}`}
            triggerClassName="workspace__board-trigger"
            {...(boardActions ? { onBoardOptions } : {})}
          />
        </span>
        {awaitingBoard && quick === 'all' && !(searchScope === 'account' && search) && (
          <span className="workspace__icon-button workspace__board-options" aria-hidden="true">
            <Icon name="more" />
          </span>
        )}
        {boardActions && (
          <button
            className="workspace__icon-button workspace__board-options"
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
        <button
          type="button"
          className="workspace__icon-button workspace__search-back"
          aria-label="close search"
          onClick={taskSearch.close}
        >
          <Icon name="left" />
        </button>
        <label className="workspace__search">
          <Icon name="search" size={16} />
          <input
            ref={taskSearch.input}
            type="search"
            enterKeyHint="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="search tasks"
            aria-label="search tasks"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                taskSearch.close();
              }
            }}
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
        <span className="workspace__desktop-view">
          <WorkspaceViewMenu {...viewMenu} />
        </span>
      </div>
      <div className="workspace__global-controls">
        {syncControl}
        <button
          ref={taskSearch.trigger}
          type="button"
          className="workspace__icon-button workspace__search-launch"
          aria-label="search tasks"
          onClick={taskSearch.open}
        >
          <Icon name="search" />
        </button>
        <div className="workspace__desktop-utilities">{desktopControls}</div>
        {accountControl}
      </div>
    </header>
  );
}
