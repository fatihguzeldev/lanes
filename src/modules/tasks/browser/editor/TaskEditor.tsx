import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import type { Coverage } from '../../../../shared/contracts/http';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { Icon } from '../../../../shared/ui/icon/Icon';
import type { CreateTask, Label, Task, TaskList, TaskPatch } from '../../contracts/task';
import {
  createEditorDraft,
  editorDraftIsDirty,
  prepareEditorSubmission,
  rebaseEditorDraft,
  restorePausedRepeatRule,
  type TaskEditorDraft,
} from './task-editor-model';
import type { RecurrenceStatus } from '../../contracts/recurrence';
import { TaskRecurrence } from './TaskRecurrence';
import { TaskDependants, type TaskDependantsProps } from './TaskDependants';
import { TimeZoneSelect } from '../../../../shared/ui/time-zone/TimeZoneSelect';
import { Select } from '../../../../shared/ui/select/Select';
import './TaskEditor.css';

export interface TaskEditorSave {
  accountId: string;
  taskId: string;
  listId: string;
  expectedRevision: number;
  expectedGraphRevision?: number;
  patch: TaskPatch;
}
export interface TaskEditorCreate {
  accountId: string;
  listRevision: number;
  expectedGraphRevision?: number;
  input: CreateTask;
}
export interface TaskEditorProps {
  dependants?: Omit<TaskDependantsProps, 'accountId' | 'completed' | 'pending'>;
  open: boolean;
  accountId: string;
  accountLabel?: string;
  task: Task | null;
  list: TaskList;
  labels: readonly Label[];
  relatedTasks: readonly Task[];
  timeZone: string;
  weekStart?: 1 | 7;
  graphRevision?: number;
  initialDay?: string | null;
  parent?: Task | null;
  providerWritesEnabled: boolean;
  localWritesEnabled: boolean;
  pending?: boolean;
  serverReachable?: boolean;
  onCheckConnection?(): void;
  submitted?: boolean;
  onRetryFailed?: () => void;
  onInspectSave?(): void;
  onInspectRecurrence?(id: string): void;
  error?: { message: string; code?: string; fields?: Record<string, string> } | null;
  subtasks?: {
    items: readonly Task[];
    nextCursor: string | null;
    coverage: Coverage;
    pending?: boolean;
  };
  pendingLabelIds?: ReadonlySet<string>;
  relatedTasksLoading?: boolean;
  dependencyError?: string | null;
  dependenciesHaveMore?: boolean;
  dependencySearchScope?: 'board' | 'account';
  onClose(): void;
  onSave(save: TaskEditorSave): void;
  onCreate(save: TaskEditorCreate): void;
  onDirtyChange?(dirty: boolean): void;
  onToggleComplete?(task: Task, completed: boolean): void;
  onOpenTask?(task: Task): void;
  onLoadMoreSubtasks?(): void;
  onCreateSubtask?(task: Task): void;
  onSearchDependencies?(query: string): void;
  onLoadMoreDependencies?(): void;
  onRefresh?(): void;
  onDelete?(task: Task): void;
  onManageLabels?(): void;
  recurrence?: {
    status: RecurrenceStatus | null;
    loading: boolean;
    error: string | null;
    pending: boolean;
  };
  onRetryRecurrence?(): void;
  onResumeRecurrence?(): void;
  onOpenRecurrenceTask?(taskId: string): void;
}
const title = (task: Task) => task.title.trim() || 'untitled task';
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const providerFields = [
  'title',
  'notes',
  'scheduledDay',
  'scheduledTime',
  'timeZone',
  'repeatRule',
];

