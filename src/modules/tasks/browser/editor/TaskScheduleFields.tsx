import type { ReactNode } from 'react';
import type { Task } from '../../contracts/task';
import type { TaskEditorDraft } from './task-editor-model';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { Select } from '../../../../shared/ui/select/Select';
import { TimeZoneSelect } from '../../../../shared/ui/time-zone/TimeZoneSelect';

interface Props {
  draft: TaskEditorDraft;
  task: Task | null;
  parent: Task | null | undefined;
  providerEnabled: boolean;
  clearingSchedule: boolean;
  clearConfirmed: boolean;
  onClearConfirmed(value: boolean): void;
  set<K extends keyof TaskEditorDraft>(field: K, value: TaskEditorDraft[K]): void;
  invalid(field: string): boolean;
  inputId(field: string): string;
  recurrence: ReactNode;
}
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export function TaskScheduleFields({
  draft,
  task,
  parent,
  providerEnabled,
  clearingSchedule,
  clearConfirmed,
  onClearConfirmed,
  set,
  invalid,
  inputId,
  recurrence,
}: Props) {
  return (
    <section className="task-editor__section" aria-labelledby={inputId('schedule-heading')}>
      <h3 id={inputId('schedule-heading')}>
        <Icon name="calendar" size={14} />
        schedule
      </h3>
      <div className="task-editor__schedule">
        <label htmlFor={inputId('day')}>
          day
          <input
            type="date"
            id={inputId('day')}
            value={draft.scheduledDay}
            disabled={!providerEnabled}
            onChange={(event) => set('scheduledDay', event.target.value)}
            aria-invalid={invalid('scheduledDay')}
          />
        </label>
        <label htmlFor={inputId('time')}>
          time <span className="task-editor__optional">optional</span>
          <input
            type="time"
            id={inputId('time')}
            value={draft.scheduledTime}
            disabled={!providerEnabled || !draft.scheduledDay}
            onChange={(event) => set('scheduledTime', event.target.value)}
            aria-invalid={invalid('scheduledTime')}
          />
        </label>
        {draft.scheduledTime && (
          <label className="task-editor__zone" htmlFor={inputId('zone')}>
            time zone
            <TimeZoneSelect
              id={inputId('zone')}
              value={draft.timeZone}
              disabled={!providerEnabled || !draft.scheduledDay}
              onChange={(value) => set('timeZone', value)}
              aria-label="scheduled time zone"
              aria-invalid={invalid('timeZone')}
            />
          </label>
        )}
      </div>
      {clearingSchedule && (
        <label className="task-editor__check-note">
          <input
            type="checkbox"
            checked={clearConfirmed}
            onChange={(event) => onClearConfirmed(event.target.checked)}
            disabled={!providerEnabled}
          />
          <span>clear the time and stop repetition when removing this day.</span>
        </label>
      )}
      {recurrence}
      <details className="task-editor__disclosure" open={draft.repeatEnabled || undefined}>
        <summary>
          <Icon name="sync" size={13} />
          {draft.repeatEnabled ? 'repeat this task' : 'add repetition'}
          <Icon name="down" size={12} />
        </summary>
        <div className="task-editor__repeat">
          <label className="task-editor__inline-check">
            <input
              type="checkbox"
              checked={draft.repeatEnabled}
              onChange={(event) => set('repeatEnabled', event.target.checked)}
              disabled={!providerEnabled || !draft.scheduledDay || !!task?.parentId || !!parent}
            />
            repeat after completion
          </label>
          {(task?.parentId || parent) && (
            <p className="task-editor__hint">
              subtasks follow their parent's checklist and cannot repeat independently.
            </p>
          )}
          {!draft.scheduledDay && (
            <p className="task-editor__hint">choose a day to add a repeat rule.</p>
          )}
          {draft.repeatEnabled && (
            <>
              <div className="task-editor__repeat-row">
                <label>
                  every
                  <input
                    type="number"
                    min="1"
                    max="365"
                    value={draft.repeatInterval}
                    onChange={(event) => set('repeatInterval', event.target.value)}
                    disabled={!providerEnabled || !draft.scheduledDay}
                    aria-invalid={invalid('repeatRule.interval')}
                  />
                </label>
                <label>
                  frequency
                  <Select
                    value={draft.repeatFrequency}
                    onChange={(selectedValue) =>
                      set('repeatFrequency', selectedValue as TaskEditorDraft['repeatFrequency'])
                    }
                    disabled={!providerEnabled || !draft.scheduledDay}
                    aria-label="frequency"
                    options={[
                      { value: 'daily', label: 'day' },
                      { value: 'weekdays', label: 'weekday' },
                      { value: 'weekly', label: 'week' },
                      { value: 'monthly', label: 'month' },
                      { value: 'yearly', label: 'year' },
                    ]}
                  />
                </label>
              </div>
              {draft.repeatFrequency === 'weekly' && (
                <fieldset
                  className="task-editor__weekdays"
                  disabled={!providerEnabled || !draft.scheduledDay}
                >
                  <legend>on these days</legend>
                  {weekdays.map((day, index) => (
                    <label key={day}>
                      <input
                        type="checkbox"
                        checked={draft.repeatWeekdays.includes(index + 1)}
                        onChange={() =>
                          set(
                            'repeatWeekdays',
                            draft.repeatWeekdays.includes(index + 1)
                              ? draft.repeatWeekdays.filter((value) => value !== index + 1)
                              : [...draft.repeatWeekdays, index + 1],
                          )
                        }
                      />
                      <span>{day}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="task-editor__repeat-row">
                <label>
                  ends
                  <Select
                    value={draft.repeatEnd}
                    onChange={(selectedValue) =>
                      set('repeatEnd', selectedValue as TaskEditorDraft['repeatEnd'])
                    }
                    disabled={!providerEnabled || !draft.scheduledDay}
                    aria-label="ends"
                    options={[
                      { value: 'never', label: 'never' },
                      { value: 'date', label: 'on a day' },
                      { value: 'count', label: 'after a count' },
                    ]}
                  />
                </label>
                {draft.repeatEnd === 'date' && (
                  <label>
                    last day
                    <input
                      type="date"
                      min={draft.scheduledDay}
                      value={draft.repeatEndDay}
                      onChange={(event) => set('repeatEndDay', event.target.value)}
                      disabled={!providerEnabled || !draft.scheduledDay}
                    />
                  </label>
                )}
                {draft.repeatEnd === 'count' && (
                  <label>
                    occurrences
                    <input
                      type="number"
                      min="1"
                      max="10000"
                      value={draft.repeatCount}
                      onChange={(event) => set('repeatCount', event.target.value)}
                      disabled={!providerEnabled || !draft.scheduledDay}
                    />
                    <span className="task-editor__hint">includes this task</span>
                  </label>
                )}
              </div>
              <label className="task-editor__repeat-zone">
                rule's time zone
                <TimeZoneSelect
                  value={draft.repeatZone}
                  onChange={(value) => set('repeatZone', value)}
                  aria-label="repeat time zone"
                  disabled={!providerEnabled || !draft.scheduledDay}
                />
              </label>
              <p className="task-editor__hint">
                lanes creates the next occurrence after completion and skips missed dates. this rule
                stays in lanes; google's native repeat rules are separate and cannot be detected
                reliably. keep only one kind of repetition on a task.
              </p>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
