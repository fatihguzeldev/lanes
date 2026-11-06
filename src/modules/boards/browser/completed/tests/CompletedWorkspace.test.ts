import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletedWorkspace, type CompletedWorkspaceProps } from '../CompletedWorkspace';
import type { TaskPage } from '../../../../tasks/contracts/query';

const state = vi.hoisted(() => ({
  loaded: true,
  settled: true,
  status: 'ready' as 'ready' | 'loading' | 'error',
  error: '',
  page: {} as TaskPage,
  reload: async () => {},
  loadMore: async () => {},
}));
vi.mock('../../../../tasks/browser/queries/useTaskQuery', () => ({ useTaskQuery: () => state }));
vi.mock('../../../../tasks/browser/planning/usePlanningToday', () => ({
  usePlanningToday: () => '2026-11-06',
}));
const coverage = { complete: true, stale: false, lastSyncedAt: null };
const props: CompletedWorkspaceProps = {
  account: {
    id: 'account',
    email: 'owner@example.com',
    displayName: 'owner',
    pictureUrl: null,
    state: 'connected',
    permissions: { tasks: true, sheetsImport: false, sheetsExport: false },
    grantExpiresAt: null,
    planningZone: 'UTC',
    weekStart: 1,
    revision: 1,
  },
  board: null,
  lists: [],
  query: '',
  filter: {},
  version: 0,
  clockOffset: 0,
  onOpenTask() {},
  onReturn() {},
  onClearFilters() {},
};
const render = (patch: Partial<CompletedWorkspaceProps> = {}) =>
  renderToStaticMarkup(createElement(CompletedWorkspace, { ...props, ...patch }));
beforeEach(() => {
  state.loaded = true;
  state.status = 'ready';
  state.error = '';
  state.page = {
    items: [],
    matchedTaskIds: [],
    contextTaskIds: [],
    subtaskSummaries: {},
    nextCursor: null,
    coverage: { ...coverage },
    providerCoverage: { ...coverage },
  };
});

describe('completed review states', () => {
  it('keeps a direct board return and a quiet empty result beside the complete summary', () => {
    const html = render();
    expect(html).toContain('aria-label="back to board"');
    expect(html).toContain('seven day completion summary');
    expect(html).toContain('no completed tasks yet.');
    expect(html).not.toContain('clear filters');
    expect(html).not.toContain('no completed tasks match');
  });
  it('offers filter recovery when the result is empty because of a selection', () => {
    const html = render({ query: 'no matching task' });
    expect(html).toContain('no completed tasks match these filters.');
    expect(html).toContain('clear filters');
  });
  it('never presents an incomplete read as an empty completed total', () => {
    state.page.coverage.complete = false;
    const html = render();
    expect(html).not.toContain('seven day completion summary');
    expect(html).toContain('no matching completed tasks loaded yet.');
  });
  it('shows a failed read without claiming there are no completed tasks', () => {
    state.status = 'error';
    state.error = 'could not load this selection';
    const html = render();
    expect(html).toContain(state.error);
    expect(html).toContain('try again');
    expect(html).not.toContain('no completed tasks yet.');
  });
});
