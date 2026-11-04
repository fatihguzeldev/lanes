import { AppError } from '../../../../shared/contracts/errors';
import type { TaskMetadataPatch } from '../../contracts/metadata-commands';
import type { TaskSchedule } from '../../contracts/planning';
import { TaskScheduleSchema } from '../../contracts/planning';
import type { Task } from '../../contracts/task';
import type { TaskRef } from './state';
export const ref = (task: Task): TaskRef => ({
  id: task.id,
  listId: task.listId,
  parentId: task.parentId,
  title: task.title,
  completed: task.completed,
  completedAt: task.completedAt,
  scheduledDay: task.scheduledDay,
  scheduledTime: task.scheduledTime,
  timeZone: task.timeZone,
  repeatRule: task.repeatRule,
  occurrenceId: task.occurrenceId,
  seriesId: task.seriesId,
  revision: task.revision,
  provider: task.provider,
  capabilities: task.capabilities,
});

export const schedule = (task: TaskRef): TaskSchedule => ({
  scheduledDay: task.scheduledDay,
  scheduledTime: task.scheduledTime,
  timeZone: task.timeZone,
  repeatRule: task.repeatRule,
});

export function conflict(
  message = 'this resource changed. refresh its confirmed values before reapplying the draft.',
): AppError {
  return new AppError('conflict', message, 409);
}

export function confirmation(message: string, fields: Record<string, string>): AppError {
  return new AppError('validation_failed', message, 422, false, {
    confirmation: 'required',
    ...fields,
  });
}

export function parseSchedule(value: unknown): TaskSchedule {
  const checked = TaskScheduleSchema.safeParse(value);
  if (!checked.success)
    throw new AppError(
      'validation_failed',
      'check the scheduled day, time, zone and repeat rule.',
      422,
    );
  return checked.data;
}

export async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function metadataPatch(value: TaskMetadataPatch): TaskMetadataPatch {
  return {
    ...(value.labelIds === undefined ? {} : { labelIds: value.labelIds }),
    ...(value.priority === undefined ? {} : { priority: value.priority }),
    ...(value.starred === undefined ? {} : { starred: value.starred }),
    ...(value.blockedBy === undefined ? {} : { blockedBy: value.blockedBy }),
  };
}

export function stableJson(value: unknown): string {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .filter(([, item]) => item !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : input;
  return JSON.stringify(canonical(value));
}

export const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
