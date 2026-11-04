import type { ConnectionSummary } from '../../../accounts/contracts';
import { type BoardTemplateSummary, type TemplateReference } from '../../template-contract';
import { type TemplateCommand } from '../../template-command-contract';
import { type ListTemplateSummary, type TemplateTask } from '../../../tasks/template-contract';
import { addCalendarDays } from '../../../tasks/planning';
import { type Capacity } from './template-client';

export type PersonalTemplate = ListTemplateSummary | BoardTemplateSummary;

export type Kind = PersonalTemplate['kind'];

export type Tab = 'personal' | 'gallery' | 'schedules' | 'runs';

export const ref = (template: PersonalTemplate): TemplateReference => ({
  kind: template.kind,
  id: template.id,
  contentRevision: template.contentRevision,
});

export const query = (cursor?: string, limit = 50) =>
  `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

export const baseFor = (accountId: string) => `/api/accounts/${encodeURIComponent(accountId)}`;

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'this action could not finish. your draft stays here.';

export const localWritable = (account: ConnectionSummary) =>
  account.state !== 'disconnecting' && account.state !== 'disconnected';

export const providerWritable = (account: ConnectionSummary) =>
  account.state === 'connected' && account.permissions.tasks;

export function applicationCapacityMessage(required: number, capacity: Capacity): string {
  if (capacity.stale || capacity.known === null || capacity.available === null)
    return 'refresh the list inventory before creating this copy.';
  return required > capacity.available
    ? `this copy needs ${required} list slots; ${capacity.available} are available. reserved work already uses ${capacity.reserved} slots.`
    : '';
}

export function templateTaskDate(
  task: Pick<TemplateTask, 'dayOffset' | 'scheduledTime' | 'timeZone'>,
  day: string,
  relative: boolean,
): string {
  if (!relative || task.dayOffset === null) return 'no date';
  try {
    return `${addCalendarDays(day, task.dayOffset)}${task.scheduledTime ? ` · ${task.scheduledTime} ${task.timeZone ?? ''}` : ''}`;
  } catch {
    return 'choose a valid application day';
  }
}

export interface InputIdentity {
  fingerprint: string;
  id: string;
}

export function unchangedInputIdentity(
  prior: InputIdentity | null,
  input: unknown,
  create: () => string,
): InputIdentity {
  const fingerprint = JSON.stringify(input);
  return prior?.fingerprint === fingerprint ? prior : { fingerprint, id: create() };
}

export type Mutate = (command: TemplateCommand) => Promise<boolean>;

export function weekdayName(day: number) {
  return (
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][day - 1] ??
    'weekday'
  );
}

export function formatInstant(value: string, zone: string) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: zone,
  }).format(new Date(value));
}
