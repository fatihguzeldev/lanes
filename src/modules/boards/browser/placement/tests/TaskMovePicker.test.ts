import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskMovePicker } from '../TaskMovePicker';
import { TaskMovePlacement } from '../TaskMovePlacement';
import type { TaskMoveWorkspace } from '../TaskMoveDestinations';
import type { TaskPlacement } from '../useTaskPlacement';
import type { BoardList } from '../../../contracts/board';
import type { Task } from '../../../../tasks/contracts/task';

const resources = vi.hoisted(() => ({ keys: [] as string[], open: new Set<string>() }));
vi.mock('../../../../../shared/ui/submenu/Submenu', async (original) => {
  const { Submenu } = await original<typeof import('../../../../../shared/ui/submenu/Submenu')>();
  return {
    Submenu: (props: ComponentProps<typeof Submenu>) =>
      resources.open.has(props.label)
        ? createElement('div', null, props.children)
        : createElement(Submenu, props),
  };
});
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
            { id: 'source', accountId: 'account', boardId: key.split(':').at(-1), title: 'todo' },
            {
              id: 'destination',
              accountId: 'account',
              boardId: key.split(':').at(-1),
              title: 'in progress',
            },
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
function workspace(): TaskMoveWorkspace {
  return {
    board: { id: 'main', accountId: 'account' },
    boards: {
      items: [
        { id: 'main', accountId: 'account', title: 'main' },
        { id: 'work', accountId: 'account', title: 'work' },
      ],
      status: 'ready',
      error: '',
      nextCursor: null,
    },
    lists: {
      items: [
        { id: 'source', accountId: 'account', boardId: 'main', title: 'todo' },
        { id: 'destination', accountId: 'account', boardId: 'main', title: 'in progress' },
      ],
      status: 'ready',
      error: '',
      nextCursor: null,
    },
  } as TaskMoveWorkspace;
}
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
    resources.open.clear();
  });

  it('queries an unvisited board only when its list submenu opens', () => {
    resources.open.add('other boards');
    const render = () =>
      renderToStaticMarkup(
        createElement(TaskMovePicker, {
          controller: controller(),
          workspace: workspace(),
          embedded: true,
        }),
      );
    expect(render()).toContain('work');
    expect(resources.keys).toEqual([]);
    resources.open.add('lists in work');
    render();
    expect(resources.keys).toEqual(['account:move-lists:work']);
  });

  it('uses the workspace boards and lists without another destination request', () => {
    const html = renderToStaticMarkup(
      createElement(TaskMovePicker, {
        controller: controller(),
        workspace: workspace(),
        embedded: true,
      }),
    );
    expect(html).toContain('in progress');
    expect(html).toContain('other boards');
    expect(html).toContain('aria-label="placement in todo"');
    expect(html).not.toContain('first in list');
    expect(resources.keys).toEqual([]);
  });

  it('keeps loaded destinations visible during refresh and retains workspace pagination', () => {
    const current = workspace();
    current.lists.status = 'loading';
    current.lists.nextCursor = 'next-list-page';
    current.boards.nextCursor = 'next-board-page';
    const html = renderToStaticMarkup(
      createElement(TaskMovePicker, {
        controller: controller(),
        workspace: current,
        embedded: true,
      }),
    );
    expect(html).toContain('in progress');
    expect(html).toContain('more lists');
    expect(html).not.toContain('loading destinations');
    expect(resources.keys).toEqual([]);
  });

  it('does not offer lists from a different account or board in the workspace page', () => {
    const current = workspace();
    current.lists.items.push(
      {
        id: 'foreign',
        accountId: 'other',
        boardId: 'main',
        title: 'foreign task list',
      } as BoardList,
      {
        id: 'other-board',
        accountId: 'account',
        boardId: 'work',
        title: 'another board list',
      } as BoardList,
    );
    const html = renderToStaticMarkup(
      createElement(TaskMovePicker, {
        controller: controller(),
        workspace: current,
        embedded: true,
      }),
    );
    expect(html).not.toContain('foreign task list');
    expect(html).not.toContain('another board list');
    expect(html).toContain('in progress');
  });

  it('withholds movement choices until source coverage is established', () => {
    const html = renderToStaticMarkup(
      createElement(TaskMovePicker, {
        controller: controller(false),
        workspace: workspace(),
        embedded: true,
      }),
    );
    expect(html).toContain('refresh the source list before moving this task.');
    expect(html).toMatch(/disabled=""[^>]*>.*?in progress/s);
  });

  it('allows choosing a known destination before reading the move preflight', () => {
    const movement = controller();
    movement.source = null;
    const html = renderToStaticMarkup(
      createElement(TaskMovePicker, {
        controller: movement,
        workspace: workspace(),
        embedded: true,
      }),
    );
    const destination = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].find((match) =>
      match[2]?.includes('<span>in progress</span>'),
    );
    expect(destination).toBeDefined();
    expect(destination![1]).not.toContain('disabled');
    expect(resources.keys).toEqual([]);
  });

  it('retains checklist confirmation rather than showing a fresh destination menu', () => {
    const movement = controller();
    movement.confirmation = {
      subtaskCount: 2,
      listTitle: 'in progress',
    } as TaskPlacement['confirmation'];
    const html = renderToStaticMarkup(
      createElement(TaskMovePicker, {
        controller: movement,
        workspace: workspace(),
        embedded: true,
      }),
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
