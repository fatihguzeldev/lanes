import { describe, expect, it } from 'vitest';
import {
  demoTasks,
  demoToday,
  demoWeek,
  demoWorkspaces,
  selectDemoTasks,
  updateDemoTask,
} from '../demo-model';

describe('interactive workspace preview', () => {
  it('uses the same ISO dates for the editor, shortcuts and calendar', () => {
    expect(demoWeek).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      demoToday,
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ]);
    expect(demoTasks.filter((task) => task.day).every((task) => demoWeek.includes(task.day))).toBe(
      true,
    );
  });

  it('keeps edits and completion in the owning account', () => {
    const personal = updateDemoTask(demoWorkspaces, 'personal', 'website', {
      title: 'finish the website',
    });
    const work = updateDemoTask(personal, 'work', 'release', { completed: true });
    expect(work.personal.find((task) => task.id === 'website')?.title).toBe('finish the website');
    expect(work.work.find((task) => task.id === 'release')?.completed).toBe(true);
    expect(work.personal).toBe(personal.personal);
    expect(personal.work).toBe(demoWorkspaces.work);
    expect(demoWorkspaces.personal.find((task) => task.id === 'website')?.title).toBe(
      'build the website',
    );
  });

  it('does not edit a task from another account even if its id is supplied', () => {
    expect(updateDemoTask(demoWorkspaces, 'work', 'website', { completed: true })).toEqual(
      demoWorkspaces,
    );
  });

  it('shares the same edited data between shortcuts and views', () => {
    const edited = updateDemoTask(demoWorkspaces, 'personal', 'small-start', {
      starred: true,
      day: demoToday,
      notes: 'read through the first draft',
      labels: ['writing'],
    }).personal;
    expect(selectDemoTasks(edited, 'today', 'first draft').map((task) => task.id)).toEqual([
      'small-start',
    ]);
    expect(selectDemoTasks(edited, 'starred', 'writing').map((task) => task.id)).toEqual([
      'small-start',
    ]);
    expect(
      selectDemoTasks(
        edited.map((task) => (task.id === 'small-start' ? { ...task, completed: true } : task)),
        'starred',
        'first draft',
      ),
    ).toEqual([]);
  });

  it('searches titles, notes, lists and label names within the selected scope', () => {
    expect(selectDemoTasks(demoTasks, 'all', ' SINGLE PAGE ').map((task) => task.id)).toEqual([
      'small-start',
    ]);
    expect(selectDemoTasks(demoTasks, 'all', 'launch').map((task) => task.id)).toEqual([
      'website',
      'walkthrough',
    ]);
    expect(selectDemoTasks(demoTasks, 'starred', 'ideas')).toEqual([]);
    expect(selectDemoTasks(demoTasks, 'all', 'website').map((task) => task.id)).toEqual([
      'website',
    ]);
  });
});