/** Presentation identity is keyed by the shell; closing/account changes use its discard guard. */
export function TaskEditor(props: TaskEditorProps) {
  return props.open ? <EditorForm {...props} /> : null;
}
function EditorForm(props: TaskEditorProps) {
  const uid = useId();
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const [snapshot, setSnapshot] = useState(() => ({
    accountId: props.accountId,
    task: props.task ? structuredClone(props.task) : null,
    list: { ...props.list },
    accountLabel: props.accountLabel,
    graphRevision: props.graphRevision,
    parent: props.parent ? structuredClone(props.parent) : null,
    timeZone: props.timeZone,
    weekStart: props.weekStart ?? 1,
    initialDay: props.initialDay,
  }));
  const options = useMemo(
    () => ({
      accountId: snapshot.accountId,
      listId: snapshot.list.id,
      timeZone: snapshot.timeZone,
      weekStart: snapshot.weekStart,
      parentId: snapshot.parent?.id ?? null,
      initialDay: snapshot.initialDay,
    }),
    [snapshot],
  );
  const [draft, setDraft] = useState(() => createEditorDraft(snapshot.task, options));
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [clearConfirmed, setClearConfirmed] = useState(false);
  const [dependencyQuery, setDependencyQuery] = useState('');
  const task = snapshot.task,
    pending = props.pending ?? false;
  const dirty = editorDraftIsDirty(draft, task, options);
  const contextChanged =
    props.accountId !== snapshot.accountId ||
    props.list.accountId !== snapshot.accountId ||
    props.list.id !== snapshot.list.id ||
    (props.task &&
      (props.task.id !== task?.id ||
        props.task.accountId !== snapshot.accountId ||
        props.task.listId !== snapshot.list.id));
  const providerEnabled =
    props.providerWritesEnabled &&
    !pending &&
    !props.submitted &&
    !contextChanged &&
    (!task || (task.capabilities.canEdit && !task.unsupportedHierarchy));
  const createParentValid =
    !snapshot.parent ||
    (snapshot.parent.accountId === snapshot.accountId &&
      snapshot.parent.listId === snapshot.list.id &&
      !snapshot.parent.parentId &&
      snapshot.parent.capabilities.canHaveChildren &&
      !snapshot.parent.unsupportedHierarchy);
  const localEnabled = props.localWritesEnabled && !pending && !props.submitted && !contextChanged;
  const errors = { ...props.error?.fields, ...localErrors };
  const clearingSchedule =
    !!task?.scheduledDay && !draft.scheduledDay && !!(task.scheduledTime || task.repeatRule);
  const candidate = prepareEditorSubmission(draft, { ...options, task });
  const providerChanges =
    candidate.ok &&
    (candidate.kind === 'create' ||
      (candidate.kind === 'edit' && providerFields.some((field) => field in candidate.patch)));
  const localChanges =
    candidate.ok &&
    candidate.kind === 'edit' &&
    Object.keys(candidate.patch).some((field) => !providerFields.includes(field));
  const saveEnabled =
    props.serverReachable !== false &&
    !contextChanged &&
    !pending &&
    !props.submitted &&
    (task
      ? dirty && (!providerChanges || providerEnabled) && (!localChanges || localEnabled)
      : providerEnabled && localEnabled && createParentValid);
  const children = (props.subtasks?.items ?? []).filter(
    (child) =>
      child.accountId === snapshot.accountId &&
      child.parentId === task?.id &&
      child.listId === snapshot.list.id,
  );
  const labels = props.labels.filter((label) => label.accountId === snapshot.accountId);
  const related = props.relatedTasks.filter(
    (item) => item.accountId === snapshot.accountId && item.id !== task?.id,
  );
  const latest =
    props.task &&
    task &&
    props.task.id === task.id &&
    props.task.accountId === task.accountId &&
    props.task.listId === task.listId
      ? props.task
      : null;
  const canReviewNewGraph =
    !task &&
    draft.blockedBy.length > 0 &&
    props.graphRevision !== undefined &&
    props.graphRevision !== snapshot.graphRevision;
  const canReapply =
    (!props.submitted || !!props.onRetryFailed) &&
    !!latest &&
    (latest.revision !== task?.revision ||
      (props.graphRevision !== snapshot.graphRevision &&
        JSON.stringify([...draft.blockedBy].sort()) !==
          JSON.stringify([...(task?.blockedBy ?? [])].sort())));

  useEffect(() => {
    titleInput.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    props.onDirtyChange?.(dirty);
  }, [dirty, props.onDirtyChange]);
  useEffect(() => {
    const blockersUntouched =
      JSON.stringify([...draft.blockedBy].sort()) ===
      JSON.stringify([...(task?.blockedBy ?? [])].sort());
    if (
      !contextChanged &&
      snapshot.graphRevision === undefined &&
      props.graphRevision !== undefined &&
      blockersUntouched
    ) {
      setSnapshot((current) => ({ ...current, graphRevision: props.graphRevision }));
    }
  }, [snapshot.graphRevision, props.graphRevision, draft.blockedBy, task, contextChanged]);
  useEffect(() => {
    if (!props.onSearchDependencies) return;
    const timer = setTimeout(() => props.onSearchDependencies?.(dependencyQuery), 200);
    return () => clearTimeout(timer);
  }, [dependencyQuery, props.onSearchDependencies]);
  const set = <K extends keyof TaskEditorDraft>(field: K, value: TaskEditorDraft[K]) => {
    setDraft((current) => {
      const date =
        field === 'scheduledDay' && typeof value === 'string' && value
          ? new Date(`${value}T12:00:00Z`).getUTCDay()
          : NaN;
      return {
        ...current,
        [field]: value,
        ...(!Number.isNaN(date) && !current.repeatEnabled && !task?.repeatRule
          ? { repeatWeekdays: [date === 0 ? 7 : date] }
          : {}),
      };
    });
    setLocalErrors({});
    if (field === 'scheduledDay') setClearConfirmed(false);
  };
  const toggle = (field: 'labelIds' | 'blockedBy', value: string) =>
    setDraft((current) => ({
      ...current,
      [field]: current[field].includes(value)
        ? current[field].filter((id) => id !== value)
        : [...current[field], value],
    }));
  const invalid = (field: string) => !!errors[field];
  const inputId = (field: string) => `${uid}-${field}`;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || contextChanged) return;
    const prepared = prepareEditorSubmission(draft, { ...options, task });
    if (!prepared.ok) {
      setLocalErrors(prepared.fields);
      return;
    }
    if (clearingSchedule && !clearConfirmed) {
      setLocalErrors({
        scheduledDay: 'confirm that removing the day also clears its time and repeat rule',
      });
      return;
    }
    if (prepared.kind === 'unchanged') return;
    if (prepared.kind === 'create') {
      if (!providerEnabled || !localEnabled || !createParentValid) return;
      if (prepared.input.blockedBy.length && snapshot.graphRevision === undefined) {
        setLocalErrors({ blockedBy: 'load the dependency graph before creating these blockers' });
        return;
      }
      props.onCreate({
        accountId: snapshot.accountId,
        listRevision: snapshot.list.revision,
        ...(snapshot.graphRevision !== undefined
          ? { expectedGraphRevision: snapshot.graphRevision }
          : {}),
        input: prepared.input,
      });
    } else {
      const hasProvider = providerFields.some((field) => field in prepared.patch),
        hasLocal = Object.keys(prepared.patch).some((field) => !providerFields.includes(field));
      if ((hasProvider && !providerEnabled) || (hasLocal && !localEnabled) || !task) return;
      if (prepared.patch.blockedBy !== undefined && snapshot.graphRevision === undefined) {
        setLocalErrors({ blockedBy: 'load the dependency graph before saving these blockers' });
        return;
      }
      props.onSave({
        accountId: snapshot.accountId,
        taskId: task.id,
        listId: snapshot.list.id,
        expectedRevision: task.revision,
        ...(snapshot.graphRevision !== undefined
          ? { expectedGraphRevision: snapshot.graphRevision }
          : {}),
        patch: prepared.patch,
      });
    }
  }
  function reapply() {
    if (!task || !latest || pending) return;
    setDraft((current) => rebaseEditorDraft(current, task, latest, options));
    setSnapshot((current) => ({
      ...current,
      task: structuredClone(latest),
      graphRevision: props.graphRevision,
    }));
    setLocalErrors({});
    setClearConfirmed(false);
    props.onRetryFailed?.();
  }

  return (
    <Dialog
      title={task ? 'task details' : snapshot.parent ? 'new subtask' : 'new task'}
      onClose={props.onClose}
      wide
      pending={pending && !props.submitted}
    >
      <form className="task-editor" onSubmit={submit} noValidate>
        <div className="task-editor__context">
          <Icon name="list" size={13} />
          <span>{snapshot.list.title || 'untitled list'}</span>
          <span aria-hidden="true">·</span>
          <span>{snapshot.accountLabel ?? 'connected account'}</span>
        </div>
        {snapshot.parent && (
          <p className="task-editor__parent">
            subtask of <strong>{title(snapshot.parent)}</strong>
          </p>
        )}
        {!createParentValid && (
          <p className="task-editor__notice" role="alert">
            this task cannot have subtasks. promote it or choose an eligible parent first.
          </p>
        )}
        {contextChanged && (
          <p className="task-editor__notice" role="alert">
            this editor belongs to another account or list. your draft is kept here; close it and
            open the task again.
          </p>
        )}
        {props.submitted && !props.error && (
          <p className="task-editor__notice" role="status">
            saving…
          </p>
        )}
        {props.serverReachable === false && (
          <p className="task-editor__notice" role="status">
            the server connection is paused. you can keep editing; your draft stays in this editor.{' '}
            {props.onCheckConnection && (
              <button type="button" onClick={props.onCheckConnection}>
                check connection
              </button>
            )}
          </p>
        )}
        {!props.localWritesEnabled && (
          <p className="task-editor__notice">
            <Icon name="lock" size={14} />
            relink this account to make changes. its workspace is retained.
          </p>
        )}
        {!props.providerWritesEnabled && props.localWritesEnabled && (
          <p className="task-editor__notice">
            <Icon name="lock" size={14} />
            google changes are paused. labels, priority, stars and blockers can still be saved.
          </p>
        )}
        {task?.capabilities.restriction && (
          <p className="task-editor__notice">
            {task.capabilities.restriction}
            {task.capabilities.sourceUrl && (
              <>
                {' '}
                <a href={task.capabilities.sourceUrl} target="_blank" rel="noreferrer">
                  open {task.capabilities.assignmentSource ?? 'source'}
                  <Icon name="external" size={12} />
                </a>
              </>
            )}
          </p>
        )}
        <label className="sr-only" htmlFor={inputId('title')}>
          task title
        </label>
        <textarea
          ref={titleInput}
          autoFocus
          className="task-editor__title"
          id={inputId('title')}
          rows={1}
          placeholder="what needs doing?"
          value={draft.title}
          onChange={(event) => set('title', event.target.value)}
          disabled={!providerEnabled}
          aria-invalid={invalid('title')}
        />
        <label className="sr-only" htmlFor={inputId('notes')}>
          notes
        </label>
        <textarea
          className="task-editor__notes"
          id={inputId('notes')}
          rows={3}
          placeholder="add a note…"
          value={draft.notes}
          onChange={(event) => set('notes', event.target.value)}
          disabled={!providerEnabled || (!!task && !task.capabilities.canEditNotes)}
          aria-invalid={invalid('notes')}
        />
        {task?.capabilities.assignmentSource === 'docs' && (
          <p className="task-editor__hint">
            notes are read-only for tasks assigned in google docs.
          </p>
        )}

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
                onChange={(event) => setClearConfirmed(event.target.checked)}
                disabled={!providerEnabled}
              />
              <span>clear the time and stop repetition when removing this day.</span>
            </label>
          )}
          {task && props.recurrence && (
            <TaskRecurrence
              taskId={task.id}
              completed={task.completed}
              hasRule={!!task.repeatRule}
              repeatEnabled={draft.repeatEnabled}
              hasDay={!!draft.scheduledDay}
              nested={!!task.parentId}
              dirty={dirty}
              available={providerEnabled && props.serverReachable !== false}
              {...props.recurrence}
              {...(props.onInspectRecurrence ? { onInspect: props.onInspectRecurrence } : {})}
              {...(props.onRetryRecurrence ? { onRetry: props.onRetryRecurrence } : {})}
              {...(props.onResumeRecurrence ? { onResume: props.onResumeRecurrence } : {})}
              {...(props.onOpenRecurrenceTask
                ? { onOpenSuccessor: props.onOpenRecurrenceTask }
                : {})}
              onRestore={(rule) => {
                setDraft((current) => restorePausedRepeatRule(current, rule));
                setLocalErrors({});
              }}
            />
          )}
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
                  disabled={
                    !providerEnabled || !draft.scheduledDay || !!task?.parentId || !!snapshot.parent
                  }
                />
                repeat after completion
              </label>
              {(task?.parentId || snapshot.parent) && (
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
                          set(
                            'repeatFrequency',
                            selectedValue as TaskEditorDraft['repeatFrequency'],
                          )
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
                    lanes creates the next occurrence after completion and skips missed dates. this
                    rule stays in lanes; google's native repeat rules are separate and cannot be
                    detected reliably. keep only one kind of repetition on a task.
                  </p>
                </>
              )}
            </div>
          </details>
        </section>

        <section className="task-editor__section" aria-labelledby={inputId('details-heading')}>
          <h3 id={inputId('details-heading')}>
            <Icon name="filter" size={14} />
            details
          </h3>
          <div className="task-editor__metadata-row">
            <label>
              priority
              <Select
                value={draft.priority}
                onChange={(selectedValue) =>
                  set('priority', selectedValue as TaskEditorDraft['priority'])
                }
                disabled={!localEnabled}
                aria-label="priority"
                options={[
                  { value: 'none', label: 'none' },
                  { value: 'low', label: 'low' },
                  { value: 'medium', label: 'medium' },
                  { value: 'high', label: 'high' },
                ]}
              />
            </label>
            <button
              className={`task-editor__star${draft.starred ? ' is-starred' : ''}`}
              type="button"
              aria-pressed={draft.starred}
              disabled={!localEnabled}
              onClick={() => set('starred', !draft.starred)}
            >
              <Icon name="star" size={16} />
              {draft.starred ? 'starred' : 'add a star'}
            </button>
          </div>
          <fieldset className="task-editor__labels" disabled={!localEnabled}>
            <legend>
              labels <span>{draft.labelIds.length}/20</span>
            </legend>
            <div>
              {labels.map((label) => (
                <label
                  className={draft.labelIds.includes(label.id) ? 'is-selected' : ''}
                  style={{ '--label-color': label.color } as CSSProperties}
                  key={label.id}
                >
                  <input
                    type="checkbox"
                    checked={draft.labelIds.includes(label.id)}
                    disabled={
                      !draft.labelIds.includes(label.id) &&
                      (draft.labelIds.length >= 20 || props.pendingLabelIds?.has(label.id))
                    }
                    onChange={() => toggle('labelIds', label.id)}
                  />
                  <i aria-hidden="true" />
                  {label.name}
                  {props.pendingLabelIds?.has(label.id) && <small>deleting</small>}
                </label>
              ))}
              {draft.labelIds
                .filter((id) => !labels.some((label) => label.id === id))
                .map((id) => (
                  <button type="button" key={id} onClick={() => toggle('labelIds', id)}>
                    label not loaded <Icon name="close" size={11} />
                  </button>
                ))}
            </div>
            {!labels.length && !draft.labelIds.length && (
              <p className="task-editor__hint">no labels in this account yet.</p>
            )}
          </fieldset>
          {props.onManageLabels && (
            <button
              className="task-editor__text-button"
              type="button"
              disabled={pending}
              onClick={props.onManageLabels}
            >
              manage labels
              <Icon name="right" size={12} />
            </button>
          )}
          <details
            className="task-editor__disclosure task-editor__dependencies"
            open={draft.blockedBy.length > 0 || undefined}
          >
            <summary>
              <Icon name="link" size={13} />
              blocked by{' '}
              {draft.blockedBy.length ? (
                <span>{draft.blockedBy.length}/50</span>
              ) : (
                <span>add a dependency</span>
              )}
              <Icon name="down" size={12} />
            </summary>
            {draft.blockedBy.length > 0 && (
              <ul className="task-editor__blockers">
                {draft.blockedBy.map((id) => {
                  const blocker = related.find((item) => item.id === id);
                  return (
                    <li key={id}>
                      <Icon
                        name={
                          blocker && !blocker.provider.missing
                            ? blocker.completed
                              ? 'check'
                              : 'link'
                            : 'warning'
                        }
                        size={13}
                      />
                      <span>
                        {blocker ? title(blocker) : 'blocker not loaded'}
                        <small>
                          {blocker && !blocker.provider.missing
                            ? blocker.completed
                              ? 'completed · no longer blocks'
                              : 'open'
                            : 'status unknown · retained'}
                        </small>
                      </span>
                      <button
                        type="button"
                        disabled={!localEnabled}
                        onClick={() => toggle('blockedBy', id)}
                        aria-label={`remove ${blocker ? title(blocker) : 'unloaded blocker'}`}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <label className="task-editor__dependency-search">
              search {props.dependencySearchScope === 'account' ? 'this account' : 'this board'}
              <input
                type="search"
                value={dependencyQuery}
                onChange={(event) => setDependencyQuery(event.target.value)}
                disabled={!localEnabled}
                placeholder="find a task…"
              />
            </label>
            {props.relatedTasksLoading && (
              <p className="task-editor__hint" role="status">
                looking for tasks…
              </p>
            )}
            {props.dependencyError && (
              <p className="task-editor__field-error" role="alert">
                {props.dependencyError}
              </p>
            )}
            <div className="task-editor__dependency-results" aria-label="tasks to add as blockers">
              {related
                .filter(
                  (item) =>
                    !draft.blockedBy.includes(item.id) &&
                    (!dependencyQuery ||
                      props.onSearchDependencies ||
                      title(item)
                        .toLocaleLowerCase()
                        .includes(dependencyQuery.toLocaleLowerCase())),
                )
                .map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    disabled={!localEnabled || draft.blockedBy.length >= 50}
                    onClick={() => toggle('blockedBy', item.id)}
                  >
                    <Icon name="plus" size={13} />
                    <span>{title(item)}</span>
                    <small>
                      {item.provider.missing
                        ? 'status unknown'
                        : item.completed
                          ? 'completed'
                          : item.listId === snapshot.list.id
                            ? 'same list'
                            : 'another list'}
                    </small>
                  </button>
                ))}
            </div>
            {props.dependenciesHaveMore && props.onLoadMoreDependencies && (
              <button
                className="task-editor__text-button"
                type="button"
                onClick={props.onLoadMoreDependencies}
                disabled={props.relatedTasksLoading}
              >
                load more tasks
                <Icon name="down" size={12} />
              </button>
            )}
            {!related.length && !props.relatedTasksLoading && !props.dependencyError && (
              <p className="task-editor__hint">
                no loaded matches. existing blockers keep their identity until they can be checked.
              </p>
            )}
          </details>
          {task && props.dependants && (
            <TaskDependants
              {...props.dependants}
              accountId={snapshot.accountId}
              completed={task.completed}
              pending={pending}
            />
          )}
        </section>

        {task && !task.parentId && (
          <section
            className="task-editor__section task-editor__subtasks"
            aria-labelledby={inputId('subtasks-heading')}
          >
            <h3 id={inputId('subtasks-heading')}>
              <Icon name="subtasks" size={14} />
              subtasks{' '}
              <span>
                {children.length}
                {props.subtasks?.coverage.complete && !props.subtasks.nextCursor ? '' : ' loaded'}
              </span>
            </h3>
            {children.length > 0 && (
              <ul>
                {children.map((child) => (
                  <li key={child.id}>
                    <button
                      className="task-editor__complete"
                      type="button"
                      role="checkbox"
                      aria-checked={child.completed}
                      aria-label={`${child.completed ? 'reopen' : 'complete'} ${title(child)}`}
                      disabled={
                        !props.onToggleComplete ||
                        !props.providerWritesEnabled ||
                        pending ||
                        !child.capabilities.canEdit ||
                        child.unsupportedHierarchy
                      }
                      onClick={() => props.onToggleComplete?.(child, !child.completed)}
                    >
                      {child.completed && <Icon name="check" size={10} />}
                    </button>
                    <button
                      type="button"
                      className={child.completed ? 'is-completed' : ''}
                      onClick={() => props.onOpenTask?.(child)}
                      disabled={!props.onOpenTask || pending}
                    >
                      {title(child)}
                    </button>
                    {child.scheduledDay && <small>{child.scheduledDay}</small>}
                  </li>
                ))}
              </ul>
            )}
            {props.subtasks?.pending && (
              <p className="task-editor__hint" role="status">
                loading subtasks…
              </p>
            )}
            {!children.length && props.subtasks?.coverage.complete && (
              <p className="task-editor__hint">no subtasks.</p>
            )}
            {!props.subtasks?.coverage.complete && !props.subtasks?.pending && (
              <p className="task-editor__hint">
                subtask coverage is incomplete; loaded work stays visible.
              </p>
            )}
            <div className="task-editor__subtask-actions">
              {props.subtasks?.nextCursor && props.onLoadMoreSubtasks && (
                <button
                  className="task-editor__text-button"
                  type="button"
                  onClick={props.onLoadMoreSubtasks}
                  disabled={props.subtasks.pending}
                >
                  load more
                  <Icon name="down" size={12} />
                </button>
              )}
              {props.onCreateSubtask && (
                <button
                  className="task-editor__text-button"
                  type="button"
                  disabled={!providerEnabled || !task.capabilities.canHaveChildren}
                  onClick={() => props.onCreateSubtask?.(task)}
                >
                  <Icon name="plus" size={13} />
                  add subtask
                </button>
              )}
            </div>
          </section>
        )}
        {(props.error || Object.keys(localErrors).length > 0) && (
          <div className="task-editor__error" role="alert">
            <p>
              {props.error?.code === 'conflict'
                ? `your draft is still here. ${props.error.message}`
                : (props.error?.message ?? 'check these fields before saving.')}
            </p>
            {Object.keys(errors).length > 0 && (
              <ul>
                {Object.entries(errors).map(([key, message]) => (
                  <li key={key}>{message}</li>
                ))}
              </ul>
            )}
            {props.onInspectSave && (
              <button
                className="task-editor__text-button"
                type="button"
                onClick={props.onInspectSave}
              >
                check save
              </button>
            )}
            {props.onRetryFailed && (
              <button
                className="task-editor__text-button"
                type="button"
                onClick={props.onRetryFailed}
                disabled={pending}
              >
                start a new attempt
                <Icon name="arrow" size={12} />
              </button>
            )}
            {props.onRefresh && (
              <button
                className="task-editor__text-button"
                type="button"
                onClick={props.onRefresh}
                disabled={pending}
              >
                refresh the confirmed task
                <Icon name="sync" size={12} />
              </button>
            )}
          </div>
        )}
        {canReviewNewGraph && (
          <div className="task-editor__reapply">
            <p>
              the dependency graph is now available. review your chosen blockers before creating
              this task.
            </p>
            <button
              type="button"
              onClick={() =>
                setSnapshot((current) => ({ ...current, graphRevision: props.graphRevision }))
              }
              disabled={pending}
            >
              use the current dependency graph
              <Icon name="sync" size={12} />
            </button>
          </div>
        )}
        {canReapply && (
          <div className="task-editor__reapply">
            <p>
              a newer confirmed version is available. keep your edited fields and review them over
              that version.
            </p>
            <button type="button" onClick={reapply} disabled={pending}>
              review draft on latest version
              <Icon name="sync" size={12} />
            </button>
          </div>
        )}
        <footer className="task-editor__footer">
          <div className="task-editor__lifecycle">
            {task && props.onToggleComplete && (
              <button
                type="button"
                disabled={!providerEnabled}
                onClick={() => props.onToggleComplete?.(task, !task.completed)}
              >
                <Icon name="check" size={14} />
                {task.completed ? 'reopen' : 'complete'}
              </button>
            )}
            {task && props.onDelete && (
              <button
                type="button"
                className="task-editor__delete"
                aria-label="delete task"
                disabled={!props.providerWritesEnabled || pending || !task.capabilities.canDelete}
                onClick={() => props.onDelete?.(task)}
              >
                <Icon name="trash" size={15} />
              </button>
            )}
          </div>
          <button
            type="button"
            className="task-editor__cancel"
            onClick={props.onClose}
            disabled={pending && !props.submitted}
          >
            {props.submitted ? 'close' : 'cancel'}
          </button>
          <button type="submit" className="task-editor__save" disabled={!saveEnabled}>
            {pending ? 'saving…' : task ? 'save changes' : 'add task'}
            {!pending && <Icon name="arrow" size={14} />}
          </button>
        </footer>
        {(pending || (!props.providerWritesEnabled && providerChanges)) && (
          <p className="task-editor__save-note" role="status">
            {pending
              ? 'saving your changes… your draft stays here.'
              : 'reconnect to save the google fields in this draft.'}
          </p>
        )}
      </form>
    </Dialog>
  );
}
