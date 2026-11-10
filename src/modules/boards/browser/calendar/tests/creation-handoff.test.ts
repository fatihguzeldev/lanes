import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskSchema, type Task } from '../../../../tasks/contracts/task';
import type { PendingTaskCreation } from '../../../../tasks/browser/creation/creation-model';
import { CalendarWorkspace, type CalendarWorkspaceProps } from '../CalendarWorkspace';
import type { CalendarViewProps } from '../CalendarView';

const state = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  status: 'ready',
  settled: true,
  items: [] as Task[],
  matched: [] as string[],
  orderReadyTaskIds: [] as string[],
  orderReadyListIds: [] as string[],
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useMemo: (value: () => unknown) => value(),
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void) => state.effects.push(effect),
}));
vi.mock('../../../../tasks/browser/queries/useTaskQuery', () => ({
  useTaskQuery: () => ({
    page: {
      items: state.items,
      matchedTaskIds: state.matched,
      orderReadyTaskIds: state.orderReadyTaskIds,
      orderReadyListIds: state.orderReadyListIds,
      nextCursor: null,
      coverage: { complete: true, stale: false, lastSyncedAt: null },
      providerCoverage: { complete: true },
    },
    status: state.status,
    settled: state.settled,
    error: '',
  }),
}));
const creation = (patch: Partial<PendingTaskCreation> = {}): PendingTaskCreation => ({
  id: 1,
  confirmedAfter: 5,
  resolvedTaskId: 'saved-task',
  input: CreateTaskSchema.parse({
    accountId: 'account',
    listId: 'list',
    title: 'new task',
    scheduledDay: '2026-11-07',
  }),
  ...patch,
});
function render(
  creations = [creation()],
  version = 6,
  patch: Partial<CalendarWorkspaceProps> = {},
) {
  const acknowledged = vi.fn();
  const props = {
    account: { id: 'account', state: 'connected', weekStart: 1 },
    board: { id: 'board', accountId: 'account' },
    lists: [{ id: 'list', accountId: 'account' }],
    today: '2026-11-07',
    filter: {},
    query: '',
    sort: 'manual',
    version,
    creations,
    onCreationRead: acknowledged,
    onReschedule: vi.fn(),
    ...patch,
  } as unknown as CalendarWorkspaceProps;
  const element = CalendarWorkspace(props) as ReactElement<{
    children: ReactElement<CalendarViewProps>[];
  }>;
  state.effects.forEach((effect) => effect());
  const view = element.props.children.find((child) => child && 'tasks' in child.props)!;
  return { props: view.props, acknowledged };
}
beforeEach(() => {
  state.effects = [];
  state.status = 'ready';
  state.settled = true;
  state.items = [];
  state.matched = [];
  state.orderReadyTaskIds = [];
  state.orderReadyListIds = [];
});
describe('calendar creation handoff', () => {
  it('reports only settled view reads to the account move owner', () => {
    const onMoveRead = vi.fn();
    state.settled = false;
    render([], 6, { onMoveRead });
    expect(onMoveRead).toHaveBeenLastCalledWith(undefined);
    state.effects = [];
    state.settled = true;
    render([], 6, { onMoveRead });
    expect(onMoveRead).toHaveBeenLastCalledWith(6);
  });
  it('retires a creation outside the visible date range after its own list order is verified', () => {
    state.orderReadyListIds = ['list'];
    const result = render();
    expect(result.props.creations).toEqual([]);
    expect(result.acknowledged).toHaveBeenCalledExactlyOnceWith(1);
  });
  it('retains board-scoped server results whose list is beyond the loaded list page', () => {
    state.items = [
      {
        ...CreateTaskSchema.parse({
          accountId: 'account',
          listId: 'off-page-list',
          title: 'off-page work',
        }),
        id: 'task',
        revision: 1,
        completed: false,
        provider: { position: '1' },
      } as Task,
    ];
    state.matched = ['task'];
    expect(render([]).props.tasks.map((task) => task.id)).toEqual(['task']);
  });
  it('keeps valid server text matches before their list and label context is available', () => {
    state.items = [
      {
        ...CreateTaskSchema.parse({
          accountId: 'account',
          listId: 'list',
          title: 'ship lanes',
          labelIds: ['release'],
        }),
        id: 'task',
        revision: 1,
        completed: false,
        provider: { position: '1' },
      } as Task,
    ];
    state.matched = ['task'];
    // The loaded list does not supply the label name used by the server search.
    const result = render([], 6, { query: 'release' });
    expect(result.props.tasks.map((task) => task.id)).toEqual(['task']);
  });
  it('keeps a creation through the old read and removes it in the same render as a fresh read', () => {
    state.orderReadyTaskIds = ['saved-task'];
    expect(render([creation()], 5).props.creations).toHaveLength(1);
    state.effects = [];
    const fresh = render();
    expect(fresh.props.creations).toEqual([]);
    expect(fresh.acknowledged).toHaveBeenCalledExactlyOnceWith(1);
  });
  it('keeps a creation after a fresh read until its own list order is reconciled', () => {
    state.orderReadyTaskIds = ['unrelated-task'];
    const result = render();
    expect(result.props.creations).toHaveLength(1);
    expect(result.acknowledged).not.toHaveBeenCalled();
  });
  it.each(['loading', 'error'])('keeps the preview when the fresh read is %s', (status) => {
    state.status = status;
    const result = render();
    expect(result.props.creations).toHaveLength(1);
    expect(result.acknowledged).not.toHaveBeenCalled();
  });
  it('does not acknowledge a pending save or one outside this board/account', () => {
    const pending = creation({ confirmedAfter: null });
    const foreign = creation({ id: 2, input: { ...pending.input, accountId: 'other' } });
    const otherList = creation({ id: 3, input: { ...pending.input, listId: 'other-list' } });
    const result = render([pending, foreign, otherList]);
    expect(result.props.creations).toEqual([pending]);
    expect(result.acknowledged).not.toHaveBeenCalled();
  });
});
