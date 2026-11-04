import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

function isCalendarDate(value: string): boolean {
  try {
    return Temporal.PlainDate.from(value).toString() === value;
  } catch {
    return false;
  }
}

function isNamedTimeZone(value: string): boolean {
  if (/^[+-]/.test(value) || value === 'Z') return false;
  try {
    Temporal.ZonedDateTime.from({ timeZone: value, year: 2000, month: 1, day: 1 });
    return true;
  } catch {
    return false;
  }
}

export const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use yyyy-mm-dd')
  .refine(isCalendarDate, 'use a valid calendar date');
export const CalendarDaySchema = CalendarDateSchema;
export const LocalTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'use hh:mm');
export const WallTimeSchema = LocalTimeSchema;
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isNamedTimeZone, 'use a named iana time zone');
export type CalendarDay = z.infer<typeof CalendarDateSchema>;
export type LocalTime = z.infer<typeof LocalTimeSchema>;
export type TimeZone = z.infer<typeof TimeZoneSchema>;

const RepeatEndSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('never') }).strict(),
  z.object({ type: z.literal('date'), day: CalendarDateSchema }).strict(),
  z.object({ type: z.literal('count'), count: z.number().int().min(1).max(10_000) }).strict(),
]);

export const RepeatRuleSchema = z
  .object({
    frequency: z.enum(['daily', 'weekdays', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).max(365).default(1),
    anchorDay: CalendarDateSchema,
    zone: TimeZoneSchema,
    weekStart: z.union([z.literal(1), z.literal(7)]).default(1),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    end: RepeatEndSchema.default({ type: 'never' }),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.frequency === 'weekly' && rule.weekdays.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['weekdays'],
        message: 'choose at least one weekday',
      });
    }
    if (new Set(rule.weekdays).size !== rule.weekdays.length) {
      context.addIssue({ code: 'custom', path: ['weekdays'], message: 'choose each weekday once' });
    }
    if (rule.end.type === 'date' && rule.end.day < rule.anchorDay) {
      context.addIssue({
        code: 'custom',
        path: ['end', 'day'],
        message: 'the end day cannot precede the anchor',
      });
    }
  });
export type RepeatRule = z.infer<typeof RepeatRuleSchema>;

export const TaskScheduleSchema = z
  .object({
    scheduledDay: CalendarDateSchema.nullable().default(null),
    scheduledTime: LocalTimeSchema.nullable().default(null),
    timeZone: TimeZoneSchema.nullable().default(null),
    repeatRule: RepeatRuleSchema.nullable().default(null),
  })
  .strict()
  .superRefine((schedule, context) => {
    if (
      !schedule.scheduledDay &&
      (schedule.scheduledTime || schedule.timeZone || schedule.repeatRule)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scheduledDay'],
        message: 'choose a day before adding time or repetition',
      });
    }
    if (schedule.scheduledTime && !schedule.timeZone) {
      context.addIssue({
        code: 'custom',
        path: ['timeZone'],
        message: 'choose a time zone for the local time',
      });
    }
  });
export type TaskSchedule = z.infer<typeof TaskScheduleSchema>;

export const TemplateScheduleSchema = z.discriminatedUnion('frequency', [
  z
    .object({
      frequency: z.literal('weekly'),
      weekday: z.number().int().min(1).max(7),
      zone: TimeZoneSchema,
      startsOn: CalendarDateSchema,
    })
    .strict(),
  z
    .object({
      frequency: z.literal('monthly'),
      dayOfMonth: z.number().int().min(1).max(28),
      zone: TimeZoneSchema,
      startsOn: CalendarDateSchema,
    })
    .strict(),
]);
export type TemplateSchedule = z.infer<typeof TemplateScheduleSchema>;
