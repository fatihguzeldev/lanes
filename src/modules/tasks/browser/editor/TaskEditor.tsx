import type { TaskEditorProps } from './editor-contract';
import { TaskScheduleFields } from './TaskScheduleFields';
import { TaskDependencies } from './TaskDependencies';
import { TaskChecklist } from './TaskChecklist';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { Icon, type IconName } from '../../../../shared/ui/icon/Icon';
import type { Task } from '../../contracts/task';
import {
  createEditorDraft,
  editorDraftIsDirty,
  prepareEditorSubmission,
  rebaseEditorDraft,
  restorePausedRepeatRule,
  type TaskEditorDraft,
} from './task-editor-model';
import { TaskRecurrence } from './TaskRecurrence';
import { TaskDependants } from './TaskDependants';
import { Select } from '../../../../shared/ui/select/Select';
import './TaskEditor.css';

const title = (task: Task) => task.title.trim() || 'untitled task';
const providerFields = [
  'title',
  'notes',
  'scheduledDay',
  'scheduledTime',
  'timeZone',
  'repeatRule',
];

/** The editor flow keys presentation identity; workspace navigation supplies the discard guard. */
export function TaskEditor(props: TaskEditorProps) {
  return props.open ? <EditorForm {...props} /> : null;
}
function EditorForm(props: TaskEditorProps) {
  const uid = useId();
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const notesInput = useRef<HTMLTextAreaElement>(null);
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
  const [section, setSection] = useState<
    'schedule' | 'details' | 'dependencies' | 'checklist' | null
  >(null);
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
    titleInput.current?.select();
  }, []);
  function resizeFields() {
    for (const input of [titleInput.current, notesInput.current]) {
      if (!input) continue;
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight}px`;
    }
  }
  useLayoutEffect(resizeFields, [draft.title, draft.notes]);
  useEffect(() => {
    const form = titleInput.current?.form;
    if (!form) return;
    let width = form.clientWidth;
    const observer = new ResizeObserver(() => {
      if (form.clientWidth === width) return;
      width = form.clientWidth;
      resizeFields();
    });
    observer.observe(form);
    return () => observer.disconnect();
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
    <section
      className="task-editor-panel"
      aria-label={task ? 'edit task' : snapshot.parent ? 'new subtask' : 'new task'}
    >
      <form
        className="task-editor"
        onSubmit={submit}
        noValidate
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.target instanceof Element && event.target.closest('[popover]')) return;
          if (event.key === 'Escape' && !event.defaultPrevented && !(pending && !props.submitted)) {
            event.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div className="task-editor__heading">
          <span className="task-editor__context">{snapshot.list.title || 'untitled list'}</span>
          <button
            type="button"
            className="task-editor__close"
            aria-label="close task"
            onClick={props.onClose}
            disabled={pending && !props.submitted}
          >
            <Icon name="close" size={14} />
          </button>
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
        {task && props.onToggleComplete && (
          <button
            type="button"
            className="task-editor__completion"
            role="checkbox"
            aria-checked={task.completed}
            aria-label={`${task.completed ? 'reopen' : 'complete'} ${title(task)}`}
            disabled={!providerEnabled}
            onClick={() => props.onToggleComplete?.(task, !task.completed)}
          >
            {task.completed && <Icon name="check" size={11} />}
          </button>
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
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (saveEnabled) event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <label className="sr-only" htmlFor={inputId('notes')}>
          notes
        </label>
        <textarea
          ref={notesInput}
          className="task-editor__notes"
          id={inputId('notes')}
          rows={1}
          placeholder="details"
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

        <div className="task-editor__tools" aria-label="task details">
          {(
            [
              ['schedule', 'calendar', 'schedule'],
              ['details', 'filter', 'labels and priority'],
              ['dependencies', 'link', 'dependencies'],
              ...(!task?.parentId && task ? [['checklist', 'subtasks', 'checklist']] : []),
            ] as const
          ).map(([value, icon, label]) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              title={label}
              aria-expanded={section === value}
              onClick={() => setSection(section === value ? null : (value as typeof section))}
            >
              <Icon name={icon as IconName} size={16} />
            </button>
          ))}
          <button
            type="button"
            aria-label={draft.starred ? 'remove star' : 'star task'}
            title={draft.starred ? 'remove star' : 'star task'}
            aria-pressed={draft.starred}
            disabled={!localEnabled}
            onClick={() => set('starred', !draft.starred)}
          >
            <Icon name="star" size={16} />
          </button>
        </div>
        {section === 'schedule' && (
          <TaskScheduleFields
            draft={draft}
            task={task}
            parent={snapshot.parent}
            providerEnabled={providerEnabled}
            clearingSchedule={clearingSchedule}
            clearConfirmed={clearConfirmed}
            onClearConfirmed={setClearConfirmed}
            set={set}
            invalid={invalid}
            inputId={inputId}
            recurrence={
              task &&
              props.recurrence && (
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
              )
            }
          />
        )}

        {section === 'details' && (
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
          </section>
        )}
        {section === 'dependencies' && (
          <section className="task-editor__section" aria-label="dependencies">
            <TaskDependencies
              blockedBy={draft.blockedBy}
              related={related}
              listId={snapshot.list.id}
              localEnabled={localEnabled}
              query={dependencyQuery}
              onQuery={setDependencyQuery}
              onToggle={(id) => toggle('blockedBy', id)}
              scope={props.dependencySearchScope}
              loading={props.relatedTasksLoading}
              error={props.dependencyError}
              hasMore={props.dependenciesHaveMore}
              onLoadMore={props.onLoadMoreDependencies}
              remoteSearch={!!props.onSearchDependencies}
            />
            {task && props.dependants && (
              <TaskDependants
                {...props.dependants}
                accountId={snapshot.accountId}
                completed={task.completed}
                pending={pending}
              />
            )}
          </section>
        )}

        {section === 'checklist' && task && !task.parentId && (
          <TaskChecklist
            task={task}
            children={children}
            providerEnabled={providerEnabled}
            pending={pending}
            inputId={inputId}
            {...(props.onToggleComplete ? { onToggleComplete: props.onToggleComplete } : {})}
            providerWritesEnabled={props.providerWritesEnabled}
            {...(props.onOpenTask ? { onOpenTask: props.onOpenTask } : {})}
            {...(props.subtasks ? { subtasks: props.subtasks } : {})}
            {...(props.onLoadMoreSubtasks ? { onLoadMoreSubtasks: props.onLoadMoreSubtasks } : {})}
            {...(props.onCreateSubtask ? { onCreateSubtask: props.onCreateSubtask } : {})}
          />
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
            {pending ? 'saving…' : task ? 'save' : 'add task'}
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
    </section>
  );
}
