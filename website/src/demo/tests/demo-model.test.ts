import { describe, expect, it } from 'vitest';
import { demoTasks, selectDemoTasks, toggleDemoTask, toggleDemoTaskStar } from '../demo-model';

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
    expect(toggleDemoTaskStar(demoTasks, 'missing-task')).toEqual(demoTasks);
  });

  it('stars and unstars tasks across views without changing completion or list placement', () => {
    const starred = toggleDemoTaskStar(demoTasks, 'small-start');
    expect(starred.find((task) => task.id === 'small-start')).toEqual({
      ...demoTasks.find((task) => task.id === 'small-start'),
      starred: true,
    });
    expect(selectDemoTasks(starred, 'starred', '').map((task) => task.id)).toEqual([
      'small-start',
      'make-room',
    ]);
    expect(starred.filter((task) => task.id !== 'small-start')).toEqual(
      demoTasks.filter((task) => task.id !== 'small-start'),
    );
    const unstarred = toggleDemoTaskStar(starred, 'make-room');
    expect(selectDemoTasks(unstarred, 'starred', '').map((task) => task.id)).toEqual([
      'small-start',
    ]);
    expect(demoTasks.find((task) => task.id === 'small-start')?.starred).toBeUndefined();
  });

  it('shows open tasks for the today and starred shortcuts', () => {
    expect(selectDemoTasks(demoTasks, 'today', '').map((task) => task.id)).toEqual(['website']);
    expect(selectDemoTasks(demoTasks, 'starred', '').map((task) => task.id)).toEqual(['make-room']);
    expect(selectDemoTasks(toggleDemoTask(demoTasks, 'make-room'), 'starred', '')).toEqual([]);
  });

  it('keeps ideas unscheduled and the active project tasks on today and tomorrow', () => {
    const ideas = demoTasks.filter((task) => task.list === 'ideas');
    expect(ideas.every((task) => task.day === null && task.time === undefined)).toBe(true);
    expect(demoTasks.find((task) => task.id === 'website')?.day).toBe(3);
    expect(demoTasks.find((task) => task.id === 'make-room')?.day).toBe(4);
  });

  it('searches titles, notes, lists and labels while keeping the selected shortcut', () => {
    expect(selectDemoTasks(demoTasks, 'all', ' SINGLE PAGE ').map((task) => task.id)).toEqual([
      'small-start',
    ]);
    expect(selectDemoTasks(demoTasks, 'all', 'making things').map((task) => task.id)).toEqual([
      'make-room',
    ]);
    expect(selectDemoTasks(demoTasks, 'starred', 'ideas')).toEqual([]);
    expect(selectDemoTasks(demoTasks, 'all', 'project website').map((task) => task.id)).toEqual([
      'website',
    ]);
  });
});
