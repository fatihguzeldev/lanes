import { RepeatRuleSchema } from '../../contracts/planning';
import {
  TemplateApplicationOptionsSchema,
  TemplateTaskSchema,
  type TemplateApplicationOptions,
  type TemplateTask,
} from '../../contracts/template';
import { addCalendarDays } from '../../model/planning';
import type { CopyEntry } from '../commands/copy-contract';
import { parse } from './validation';

export function materializeTemplateTask(
  input: TemplateTask,
  rawOptions: TemplateApplicationOptions,
): {
  entry: CopyEntry;
  warnings: string[];
} {
  const task = parse(TemplateTaskSchema, input),
    options = parse(TemplateApplicationOptionsSchema, rawOptions);
  const day =
    options.useRelativeDates && task.dayOffset !== null
      ? addCalendarDays(options.applicationDay, task.dayOffset)
      : null;
  const warnings: string[] = [];
  let repeatRule = null;
  if (day && task.repeatPreset) {
    const preset = task.repeatPreset,
      end =
        preset.end.type === 'date'
          ? {
              type: 'date' as const,
              day: addCalendarDays(options.applicationDay, preset.end.offsetDays),
            }
          : preset.end;
    const result = RepeatRuleSchema.safeParse({ ...preset, anchorDay: day, end });
    if (result.success) repeatRule = result.data;
    else
      warnings.push(
        'the captured repeat end precedes this task; its active repeat rule is omitted',
      );
  } else if (task.repeatPreset)
    warnings.push('active repetition is omitted without a scheduled day');
  return {
    entry: {
      key: task.key,
      listKey: task.listKey,
      position: task.position,
      parentKey: task.parentKey,
      title: task.title,
      notes: task.notes,
      completed: false,
      completedAt: null,
      scheduledDay: day,
      scheduledTime: day ? task.scheduledTime : null,
      timeZone: day ? task.timeZone : null,
      repeatRule,
      labelDefinitions: task.labels,
      priority: task.priority,
      starred: task.starred,
      dependencyKeys: task.dependencyKeys,
    },
    warnings,
  };
}
