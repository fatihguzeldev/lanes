import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskSchema } from '../../../../tasks/contracts/task';
import type { PendingTaskCreation } from '../../../../tasks/browser/creation/useTaskCreations';
import { CalendarWorkspace, type CalendarWorkspaceProps } from '../CalendarWorkspace';
import type { CalendarViewProps } from '../CalendarView';

const state = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  status: 'ready',
  settled: true,
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
      items: [],
      matchedTaskIds: [],
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
  input: CreateTaskSchema.parse({
    accountId: 'account',
    listId: 'list',
    title: 'new task',
    scheduledDay: '2026-11-07',
  }),
  ...patch,
});
function render(creations = [creation()], version = 6) {
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
  } as unknown as CalendarWorkspaceProps;
  const element = CalendarWorkspace(props) as ReactElement<{
    children: ReactElement<CalendarViewProps>[];
  }>;
  state.effects.forEach((effect) => effect());
  return { props: element.props.children[0]!.props, acknowledged };
}
beforeEach(() => {
  state.effects = [];
  state.status = 'ready';
  state.settled = true;
});
describe('calendar creation handoff', () => {
  it('keeps a creation through the old read and removes it in the same render as a fresh read', () => {
    expect(render([creation()], 5).props.creations).toHaveLength(1);
    state.effects = [];
    const fresh = render();
    expect(fresh.props.creations).toEqual([]);
    expect(fresh.acknowledged).toHaveBeenCalledExactlyOnceWith(1);
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
