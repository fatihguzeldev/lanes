import { describe, expect, it } from 'vitest';
import { TaskSchema, type Task } from '../../../../tasks/contracts/task';
import {
  calendarCreateIntent,
  calendarGrid,
  calendarRange,
  groupCalendarTasks,
  moveCalendarCursor,
} from '../calendar-model';

function task(input: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id: 'task',
    accountId: 'account',
    listId: 'list',
    parentId: null,
    title: 'a task',
    notes: '',
    completed: false,
    completedAt: null,
    seriesId: null,
    occurrenceId: null,
    labelIds: [],
    priority: 'none',
    starred: false,
    blockedBy: [],
    revision: 1,
    provider: {
      id: 'google-task',
      listId: 'google-list',
      etag: null,
      position: '1',
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
    unsupportedHierarchy: false,
    ...input,
  });
}

const period = { accountId: 'account', from: '2026-11-01', to: '2026-11-30' };

describe('calendar creation destination', () => {
  it('uses the explicitly selected list and keeps the selected day without choosing another list', () => {
    expect(
      calendarCreateIntent(
        'account',
        'board',
        { id: 'chosen', accountId: 'account', boardId: 'board' },
        '2026-11-03',
      ),
    ).toEqual({ accountId: 'account', listId: 'chosen', scheduledDay: '2026-11-03' });
    expect(
      calendarCreateIntent(
        'account',
        'board',
        { id: 'chosen', accountId: 'account', boardId: 'board' },
        null,
      )?.scheduledDay,
    ).toBeNull();
  });

  it('refuses a stale board selection or a list from another account', () => {
    expect(
      calendarCreateIntent(
        'account',
        'board',
        { id: 'chosen', accountId: 'other', boardId: 'board' },
        '2026-11-03',
      ),
    ).toBeNull();
    expect(
      calendarCreateIntent(
        'account',
        'board',
        { id: 'chosen', accountId: 'account', boardId: 'old-board' },
        '2026-11-03',
      ),
    ).toBeNull();
  });
});

describe('calendar grid composition', () => {
  it('starts a monday week on monday and includes exactly seven calendar days', () => {
    const grid = calendarGrid('2026-11-04', 'week', 1);
    expect(grid.flat().map((day) => day.date)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
  });

  it('uses the account sunday week start instead of the browser default', () => {
    expect(calendarRange('2026-11-04', 'week', 7)).toEqual({
      from: '2026-11-01',
      to: '2026-11-07',
    });
  });

  it('covers a six-week month with adjacent-month dates', () => {
    const grid = calendarGrid('2026-11-15', 'month', 1);
    expect(grid).toHaveLength(6);
    expect(grid.every((row) => row.length === 7)).toBe(true);
    expect(calendarRange('2026-11-15', 'month', 1)).toEqual({
      from: '2026-10-26',
      to: '2026-12-06',
    });
    expect(grid.flat().filter((day) => day.inMonth)).toHaveLength(30);
  });

  it('does not add empty weeks to a four-week month and retains leap day', () => {
    expect(calendarGrid('2021-02-11', 'month', 1)).toHaveLength(4);
    const leapMonth = calendarGrid('2024-02-11', 'month', 1);
    expect(leapMonth).toHaveLength(5);
    expect(leapMonth.flat().some((day) => day.date === '2024-02-29' && day.inMonth)).toBe(true);
  });

  it('navigates months by calendar month and weeks by calendar days', () => {
    expect(moveCalendarCursor('2026-01-31', 'month', 1)).toBe('2026-02-01');
    expect(moveCalendarCursor('2026-01-31', 'month', -1)).toBe('2025-12-01');
    expect(moveCalendarCursor('2026-12-28', 'week', 1)).toBe('2027-01-04');
  });
});

describe('calendar task composition', () => {
  it('places date-only tasks on their stored day without converting midnight', () => {
    const dated = task({ scheduledDay: '2026-11-02' });
    const result = groupCalendarTasks([dated], period);
    expect(result.byDay.get('2026-11-02')?.dateOnly.map((item) => item.id)).toEqual(['task']);
    expect(result.byDay.get('2026-11-01')).toBeUndefined();
  });

  it('keeps a timed task on its stored day even when its zone would cross a date elsewhere', () => {
    const dated = task({
      scheduledDay: '2026-11-02',
      scheduledTime: '00:30',
      timeZone: 'Pacific/Auckland',
    });
    const result = groupCalendarTasks([dated], period);
    expect(result.byDay.get('2026-11-02')?.timed.map((item) => item.id)).toEqual(['task']);
    expect(result.byDay.get('2026-11-01')).toBeUndefined();
  });

  it('separates date-only work from timed work and sorts stored local times', () => {
    const a = task({
      id: 'afternoon',
      scheduledDay: '2026-11-02',
      scheduledTime: '15:00',
      timeZone: 'UTC',
    });
    const b = task({
      id: 'morning',
      scheduledDay: '2026-11-02',
      scheduledTime: '08:00',
      timeZone: 'Asia/Tokyo',
    });
    const c = task({ id: 'day-only', scheduledDay: '2026-11-02' });
    const bucket = groupCalendarTasks([a, b, c], period).byDay.get('2026-11-02');
    expect(bucket?.dateOnly.map((item) => item.id)).toEqual(['day-only']);
    expect(bucket?.timed.map((item) => item.id)).toEqual(['morning', 'afternoon']);
  });

  it('preserves dated subtasks as their own entries', () => {
    const parent = task({ id: 'parent', scheduledDay: '2026-11-02' });
    const child = task({ id: 'child', parentId: 'parent', scheduledDay: '2026-11-03' });
    const result = groupCalendarTasks([parent, child], period);
    expect(result.byDay.get('2026-11-03')?.dateOnly[0]?.parentId).toBe('parent');
  });

  it('keeps undated work separate and omits dated records outside the visible range', () => {
    const unscheduled = task({ id: 'undated' });
    const outside = task({ id: 'outside', scheduledDay: '2026-12-01' });
    const result = groupCalendarTasks([unscheduled, outside], period);
    expect(result.unscheduled.map((item) => item.id)).toEqual(['undated']);
    expect(result.byDay.size).toBe(0);
  });

  it('does not leak another account and chooses the newest revision after page overlap', () => {
    const old = task({ scheduledDay: '2026-11-02' });
    const newer = task({ revision: 2, scheduledDay: '2026-11-03' });
    const foreign = task({ id: 'foreign', accountId: 'other', scheduledDay: '2026-11-02' });
    const result = groupCalendarTasks([old, newer, foreign], period);
    expect(result.byDay.get('2026-11-02')).toBeUndefined();
    expect(result.byDay.get('2026-11-03')?.dateOnly.map((item) => item.id)).toEqual(['task']);
  });

  it('does not turn a search parent-context record into a second matching event', () => {
    const parent = task({ id: 'parent', scheduledDay: '2026-11-02' });
    const child = task({ id: 'child', parentId: 'parent', scheduledDay: '2026-11-03' });
    const result = groupCalendarTasks([parent, child], {
      ...period,
      matchedTaskIds: new Set(['child']),
    });
    expect(result.byDay.has('2026-11-02')).toBe(false);
    expect(result.byDay.get('2026-11-03')?.dateOnly.map((item) => item.id)).toEqual(['child']);
  });
});
