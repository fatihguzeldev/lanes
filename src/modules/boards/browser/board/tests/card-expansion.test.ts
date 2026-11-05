import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskSchema, type Task } from '../../../../tasks/contracts/task';
import { TaskCard, type TaskCardProps } from '../../../../tasks/browser/items/TaskCard';
import { BoardSurface, type BoardColumn, type BoardSurfaceProps } from '../BoardSurface';

const hooks = vi.hoisted(() => ({
  instances: new Map<string, unknown[]>(),
  instance: '',
  cursor: 0,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const slots = hooks.instances.get(hooks.instance)!;
    const index = hooks.cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      slots[index],
      (value: unknown) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      },
    ];
  },
  useMemo: (factory: () => unknown) => factory(),
  useId: () => `${hooks.instance}-${hooks.cursor++}`,
  useEffect: (effect: () => void) => effect(),
}));
vi.mock('../useBoardTaskDrag', () => ({
  useBoardTaskDrag: ({ columns }: { columns: readonly BoardColumn[] }) => ({ columns }),
}));

function render(instance: string, component: () => ReactNode) {
  hooks.instance = instance;
  hooks.cursor = 0;
  if (!hooks.instances.has(instance)) hooks.instances.set(instance, []);
  return component();
}
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function task(id: string, listId: string, parentId: string | null = null): Task {
  return TaskSchema.parse({
    id,
    accountId: 'account',
    listId,
    parentId,
    title: id,
    notes: '',
    completed: false,
    completedAt: null,
    scheduledDay: null,
    scheduledTime: null,
    timeZone: null,
    repeatRule: null,
    seriesId: null,
    occurrenceId: null,
    labelIds: [],
    priority: 'none',
    starred: false,
    blockedBy: [],
    revision: 1,
    unsupportedHierarchy: false,
    provider: { id, listId, etag: 'etag', position: id, updatedAt: null },
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
}
function columns(listId = 'source'): BoardColumn[] {
  return ['source', 'destination'].map((id) => ({
    list: {
      id,
      accountId: 'account',
      providerId: id,
      providerEtag: null,
      title: id,
      isDefault: false,
      revision: 1,
    },
    tasks: id === listId ? [task('parent', id), task('child', id, 'parent')] : [],
    subtaskSummaries: id === listId ? { parent: { total: 1, open: 1, complete: true } } : {},
    coverage: { complete: true, stale: false, lastSyncedAt: null },
    nextCursor: null,
    status: 'ready',
  }));
}
function card(columns: BoardColumn[], filtered = false): TaskCardProps {
  const props: BoardSurfaceProps = {
    accountId: columns[0]!.list.accountId,
    columns,
    labels: [],
    today: '2026-11-05',
    accountTimeZone: 'UTC',
    filtered,
    onOpenTask() {},
    onToggleComplete() {},
    onTaskMenu() {},
    onListMenu() {},
    onLoadMore() {},
    onRetryList() {},
  };
  const board = render('board', () => BoardSurface(props));
  const column = elements(board).find((element) =>
    (element.props.column as BoardColumn | undefined)?.tasks.some((item) => item.id === 'parent'),
  )!;
  const columnId = (column.props.column as BoardColumn).list.id;
  const rows = render(`column:${columnId}`, () =>
    (column.type as (props: unknown) => ReactNode)(column.props),
  );
  return elements(rows).find((element) => element.type === TaskCard)!
    .props as unknown as TaskCardProps;
}
function toggle(instance: string, props: TaskCardProps) {
  const tree = render(instance, () => TaskCard(props));
  return elements(tree).find(
    (element) => element.props.className === 'task-card__subtasks-toggle',
  )!;
}

describe('board checklist expansion', () => {
  beforeEach(() => hooks.instances.clear());

  it('keeps an expanded checklist open when its card remounts in another list', () => {
    const first = toggle('card:source', card(columns()));
    expect(first.props['aria-expanded']).toBe(false);
    (first.props.onClick as () => void)();
    const moved = toggle('card:destination', card(columns('destination')));
    expect(moved.props['aria-expanded']).toBe(true);
  });

  it('retains an explicit collapsed choice across filtered remounts', () => {
    const first = toggle('card:source', card(columns(), true));
    expect(first.props['aria-expanded']).toBe(true);
    (first.props.onClick as () => void)();
    const moved = toggle('card:destination', card(columns('destination'), true));
    expect(moved.props['aria-expanded']).toBe(false);
  });

  it('uses the filtered default until the user makes an expansion choice', () => {
    expect(toggle('card:source', card(columns())).props['aria-expanded']).toBe(false);
    const filtered = card(columns(), true);
    toggle('card:source', filtered);
    expect(toggle('card:source', filtered).props['aria-expanded']).toBe(true);
  });

  it('keeps expansion choices separate for equal task ids in different accounts', () => {
    const first = toggle('card:source', card(columns()));
    (first.props.onClick as () => void)();
    const otherAccount = columns('destination').map((column) => ({
      ...column,
      list: { ...column.list, accountId: 'other-account' },
      tasks: column.tasks.map((task) => ({ ...task, accountId: 'other-account' })),
    }));
    const other = toggle('card:other-account', card(otherAccount));
    expect(other.props['aria-expanded']).toBe(false);
  });

  it('keeps standalone cards locally expandable without a board controller', () => {
    const {
      task,
      subtasks,
      subtaskSummary,
      relatedTasks,
      labels,
      today,
      accountTimeZone,
      onOpen,
      onToggleComplete,
    } = card(columns());
    const props = {
      task,
      subtasks,
      subtaskSummary,
      relatedTasks,
      labels,
      today,
      accountTimeZone,
      onOpen,
      onToggleComplete,
    };
    const first = toggle('standalone', props);
    expect(first.props['aria-expanded']).toBe(false);
    (first.props.onClick as () => void)();
    expect(toggle('standalone', props).props['aria-expanded']).toBe(true);
  });
});
