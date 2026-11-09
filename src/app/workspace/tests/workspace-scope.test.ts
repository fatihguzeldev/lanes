import { Children, isValidElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceViews } from '../WorkspaceViews';
import { CalendarWorkspace } from '../../../modules/boards/browser/calendar/CalendarWorkspace';
import { CompletedWorkspace } from '../../../modules/boards/browser/completed/CompletedWorkspace';

describe('workspace search scope', () => {
  it.each([
    ['calendar', CalendarWorkspace],
    ['completed', CompletedWorkspace],
  ] as const)('shares the toolbar scope and labels with the %s view', (view, component) => {
    const changeScope = vi.fn();
    const labels = [{ id: 'release', accountId: 'account', name: 'release', color: '#82966f' }];
    const input = {
      account: { id: 'account' },
      board: { id: 'board', accountId: 'account' },
      boardId: 'board',
      lists: { items: [], status: 'ready' },
      visibleLists: [],
      labels,
      viewPreferences: { view },
      quick: 'all',
      searchScope: 'account',
      search: 'release',
      filter: {},
      activeFilter: {},
      moveQueue: { moves: [] },
      actions: { onSearchScope: changeScope },
    } as unknown as Parameters<typeof WorkspaceViews>[0];
    const children = Children.toArray(WorkspaceViews(input).props.children);
    const child = children.find((item) => isValidElement(item) && item.type === component);
    expect(child).toBeDefined();
    const props = (
      child as ReactElement<{
        scope: string;
        labels: unknown;
        onScopeChange(scope: string): void;
      }>
    ).props;
    expect(props.scope).toBe('account');
    expect(props.labels).toBe(labels);
    props.onScopeChange('board');
    expect(changeScope).toHaveBeenCalledWith('board');
  });
});
