import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreviewTaskEditor } from './usePreviewTaskEditor';
import { workbenchTasks, type WorkbenchTask } from './workbench-data';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
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
}));

let tasks: WorkbenchTask[];
const change = vi.fn((id: string, patch: Partial<WorkbenchTask>) => {
  tasks = tasks.map((task) => (task.id === id ? { ...task, ...patch } : task));
});
function render(shouldGuardDraft?: () => boolean) {
  hooks.index = 0;
  return usePreviewTaskEditor(tasks, change, shouldGuardDraft ? { shouldGuardDraft } : {});
}
function dialogs() {
  return (
    render().dialogs as ReactElement<{
      onKeepEditing(): void;
      onDiscard(): void;
      onConfirmCompletion(): void;
      onCancelCompletion(): void;
    }>
  ).props;
}

describe('preview task editor ownership', () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.index = 0;
    tasks = structuredClone(workbenchTasks);
    change.mockClear();
  });

  it('keeps metadata local until save and leaves completion outside the draft', () => {
    expect(render().editingId).toBeNull();
    render().open(tasks[0]!);
    render().patch({ title: '  revised website  ', notes: 'unsaved notes' });

    expect(render().dirty).toBe(true);
    expect(change).not.toHaveBeenCalled();
    render().completeSubtask(tasks[0]!, 1, true);
    expect(tasks[0]!.notes).toBe(workbenchTasks[0]!.notes);
    expect(render().draft?.notes).toBe('unsaved notes');
    render().save();

    expect(tasks[0]).toMatchObject({ title: 'revised website', notes: 'unsaved notes' });
    expect(tasks[0]!.subtasks[1]!.completed).toBe(true);
    expect(render().editingId).toBeNull();
    expect(render().dirty).toBe(false);
  });

  it('does not save a blank title', () => {
    render().open(tasks[0]!);
    render().patch({ title: '  ' });
    render().save();

    expect(change).not.toHaveBeenCalled();
    expect(render().editingId).toBe(tasks[0]!.id);
  });

  it('lets visitors leave an automated draft and guards it after they edit', () => {
    let automated = true;
    const guard = () => !automated;
    render(guard).open(tasks[0]!);
    render(guard).patch({ notes: 'an automated draft' });
    const navigate = vi.fn();
    render(guard).navigate(navigate);
    expect(navigate).toHaveBeenCalledOnce();
    expect(render(guard).editingId).toBeNull();
    expect(change).not.toHaveBeenCalled();

    render(guard).open(tasks[0]!);
    render(guard).patch({ notes: 'visitor edits' });
    automated = false;
    render(guard).close();
    expect(render(guard).editingId).toBe(tasks[0]!.id);
    dialogs().onKeepEditing();
    expect(render(guard).draft?.notes).toBe('visitor edits');
  });

  it('runs clean navigation immediately and closes the editor', () => {
    render().open(tasks[0]!);
    const navigate = vi.fn();
    render().navigate(navigate);

    expect(navigate).toHaveBeenCalledOnce();
    expect(render().editingId).toBeNull();
  });

  it('guards explicit close and discards only the unsent metadata', () => {
    render().open(tasks[0]!);
    render().patch({ notes: 'unsaved notes' });
    render().completeSubtask(tasks[0]!, 1, true);
    render().close();
    expect(render().editingId).toBe(tasks[0]!.id);
    dialogs().onDiscard();

    expect(render().editingId).toBeNull();
    expect(tasks[0]!.notes).toBe(workbenchTasks[0]!.notes);
    expect(tasks[0]!.subtasks[1]!.completed).toBe(true);
  });

  it('keeps a dirty draft when navigation is cancelled', () => {
    render().open(tasks[0]!);
    render().patch({ notes: 'keep these notes' });
    const navigate = vi.fn();
    render().navigate(navigate);

    expect(navigate).not.toHaveBeenCalled();
    dialogs().onKeepEditing();
    expect(render().editingId).toBe(tasks[0]!.id);
    expect(render().draft?.notes).toBe('keep these notes');
    expect(navigate).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });

  it('runs the requested navigation after discarding without writing the draft', () => {
    render().open(tasks[0]!);
    render().patch({ notes: 'discard these notes' });
    const navigate = vi.fn();
    render().navigate(navigate);
    dialogs().onDiscard();

    expect(navigate).toHaveBeenCalledOnce();
    expect(render().editingId).toBeNull();
    expect(change).not.toHaveBeenCalled();
    expect(tasks).toEqual(workbenchTasks);
  });

  it('guards opening another task and creates its draft after confirmation', () => {
    render().open(tasks[0]!);
    render().patch({ notes: 'unsaved first task' });
    render().open(tasks[1]!);
    expect(render().editingId).toBe(tasks[0]!.id);
    dialogs().onDiscard();

    expect(render().editingId).toBe(tasks[1]!.id);
    expect(render().draft?.notes).toBe(tasks[1]!.notes);
    expect(render().dirty).toBe(false);
  });

  it('confirms parent completion and applies it independently of an open draft', () => {
    render().open(tasks[0]!);
    render().patch({ notes: 'still unsaved' });
    render().complete(tasks[0]!, true);
    expect(change).not.toHaveBeenCalled();
    dialogs().onCancelCompletion();
    expect(change).not.toHaveBeenCalled();
    render().complete(tasks[0]!, true);
    dialogs().onConfirmCompletion();

    expect(tasks[0]!.completed).toBe(true);
    expect(tasks[0]!.subtasks.every((child) => child.completed)).toBe(true);
    expect(tasks[0]!.notes).toBe(workbenchTasks[0]!.notes);
    expect(render().draft?.notes).toBe('still unsaved');
    expect(render().dirty).toBe(true);
  });

  it('confirms open blockers even when the checklist is already complete', () => {
    tasks[0] = {
      ...tasks[0]!,
      blockedBy: [tasks[1]!.id],
      subtasks: tasks[0]!.subtasks.map((child) => ({ ...child, completed: true })),
    };
    render().complete(tasks[0]!, true);
    expect(change).not.toHaveBeenCalled();
    dialogs().onConfirmCompletion();
    expect(tasks[0]!.completed).toBe(true);
  });

  it('changes stars directly without opening or overwriting a metadata draft', () => {
    render().open(tasks[0]!);
    render().patch({ notes: 'unsaved first task' });
    render().star(tasks[1]!, true);

    expect(change).toHaveBeenCalledWith(tasks[1]!.id, { starred: true });
    expect(render().editingId).toBe(tasks[0]!.id);
    expect(render().draft?.notes).toBe('unsaved first task');
  });
});
