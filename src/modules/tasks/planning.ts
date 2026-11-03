import { Temporal } from '@js-temporal/polyfill';
import type { RepeatRule, TemplateSchedule } from './planning-contract';

export interface NextOccurrenceQuery {
  after: string;
  notBefore: string;
  createdCount: number;
}

export interface LatestTemplateSlotQuery {
  notAfter: string;
  after?: string;
}

export interface NextTemplateSlotQuery {
  after: string;
}

function dayString(day: Temporal.PlainDate): string {
  if (day.year < 0 || day.year > 9999) {
    throw new RangeError('the resulting day is outside the supported iso date range');
  }
  return day.toString();
}

function laterDay(...days: Temporal.PlainDate[]): Temporal.PlainDate {
  return days.reduce((latest, day) => (Temporal.PlainDate.compare(day, latest) > 0 ? day : latest));
}

export function accountToday(zone: string, nowInstant?: string): string {
  const now = nowInstant === undefined ? Temporal.Now.instant() : Temporal.Instant.from(nowInstant);
  return dayString(now.toZonedDateTimeISO(zone).toPlainDate());
}

export function addCalendarDays(day: string, delta: number): string {
  if (!Number.isSafeInteger(delta)) throw new RangeError('calendar-day offsets must be integers');
  return dayString(Temporal.PlainDate.from(day).add({ days: delta }));
}

export function calendarDayDifference(from: string, to: string): number {
  return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: 'day' })
    .days;
}

export function wallClockInstant(day: string, time: string, zone: string): string {
  const local = Temporal.PlainDate.from(day).toPlainDateTime(Temporal.PlainTime.from(time));
  const earlier = local.toZonedDateTime(zone, { disambiguation: 'earlier' });
  if (earlier.toPlainDateTime().equals(local)) return earlier.toInstant().toString();

  // shifting the requested clock time by the gap's duration would return 03:30
  // for a missing 02:30. lanes instead uses the transition's first valid instant.
  const transition = earlier.getTimeZoneTransition('next');
  if (!transition || Temporal.PlainDateTime.compare(transition.toPlainDateTime(), local) < 0) {
    throw new RangeError('the local time gap could not be resolved');
  }
  return transition.toInstant().toString();
}

function dailyDate(
  anchor: Temporal.PlainDate,
  threshold: Temporal.PlainDate,
  interval: number,
): Temporal.PlainDate {
  const days = anchor.until(threshold, { largestUnit: 'day' }).days;
  return anchor.add({ days: Math.ceil(days / interval) * interval });
}

function weekdaysAfter(anchor: Temporal.PlainDate, threshold: Temporal.PlainDate): number {
  const distance = anchor.until(threshold, { largestUnit: 'day' }).days;
  const fullWeeks = Math.floor(distance / 7);
  let weekdays = fullWeeks * 5;
  let day = anchor.add({ days: fullWeeks * 7 });
  for (let remaining = distance % 7; remaining > 0; remaining -= 1) {
    day = day.add({ days: 1 });
    if (day.dayOfWeek <= 5) weekdays += 1;
  }
  return weekdays;
}

function addWeekdays(anchor: Temporal.PlainDate, count: number): Temporal.PlainDate {
  let day = anchor.add({ days: Math.floor(count / 5) * 7 });
  let remaining = count % 5;
  while (remaining > 0) {
    day = day.add({ days: 1 });
    if (day.dayOfWeek <= 5) remaining -= 1;
  }
  return day;
}

function weekdayDate(
  anchor: Temporal.PlainDate,
  threshold: Temporal.PlainDate,
  interval: number,
): Temporal.PlainDate {
  const base = anchor.dayOfWeek > 5 ? anchor.subtract({ days: anchor.dayOfWeek - 5 }) : anchor;
  const distance = weekdaysAfter(base, threshold);
  let count = Math.ceil(Math.max(1, distance) / interval) * interval;
  let candidate = addWeekdays(base, count);
  if (Temporal.PlainDate.compare(candidate, threshold) < 0) {
    count += interval;
    candidate = addWeekdays(base, count);
  }
  return candidate;
}

function weeklyDate(
  rule: RepeatRule,
  anchor: Temporal.PlainDate,
  threshold: Temporal.PlainDate,
): Temporal.PlainDate {
  if (rule.weekdays.length === 0) throw new RangeError('a weekly rule needs selected weekdays');
  const anchorWeek = anchor.subtract({ days: (anchor.dayOfWeek - rule.weekStart + 7) % 7 });
  const weekDistance = Math.floor(anchorWeek.until(threshold, { largestUnit: 'day' }).days / 7);
  const firstWeek = Math.floor(weekDistance / rule.interval) * rule.interval;
  const offsets = rule.weekdays
    .map((weekday) => (weekday - rule.weekStart + 7) % 7)
    .sort((a, b) => a - b);

  // the threshold's active week or the following active week contains the answer.
  for (const week of [firstWeek, firstWeek + rule.interval]) {
    for (const offset of offsets) {
      const candidate = anchorWeek.add({ days: week * 7 + offset });
      if (Temporal.PlainDate.compare(candidate, threshold) >= 0) return candidate;
    }
  }
  throw new RangeError('the weekly rule could not produce an eligible date');
}

