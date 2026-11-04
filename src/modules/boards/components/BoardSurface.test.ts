import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskSchema, type TaskList } from '../../tasks/contracts';
import { BoardSurface, type BoardColumn, type BoardSurfaceProps } from './BoardSurface';

const list: TaskList = {
  id: 'list',
  accountId: 'account',
  title: 'reading',
  revision: 0,
  providerId: 'google-list',
  providerEtag: null,
  isDefault: false,
};
const complete = { complete: true, stale: false, lastSyncedAt: '2026-11-04T12:00:00Z' };
const base: BoardSurfaceProps = {
  accountId: 'account',
  columns: [],
  labels: [],
  today: '2026-11-04',
  accountTimeZone: 'UTC',
  onOpenTask() {},
  onToggleComplete() {},
  onTaskMenu() {},
  onAddTask() {},
  onListMenu() {},
  onLoadMore() {},
  onRetryList() {},
};
function render(column: Partial<BoardColumn> = {}, surface: Partial<BoardSurfaceProps> = {}) {
  return renderToStaticMarkup(
    createElement(BoardSurface, {
      ...base,
      columns: [
        { list, tasks: [], coverage: complete, status: 'ready', nextCursor: null, ...column },
      ],
      ...surface,
    }),
  );
}

describe('board list presentation', () => {
  it('keeps later list pages accessible beside the end of the visible columns', () => {
    expect(render()).not.toContain('board-surface__more-lists');
    const markup = render({}, { onLoadMoreLists() {}, onAddList() {} });
    expect(markup).toContain('board-surface__more-lists');
    expect(markup.indexOf('board-surface__more-lists')).toBeLessThan(
      markup.indexOf('board-surface__add-list'),
    );
    expect(render({}, { onLoadMoreLists() {}, status: 'loading' })).toMatch(
      /class="board-surface__more-lists"[^>]*disabled=""/,
    );
  });
  it('hides completed sections with no known completed tasks', () => {
    expect(render({ completedCoverage: complete })).not.toContain('board-column__completed');
  });

  it('does not publish loaded-page counts as an exact total', () => {
    const markup = render({ coverage: { ...complete, complete: false }, nextCursor: 'next' });
    expect(markup).not.toContain('board-column__count');
    expect(markup).toContain('board-skeleton__count');
    expect(markup).not.toContain('partially loaded');
    expect(markup).not.toContain('refresh needed');
  });

  it('retains a confirmed count when its cached tasks are refreshing', () => {
    const markup = render({ status: 'loading' });
    expect(markup).toContain('class="board-column__count"');
    expect(markup).not.toContain('board-skeleton__count');
    expect(markup).not.toContain('board-column__skeleton-row');
    expect(markup).toContain('no tasks.');
    expect(
      render({ coverage: { ...complete, complete: false } }, { showCounts: false }),
    ).not.toContain('board-skeleton__count');
    expect(
      renderToStaticMarkup(
        createElement(BoardSurface, { ...base, status: 'loading', showCounts: false }),
      ),
    ).not.toContain('board-skeleton__count');
  });

  it('keeps the completed section discoverable when a completed task is known', () => {
    const task = TaskSchema.parse({
      id: 'task',
      accountId: 'account',
      listId: 'list',
      title: 'read chapter',
      completed: true,
      parentId: null,
      notes: '',
      labelIds: [],
      priority: 'none',
      starred: false,
      blockedBy: [],
      scheduledDay: null,
      scheduledTime: null,
      timeZone: null,
      repeatRule: null,
      occurrenceId: null,
      seriesId: null,
      completedAt: '2026-11-04T11:00:00Z',
      revision: 0,
      unsupportedHierarchy: false,
      provider: {
        id: 'google-task',
        listId: 'google-list',
        etag: null,
        position: '1',
        updatedAt: null,
      },
      capabilities: {
        canEdit: true,
        canEditNotes: true,
        canMove: true,
        canDelete: true,
        canHaveChildren: true,
        canNest: true,
        assignmentSource: null,
        sourceUrl: null,
        restriction: null,
      },
    });
    expect(render({ tasks: [task], completedCoverage: complete })).toContain(
      'board-column__completed',
    );
  });
});
