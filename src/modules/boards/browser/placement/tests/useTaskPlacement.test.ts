import { beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionSummary } from '../../../../accounts/contracts/connection';
import type { Task } from '../../../../tasks/contracts/task';
import type { BoardList } from '../../../contracts/board';
import { useTaskPlacement } from '../useTaskPlacement';
const harness = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = initial;
    return [harness.slots[index], (next: unknown) => (harness.slots[index] = next)];
  },
}));
vi.mock('../../../../../shared/browser/connectivity/useServerConnection', () => ({
  useServerConnection: () => 'reachable',
}));
const move = vi.fn(() => true);
const task = {
  id: 'task',
  accountId: 'account',
  listId: 'one',
  parentId: null,
  capabilities: { canMove: true },
  unsupportedHierarchy: false,
} as Task;
const choice = {
  list: { id: 'two', accountId: 'account' } as BoardList,
  position: 'last' as const,
};
function render() {
  harness.cursor = 0;
  return useTaskPlacement({
    account: { id: 'account', state: 'connected' } as ConnectionSummary,
    onMoveTask: move,
  });
}
beforeEach(() => {
  harness.slots = [];
  move.mockReset();
  move.mockReturnValue(true);
});
it('closes a chosen move at capture without owning the background request', () => {
  render().open(task, {} as HTMLElement, 'board');
  render().choose(choice);
  expect(move).toHaveBeenCalledExactlyOnceWith(task, choice);
  expect(render().selection).toBeNull();
  render().open({ ...task, id: 'another' }, {} as HTMLElement, 'board');
  expect(render().selection?.task.id).toBe('another');
});
it('keeps an invalid destination visible and does not discard selection', () => {
  move.mockReturnValue(false);
  render().open(task, {} as HTMLElement, 'board');
  render().choose(choice);
  expect(render().selection?.task.id).toBe(task.id);
  expect(render().error).toContain('destination');
});
it('rejects foreign or restricted tasks before opening', () => {
  render().open({ ...task, accountId: 'other' }, {} as HTMLElement, 'board');
  expect(render().selection).toBeNull();
  render().open(
    { ...task, capabilities: { ...task.capabilities, canMove: false } },
    {} as HTMLElement,
    'board',
  );
  expect(render().selection).toBeNull();
});
it('closing destination browsing never calls the shared move queue', () => {
  render().open(task, {} as HTMLElement, 'board');
  render().close();
  expect(render().selection).toBeNull();
  expect(move).not.toHaveBeenCalled();
});
