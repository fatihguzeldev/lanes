import { describe, expect, it } from 'vitest';
import type { Task, TaskList } from '../../../../tasks/contracts/task';
import { HistoryEventSchema } from '../../../contracts/events';
import {
  groupCompletedTasks,
  sevenDayCompletionSummary,
  groupHistoryEventsByDay,
} from '../completed';

const options = {
  accountId: 'a',
  zone: 'Europe/Istanbul',
  weekStart: 1 as const,
  now: '2026-11-04T12:00:00Z',
};
function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    accountId: 'a',
    listId: 'list-a',
    parentId: null,
    title: id,
    notes: '',
    completed: true,
    completedAt: '2026-11-04T10:00:00Z',
    scheduledDay: null,
    scheduledTime: null,
    timeZone: null,
    repeatRule: null,
    seriesId: null,
    occurrenceId: null,
    labelIds: [],
    priority: 'none',
    starred: false,
    blockedBy: [],
    revision: 1,
    provider: { id, listId: 'google-list', etag: null, position: null, updatedAt: null },
    unsupportedHierarchy: false,
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
    ...overrides,
  };
}
const list: TaskList = {
  id: 'list-a',
  accountId: 'a',
  providerId: 'google-list',
  providerEtag: null,
  title: 'writing',
  isDefault: false,
  revision: 1,
};

describe('completed task groups', () => {
  it('makes today, yesterday, this week and earlier mutually exclusive', () => {
    const groups = groupCompletedTasks(
      [
        task('today'),
        task('yesterday', { completedAt: '2026-11-03T10:00:00Z' }),
        task('week', { completedAt: '2026-11-02T10:00:00Z' }),
        task('earlier', { completedAt: '2026-10-31T10:00:00Z' }),
      ],
      options,
    );
    expect(groups.map((group) => [group.key, group.items.map((item) => item.task.id)])).toEqual([
      ['today', ['today']],
      ['yesterday', ['yesterday']],
      ['this_week', ['week']],
      ['earlier', ['earlier']],
    ]);
  });
  it('uses the configured week start without moving yesterday into another group', () => {
    const tasks = [
      task('sunday', { completedAt: '2026-11-01T10:00:00Z' }),
      task('yesterday', { completedAt: '2026-11-03T10:00:00Z' }),
    ];
    expect(
      groupCompletedTasks(tasks, options).find((group) => group.key === 'earlier')?.items[0]?.task
        .id,
    ).toBe('sunday');
    expect(
      groupCompletedTasks(tasks, { ...options, weekStart: 7 }).find(
        (group) => group.key === 'this_week',
      )?.items[0]?.task.id,
    ).toBe('sunday');
    expect(
      groupCompletedTasks(tasks, { ...options, weekStart: 7 }).find(
        (group) => group.key === 'yesterday',
      )?.items[0]?.task.id,
    ).toBe('yesterday');
  });
  it('groups by account zone rather than browser zone or UTC day', () => {
    const tasks = [task('late', { completedAt: '2026-11-02T01:00:00Z' })];
    const now = '2026-11-02T20:00:00Z';
    expect(
      groupCompletedTasks(tasks, { ...options, now, zone: 'America/Los_Angeles' })[0]?.key,
    ).toBe('yesterday');
    expect(groupCompletedTasks(tasks, { ...options, now, zone: 'Europe/Berlin' })[0]?.key).toBe(
      'today',
    );
  });
  it('keeps a 25-hour daylight-saving yesterday on its calendar day', () => {
    const tasks = [task('dst', { completedAt: '2026-10-24T22:30:00Z' })];
    const result = groupCompletedTasks(tasks, {
      ...options,
      now: '2026-10-25T23:30:00Z',
      zone: 'Europe/Berlin',
    });
    expect(result[0]?.key).toBe('yesterday');
    expect(result[0]?.items[0]?.completedDay).toBe('2026-10-25');
  });
  it('keeps unknown, invalid and future completion days separate without inventing dates', () => {
    const groups = groupCompletedTasks(
      [
        task('unknown', { completedAt: null }),
        task('invalid', { completedAt: 'not a timestamp' }),
        task('future', { completedAt: '2026-11-05T10:00:00Z' }),
      ],
      options,
    );
    expect(
      groups
        .find((group) => group.key === 'unknown_time')
        ?.items.map((item) => item.task.id)
        .sort(),
    ).toEqual(['invalid', 'unknown']);
    expect(groups.find((group) => group.key === 'future')?.items[0]?.completedDay).toBe(
      '2026-11-05',
    );
  });
  it('deduplicates current state by account identity and latest revision so reopening removes counts', () => {
    const tasks = [
      task('same'),
      task('same', { revision: 2, completed: false, completedAt: null }),
      task('foreign', { accountId: 'b' }),
    ];
    expect(groupCompletedTasks(tasks, options)).toEqual([]);
    expect(sevenDayCompletionSummary(tasks, options).total).toBe(0);
  });
  it('includes subtasks once and preserves an open parent as context', () => {
    const tasks = [
      task('parent', { completed: false, completedAt: null, title: 'the article' }),
      task('child', { parentId: 'parent', title: 'one last read' }),
    ];
    const groups = groupCompletedTasks(tasks, { ...options, query: 'ARTICLE', lists: [list] });
    expect(groups[0]?.items).toHaveLength(1);
    expect(groups[0]?.items[0]?.parent?.id).toBe('parent');
    expect(groups[0]?.items[0]?.list?.title).toBe('writing');
    expect(sevenDayCompletionSummary(tasks, options).total).toBe(1);
  });
  it('filters by task, parent and list names and never includes another account implicitly', () => {
    const tasks = [
      task('one', { title: 'A Draft' }),
      task('two', { listId: 'other' }),
      task('foreign', { accountId: 'b', title: 'A Draft' }),
    ];
    expect(
      groupCompletedTasks(tasks, { ...options, query: 'draft' })[0]?.items.map(
        (item) => item.task.id,
      ),
    ).toEqual(['one']);
    expect(
      groupCompletedTasks(tasks, { ...options, query: 'WRITING', lists: [list] })[0]?.items.map(
        (item) => item.task.id,
      ),
    ).toEqual(['one']);
    expect(groupCompletedTasks(tasks, { ...options, listIds: [] })).toEqual([]);
  });
});

