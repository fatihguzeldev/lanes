import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../contracts/task';
import { createTaskActionQueue } from '../task-action-queue';

const task = { id: 'task', accountId: 'account' } as Task;
const intent = (field: 'starred' | 'completed', value: boolean, selected = task) => ({
  task: selected,
  field,
  value,
});
const deferred = () => {
  let resolve!: (saved: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('quick task action queue', () => {
  it('dispatches another task while earlier provider work is still pending', async () => {
    const first = deferred();
    const completed: string[] = [];
    const queue = createTaskActionQueue(
      async ({ task: selected }) => {
        if (selected.id === task.id) await first.promise;
        completed.push(selected.id);
        return true;
      },
      vi.fn(),
      vi.fn(),
    );
    const completion = queue.enqueue(intent('completed', true));
    const star = queue.enqueue(intent('starred', true, { ...task, id: 'other' }));
    await Promise.resolve();
    expect(completed).toEqual(['other']);
    first.resolve(true);
    expect(await Promise.all([completion, star])).toEqual([true, true]);
  });
  it('retains rapid intents and starts the next action only after the previous result', async () => {
    const first = deferred();
    let revision = 7;
    const revisions: number[] = [];
    const save = vi.fn(async () => {
      revisions.push(revision);
      if (revisions.length === 1) await first.promise;
      revision++;
      return true;
    });
    const busy = vi.fn();
    const queue = createTaskActionQueue(save, busy, vi.fn());
    const star = queue.enqueue(intent('starred', true));
    const complete = queue.enqueue(intent('completed', true));
    const unstar = queue.enqueue(intent('starred', false));
    expect(revisions).toEqual([7]);
    first.resolve(true);
    expect(await Promise.all([star, complete, unstar])).toEqual([true, true, true]);
    expect(revisions).toEqual([7, 8, 9]);
    expect(busy).toHaveBeenLastCalledWith(false);
  });

  it.each([false, new Error('uncertain save')])(
    'stops dependent unsent work while allowing another task to continue (%s)',
    async (failure) => {
      const first = deferred();
      const failed = vi.fn();
      const save = vi.fn(async () => {
        if (save.mock.calls.length === 1) {
          await first.promise;
          if (failure instanceof Error) throw failure;
          return false;
        }
        return true;
      });
      const queue = createTaskActionQueue(save, vi.fn(), failed);
      const star = queue.enqueue(intent('starred', true));
      const complete = queue.enqueue(intent('completed', true));
      const other = queue.enqueue(intent('starred', true, { ...task, id: 'other' }));
      first.resolve(true);
      expect(await Promise.all([star, complete, other])).toEqual([false, false, true]);
      expect(save.mock.calls).toHaveLength(2);
      expect(failed).toHaveBeenCalledTimes(failure instanceof Error ? 1 : 0);
    },
  );

  it('disposes unsent work and does not run another action after a late result', async () => {
    const first = deferred();
    const save = vi.fn(() => first.promise);
    const queue = createTaskActionQueue(save, vi.fn(), vi.fn());
    const star = queue.enqueue(intent('starred', true));
    const complete = queue.enqueue(intent('completed', true));
    queue.dispose();
    first.resolve(true);
    expect(await Promise.all([star, complete])).toEqual([false, false]);
    expect(save).toHaveBeenCalledOnce();
    expect(await queue.enqueue(intent('completed', false))).toBe(false);
  });
});
