import { describe, expect, it } from 'vitest';
import { demoTasks, toggleDemoTask } from '../demo-model';

describe('interactive workspace preview', () => {
  it('completes a task and reopens it without changing its list or other tasks', () => {
    const original = demoTasks.find((task) => task.id === 'small-start');
    const completed = toggleDemoTask(demoTasks, 'small-start');

    expect(completed.find((task) => task.id === 'small-start')).toEqual({
      ...original,
      completed: true,
    });
    expect(completed.filter((task) => task.id !== 'small-start')).toEqual(
      demoTasks.filter((task) => task.id !== 'small-start'),
    );
    expect(toggleDemoTask(completed, 'small-start')).toEqual(demoTasks);
    expect(original?.completed).toBe(false);
  });

  it('leaves the preview unchanged when a task no longer exists', () => {
    expect(toggleDemoTask(demoTasks, 'missing-task')).toEqual(demoTasks);
  });
});
