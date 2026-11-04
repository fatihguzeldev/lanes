import type { RecurrenceStatus } from '../recurrence-contract';
import type { RepeatRule } from '../planning-contract';

export interface TaskRecurrenceProps {
  taskId: string;
  completed: boolean;
  hasRule: boolean;
  repeatEnabled: boolean;
  hasDay: boolean;
  nested: boolean;
  dirty: boolean;
  available: boolean;
  status: RecurrenceStatus | null;
  loading: boolean;
  error: string | null;
  pending: boolean;
  onResume?(): void;
  onInspect?(id: string): void;
  onRestore(rule: RepeatRule): void;
  onRetry?(): void;
  onOpenSuccessor?(taskId: string): void;
}

/** Read-only lifecycle state never changes a draft. Recovery is always an explicit owner action. */
export function TaskRecurrence(props: TaskRecurrenceProps) {
  const status = props.status?.taskId === props.taskId ? props.status : null;
  const pausedRule = !props.hasRule ? status?.pausedRule : null;
  const uncertain = status?.state === 'uncertain' || status?.errorCode === 'outcome_uncertain';
  const stateText =
    status?.state === 'pending'
      ? 'next occurrence pending'
      : status?.state === 'undoing'
        ? 'reopen recovery in progress'
        : status?.state === 'reopen_required'
          ? 'this completion needs an explicit reopen choice'
          : status?.state === 'finished'
            ? 'this repeat series reached its end'
            : status?.state === 'stopped'
              ? 'this repeat series is stopped'
              : status?.state === 'paused'
                ? 'repeat work is paused'
                : null;
  const canRestore =
    props.available &&
    !props.pending &&
    !props.loading &&
    !props.error &&
    props.hasDay &&
    !props.nested &&
    !props.repeatEnabled;
  const canResume =
    props.available &&
    !props.pending &&
    !props.loading &&
    !props.error &&
    !props.dirty &&
    !uncertain;
  if (!props.loading && !props.error && !status && !(props.completed && props.repeatEnabled))
    return null;
  return (
    <div className="task-editor__recurrence" aria-label="repeat state">
      {props.loading && <p role="status">checking repeat state…</p>}
      {props.error && (
        <div role="alert">
          <p>{props.error}</p>
          {props.onRetry && (
            <button
              type="button"
              className="task-editor__text-button"
              disabled={props.pending || props.loading}
              onClick={props.onRetry}
            >
              retry repeat state
            </button>
          )}
        </div>
      )}
      {pausedRule ? (
        <>
          <p>
            {pausedRule.reason === 'provider_day_removed'
              ? 'google removed the scheduled day. lanes retained the rule and stopped repetition; the removed date and time will not be written back automatically.'
              : 'google nested this task. lanes retained the rule and stopped independent repetition; promote this task before restoring it.'}
          </p>
          <p className="task-editor__retained-rule">
            retained rule: every {pausedRule.rule.interval} {pausedRule.rule.frequency}
            {pausedRule.rule.frequency === 'weekly'
              ? ` · ${pausedRule.rule.weekdays.map((day) => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][day - 1]).join(', ')}`
              : ''}{' '}
            · {pausedRule.rule.zone}
            {pausedRule.rule.end.type === 'date'
              ? ` · ends ${pausedRule.rule.end.day}`
              : pausedRule.rule.end.type === 'count'
                ? ` · ${pausedRule.rule.end.count} occurrences`
                : ' · no end day'}
          </p>
          {!props.hasDay && <p>choose a day above, then restore the rule into your draft.</p>}
          {props.repeatEnabled ? (
            <p>your draft already has repeat settings. review them before saving.</p>
          ) : (
            <button
              type="button"
              className="task-editor__text-button"
              disabled={!canRestore}
              onClick={() => {
                if (canRestore) props.onRestore(pausedRule.rule);
              }}
            >
              restore this rule to the draft
            </button>
          )}
          <p>
            restoring uses your chosen day as the new anchor. review the settings, then save
            changes.
          </p>
        </>
      ) : (
        <>
          {uncertain ? (
            <p>check the last save before continuing repetition.</p>
          ) : (
            stateText && <p>{stateText}.</p>
          )}
          {status?.state === 'paused' && !uncertain && props.onResume && (
            <>
              {props.dirty && <p>save or discard your draft before resuming repeat work.</p>}
              <button
                type="button"
                className="task-editor__text-button"
                disabled={!canResume}
                onClick={() => {
                  if (canResume) props.onResume?.();
                }}
              >
                resume repeat work
              </button>
            </>
          )}
          {status?.successorTaskId && (
            <p>
              successor retained
              {props.onOpenSuccessor && (
                <button
                  type="button"
                  className="task-editor__text-button"
                  disabled={props.pending}
                  onClick={() => props.onOpenSuccessor?.(status.successorTaskId!)}
                >
                  open successor
                </button>
              )}
              .
            </p>
          )}
          {status && !status.checklistComplete && status.operationId && (
            <p>
              checklist coverage is incomplete. inspect the retained work before assuming every
              subtask was copied.
            </p>
          )}
          {status?.errorCode && !uncertain && (
            <p>repeat work needs attention: {status.errorCode.replaceAll('_', ' ')}.</p>
          )}
          {status?.operationId && (stateText || uncertain) && props.onInspect && (
            <button
              type="button"
              className="task-editor__text-button"
              onClick={() => props.onInspect?.(status.operationId!)}
            >
              check repeat progress
            </button>
          )}
        </>
      )}
      {props.completed &&
        props.repeatEnabled &&
        !props.loading &&
        !props.error &&
        !status?.occurrenceId &&
        !status?.operationId && (
          <p>
            this task stays completed. reopen it before a new completion can create its next
            occurrence.
          </p>
        )}
    </div>
  );
}