describe('seven-day current completion summary', () => {
  it('always emits seven local calendar days, including empty days', () => {
    const summary = sevenDayCompletionSummary([], {
      ...options,
      now: '2026-10-25T23:30:00Z',
      zone: 'Europe/Berlin',
    });
    expect(summary.days.map((day) => day.day)).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(summary.total).toBe(0);
  });
  it('counts current completed parents and children once by day and list', () => {
    const tasks = [
      task('parent'),
      task('child', { parentId: 'parent' }),
      task('other', { listId: 'list-b' }),
      task('old', { completedAt: '2026-10-01T10:00:00Z' }),
      task('unknown', { completedAt: null }),
    ];
    const summary = sevenDayCompletionSummary(tasks, options);
    expect(summary.total).toBe(3);
    expect(summary.days.at(-1)).toMatchObject({
      day: '2026-11-04',
      count: 3,
      lists: [
        { listId: 'list-a', count: 2 },
        { listId: 'list-b', count: 1 },
      ],
    });
    expect(summary.unknownTimeCount).toBe(1);
    expect(summary.outsideWindowCount).toBe(1);
    expect(summary.countingRule).toBe('current_completed_tasks_including_subtasks');
  });
  it('does not assign unknown or future days to the summary window', () => {
    const summary = sevenDayCompletionSummary(
      [
        task('unknown', { completedAt: null }),
        task('future', { completedAt: '2026-11-10T10:00:00Z' }),
      ],
      options,
    );
    expect(summary.total).toBe(0);
    expect(summary.unknownTimeCount).toBe(1);
    expect(summary.outsideWindowCount).toBe(1);
  });
});

describe('history day presentation', () => {
  it('groups immutable recorded instants in the account zone and deduplicates page overlap', () => {
    const event = HistoryEventSchema.parse({
      id: 'one',
      accountId: 'a',
      taskId: 'task',
      listId: 'list-a',
      kind: 'task_completed',
      origin: 'owner',
      dedupKey: 'op:step:complete',
      recordedAt: '2026-11-02T01:00:00Z',
      taskTitle: 'task',
      listTitle: 'list',
      summary: { operationId: 'op', stepKey: 'step', completedAt: null },
    });
    const foreign = { ...event, id: 'foreign', accountId: 'other' };
    const groups = groupHistoryEventsByDay([event, event, foreign], {
      accountId: 'a',
      zone: 'America/Los_Angeles',
    });
    expect(groups.map((group) => [group.day, group.events.map((event) => event.id)])).toEqual([
      ['2026-11-01', ['one']],
    ]);
    expect(event.recordedAt).toBe('2026-11-02T01:00:00Z');
  });
});
