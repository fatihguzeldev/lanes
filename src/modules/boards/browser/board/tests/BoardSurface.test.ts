import type { BoardColumn } from '../board-column';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreateTaskSchema, TaskSchema, type TaskList } from '../../../../tasks/contracts/task';
import { BoardSurface, type BoardSurfaceProps } from '../BoardSurface';

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

const completedTask = TaskSchema.parse({
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

describe('board list presentation', () => {
  it('keeps a submitted creation in the list before its confirmed task is available', () => {
    const markup = render({
      ...{
        creations: [
          {
            id: 1,
            input: CreateTaskSchema.parse({
              accountId: 'account',
              listId: 'list',
              title: 'ring64',
            }),
            confirmedAfter: null,
            controls: { onEdit() {}, onStar() {}, onComplete() {}, onDelete() {} },
          },
        ],
      },
    });
    expect(markup).toContain('ring64');
    expect(markup).not.toContain('no tasks.');
    expect(markup).not.toContain('saving…');
    expect(markup).not.toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="star ring64"');
    expect(markup).toContain('aria-label="delete ring64"');
    expect(markup).toMatch(/aria-label="complete ring64"(?![^>]*disabled)/);
    expect(markup).toMatch(/class="board-column__count"[^>]*>1</);
  });

  it('shows a rejected creation as an actionable error instead of a saving row', () => {
    const markup = render({
      creations: [
        {
          id: 1,
          confirmedAfter: null,
          input: CreateTaskSchema.parse({
            accountId: 'account',
            listId: 'list',
            title: 'recover me',
          }),
          failure: { message: 'list changed', onEdit() {}, onDiscard() {} },
        },
      ],
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('list changed');
    expect(markup).toContain('aria-label="edit recover me"');
    expect(markup).toContain('aria-label="discard recover me"');
    expect(markup).not.toContain('aria-busy="true"');
    expect(markup).toMatch(/class="board-column__count"[^>]*>0</);
  });

  it('keeps the known list symbol identical while names and counts are unknown', () => {
    const symbol = (markup: string) =>
      markup.match(/<span class="board-column__symbol">([\s\S]*?)<\/span>/)?.[1];
    const ready = symbol(render());
    const loading = renderToStaticMarkup(
      createElement(BoardSurface, { ...base, status: 'loading' }),
    );
    expect(ready).toContain('width="18" height="18"');
    expect(symbol(loading)).toBe(ready);
    expect(symbol(render({}, { layout: 'stacked' }))).toBe(ready);
    expect(ready).not.toContain('skeleton');
    expect(loading).toContain('skeleton board-skeleton__list-title');
    expect(loading).toContain('skeleton board-skeleton__count');
  });

  const first = {
    ...completedTask,
    id: 'first',
    title: 'first',
    completed: false,
    completedAt: null,
  };
  const second = {
    ...first,
    id: 'second',
    title: 'second',
    provider: { ...first.provider, position: '2' },
  };

  it('places a newly captured task above existing tasks', () => {
    const markup = render({
      tasks: [first, second],
      creations: [
        {
          id: 1,
          confirmedAfter: null,
          input: CreateTaskSchema.parse({
            accountId: 'account',
            listId: 'list',
            title: 'new arrival',
          }),
        },
      ],
    });
    expect(markup.indexOf('new arrival')).toBeLessThan(markup.indexOf('data-task-id="first"'));
  });

  it('keeps a submitted subtask under its parent and counts it as open', () => {
    const markup = render({
      tasks: [first],
      subtaskSummaries: { [first.id]: { total: 0, open: 0, complete: true } },
      creations: [
        {
          id: 1,
          confirmedAfter: null,
          input: CreateTaskSchema.parse({
            accountId: 'account',
            listId: 'list',
            parentId: first.id,
            title: 'new child',
          }),
        },
      ],
    });
    expect(markup).toContain('aria-label="subtasks of first"');
    expect(markup).toContain('0/1');
    expect(markup.indexOf('new child')).toBeLessThan(markup.indexOf('</article>'));
    expect(markup).not.toContain('class="task-card task-creation-preview"');
    expect(markup).toMatch(/class="board-column__count"[^>]*>2</);
  });

  it('renders queued ranks only in manual order, without rewriting task positions', () => {
    const column = { tasks: [first, second], orderedTaskIds: ['second', 'first'] };
    const manual = render(column);
    expect(manual.indexOf('data-task-id="second"')).toBeLessThan(
      manual.indexOf('data-task-id="first"'),
    );
    const alphabetical = render(column, { sort: 'title' });
    expect(alphabetical.indexOf('data-task-id="first"')).toBeLessThan(
      alphabetical.indexOf('data-task-id="second"'),
    );
    expect(first.provider.position).toBe('1');
    expect(second.provider.position).toBe('2');
  });

  it('keeps known rows draggable while provider order reconciliation is incomplete', () => {
    const column = {
      tasks: [first],
      status: 'loading' as const,
      coverage: { ...complete, complete: false },
      orderReady: true,
    };
    const markup = render(column, { onMoveTask() {} });
    expect(markup).toContain('data-draggable="true"');
    expect(markup).not.toMatch(/(?:^|\s)draggable=/);
    expect(markup).not.toContain('board-column__count');
    expect(render({ ...column, orderReady: false }, { onMoveTask() {} })).toContain(
      'data-draggable="true"',
    );
  });

  it('keeps pending root and child controls disabled without adding saving rows', () => {
    const child = { ...second, parentId: first.id };
    const markup = render(
      {
        tasks: [first, child],
        matchedTaskIds: [child.id],
        subtaskSummaries: { [first.id]: { total: 1, open: 1, complete: true } },
      },
      { filtered: true, pendingTaskIds: new Set([first.id, child.id]) },
    );
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="complete first"');
    expect(markup).toContain('aria-label="complete second"');
    expect(markup).toMatch(/aria-label="complete first"[^>]*disabled=""/);
    expect(markup).toMatch(/aria-label="complete second"[^>]*disabled=""/);
    expect(markup).not.toContain('saving…');
  });

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
    expect(markup).not.toContain('board-skeleton__count');
    expect(markup).toContain('load more tasks');
    expect(markup).not.toContain('partially loaded');
    expect(markup).not.toContain('refresh needed');
  });

  it.each(['ready', 'error'] as const)(
    'does not leave the count loading after an incomplete query is %s',
    (status) => {
      const markup = render({ status, coverage: { ...complete, complete: false } });
      expect(markup).not.toContain('board-column__count');
      expect(markup).not.toContain('board-skeleton__count');
    },
  );

  it('shows an unknown count as loading while its query is running', () => {
    const markup = render({
      status: 'loading',
      countLoading: true,
      coverage: { ...complete, complete: false },
    });
    expect(markup).not.toContain('board-column__count');
    expect(markup).toContain('board-skeleton__count');
  });

  it('does not restart a settled incomplete count during a background refresh', () => {
    const markup = render({
      status: 'loading',
      countLoading: false,
      coverage: { ...complete, complete: false },
    });
    expect(markup).not.toContain('board-column__count');
    expect(markup).not.toContain('board-skeleton__count');
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
    const task = completedTask;
    expect(render({ tasks: [task], completedCoverage: complete })).toContain(
      'board-column__completed',
    );
    const partial = { tasks: [task], completedCoverage: { ...complete, complete: false } };
    expect(render(partial)).not.toContain('board-skeleton__count');
    expect(render({ ...partial, completedCountLoading: true })).toContain('board-skeleton__count');
    expect(
      render({ ...partial, completedLoading: true, completedCountLoading: false }),
    ).not.toContain('board-skeleton__count');
    expect(render({ ...partial, completedError: 'could not load completed tasks' })).not.toContain(
      'board-skeleton__count',
    );
  });

  it('keeps adding lists available beside captured creation previews', () => {
    const markup = render(
      {},
      {
        onAddList() {},
        listCreation: createElement('span', null, 'new reading list'),
        listCreationOpen: false,
      },
    );
    expect(markup).toContain('new reading list');
    expect(markup).toContain('new list</button>');
  });

  it.each([false, true])(
    'replaces the new-list action with its inline entry, empty=%s',
    (empty) => {
      const entry = createElement('input', { 'aria-label': 'new list name' });
      const markup = render(
        {},
        {
          ...(empty ? { columns: [] } : {}),
          onAddList() {},
          listCreation: entry,
          listCreationOpen: true,
        },
      );
      expect(markup).toContain('aria-label="new list name"');
      expect(markup).not.toContain('new list</button>');
      expect(markup).not.toContain('board-surface__add-list');
    },
  );
});
