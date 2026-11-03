import { describe, expect, it } from 'vitest';
import {
  CalendarDateSchema,
  LocalTimeSchema,
  RepeatRuleSchema,
  TaskScheduleSchema,
  TemplateScheduleSchema,
  TimeZoneSchema,
  type RepeatRule,
} from './planning-contract';
import {
  accountToday,
  addCalendarDays,
  calendarDayDifference,
  latestTemplateSlot,
  nextOccurrence,
  nextTemplateSlot,
  wallClockInstant,
} from './planning';

function rule(input: Partial<RepeatRule> = {}): RepeatRule {
  return RepeatRuleSchema.parse({
    frequency: 'daily',
    interval: 1,
    anchorDay: '2026-01-01',
    zone: 'Europe/Istanbul',
    weekStart: 1,
    weekdays: [],
    end: { type: 'never' },
    ...input,
  });
}

function next(repeat: RepeatRule, after: string, notBefore = after, createdCount = 1) {
  return nextOccurrence(repeat, { after, notBefore, createdCount });
}

describe('planning boundary validation', () => {
  it('accepts a real iso calendar date and rejects normalized invalid dates', () => {
    expect(CalendarDateSchema.parse('2024-02-29')).toBe('2024-02-29');
    for (const invalid of [
      '2026-02-29',
      '2026-04-31',
      '26-01-01',
      '2026-1-01',
      '2026-01-01T00:00:00Z',
    ]) {
      expect(CalendarDateSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('keeps wall-clock input minute-precision and rejects invalid or offset times', () => {
    expect(LocalTimeSchema.parse('23:59')).toBe('23:59');
    for (const invalid of ['24:00', '12:60', '9:00', '12:00:00', '12:00Z']) {
      expect(LocalTimeSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('accepts named zones and rejects an invalid zone or fixed offset', () => {
    expect(TimeZoneSchema.parse('America/New_York')).toBe('America/New_York');
    expect(TimeZoneSchema.parse('UTC')).toBe('UTC');
    expect(TimeZoneSchema.safeParse('Mars/Olympus').success).toBe(false);
    expect(TimeZoneSchema.safeParse('+03:00').success).toBe(false);
  });

  it('requires a scheduled day before a time or a repeat rule', () => {
    expect(TaskScheduleSchema.safeParse({ scheduledTime: '09:00', timeZone: 'UTC' }).success).toBe(
      false,
    );
    expect(TaskScheduleSchema.safeParse({ repeatRule: rule() }).success).toBe(false);
    expect(
      TaskScheduleSchema.parse({
        scheduledDay: '2026-01-01',
        scheduledTime: '09:00',
        timeZone: 'UTC',
      }),
    ).toMatchObject({ scheduledTime: '09:00' });
  });

  it('requires a named zone for timed tasks', () => {
    expect(
      TaskScheduleSchema.safeParse({ scheduledDay: '2026-01-01', scheduledTime: '09:00' }).success,
    ).toBe(false);
  });

  it('rejects empty or duplicate weekly selections and out-of-bound intervals', () => {
    expect(
      RepeatRuleSchema.safeParse({ ...rule(), frequency: 'weekly', weekdays: [] }).success,
    ).toBe(false);
    expect(
      RepeatRuleSchema.safeParse({ ...rule(), frequency: 'weekly', weekdays: [1, 1] }).success,
    ).toBe(false);
    for (const interval of [0, -1, 1.5, 366]) {
      expect(RepeatRuleSchema.safeParse({ ...rule(), interval }).success).toBe(false);
    }
  });

  it('validates end-day and created-count limits', () => {
    expect(
      RepeatRuleSchema.safeParse({ ...rule(), end: { type: 'date', day: '2025-12-31' } }).success,
    ).toBe(false);
    for (const count of [0, 10_001, 1.5]) {
      expect(RepeatRuleSchema.safeParse({ ...rule(), end: { type: 'count', count } }).success).toBe(
        false,
      );
    }
    expect(
      RepeatRuleSchema.parse({ ...rule(), end: { type: 'date', day: '2026-01-01' } }).end,
    ).toEqual({ type: 'date', day: '2026-01-01' });
  });
});

describe('calendar days', () => {
  it('calculates today in the stored account zone, not the browser zone', () => {
    const instant = '2026-03-08T07:30:00Z';
    expect(accountToday('America/Los_Angeles', instant)).toBe('2026-03-07');
    expect(accountToday('Asia/Tokyo', instant)).toBe('2026-03-08');
  });

  it('adds calendar days without crossing a date through a midnight conversion', () => {
    expect(addCalendarDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(addCalendarDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(calendarDayDifference('2026-03-07', '2026-03-09')).toBe(2);
    expect(calendarDayDifference('2026-03-09', '2026-03-07')).toBe(-2);
  });

  it('does not truncate a fractional calendar-day offset', () => {
    expect(() => addCalendarDays('2026-01-01', 1.5)).toThrow(RangeError);
  });
});

describe('successor dates', () => {
  it('chooses the first interval date strictly after the completed occurrence', () => {
    expect(next(rule({ interval: 3 }), '2026-01-01')).toBe('2026-01-04');
    expect(next(rule({ interval: 3 }), '2026-01-04')).toBe('2026-01-07');
  });

  it('skips missed days without spending the created-occurrence count', () => {
    const repeat = rule({ interval: 3, end: { type: 'count', count: 2 } });
    expect(next(repeat, '2026-01-01', '2026-02-01', 1)).toBe('2026-02-03');
    expect(next(repeat, '2026-02-03', '2026-02-03', 2)).toBeNull();
  });

  it('can use today when it is an eligible day after the completed occurrence', () => {
    expect(next(rule(), '2026-01-01', '2026-01-10')).toBe('2026-01-10');
  });

  it('skips weekends for the weekdays preset', () => {
    const repeat = rule({ frequency: 'weekdays', anchorDay: '2026-01-02' });
    expect(next(repeat, '2026-01-02')).toBe('2026-01-05');
    expect(next(repeat, '2026-01-05')).toBe('2026-01-06');
  });

  it('counts only eligible weekdays for a weekday interval', () => {
    const repeat = rule({ frequency: 'weekdays', interval: 2, anchorDay: '2026-01-02' });
    expect(next(repeat, '2026-01-02')).toBe('2026-01-06');
    expect(next(repeat, '2026-01-06')).toBe('2026-01-08');
    expect(next(repeat, '2026-01-08')).toBe('2026-01-12');
  });

  it('can anchor an initial task on a weekend without repeating on weekends', () => {
    expect(next(rule({ frequency: 'weekdays', anchorDay: '2026-01-03' }), '2026-01-03')).toBe(
      '2026-01-05',
    );
    expect(
      next(rule({ frequency: 'weekdays', interval: 2, anchorDay: '2026-01-04' }), '2026-01-04'),
    ).toBe('2026-01-06');
  });

  it('advances past a missed weekend without shifting the weekday interval', () => {
    const repeat = rule({ frequency: 'weekdays', interval: 2, anchorDay: '2026-01-02' });
    expect(next(repeat, '2026-01-06', '2026-01-17')).toBe('2026-01-20');
  });

  it('retains selected weekdays inside interval weeks anchored to monday', () => {
    const repeat = rule({
      frequency: 'weekly',
      interval: 2,
      anchorDay: '2026-01-07',
      weekdays: [1, 5],
    });
    expect(next(repeat, '2026-01-07')).toBe('2026-01-09');
    expect(next(repeat, '2026-01-09')).toBe('2026-01-19');
    expect(next(repeat, '2026-01-19')).toBe('2026-01-23');
  });

  it('uses the captured sunday week start for interval grouping', () => {
    const repeat = rule({
      frequency: 'weekly',
      interval: 2,
      anchorDay: '2026-01-04',
      weekdays: [1, 7],
      weekStart: 7,
    });
    expect(next(repeat, '2026-01-04')).toBe('2026-01-05');
    expect(next(repeat, '2026-01-05')).toBe('2026-01-18');
  });

  it('does not recreate the initial task when selected weekdays precede the anchor', () => {
    const repeat = rule({ frequency: 'weekly', anchorDay: '2026-01-07', weekdays: [1] });
    expect(next(repeat, '2026-01-07')).toBe('2026-01-12');
  });

  it('orders weekday selections by the captured week, independent of input order', () => {
    const repeat = rule({
      frequency: 'weekly',
      interval: 2,
      anchorDay: '2026-01-07',
      weekdays: [5, 1],
    });
    expect(next(repeat, '2026-01-09', '2026-01-20')).toBe('2026-01-23');
  });

  it('clamps february while retaining the original january month-day', () => {
    const repeat = rule({ frequency: 'monthly', anchorDay: '2026-01-31' });
    expect(next(repeat, '2026-01-31')).toBe('2026-02-28');
    expect(next(repeat, '2026-02-28')).toBe('2026-03-31');
    expect(next(repeat, '2026-03-31')).toBe('2026-04-30');
  });

  it('keeps monthly intervals relative to the anchor when skipping years of missed dates', () => {
    const repeat = rule({ frequency: 'monthly', interval: 3, anchorDay: '2020-01-31' });
    expect(next(repeat, '2020-04-30', '2026-02-01')).toBe('2026-04-30');
  });

  it('restores february 29 in a later leap year', () => {
    const repeat = rule({ frequency: 'yearly', anchorDay: '2024-02-29' });
    expect(next(repeat, '2024-02-29')).toBe('2025-02-28');
    expect(next(repeat, '2025-02-28', '2028-01-01')).toBe('2028-02-29');
  });

  it('includes a rule end day and then finishes the series', () => {
    const repeat = rule({ end: { type: 'date', day: '2026-01-03' } });
    expect(next(repeat, '2026-01-02')).toBe('2026-01-03');
    expect(next(repeat, '2026-01-03')).toBeNull();
    expect(next(repeat, '2026-01-01', '2026-01-04')).toBeNull();
  });

  it('finishes immediately when the initial occurrence consumes the count limit', () => {
    expect(next(rule({ end: { type: 'count', count: 1 } }), '2026-01-01')).toBeNull();
  });

  it('rejects a created count that omits the initial occurrence', () => {
    expect(() => next(rule(), '2026-01-01', '2026-01-01', 0)).toThrow(RangeError);
  });
});

describe('wall-clock resolution', () => {
  it('uses the first valid instant after a one-hour daylight-saving gap', () => {
    expect(wallClockInstant('2026-03-08', '02:30', 'America/New_York')).toBe(
      '2026-03-08T07:00:00Z',
    );
    expect(wallClockInstant('2026-03-09', '02:30', 'America/New_York')).toBe(
      '2026-03-09T06:30:00Z',
    );
  });

  it('chooses the earlier occurrence of a repeated local time', () => {
    expect(wallClockInstant('2026-11-01', '01:30', 'America/New_York')).toBe(
      '2026-11-01T05:30:00Z',
    );
  });

  it('handles a half-hour gap without assuming a sixty-minute transition', () => {
    expect(wallClockInstant('2026-10-04', '02:15', 'Australia/Lord_Howe')).toBe(
      '2026-10-03T15:30:00Z',
    );
  });

  it('resolves a completely skipped local day to the first valid following instant', () => {
    expect(wallClockInstant('2011-12-30', '12:00', 'Pacific/Apia')).toBe('2011-12-30T10:00:00Z');
  });
});

describe('template schedule slots', () => {
  const weekly = () =>
    TemplateScheduleSchema.parse({
      frequency: 'weekly',
      weekday: 1,
      zone: 'Europe/Istanbul',
      startsOn: '2026-01-01',
    });
  const monthly = () =>
    TemplateScheduleSchema.parse({
      frequency: 'monthly',
      dayOfMonth: 28,
      zone: 'Europe/Istanbul',
      startsOn: '2026-01-01',
    });

  it('allows only the documented weekly and monthly slots', () => {
    expect(
      TemplateScheduleSchema.safeParse({
        frequency: 'weekly',
        weekday: 0,
        zone: 'UTC',
        startsOn: '2026-01-01',
      }).success,
    ).toBe(false);
    expect(
      TemplateScheduleSchema.safeParse({
        frequency: 'monthly',
        dayOfMonth: 29,
        zone: 'UTC',
        startsOn: '2026-01-01',
      }).success,
    ).toBe(false);
  });

  it('finds only the latest weekly missed slot instead of producing a backlog', () => {
    expect(latestTemplateSlot(weekly(), { notAfter: '2026-03-25', after: '2026-01-05' })).toBe(
      '2026-03-23',
    );
    expect(
      latestTemplateSlot(weekly(), { notAfter: '2026-03-23', after: '2026-03-23' }),
    ).toBeNull();
  });

  it('does not admit a slot earlier than schedule creation', () => {
    const schedule = TemplateScheduleSchema.parse({ ...weekly(), startsOn: '2026-01-06' });
    expect(latestTemplateSlot(schedule, { notAfter: '2026-01-10' })).toBeNull();
    expect(nextTemplateSlot(schedule, { after: '2026-01-01' })).toBe('2026-01-12');
  });

  it('chooses a current-day slot inclusively but calculates the next one strictly later', () => {
    expect(latestTemplateSlot(weekly(), { notAfter: '2026-01-05' })).toBe('2026-01-05');
    expect(nextTemplateSlot(weekly(), { after: '2026-01-05' })).toBe('2026-01-12');
  });

  it('finds monthly slots across year boundaries and respects the last admitted slot', () => {
    expect(latestTemplateSlot(monthly(), { notAfter: '2027-01-03' })).toBe('2026-12-28');
    expect(
      latestTemplateSlot(monthly(), { notAfter: '2027-01-27', after: '2026-12-28' }),
    ).toBeNull();
    expect(nextTemplateSlot(monthly(), { after: '2026-12-28' })).toBe('2027-01-28');
  });
});
