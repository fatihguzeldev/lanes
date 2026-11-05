import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskMovePicker } from '../TaskMovePicker';
import { TaskMovePlacement } from '../TaskMovePlacement';
import type { TaskPlacement } from '../useTaskPlacement';
import type { BoardList } from '../../../contracts/board';
import type { Task } from '../../../../tasks/contracts/task';

const resources = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('../../../../../shared/browser/resources/usePagedResource', () => ({
  usePagedResource: (key: string) => {
    resources.keys.push(key);
    return {
      items: key.endsWith('move-boards')
        ? [
            { id: 'main', accountId: 'account', title: 'main' },
            { id: 'work', accountId: 'account', title: 'work' },
          ]
        : [
            { id: 'source', accountId: 'account', boardId: 'main', title: 'todo' },
            { id: 'destination', accountId: 'account', boardId: 'main', title: 'in progress' },
          ],
      status: 'ready',
      error: '',
      nextCursor: null,
    };
  },
}));
const task = {
  id: 'task',
  accountId: 'account',
  listId: 'source',
  title: 'read',
  parentId: null,
  capabilities: { canMove: true, canNest: true },
} as Task;
function controller(complete = true): TaskPlacement {
  return {
    selection: { task, anchor: {} as HTMLElement, boardId: 'main' },
    source: { task, preview: { coverageComplete: complete, subtaskCount: 0 } },
    enabled: true,
    sourceLoading: false,
    busy: false,
    locked: false,
    confirmation: null,
    error: '',
  } as unknown as TaskPlacement;
}

describe('task move destinations', () => {
  beforeEach(() => {
    resources.keys = [];
  });

  it('loads the current board lists and leaves other board queries until their submenu opens', () => {
    const html = renderToStaticMarkup(
      createElement(TaskMovePicker, { controller: controller(), embedded: true }),
    );
    expect(html).toContain('in progress');
    expect(html).toContain('other boards');
    expect(html).toContain('aria-label="placement in todo"');
    expect(html).not.toContain('first in list');
    expect(resources.keys).toEqual(['account:move-boards', 'account:move-lists:main']);
  });

  it('withholds movement choices until source coverage is established', () => {
    const html = renderToStaticMarkup(
      createElement(TaskMovePicker, { controller: controller(false), embedded: true }),
    );
    expect(html).toContain('refresh the source list before moving this task.');
    expect(html).toMatch(/disabled=""[^>]*>.*?in progress/s);
  });

  it('retains checklist confirmation rather than showing a fresh destination menu', () => {
    const movement = controller();
    movement.confirmation = {
      subtaskCount: 2,
      listTitle: 'in progress',
    } as TaskPlacement['confirmation'];
    const html = renderToStaticMarkup(
      createElement(TaskMovePicker, { controller: movement, embedded: true }),
    );
    expect(html).toContain('move checklist');
    expect(html).toContain('its 2 subtasks');
    expect(resources.keys).toEqual([]);
  });

  it('retains ordering controls while withholding unsupported nesting', () => {
    const movement = controller();
    const list = { id: 'destination', title: 'in progress' } as BoardList;
    const render = (selected = task, parent: Task | null = null) =>
      renderToStaticMarkup(
        createElement(TaskMovePlacement, {
          controller: movement,
          task: selected,
          list,
          disabled: false,
          parent,
        }),
      );
    const html = render();
    expect(html).toContain('first in list');
    expect(html).toContain('last in list');
    expect(html).toContain('after a task');
    expect(html).toContain('under a task');
    expect(render({ ...task, repeatRule: {} as Task['repeatRule'] })).not.toContain('under a task');
    expect(render(task, { id: 'parent', title: 'parent' } as Task)).not.toContain('under a task');
  });
});
