import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CreateTaskSchema } from '../../../contracts/task';
import { TaskCollectionWorkspace } from '../TaskCollectionWorkspace';
vi.mock('../useTaskQuery', () => ({
  useTaskQuery: () => ({
    page: {
      items: [],
      matchedTaskIds: [],
      contextTaskIds: [],
      subtaskSummaries: {},
      nextCursor: null,
      coverage: { complete: true },
      providerCoverage: { complete: true },
    },
    status: 'ready',
    settled: true,
    loaded: true,
    error: '',
  }),
}));
const create = {
  id: 1,
  confirmedAfter: null,
  input: CreateTaskSchema.parse({
    accountId: 'account',
    listId: 'list',
    title: 'ring64',
    scheduledDay: '2026-11-07',
    starred: true,
  }),
  controls: { onEdit() {}, onStar() {}, onComplete() {}, onDelete() {} },
};
const props = {
  account: { id: 'account', state: 'connected', planningZone: 'UTC' },
  today: '2026-11-07',
  labels: [],
  query: '',
  filter: { scheduled: { kind: 'today' } },
  sort: 'manual',
  version: 0,
  onOpenTask() {},
  onToggleComplete() {},
  onTaskMenu() {},
  onOpenBoard() {},
  creations: [create],
} as unknown as Parameters<typeof TaskCollectionWorkspace>[0];
describe('pending task collection rows', () => {
  it('shows a matching top-level creation before the first confirmed task query includes it', () => {
    const html = renderToStaticMarkup(createElement(TaskCollectionWorkspace, props));
    expect(html).toContain('ring64');
    expect(html).toContain('aria-label="unstar ring64"');
    expect(html).not.toContain('nothing here right now');
    expect(html).not.toContain('aria-busy="true"');
  });
  it('does not show a deleted creation or a mismatched smart view', () => {
    const deleted = renderToStaticMarkup(
      createElement(TaskCollectionWorkspace, {
        ...props,
        creations: [{ ...create, deleted: true }],
      }),
    );
    expect(deleted).not.toContain('ring64');
    const mismatch = renderToStaticMarkup(
      createElement(TaskCollectionWorkspace, {
        ...props,
        filter: { starred: false },
      }),
    );
    expect(mismatch).not.toContain('ring64');
  });
  it('retains a matching pending subtask when its unscheduled parent is outside the view', () => {
    const html = renderToStaticMarkup(
      createElement(TaskCollectionWorkspace, {
        ...props,
        creations: [{ ...create, input: { ...create.input, parentId: 'parent' } }],
      }),
    );
    expect(html).toContain('ring64');
  });
});
