import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import type { ConnectionSummary } from '../../accounts/contracts';
import { TaskEditor, type TaskEditorCreate, type TaskEditorSave } from '../components/TaskEditor';
import { TaskSchema, type Label, type Task, type TaskList } from '../contracts';
import { LabelDeletionJobSchema } from '../metadata-command-contract';
import { TaskCoverageSchema, TaskDependantsPageSchema } from '../query-contract';
import { RecurrenceStatusSchema, type RecurrenceStatus } from '../recurrence-contract';
import { checkServerConnection, request } from '../../../client/http';
import { useTaskQuery } from './useTaskQuery';
import { usePagedResource } from '../../../client/usePagedResource';
import { newOperationId } from '../../../client/operation-identity';
import { useCommands } from './useCommands';
import { useServerConnection } from '../../../client/useServerConnection';
import { useRecurrenceWork } from './useRecurrenceWork';

export interface EditorSelection {
  task: Task | null;
  list: TaskList;
  initialDay?: string | null;
  parent?: Task | null;
}
interface Props {
  account: ConnectionSummary;
  selection: EditorSelection;
  boardId: string | null;
  labels: readonly Label[];
  version: number;
  clockOffset: number;
  onChanged: () => void;
  onClose: () => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onOpenTask: (task: Task) => void;
  onToggleComplete: (task: Task, completed: boolean) => void;
  onDelete: (task: Task) => void;
  onCreateSubtask: (task: Task) => void;
  onManageLabels: () => void;
  onInspectChange: (id: string) => void;
}
const graphSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
const resolvedSchema = z.object({ items: z.array(TaskSchema).max(100) }).strict();
const deletionPage = z
  .object({
    items: z.array(LabelDeletionJobSchema).max(100),
    nextCursor: z.string().nullable(),
    coverage: TaskCoverageSchema,
  })
  .strict();
const providerFields = new Set([
  'title',
  'notes',
  'scheduledDay',
  'scheduledTime',
  'timeZone',
  'repeatRule',
]);