function monthlyDate(
  anchor: Temporal.PlainDate,
  threshold: Temporal.PlainDate,
  interval: number,
): Temporal.PlainDate {
  const monthDistance = (threshold.year - anchor.year) * 12 + threshold.month - anchor.month;
  let months = Math.floor(monthDistance / interval) * interval;
  let candidate = anchor.add({ months }, { overflow: 'constrain' });
  if (Temporal.PlainDate.compare(candidate, threshold) < 0) {
    months += interval;
    candidate = anchor.add({ months }, { overflow: 'constrain' });
  }
  return candidate;
}

function yearlyDate(
  anchor: Temporal.PlainDate,
  threshold: Temporal.PlainDate,
  interval: number,
): Temporal.PlainDate {
  const yearDistance = threshold.year - anchor.year;
  let years = Math.floor(yearDistance / interval) * interval;
  let candidate = anchor.add({ years }, { overflow: 'constrain' });
  if (Temporal.PlainDate.compare(candidate, threshold) < 0) {
    years += interval;
    candidate = anchor.add({ years }, { overflow: 'constrain' });
  }
  return candidate;
}

export function nextOccurrence(rule: RepeatRule, query: NextOccurrenceQuery): string | null {
  if (!Number.isSafeInteger(query.createdCount) || query.createdCount < 1) {
    throw new RangeError('createdCount must include the initial occurrence');
  }
  if (rule.end.type === 'count' && query.createdCount >= rule.end.count) return null;
  const anchor = Temporal.PlainDate.from(rule.anchorDay);
  const threshold = laterDay(
    anchor.add({ days: 1 }),
    Temporal.PlainDate.from(query.after).add({ days: 1 }),
    Temporal.PlainDate.from(query.notBefore),
  );
  if (
    rule.end.type === 'date' &&
    Temporal.PlainDate.compare(threshold, Temporal.PlainDate.from(rule.end.day)) > 0
  )
    return null;

  let candidate: Temporal.PlainDate;
  switch (rule.frequency) {
    case 'daily':
      candidate = dailyDate(anchor, threshold, rule.interval);
      break;
    case 'weekdays':
      candidate = weekdayDate(anchor, threshold, rule.interval);
      break;
    case 'weekly':
      candidate = weeklyDate(rule, anchor, threshold);
      break;
    case 'monthly':
      candidate = monthlyDate(anchor, threshold, rule.interval);
      break;
    case 'yearly':
      candidate = yearlyDate(anchor, threshold, rule.interval);
      break;
  }
  const day = dayString(candidate);
  return rule.end.type === 'date' && day > rule.end.day ? null : day;
}

export function latestTemplateSlot(
  schedule: TemplateSchedule,
  query: LatestTemplateSlotQuery,
): string | null {
  const through = Temporal.PlainDate.from(query.notAfter);
  const startsOn = Temporal.PlainDate.from(schedule.startsOn);
  if (Temporal.PlainDate.compare(through, startsOn) < 0) return null;

  let candidate: Temporal.PlainDate;
  if (schedule.frequency === 'weekly') {
    candidate = through.subtract({ days: (through.dayOfWeek - schedule.weekday + 7) % 7 });
  } else {
    candidate = through.with({ day: schedule.dayOfMonth });
    if (Temporal.PlainDate.compare(candidate, through) > 0)
      candidate = candidate.subtract({ months: 1 });
  }
  if (Temporal.PlainDate.compare(candidate, startsOn) < 0) return null;
  const day = dayString(candidate);
  return query.after !== undefined && day <= query.after ? null : day;
}

export function nextTemplateSlot(schedule: TemplateSchedule, query: NextTemplateSlotQuery): string {
  const threshold = laterDay(
    Temporal.PlainDate.from(schedule.startsOn),
    Temporal.PlainDate.from(query.after).add({ days: 1 }),
  );
  let candidate: Temporal.PlainDate;
  if (schedule.frequency === 'weekly') {
    candidate = threshold.add({ days: (schedule.weekday - threshold.dayOfWeek + 7) % 7 });
  } else {
    candidate = threshold.with({ day: schedule.dayOfMonth });
    if (Temporal.PlainDate.compare(candidate, threshold) < 0)
      candidate = candidate.add({ months: 1 });
  }
  return dayString(candidate);
}
