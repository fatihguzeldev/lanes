import { describe, expect, it } from 'vitest';
import {
  canBlockWorkbenchTask,
  setWorkbenchCompletion,
  setWorkbenchSubtaskCompletion,
  workbenchDraft,
  workbenchTasks,
} from './workbench-data';

describe('inline editor draft boundary', () => {
  it('excludes root-owned placement fields from metadata drafts', () => {
    const task = { ...workbenchTasks[0]!, list: 'in progress' };

    expect(workbenchDraft(task)).not.toHaveProperty('list');
  });

  it('keeps immediate completion changes out of the metadata draft', () => {
    const task = workbenchTasks[0]!;
    const draft = workbenchDraft(task);
    const changed = {
      ...task,
      completed: !task.completed,
      subtasks: task.subtasks.map((child) => ({ ...child, completed: !child.completed })),
    };
    expect(workbenchDraft(changed)).toEqual(draft);
    expect({ ...changed, ...draft }).toMatchObject({
      completed: changed.completed,
      subtasks: changed.subtasks,
    });
  });

  it('retains every editable metadata field for save and dirty detection', () => {
    const task = workbenchTasks[0]!;
    const changed = {
      ...task,
      title: 'new title',
      notes: 'new notes',
      day: '2026-11-20',
      time: '15:30',
      timeZone: 'UTC',
      labels: ['writing'],
      priority: 'low' as const,
      starred: false,
      blockedBy: ['notes'],
    };
    expect(workbenchDraft(changed)).not.toEqual(workbenchDraft(task));
    expect({ ...task, ...workbenchDraft(changed) }).toEqual(changed);
  });
});

describe('inline editor completion', () => {
  it('completes the parent and every open subtask without changing metadata', () => {
    const task = workbenchTasks[0]!;
    const completed = setWorkbenchCompletion(task, true);

    expect(completed.completed).toBe(true);
    expect(completed.subtasks.map((child) => child.completed)).toEqual([true, true, true]);
    expect(workbenchDraft(completed)).toEqual(workbenchDraft(task));
  });

  it('reopens the parent while retaining completed children', () => {
    const completed = setWorkbenchCompletion(workbenchTasks[0]!, true);
    const reopened = setWorkbenchCompletion(completed, false);

    expect(reopened.completed).toBe(false);
    expect(reopened.subtasks).toEqual(completed.subtasks);
  });

  it('reopens the parent when a completed child is reopened', () => {
    const completed = setWorkbenchCompletion(workbenchTasks[0]!, true);
    const reopened = setWorkbenchSubtaskCompletion(completed, 1, false);

    expect(reopened.completed).toBe(false);
    expect(reopened.subtasks.map((child) => child.completed)).toEqual([true, false, true]);
    expect(workbenchDraft(reopened)).toEqual(workbenchDraft(completed));
  });

  it('does not automatically complete the parent when its last open child completes', () => {
    const task = {
      ...workbenchTasks[0]!,
      subtasks: [
        { title: 'first', completed: true },
        { title: 'last', completed: false },
      ],
    };
    const completed = setWorkbenchSubtaskCompletion(task, 1, true);

    expect(completed.completed).toBe(false);
    expect(completed.subtasks.map((child) => child.completed)).toEqual([true, true]);
  });

  it('leaves fixture tasks and their children unchanged', () => {
    const original = structuredClone(workbenchTasks);

    setWorkbenchCompletion(workbenchTasks[0]!, true);
    setWorkbenchSubtaskCompletion(workbenchTasks[0]!, 0, false);

    expect(workbenchTasks).toEqual(original);
  });

  it('leaves the parent unchanged when a requested child does not exist', () => {
    const task = setWorkbenchCompletion(workbenchTasks[0]!, true);

    expect(setWorkbenchSubtaskCompletion(task, 99, false)).toBe(task);
  });
});

describe('inline editor dependencies', () => {
  it('allows an edge when no path leads back to the dependant', () => {
    expect(canBlockWorkbenchTask(workbenchTasks, 'website', 'walkthrough')).toBe(true);
  });

  it('rejects self-dependencies', () => {
    expect(canBlockWorkbenchTask(workbenchTasks, 'website', 'website')).toBe(false);
  });

  it('rejects references to tasks outside the local graph', () => {
    expect(canBlockWorkbenchTask(workbenchTasks, 'website', 'missing')).toBe(false);
    expect(canBlockWorkbenchTask(workbenchTasks, 'missing', 'website')).toBe(false);
  });

  it('rejects a direct dependency cycle', () => {
    const tasks = workbenchTasks.map((task) =>
      task.id === 'walkthrough' ? { ...task, blockedBy: ['website'] } : task,
    );

    expect(canBlockWorkbenchTask(tasks, 'website', 'walkthrough')).toBe(false);
    expect(canBlockWorkbenchTask(tasks, 'website', 'notes')).toBe(true);
  });

  it('rejects a transitive dependency cycle without changing the graph', () => {
    const tasks = workbenchTasks.map((task) => ({
      ...task,
      blockedBy: task.id === 'walkthrough' ? ['notes'] : task.id === 'notes' ? ['website'] : [],
    }));
    const original = structuredClone(tasks);

    expect(canBlockWorkbenchTask(tasks, 'website', 'walkthrough')).toBe(false);
    expect(tasks).toEqual(original);
  });
});
