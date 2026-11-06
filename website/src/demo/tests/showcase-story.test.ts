import { describe, expect, it, vi } from 'vitest';
import { demoWorkspaces, updateDemoTask, type DemoTask } from '../demo-model';
import { playWorkspaceStory } from '../showcase-story';
import { setWorkbenchSubtaskCompletion } from '../../details/workbench-data';

function setup() {
  let workspace = structuredClone(demoWorkspaces);
  let draft: string | null = null;
  const original = structuredClone(workspace);
  const controller = new AbortController();
  const events: string[] = [];
  const drafts: string[] = [];
  const views: { view: 'list' | 'calendar'; task: DemoTask }[] = [];
  const task = () => workspace.personal.find((item) => item.id === 'website')!;
  const context = {
    signal: controller.signal,
    checkpoint: vi.fn(() => controller.signal.throwIfAborted()),
    wait: vi.fn(async () => controller.signal.throwIfAborted()),
    registerAnimation: vi.fn(),
  };
  const motion = {
    move: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    transition: vi.fn(async (update: () => void) => update()),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
  const story = {
    context,
    motion,
    task,
    edit: vi.fn(() => {
      draft = task().notes;
      events.push('edit');
    }),
    notes: vi.fn((value: string) => {
      if (draft === null) throw new Error('the task editor is closed');
      draft = value;
      drafts.push(value);
    }),
    save: vi.fn(() => {
      if (draft === null) throw new Error('there is no task draft to save');
      workspace = updateDemoTask(workspace, 'personal', task().id, { notes: draft });
      draft = null;
      events.push('save');
    }),
    view: vi.fn((view: 'list' | 'calendar') => {
      views.push({ view, task: structuredClone(task()) });
      events.push(view);
    }),
    completeSubtask: vi.fn((index: number) => {
      workspace = updateDemoTask(
        workspace,
        'personal',
        task().id,
        setWorkbenchSubtaskCompletion(task(), index, true),
      );
      events.push('complete-subtask');
    }),
  } satisfies Parameters<typeof playWorkspaceStory>[0];
  return { story, controller, original, events, drafts, views, workspace: () => workspace };
}

describe('workspace showcase story', () => {
  it('saves one task draft and carries the same task through list, checklist and calendar', async () => {
    const { story, original, events, drafts, views, workspace } = setup();
    const initial = original.personal.find((item) => item.id === 'website')!;
    const notes = initial.notes + ' ready for launch.';
    const firstOpenChild = initial.subtasks.findIndex((child) => !child.completed);

    await playWorkspaceStory(story);

    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts.every((value) => value.startsWith(initial.notes))).toBe(true);
    expect(drafts.at(-1)).toBe(notes);
    expect(story.save).toHaveBeenCalledOnce();
    expect(events).toEqual(['edit', 'save', 'list', 'complete-subtask', 'calendar']);
    expect(views.map(({ view }) => view)).toEqual(['list', 'calendar']);
    expect(views[0]!.task).toEqual({ ...initial, notes });
    expect(views[1]!.task).toEqual({
      ...initial,
      notes,
      subtasks: initial.subtasks.map((child, index) =>
        index === firstOpenChild ? { ...child, completed: true } : child,
      ),
    });
    expect(story.task()).toEqual(views[1]!.task);
    expect(workspace().personal.filter((item) => item.id !== initial.id)).toEqual(
      original.personal.filter((item) => item.id !== initial.id),
    );
    expect(workspace().work).toEqual(original.work);
    expect(story.motion.hide).toHaveBeenCalledOnce();
  });

  it('reaches the calendar without reopening a checklist that is already complete', async () => {
    const { story, views } = setup();
    for (const child of story.task().subtasks) child.completed = true;

    await playWorkspaceStory(story);

    expect(views.map(({ view }) => view)).toEqual(['list', 'calendar']);
    expect(story.completeSubtask).not.toHaveBeenCalled();
    expect(story.task().subtasks.every((child) => child.completed)).toBe(true);
  });

  it('checks cancellation after a press resolves and before opening the editor', async () => {
    const { story, controller, original, events, workspace } = setup();
    story.motion.press.mockImplementationOnce(async () => controller.abort());

    await expect(playWorkspaceStory(story)).rejects.toMatchObject({ name: 'AbortError' });

    expect(events).toEqual([]);
    expect(story.notes).not.toHaveBeenCalled();
    expect(workspace()).toEqual(original);
  });

  it('stops typing after takeover without saving a partial draft or changing views', async () => {
    const { story, controller, original, events, drafts, workspace } = setup();
    story.context.wait.mockImplementation(async () => {
      if (drafts.length === 3) controller.abort();
    });

    await expect(playWorkspaceStory(story)).rejects.toMatchObject({ name: 'AbortError' });

    expect(drafts).toHaveLength(3);
    expect(events).toEqual(['edit']);
    expect(story.save).not.toHaveBeenCalled();
    expect(story.view).not.toHaveBeenCalled();
    expect(story.completeSubtask).not.toHaveBeenCalled();
    expect(workspace()).toEqual(original);
  });

  it('blocks a late transition callback after abort while keeping the completed save', async () => {
    const { story, controller, original, events, views } = setup();
    story.motion.transition.mockImplementationOnce(async (update) => {
      controller.abort();
      update();
    });

    await expect(playWorkspaceStory(story)).rejects.toMatchObject({ name: 'AbortError' });

    expect(story.task().notes).toBe(original.personal[0]!.notes + ' ready for launch.');
    expect(story.task().subtasks).toEqual(original.personal[0]!.subtasks);
    expect(events).toEqual(['edit', 'save']);
    expect(views).toEqual([]);
    expect(story.completeSubtask).not.toHaveBeenCalled();
  });
});