/** Draft and operation identity live for one editor presentation, independently of background refreshes. */
export function TaskEditorWorkspace({
  account,
  selection,
  boardId,
  labels,
  version,
  clockOffset,
  onChanged,
  onClose,
  onSaved,
  onDirtyChange,
  onOpenTask,
  onToggleComplete,
  onDelete,
  onCreateSubtask,
  onManageLabels,
  onInspectChange,
}: Props) {
  const connection = useServerConnection();
  const [recurrence, setRecurrence] = useState<RecurrenceStatus | null>(null),
    [recurrenceLoading, setRecurrenceLoading] = useState(!!selection.task),
    [recurrenceError, setRecurrenceError] = useState(''),
    [recurrenceVersion, setRecurrenceVersion] = useState(0),
    [resumePending, setResumePending] = useState(false);
  const resumeAbort = useRef<AbortController | null>(null);
  const repeatWork = useRecurrenceWork(
    account.id,
    account.state === 'connected' && connection === 'reachable',
    onChanged,
  );
  const [latest, setLatest] = useState(selection.task),
    [graph, setGraph] = useState<number | undefined>(undefined),
    [dependencyQuery, setDependencyQuery] = useState('');
  const [resolved, setResolved] = useState<Task[]>([]),
    [readError, setReadError] = useState('');
  const [identity, setIdentity] = useState(() => newOperationId(clockOffset));
  const commands = useCommands(account.id, clockOffset, onChanged);
  const submitted = commands.latest?.id === identity;
  const retryFailed =
    submitted && commands.latest?.state === 'failed' && commands.latest.finished
      ? () => {
          setIdentity(newOperationId(clockOffset));
          commands.clearError();
        }
      : undefined;
  const base = `/api/accounts/${encodeURIComponent(account.id)}`;
  const dependants = usePagedResource(
    selection.task ? `${account.id}:${selection.task.id}:dependants` : null,
    (cursor, signal) =>
      request(
        `${base}/tasks/${encodeURIComponent(selection.task!.id)}/dependants?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        TaskDependantsPageSchema,
        { signal },
      ),
    (item) => item.id,
    version,
  );
  useEffect(() => {
    if (!selection.task) return;
    const abort = new AbortController();
    setRecurrenceLoading(true);
    setRecurrenceError('');
    void request(
      `${base}/tasks/${encodeURIComponent(selection.task.id)}/recurrence`,
      RecurrenceStatusSchema.nullable(),
      { signal: abort.signal },
    )
      .then(setRecurrence)
      .catch((error) => {
        if (!abort.signal.aborted)
          setRecurrenceError(
            error instanceof Error ? error.message : 'repeat state could not load.',
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setRecurrenceLoading(false);
      });
    return () => abort.abort();
  }, [base, selection.task?.id, version, recurrenceVersion]);
  useEffect(() => () => resumeAbort.current?.abort(), [account.id, selection.task?.id]);
  const resumeRecurrence = () => {
    if (
      !selection.task ||
      account.state !== 'connected' ||
      connection !== 'reachable' ||
      resumePending
    )
      return;
    const abort = new AbortController();
    resumeAbort.current = abort;
    setResumePending(true);
    setRecurrenceError('');
    void request(
      `${base}/tasks/${encodeURIComponent(selection.task.id)}/recurrence/resume`,
      RecurrenceStatusSchema.nullable(),
      { method: 'POST', body: {}, signal: abort.signal },
    )
      .then((status) => {
        setRecurrence(status);
        onChanged();
        void repeatWork.run();
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setRecurrenceError(
            error instanceof Error ? error.message : 'repeat work could not resume.',
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setResumePending(false);
      });
  };
  const subtasksInput = useMemo(
    () =>
      selection.task
        ? {
            listIds: [selection.list.id],
            parentId: selection.task.id,
            filter: { completion: 'all' as const },
            sort: 'manual' as const,
          }
        : null,
    [selection.task?.id, selection.list.id],
  );
  const subtasks = useTaskQuery(account.id, subtasksInput, version);
  const dependenciesInput = useMemo(
    () => ({
      ...(boardId ? { boardId } : {}),
      query: dependencyQuery,
      filter: { completion: 'all' as const },
    }),
    [boardId, dependencyQuery],
  );
  const dependencies = useTaskQuery(account.id, dependenciesInput, version);
  const deleting = usePagedResource(
    `${account.id}:label-deletions`,
    (cursor, signal) =>
      request(
        `${base}/labels/deletions${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        deletionPage,
        { signal },
      ),
    (job) => job.id,
    version,
  );
  useEffect(() => {
    const abort = new AbortController();
    setReadError('');
    void request(`${base}/dependency-graph`, graphSchema, { signal: abort.signal })
      .then((value) => setGraph(value.revision))
      .catch((error) => {
        if (!abort.signal.aborted)
          setReadError(
            error instanceof Error ? error.message : 'the dependency graph could not load.',
          );
      });
    if (selection.task)
      void request(`${base}/tasks/${encodeURIComponent(selection.task.id)}`, TaskSchema, {
        signal: abort.signal,
      })
        .then(setLatest)
        .catch((error) => {
          if (!abort.signal.aborted)
            setReadError(
              error instanceof Error ? error.message : 'the latest task could not load.',
            );
        });
    return () => abort.abort();
  }, [account.id, selection.task?.id, version, base]);
  useEffect(() => {
    const ids = latest?.blockedBy ?? [];
    if (!ids.length) {
      setResolved([]);
      return;
    }
    const abort = new AbortController();
    void request(`${base}/tasks/resolve`, resolvedSchema, {
      method: 'POST',
      body: { ids },
      signal: abort.signal,
    })
      .then((value) => setResolved(value.items))
      .catch((error) => {
        if (!abort.signal.aborted)
          setReadError(
            error instanceof Error ? error.message : 'existing blockers could not load.',
          );
      });
    return () => abort.abort();
  }, [base, latest?.blockedBy, version]);
  const related = [
    ...new Map([...dependencies.page.items, ...resolved].map((task) => [task.id, task])).values(),
  ];
  const finish = async (command: unknown, category: 'local' | 'provider') => {
    const result = await commands.submit(command, category, identity);
    if (result?.state === 'succeeded') {
      onDirtyChange(false);
      onSaved();
    }
  };
  const save = (value: TaskEditorSave) => {
    if (value.accountId !== account.id || value.taskId !== selection.task?.id) return;
    const provider = Object.keys(value.patch).some((field) => providerFields.has(field));
    void finish(
      provider
        ? {
            kind: 'task.edit',
            taskId: value.taskId,
            revision: value.expectedRevision,
            patch: value.patch,
            ...(value.expectedGraphRevision === undefined
              ? {}
              : { expectedGraphRevision: value.expectedGraphRevision }),
          }
        : {
            kind: 'task.patch',
            taskId: value.taskId,
            expectedRevision: value.expectedRevision,
            patch: value.patch,
            ...(value.expectedGraphRevision === undefined
              ? {}
              : { expectedGraphRevision: value.expectedGraphRevision }),
          },
      provider ? 'provider' : 'local',
    );
  };
  const create = (value: TaskEditorCreate) => {
    if (value.accountId !== account.id || value.input.listId !== selection.list.id) return;
    const { accountId: capturedAccount, ...input } = value.input;
    if (capturedAccount !== account.id) return;
    void finish(
      {
        kind: 'task.create',
        ...input,
        listRevision: value.listRevision,
        ...(selection.parent ? { parentRevision: selection.parent.revision } : {}),
        ...(value.expectedGraphRevision === undefined
          ? {}
          : { expectedGraphRevision: value.expectedGraphRevision }),
      },
      'provider',
    );
  };
  return (
    <TaskEditor
      open
      accountId={account.id}
      accountLabel={account.email}
      task={latest}
      list={selection.list}
      labels={labels}
      relatedTasks={related}
      timeZone={account.planningZone}
      weekStart={account.weekStart}
      {...(graph === undefined ? {} : { graphRevision: graph })}
      {...(selection.initialDay === undefined ? {} : { initialDay: selection.initialDay })}
      {...(selection.parent === undefined ? {} : { parent: selection.parent })}
      providerWritesEnabled={account.state === 'connected'}
      localWritesEnabled={!['disconnecting', 'disconnected'].includes(account.state)}
      serverReachable={connection === 'reachable'}
      pending={commands.busy || resumePending}
      submitted={submitted}
      onCheckConnection={() => {
        if (connection === 'incompatible') window.location.reload();
        else
          void checkServerConnection().catch((error) =>
            setReadError(
              error instanceof Error ? error.message : 'the server is still unavailable.',
            ),
          );
      }}
      {...(retryFailed ? { onRetryFailed: retryFailed } : {})}
      error={
        commands.error
          ? {
              message: commands.error,
              ...(commands.errorDetails?.code ? { code: commands.errorDetails.code } : {}),
              ...(commands.errorDetails?.fields ? { fields: commands.errorDetails.fields } : {}),
            }
          : null
      }
      subtasks={{
        items: subtasks.page.items,
        nextCursor: subtasks.page.nextCursor,
        coverage: subtasks.page.coverage,
        pending: subtasks.status === 'loading',
      }}
      relatedTasksLoading={dependencies.status === 'loading'}
      dependencyError={dependencies.error || readError || null}
      dependencySearchScope={boardId ? 'board' : 'account'}
      dependenciesHaveMore={dependencies.page.nextCursor !== null}
      pendingLabelIds={new Set(deleting.items.map((job) => job.labelId))}
      onClose={onClose}
      onSave={save}
      onCreate={create}
      onDirtyChange={(dirty) => onDirtyChange(dirty && !submitted)}
      onOpenTask={onOpenTask}
      onToggleComplete={onToggleComplete}
      onLoadMoreSubtasks={() => void subtasks.loadMore()}
      onCreateSubtask={onCreateSubtask}
      onSearchDependencies={setDependencyQuery}
      onLoadMoreDependencies={() => void dependencies.loadMore()}
      onRefresh={onChanged}
      onDelete={onDelete}
      onManageLabels={onManageLabels}
      {...(selection.task
        ? {
            dependants: {
              items: dependants.items,
              loading: dependants.status === 'loading',
              loaded: dependants.loaded,
              error: dependants.error,
              nextCursor: dependants.nextCursor,
              stale: dependants.coverage.stale,
              onRetry: () => void dependants.reload(),
              onMore: () => void dependants.loadMore(),
              onOpenTask: (taskId: string) => {
                void request(`${base}/tasks/${encodeURIComponent(taskId)}`, TaskSchema)
                  .then((task) => {
                    if (task.accountId === account.id) onOpenTask(task);
                  })
                  .catch((error) =>
                    setReadError(
                      error instanceof Error
                        ? error.message
                        : 'the dependent task could not be opened.',
                    ),
                  );
              },
            },
          }
        : {})}
      recurrence={{
        status: recurrence,
        loading: recurrenceLoading,
        error: recurrenceError || repeatWork.error || null,
        pending: resumePending || repeatWork.busy,
      }}
      {...(commands.errorDetails?.operationId || (submitted && commands.latest?.id)
        ? {
            onInspectSave: () =>
              onInspectChange(commands.errorDetails?.operationId ?? commands.latest!.id),
          }
        : {})}
      onInspectRecurrence={onInspectChange}
      onRetryRecurrence={() => setRecurrenceVersion((value) => value + 1)}
      onResumeRecurrence={resumeRecurrence}
      onOpenRecurrenceTask={(taskId) => {
        void request(`${base}/tasks/${encodeURIComponent(taskId)}`, TaskSchema)
          .then((task) => {
            if (task.accountId === account.id) onOpenTask(task);
          })
          .catch((error) =>
            setRecurrenceError(
              error instanceof Error ? error.message : 'the successor could not be opened.',
            ),
          );
      }}
    />
  );
}
