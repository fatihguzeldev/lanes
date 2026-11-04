import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionSummary } from '../../../modules/accounts/contracts/connection';
import type { Board } from '../../../modules/boards/contracts/board';
import {
  CalendarView,
  type CalendarViewProps,
} from '../../../modules/boards/browser/calendar/CalendarView';
import { TaskCard } from '../../../modules/tasks/browser/items/TaskCard';
import { TaskSchema, type TaskList } from '../../../modules/tasks/contracts/task';
import type { TaskPage } from '../../../modules/tasks/contracts/query';
import { CompletedWorkspace } from '../../../modules/boards/browser/completed/CompletedWorkspace';
import { TaskCollectionWorkspace } from '../../../modules/tasks/browser/queries/TaskCollectionWorkspace';

vi.mock('../../../modules/tasks/browser/queries/useTaskQuery', () => ({
  useTaskQuery: () => queryState,
}));
vi.mock('../../../modules/tasks/browser/planning/usePlanningToday', () => ({
  usePlanningToday: () => '2026-11-04',
}));

const task = TaskSchema.parse({
  id: 'task',
  accountId: 'account',
  listId: 'list',
  title: 'read chapter',
  completed: false,
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
  completedAt: null,
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
const account: ConnectionSummary = {
  id: 'account',
  email: 'owner@example.com',
  displayName: 'owner',
  pictureUrl: null,
  state: 'connected',
  permissions: { tasks: true, sheetsImport: false, sheetsExport: false },
  grantExpiresAt: null,
  planningZone: 'UTC',
  weekStart: 1,
  revision: 0,
};
const board: Board = {
  id: 'board',
  accountId: 'account',
  title: 'reading',
  isMain: true,
  emoji: null,
  color: '#ffffff',
  backgroundUrl: null,
  position: 0,
  revision: 0,
  createdAt: '2026-11-04T12:00:00Z',
};
const list: TaskList = {
  id: 'list',
  accountId: 'account',
  title: 'reading',
  providerId: 'google-list',
  providerEtag: null,
  isDefault: false,
  revision: 0,
};
const coverage = { complete: true, stale: false, lastSyncedAt: '2026-11-04T12:00:00Z' };
const noop = () => {};
let queryState: {
  page: TaskPage;
  status: 'ready' | 'loading' | 'error';
  loaded: boolean;
  error: string;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
};
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-11-04T12:00:00Z').getTime());
  queryState = {
    page: {
      items: [task],
      matchedTaskIds: [task.id],
      contextTaskIds: [],
      subtaskSummaries: {},
      nextCursor: null,
      coverage: { ...coverage },
      providerCoverage: coverage,
    },
    status: 'ready',
    loaded: true,
    error: '',
    reload: async () => {},
    loadMore: async () => {},
  };
});
afterEach(() => vi.restoreAllMocks());
const collection = () =>
  renderToStaticMarkup(
    createElement(TaskCollectionWorkspace, {
      account,
      today: '2026-11-04',
      labels: [],
      query: '',
      filter: {},
      sort: 'manual',
      version: 0,
      onOpenTask: noop,
      onToggleComplete: noop,
      onTaskMenu: noop,
      onOpenBoard: noop,
    }),
  );
const completed = () =>
  renderToStaticMarkup(
    createElement(CompletedWorkspace, {
      account,
      board,
      lists: [list],
      query: '',
      filter: {},
      version: 0,
      clockOffset: 0,
      onOpenTask: noop,
    }),
  );

describe('bounded workspace counts', () => {
  it('shows collection counts only after the final page and complete provider coverage', () => {
    queryState.page.coverage.complete = false;
    expect(collection()).not.toContain('matching open');
    expect(collection()).not.toContain(account.email);
    expect(collection()).not.toContain('partially loaded');
    queryState.page.coverage.complete = true;
    queryState.page.nextCursor = 'next';
    expect(collection()).not.toContain('matching open');
    queryState.page.nextCursor = null;
    expect(collection()).toContain('1 matching open');
  });

  it('keeps completion statistics hidden until all matching pages are known', () => {
    queryState.page.items = [{ ...task, completed: true, completedAt: '2026-11-04T11:00:00Z' }];
    queryState.page.coverage.complete = false;
    expect(completed()).not.toContain('seven day completion summary');
    queryState.page.coverage.complete = true;
    queryState.page.nextCursor = 'next';
    expect(completed()).not.toContain('seven day completion summary');
    queryState.page.nextCursor = null;
    expect(completed()).toContain('seven day completion summary');
    expect(completed()).toContain('<strong>1</strong>');
  });

  it('keeps restriction controls intact and avoids a fabricated checklist fraction', () => {
    const restricted = {
      ...task,
      capabilities: {
        ...task.capabilities,
        canEdit: false,
        restriction: 'google controls this task',
      },
    };
    const markup = renderToStaticMarkup(
      createElement(TaskCard, {
        task: restricted,
        subtasks: [],
        subtaskSummary: { total: 3, open: 1, complete: false },
        relatedTasks: [],
        labels: [],
        today: '2026-11-04',
        accountTimeZone: 'UTC',
        onOpen: noop,
        onToggleComplete: noop,
      }),
    );
    expect(markup).toContain('aria-label="open checklist"');
    expect(markup).toContain('>checklist</span>');
    expect(markup).not.toContain('2/3');
    expect(markup).toContain('aria-label="google controls this task"');
    expect(markup).toMatch(/aria-label="complete read chapter"[^>]*disabled=""/);
    expect(markup).not.toContain('class="task-card__restriction"');
  });

  it('keeps a refreshing calendar quiet without showing an incomplete unscheduled count', () => {
    const props: CalendarViewProps = {
      accountId: account.id,
      boardId: board.id,
      tasks: [task],
      lists: [list],
      today: '2026-11-04',
      accountTimeZone: 'UTC',
      weekStart: 1,
      mode: 'month',
      scope: 'board',
      coverage: { ...coverage, complete: false, stale: true },
      status: 'loading',
      nextCursor: 'next',
      onModeChange: noop,
      onScopeChange: noop,
      onOpenTask: noop,
      onTaskMenu: noop,
      onCreateTask: noop,
      onReschedule: noop,
      onLoadMore: noop,
      onRetry: noop,
    };
    const markup = renderToStaticMarkup(createElement(CalendarView, props));
    const header = markup.match(/class="calendar-view__unscheduled-toggle"[\s\S]*?<\/button>/)?.[0];
    expect(header).toBeTruthy();
    expect(header).not.toContain('<span>1</span>');
    expect(markup).not.toContain('refreshing calendar');
    expect(markup).not.toContain('partially loaded');
    expect(markup).not.toContain('refresh needed');
  });
});
