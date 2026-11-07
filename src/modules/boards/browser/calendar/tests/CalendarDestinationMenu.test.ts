import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarDestinationMenu } from '../CalendarDestinationMenu';
import type { Board } from '../../../contracts/board';
import type { TaskList } from '../../../../tasks/contracts/task';

const resource = vi.hoisted(() => ({ scopes: [] as Array<string | null>, boardId: 'board' }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: () => [resource.boardId, vi.fn()],
}));
vi.mock('../../../../../shared/browser/resources/usePagedResource', () => ({
  usePagedResource: (scope: string | null) => {
    resource.scopes.push(scope);
    return {
      items: scope?.includes(':calendar-destination:')
        ? [
            {
              id: 'remote-list',
              accountId: 'account',
              boardId: resource.boardId,
              title: 'remote list',
            },
          ]
        : [],
      status: 'ready',
      loaded: true,
      nextCursor: null,
      error: '',
      coverage: { complete: true, stale: false, lastSyncedAt: null },
      reload: vi.fn(),
      loadMore: vi.fn(),
    };
  },
}));
vi.mock('../../../../../shared/browser/connectivity/useServerConnection', () => ({
  useServerConnection: () => 'reachable',
}));
vi.mock('../../../../../shared/ui/popover/Popover', () => ({
  AnchoredPopover: ({ children }: { children: import('react').ReactNode }) => children,
}));
const board = { id: 'board', accountId: 'account', title: 'work' } as Board;
const list = {
  id: 'known-list',
  accountId: 'account',
  title: 'already loaded',
  revision: 1,
} as TaskList;
const props = {
  anchor: {} as HTMLElement,
  accountId: 'account',
  board,
  scope: 'board' as const,
  scheduledDay: null,
  enabled: true,
  version: 1,
  onChoose: vi.fn(),
  onClose: vi.fn(),
};
const knownLists = {
  items: [list],
  status: 'ready' as const,
  loaded: true,
  nextCursor: null,
  error: '',
  coverage: { complete: true, stale: false, lastSyncedAt: null },
  reload: vi.fn(),
  loadMore: vi.fn(),
};

describe('calendar destination context', () => {
  beforeEach(() => {
    resource.scopes = [];
    resource.boardId = 'board';
  });
  it('uses the current board lists immediately without starting another list read', () => {
    const html = renderToStaticMarkup(
      createElement(CalendarDestinationMenu, { ...props, knownLists }),
    );
    expect(resource.scopes).toEqual([null, null]);
    expect(html).toContain('already loaded');
    expect(html).not.toContain('remote list');
    expect(html).not.toContain('loading lists');
  });
  it('fetches destinations when the selected board is different', () => {
    resource.boardId = 'another-board';
    const html = renderToStaticMarkup(
      createElement(CalendarDestinationMenu, { ...props, knownLists }),
    );
    expect(resource.scopes).toEqual([null, 'account:calendar-destination:another-board']);
    expect(html).toContain('remote list');
    expect(html).not.toContain('already loaded');
  });
  it('retains known pagination and freshness instead of claiming a full list set', () => {
    const html = renderToStaticMarkup(
      createElement(CalendarDestinationMenu, {
        ...props,
        knownLists: {
          ...knownLists,
          status: 'loading',
          nextCursor: 'more',
          coverage: { ...knownLists.coverage, complete: false },
        },
      }),
    );
    expect(html).toContain('already loaded');
    expect(html).toContain('loading more lists');
    expect(html).toContain('more lists');
    expect(html).toContain('list data is incomplete');
  });
  it('does not leak a known list from another account', () => {
    const html = renderToStaticMarkup(
      createElement(CalendarDestinationMenu, {
        ...props,
        knownLists: {
          ...knownLists,
          items: [{ ...list, accountId: 'other' }],
        },
      }),
    );
    expect(html).not.toContain('already loaded');
  });
});
