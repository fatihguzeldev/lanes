import { describe, expect, it } from 'vitest';
import { buildCalendarQueries } from '../calendar-queries';

const base = {
  accountId: 'account',
  boardId: 'board',
  scope: 'board' as const,
  range: { from: '2026-10-26', to: '2026-12-06' },
  today: '2026-11-02',
  filter: {},
  query: 'paper',
  sort: 'manual' as const,
};
describe('calendar query composition', () => {
  it('queries only the displayed range and a separately paged unscheduled section', () => {
    const queries = buildCalendarQueries(base);
    expect(queries.dated).toMatchObject({
      boardId: 'board',
      query: 'paper',
      filter: { scheduled: { kind: 'range', from: base.range.from, to: base.range.to } },
    });
    expect(queries.unscheduled).toMatchObject({
      boardId: 'board',
      filter: { scheduled: { kind: 'none' } },
    });
    expect(buildCalendarQueries({ ...base, scope: 'account' }).dated).not.toHaveProperty('boardId');
  });
  it('intersects date filters instead of replacing them when navigating', () => {
    expect(
      buildCalendarQueries({ ...base, filter: { scheduled: { kind: 'today' } } }),
    ).toMatchObject({
      dated: { filter: { scheduled: { kind: 'range', from: base.today, to: base.today } } },
      unscheduled: null,
    });
    expect(
      buildCalendarQueries({ ...base, filter: { scheduled: { kind: 'overdue' } } }).dated?.filter
        ?.scheduled,
    ).toEqual({ kind: 'range', from: base.range.from, to: '2026-11-01' });
    expect(
      buildCalendarQueries({
        ...base,
        filter: { scheduled: { kind: 'range', from: '2027-01-01', to: '2027-01-02' } },
      }).dated,
    ).toBeNull();
    expect(
      buildCalendarQueries({ ...base, filter: { scheduled: { kind: 'none' } } }).dated,
    ).toBeNull();
  });
  it('keeps other filters and refuses an impossible completed-overdue selection', () => {
    expect(
      buildCalendarQueries({
        ...base,
        filter: { starred: true, priorities: ['high'], scheduled: { kind: 'today' } },
      }).dated?.filter,
    ).toMatchObject({ starred: true, priorities: ['high'] });
    expect(
      buildCalendarQueries({
        ...base,
        filter: { completion: 'completed', scheduled: { kind: 'overdue' } },
      }).dated,
    ).toBeNull();
  });
});
