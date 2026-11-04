import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskDependants } from '../TaskDependants';

const item = {
  id: 'waiting',
  accountId: 'a',
  listId: 'other-list',
  listTitle: 'work',
  parentId: null,
  parentTitle: null,
  title: 'waiting for this',
  completed: false,
  providerMissing: false,
  revision: 1,
};
const base = {
  accountId: 'a',
  completed: false,
  items: [item],
  loading: false,
  loaded: true,
  error: '',
  nextCursor: null,
  stale: false,
  pending: false,
  onRetry() {},
  onMore() {},
  onOpenTask() {},
};
describe('saved reverse dependency presentation', () => {
  it('shows dependant context and retains unknown status without exposing editing controls', () => {
    const html = renderToStaticMarkup(
      createElement(TaskDependants, {
        ...base,
        items: [{ ...item, parentId: 'parent', parentTitle: 'checklist', providerMissing: true }],
      }),
    );
    expect(html).toContain('waiting for this');
    expect(html).toContain('checklist');
    expect(html).toContain('work');
    expect(html).toContain('status unknown');
    expect(html).not.toContain('remove dependency');
  });
  it('does not leak another account and labels a partially loaded count honestly', () => {
    const html = renderToStaticMarkup(
      createElement(TaskDependants, {
        ...base,
        items: [item, { ...item, accountId: 'b', id: 'private', title: 'private account task' }],
        nextCursor: 'next',
      }),
    );
    expect(html).not.toContain('private account task');
    expect(html).toContain('1 loaded');
    expect(html).toContain('more dependent tasks');
  });
  it('preserves the graph reference after completion and explains it no longer blocks', () => {
    const html = renderToStaticMarkup(createElement(TaskDependants, { ...base, completed: true }));
    expect(html).toContain('does not currently block');
    expect(html).toContain('waiting for this');
  });
  it('keeps failed pages distinct from an empty graph and offers explicit retry', () => {
    const html = renderToStaticMarkup(
      createElement(TaskDependants, { ...base, items: [], error: 'the dependency graph changed' }),
    );
    expect(html).toContain('the dependency graph changed');
    expect(html).toContain('refresh dependent tasks');
    expect(html).not.toContain('no saved task depends');
  });
});
