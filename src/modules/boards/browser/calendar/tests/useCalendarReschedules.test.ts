import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../../tasks/contracts/task';
import { useCalendarReschedules } from '../useCalendarReschedules';
import type { CalendarRescheduleIntent } from '../CalendarView';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as Array<() => void>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => (hooks.slots[hooks.index++] ??= { current: initial }),
  useEffect: (effect: () => void) => hooks.effects.push(effect),
}));
const task = {
  id: 'task',
  accountId: 'account',
  listId: 'list',
  revision: 4,
  scheduledDay: '2026-11-05',
  scheduledTime: '09:00',
  timeZone: 'UTC',
  repeatRule: null,
} as Task;
const intent = (day: string | null) => ({
  accountId: task.accountId,
  taskId: task.id,
  listId: task.listId,
  revision: task.revision,
  scheduledDay: day,
});
let save: ReturnType<typeof vi.fn<(intent: CalendarRescheduleIntent) => Promise<boolean>>>;
function render(tasks: Task[] = [task], version = 0, readVersion?: number) {
  hooks.index = 0;
  hooks.effects = [];
  const result = useCalendarReschedules('account', tasks, version, readVersion, save);
  hooks.effects.forEach((effect) => effect());
  return result;
}
beforeEach(() => {
  hooks.slots = [];
  save = vi.fn();
});
describe('calendar background date changes', () => {
  it('moves immediately, preserves time, and rolls back a failed save', async () => {
    let finish!: (saved: boolean) => void;
    save.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = render().reschedule(intent('2026-11-07'));
    expect(render().tasks[0]).toMatchObject({
      scheduledDay: '2026-11-07',
      scheduledTime: '09:00',
      revision: 4,
    });
    finish(false);
    await pending;
    expect(render().tasks[0]).toBe(task);
  });
  it('retains a confirmed date until a newer settled read, without losing it between queries', async () => {
    save.mockResolvedValue(true);
    await render().reschedule(intent('2026-11-07'));
    expect(render([], 0, 0).tasks[0]?.scheduledDay).toBe('2026-11-07');
    expect(render([], 1).tasks[0]?.scheduledDay).toBe('2026-11-07');
    expect(render([], 1, 1).tasks).toEqual([]);
  });
  it('hands off when a fresh query settles before the save promise resolves', async () => {
    let finish!: (saved: boolean) => void;
    save.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = render().reschedule(intent('2026-11-07'));
    const confirmed = { ...task, scheduledDay: '2026-11-07', revision: task.revision + 1 };
    render([confirmed], 1, 1);
    finish(true);
    await pending;
    const result = render([confirmed], 1, 1);
    expect(result.taskIds).toEqual([]);
    expect(result.tasks[0]).toBe(confirmed);
  });

  it('keeps a later date while an earlier save settles', async () => {
    const finishes: Array<(value: boolean) => void> = [];
    save.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishes.push(resolve);
        }),
    );
    const first = render().reschedule(intent('2026-11-07'));
    const second = render().reschedule(intent('2026-11-08'));
    finishes[0]!(true);
    await first;
    expect(render().tasks[0]?.scheduledDay).toBe('2026-11-08');
    finishes[1]!(false);
    await second;
    expect(render().tasks[0]?.scheduledDay).toBe('2026-11-07');
  });
  it('does not save a same-day drop or an unknown or foreign task', async () => {
    expect(await render().reschedule(intent(task.scheduledDay))).toBe(true);
    expect(await render().reschedule({ ...intent('2026-11-07'), taskId: 'missing' })).toBe(false);
    expect(await render().reschedule({ ...intent('2026-11-07'), accountId: 'other' })).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
