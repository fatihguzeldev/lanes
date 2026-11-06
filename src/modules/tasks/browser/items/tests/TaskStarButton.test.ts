import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskSchema, type Task } from '../../../contracts/task';
import { TaskStarButton } from '../TaskStarButton';
import { TaskCard } from '../TaskCard';

const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots))
      harness.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      harness.slots[index],
      (value: unknown) => {
        harness.slots[index] = typeof value === 'function' ? value(harness.slots[index]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = harness.cursor++;
    return (harness.slots[index] ??= { current: initial });
  },
  useEffect(effect: () => void) {
    harness.effects.push(effect);
  },
}));
const task = TaskSchema.parse({
  id: 'task',
  accountId: 'account',
  listId: 'list',
  parentId: null,
  title: 'prepare the talk',
  notes: 'keep the notes',
  completed: false,
  completedAt: null,
  scheduledDay: '2026-11-04',
  scheduledTime: null,
  timeZone: null,
  repeatRule: null,
  seriesId: null,
  occurrenceId: null,
  labelIds: [],
  priority: 'none',
  starred: false,
  blockedBy: [],
  revision: 7,
  unsupportedHierarchy: false,
  provider: {
    id: 'google-task',
    listId: 'google-list',
    etag: 'v7',
    position: '100',
    updatedAt: null,
  },
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

type Element = ReactElement<Record<string, any>>;
const toggle = vi.fn<(task: Task, starred: boolean) => Promise<boolean>>();
function render(current = task, disabled = false) {
  harness.cursor = 0;
  harness.effects = [];
  const root = TaskStarButton({ task: current, disabled, onToggle: toggle }) as Element;
  harness.effects.forEach((effect) => effect());
  return root;
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  harness.slots = [];
  harness.cursor = 0;
  harness.effects = [];
  toggle.mockReset().mockResolvedValue(true);
});
describe('quick task star', () => {
  it('previews immediately and waits for a fresh revision before another write', async () => {
    let finish!: (saved: boolean) => void;
    toggle.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const before = render();
    before.props.onClick();
    before.props.onClick();
    expect(toggle).toHaveBeenCalledExactlyOnceWith(task, true);
    expect(render().props['aria-pressed']).toBe(true);
    expect(render().props.disabled).toBe(true);
    finish(true);
    await settle();
    expect(render().props.disabled).toBe(true);
    render({ ...task, revision: 8, starred: true });
    const confirmed = render({ ...task, revision: 8, starred: true });
    expect(confirmed.props.disabled).toBe(false);
    expect(confirmed.props['aria-label']).toBe('unstar prepare the talk');
    confirmed.props.onClick();
    expect(toggle).toHaveBeenLastCalledWith({ ...task, revision: 8, starred: true }, false);
  });
  it.each([false, new Error('offline')])(
    'restores the confirmed star after a failed write (%s)',
    async (failure) => {
      if (failure instanceof Error) toggle.mockRejectedValue(failure);
      else toggle.mockResolvedValue(failure);
      render({ ...task, starred: true }).props.onClick();
      expect(render({ ...task, starred: true }).props['aria-pressed']).toBe(false);
      await settle();
      const restored = render({ ...task, starred: true });
      expect(restored.props['aria-pressed']).toBe(true);
      expect(restored.props.disabled).toBe(false);
    },
  );
  it('does not write while local actions are unavailable', () => {
    render(task, true).props.onClick();
    expect(toggle).not.toHaveBeenCalled();
  });
});
describe('row star placement', () => {
  const child = { ...task, id: 'child', parentId: task.id, title: 'child task' };
  const html = (enabled: boolean, pending = new Set<string>()) =>
    renderToStaticMarkup(
      createElement(TaskCard, {
        task,
        subtasks: [child],
        relatedTasks: [task, child],
        labels: [],
        today: '2026-11-04',
        accountTimeZone: 'UTC',
        expanded: true,
        providerActionsEnabled: false,
        localActionsEnabled: enabled,
        pendingTaskIds: pending,
        onToggleStar: toggle,
        onOpen() {},
        onToggleComplete() {},
        onMenu() {},
      }),
    );
  it('places a direct star before options for roots and children, independently of provider access', () => {
    const markup = html(true);
    for (const title of ['prepare the talk', 'child task']) {
      const star = markup.indexOf(`aria-label="star ${title}"`);
      expect(star).toBeGreaterThan(-1);
      expect(star).toBeLessThan(markup.indexOf(`aria-label="options for ${title}"`));
      expect(markup.slice(star, markup.indexOf('>', star))).not.toContain('disabled');
    }
  });
  it('disables read-only stars and the specific child with a pending write', () => {
    const readOnly = html(false);
    expect(readOnly.match(/aria-pressed="false" disabled/g)).toHaveLength(2);
    harness.slots = [];
    harness.cursor = 0;
    const pending = html(true, new Set([child.id]));
    expect(pending.match(/aria-pressed="false" disabled/g)).toHaveLength(1);
  });
});
