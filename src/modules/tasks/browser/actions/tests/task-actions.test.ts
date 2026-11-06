import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmationChoice } from '../../../../operations/browser/submission/Confirmation';
import { request } from '../../../../../shared/browser/http/http';
import { TaskSchema, TaskListSchema, type Task } from '../../../contracts/task';
import { TaskConsequencesSchema, ListConsequencesSchema } from '../../../contracts/consequence';
import { OperationSummarySchema } from '../../../../operations/contracts/receipt';
import { ProviderCommandSchema } from '../../../contracts/provider-commands';
import { ReopenPreviewSchema, RecurrenceStatusSchema } from '../../../contracts/recurrence';
import { createTaskActions } from '../task-actions';

const base = '/api/accounts/account';
const identity = '1793811600000:abcdefghijklmnop';
const task = TaskSchema.parse({
  id: 'task',
  accountId: 'account',
  listId: 'list',
  parentId: null,
  title: 'prepare the talk',
  notes: 'keep the notes',
  completed: false,
  completedAt: null,
  scheduledDay: '2026-11-04',
  scheduledTime: null,
  timeZone: null,
  repeatRule: null,
  seriesId: null,
  occurrenceId: null,
  labelIds: [],
  priority: 'none',
  starred: false,
  blockedBy: [],
  revision: 7,
  unsupportedHierarchy: false,
  provider: {
    id: 'google-task',
    listId: 'google-list',
    etag: 'v7',
    position: '100',
    updatedAt: null,
  },
  capabilities: {
    canEdit: true,
    canEditNotes: true,
    canMove: true,
    canDelete: true,
    canHaveChildren: true,
    canNest: true,
    assignmentSource: null,
    sourceUrl: null,
    restriction: null,
  },
});
const list = TaskListSchema.parse({
  id: 'list',
  accountId: 'account',
  title: 'talks',
  revision: 3,
  providerId: 'google-list',
  providerEtag: 'list-v3',
  isDefault: false,
});
const consequences = (patch: Partial<ReturnType<typeof TaskConsequencesSchema.parse>> = {}) =>
  TaskConsequencesSchema.parse({
    taskId: task.id,
    revision: task.revision,
    title: task.title,
    openSubtaskCount: 0,
    subtaskCount: 0,
    openBlockerCount: 0,
    openBlockedSubtaskCount: 0,
    unknownBlockerCount: 0,
    assignmentSource: null,
    coverageComplete: true,
    ...patch,
  });
const listConsequences = (patch: Partial<ReturnType<typeof ListConsequencesSchema.parse>> = {}) =>
  ListConsequencesSchema.parse({
    listId: list.id,
    revision: list.revision,
    title: list.title,
    taskCount: 4,
    assignedTaskCount: 0,
    coverageComplete: true,
    isDefault: false,
    ...patch,
  });

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}
function workflow(
  options: {
    taskPreview?: unknown;
    listPreview?: unknown;
    currentTask?: Task;
    recurrenceStatus?: unknown;
    reopenPreview?: unknown;
    saveSucceeded?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const events: string[] = [];
  let confirmation: ConfirmationChoice | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        path: new URL(String(input), 'https://lanes.test').pathname,
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      };
      calls.push(call);
      if (call.path === `${base}/tasks/task/consequences`)
        return Response.json(options.taskPreview ?? consequences());
      if (call.path === `${base}/lists/list/consequences`)
        return Response.json(options.listPreview ?? listConsequences());
      if (call.path === `${base}/tasks/task`) return Response.json(options.currentTask ?? task);
      if (call.path === `${base}/tasks/task/recurrence`)
        return Response.json(options.recurrenceStatus ?? null);
      if (call.path === `${base}/tasks/task/recurrence/advance`)
        return Response.json({
          accountId: 'account',
          taskId: 'task',
          advanced: true,
          pending: false,
          state: 'active',
        });
      if (call.path === `${base}/tasks/task/recurrence/reopen-preview`)
        return Response.json(options.reopenPreview);
      if (call.path === `${base}/commands/provider`) {
        const command = ProviderCommandSchema.parse(call.body?.command);
        return Response.json({
          id: call.body?.operationId,
          accountId: 'account',
          kind: command.kind,
          state: options.saveSucceeded === false ? 'failed' : 'succeeded',
          createdAt: 1793811600000,
          updatedAt: 1793811600000,
          cancelRequested: false,
          totalSteps: 1,
          confirmedSteps: options.saveSucceeded === false ? 0 : 1,
          inputSealed: true,
          error: null,
          nextAttemptAt: null,
          finished: true,
        });
      }
      throw new Error(`unexpected task action request: ${call.method} ${call.path}`);
    }),
  );
  const submit = vi.fn(
    async (command: unknown, category: 'provider' | 'local', operationId = identity) => {
      events.push('submit');
      const receipt = await request(`${base}/commands/${category}`, OperationSummarySchema, {
        method: 'POST',
        body: { operationId, command },
      });
      return receipt.state === 'succeeded';
    },
  );
  const onNotice = vi.fn();
  const onChanged = vi.fn();
  const onRepeat = vi.fn(async () => {
    events.push('repeat');
  });
  const onReopen = vi.fn();
  const onTaskDeleted = vi.fn(() => {
    events.push('task deleted');
  });
  const onListDeleteReady = vi.fn(() => {
    events.push('list ready');
  });
  const confirm = vi.fn((choice: ConfirmationChoice) => {
    events.push('confirm');
    confirmation = choice;
  });
  const actions = createTaskActions({
    accountId: 'account',
    submit,
    confirm,
    onNotice,
    onChanged,
    onRepeat,
    onReopen,
    onTaskDeleted,
    onListDeleteReady,
  });
  return {
    ...actions,
    calls,
    events,
    submit,
    confirm,
    onNotice,
    onChanged,
    onRepeat,
    onReopen,
    onTaskDeleted,
    onListDeleteReady,
    confirmation() {
      if (!confirmation) throw new Error('no confirmation was presented');
      return confirmation;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('task completion workflow', () => {
  it.each([
    ['stale', { revision: task.revision + 1 }, true],
    ['incomplete', { coverageComplete: false }, false],
  ] as const)('does not mutate from a %s consequence preview', async (_reason, patch, refresh) => {
    const action = workflow({ taskPreview: consequences(patch) });
    await action.toggleComplete(task, true);
    expect(action.calls.map((call) => call.method)).toEqual(['GET']);
    expect(action.confirm).not.toHaveBeenCalled();
    expect(action.submit).not.toHaveBeenCalled();
    expect(action.onNotice).toHaveBeenCalledOnce();
    expect(action.onChanged).toHaveBeenCalledTimes(refresh ? 1 : 0);
  });

  it('confirms the captured blocked checklist before sending its exact command', async () => {
    const action = workflow({
      taskPreview: consequences({
        openSubtaskCount: 2,
        subtaskCount: 3,
        openBlockerCount: 1,
        openBlockedSubtaskCount: 1,
        unknownBlockerCount: 1,
      }),
    });
    const saving = action.toggleComplete(task, true);
    await vi.waitFor(() => expect(action.confirm).toHaveBeenCalledOnce());
    const choice = action.confirmation();
    expect(choice.message).toContain('2 open subtasks will also complete.');
    expect(choice.message).toContain('1 open blockers');
    expect(choice.message).toContain('1 open subtasks are blocked.');
    expect(choice.message).toContain('1 blockers have an unresolved identity.');
    expect(action.submit).not.toHaveBeenCalled();
    expect(action.onRepeat).not.toHaveBeenCalled();
    expect(await choice.onConfirm(identity)).toBe(true);
    expect(await saving).toBe(true);
    expect(action.calls.at(-1)).toEqual({
      path: `${base}/commands/provider`,
      method: 'POST',
      body: {
        operationId: identity,
        command: {
          kind: 'task.complete',
          taskId: task.id,
          revision: task.revision,
          confirmBlocked: true,
          confirmOpenSubtaskCount: 2,
        },
      },
    });
    expect(action.events).toEqual(['confirm', 'submit', 'repeat']);
  });

  it('does not advance recurrence when confirmed completion fails', async () => {
    const action = workflow({
      taskPreview: consequences({ openSubtaskCount: 1 }),
      saveSucceeded: false,
    });
    const saving = action.toggleComplete(task, true);
    await vi.waitFor(() => expect(action.confirm).toHaveBeenCalledOnce());
    expect(await action.confirmation().onConfirm(identity)).toBe(false);
    expect(await saving).toBe(false);
    expect(action.onRepeat).not.toHaveBeenCalled();
  });

  it('reports a cancelled confirmation without sending a completion', async () => {
    const action = workflow({ taskPreview: consequences({ openSubtaskCount: 1 }) });
    const saving = action.toggleComplete(task, true);
    await vi.waitFor(() => expect(action.confirm).toHaveBeenCalledOnce());
    action.confirmation().onCancel?.();
    expect(await saving).toBe(false);
    expect(action.submit).not.toHaveBeenCalled();
  });

  it.each([true, false])('reports the ordinary completion result (%s)', async (saveSucceeded) => {
    const action = workflow({ saveSucceeded });
    expect(await action.toggleComplete(task, true)).toBe(saveSucceeded);
  });
});

describe('recurring reopen workflow', () => {
  it('settles recurrence before presenting the server reopen choices', async () => {
    const completed = TaskSchema.parse({ ...task, completed: true, seriesId: 'series' });
    const preview = ReopenPreviewSchema.parse({
      taskId: task.id,
      revision: task.revision,
      successorTaskId: 'successor',
      successorTitle: 'next talk',
      successorSubtaskCount: 2,
      choices: ['remove_untouched', 'one_off'],
      reason: 'the successor already exists',
      token: 'preview-token',
    });
    const action = workflow({
      recurrenceStatus: RecurrenceStatusSchema.parse({
        taskId: task.id,
        seriesId: 'series',
        occurrenceId: 'occurrence',
        state: 'active',
        createdCount: 2,
        successorTaskId: 'successor',
        operationId: null,
        checklistComplete: true,
        nextAttemptAt: null,
        errorCode: null,
      }),
      reopenPreview: preview,
    });
    await action.toggleComplete(completed, false);
    expect(action.calls.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
      { path: `${base}/tasks/task/recurrence`, method: 'GET', body: undefined },
      { path: `${base}/tasks/task/recurrence/advance`, method: 'POST', body: {} },
      { path: `${base}/tasks/task/recurrence/reopen-preview`, method: 'GET', body: undefined },
    ]);
    expect(action.onReopen).toHaveBeenCalledWith({ task: completed, preview });
    expect(action.submit).not.toHaveBeenCalled();
    expect(action.confirm).not.toHaveBeenCalled();
  });

  it('uses ordinary reopen when a repeating task has no admitted occurrence', async () => {
    const completed = TaskSchema.parse({ ...task, completed: true, seriesId: 'series' });
    const action = workflow();
    await action.toggleComplete(completed, false);
    expect(action.submit).toHaveBeenCalledWith(
      { kind: 'task.reopen', taskId: task.id, revision: task.revision },
      'provider',
    );
    expect(action.calls).toHaveLength(2);
    expect(action.onReopen).not.toHaveBeenCalled();
  });
});

describe('destructive task and list actions', () => {
  it.each([true, false])(
    'closes task editing only after a successful assigned-task deletion (%s)',
    async (saveSucceeded) => {
      const action = workflow({
        taskPreview: consequences({ assignmentSource: 'docs', subtaskCount: 3 }),
        saveSucceeded,
      });
      await action.deleteTask(task);
      const choice = action.confirmation();
      expect(choice.message).toContain('and 3 subtasks');
      expect(choice.message).toContain('source assignment will also be removed');
      expect(action.onTaskDeleted).not.toHaveBeenCalled();
      expect(action.submit).not.toHaveBeenCalled();
      expect(await choice.onConfirm(identity)).toBe(saveSucceeded);
      expect(action.submit).toHaveBeenCalledWith(
        {
          kind: 'task.delete',
          taskId: task.id,
          revision: task.revision,
          confirm: true,
          confirmSubtaskCount: 3,
          confirmAssignment: true,
        },
        'provider',
        identity,
      );
      expect(action.onTaskDeleted).toHaveBeenCalledTimes(saveSucceeded ? 1 : 0);
      expect(action.events).toEqual(
        saveSucceeded ? ['confirm', 'submit', 'task deleted'] : ['confirm', 'submit'],
      );
    },
  );

  it.each([{ revision: task.revision + 1 }, { coverageComplete: false }])(
    'retains task editing when the delete preview cannot be trusted (%j)',
    async (patch) => {
      const action = workflow({ taskPreview: consequences(patch) });
      await action.deleteTask(task);
      expect(action.submit).not.toHaveBeenCalled();
      expect(action.confirm).not.toHaveBeenCalled();
      expect(action.onTaskDeleted).not.toHaveBeenCalled();
      expect(action.onChanged).toHaveBeenCalledOnce();
    },
  );

  it('confirms assigned-list consequences and uses the confirmation identity', async () => {
    const action = workflow({ listPreview: listConsequences({ assignedTaskCount: 2 }) });
    await action.deleteList(list);
    expect(action.events).toEqual(['list ready', 'confirm']);
    expect(action.confirmation().message).toContain('2 source assignments');
    expect(action.submit).not.toHaveBeenCalled();
    await action.confirmation().onConfirm(identity);
    expect(action.submit).toHaveBeenCalledWith(
      {
        kind: 'list.delete',
        listId: list.id,
        revision: list.revision,
        confirm: true,
        confirmTaskCount: 4,
        confirmAssignments: true,
      },
      'provider',
      identity,
    );
    expect(action.onTaskDeleted).not.toHaveBeenCalled();
  });

  it.each([{ isDefault: true }, { revision: list.revision + 1 }, { coverageComplete: false }])(
    'keeps the list menu when deletion is not safe (%j)',
    async (patch) => {
      const action = workflow({ listPreview: listConsequences(patch) });
      await action.deleteList(list);
      expect(action.confirm).not.toHaveBeenCalled();
      expect(action.submit).not.toHaveBeenCalled();
      expect(action.onListDeleteReady).not.toHaveBeenCalled();
      expect(action.onNotice).toHaveBeenCalledOnce();
    },
  );
});

describe('calendar date changes', () => {
  it('ignores another account before reading or changing a task', async () => {
    const action = workflow();
    await action.reschedule({
      accountId: 'other',
      taskId: task.id,
      revision: task.revision,
      scheduledDay: '2026-11-05',
    });
    expect(action.calls).toEqual([]);
    expect(action.submit).not.toHaveBeenCalled();
    expect(action.confirm).not.toHaveBeenCalled();
  });

  it('refuses a stale dragged date and refreshes confirmed values', async () => {
    const action = workflow({
      currentTask: TaskSchema.parse({ ...task, revision: task.revision + 1 }),
    });
    await action.reschedule({
      accountId: 'account',
      taskId: task.id,
      revision: task.revision,
      scheduledDay: '2026-11-05',
    });
    expect(action.submit).not.toHaveBeenCalled();
    expect(action.confirm).not.toHaveBeenCalled();
    expect(action.onChanged).toHaveBeenCalledOnce();
  });

  it('confirms removing a scheduled task’s local time before sending the day change', async () => {
    const action = workflow({
      currentTask: TaskSchema.parse({
        ...task,
        scheduledTime: '09:30',
        timeZone: 'Europe/Istanbul',
      }),
    });
    await action.reschedule({
      accountId: 'account',
      taskId: task.id,
      revision: task.revision,
      scheduledDay: null,
    });
    expect(action.submit).not.toHaveBeenCalled();
    expect(action.confirmation().message).toContain(
      'local time and repeat rule will also be removed',
    );
    await action.confirmation().onConfirm(identity);
    expect(action.submit).toHaveBeenCalledWith(
      {
        kind: 'task.edit',
        taskId: task.id,
        revision: task.revision,
        patch: { scheduledDay: null },
      },
      'provider',
      identity,
    );
  });
});

describe('quick task stars', () => {
  it('submits only a local star patch with the captured revision', async () => {
    const flow = workflow();
    flow.submit.mockResolvedValue(true);
    expect(await flow.toggleStar(task, true)).toBe(true);
    expect(flow.submit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'task.patch', taskId: task.id, expectedRevision: 7, patch: { starred: true } },
      'local',
    );
  });
  it('does not write unchanged stars or cross-account tasks', async () => {
    const flow = workflow();
    expect(await flow.toggleStar(task, false)).toBe(true);
    expect(await flow.toggleStar({ ...task, accountId: 'other' }, true)).toBe(false);
    expect(flow.submit).not.toHaveBeenCalled();
  });
  it('reports failed star requests to the workspace', async () => {
    const flow = workflow();
    flow.submit.mockRejectedValue(new Error('connection lost'));
    expect(await flow.toggleStar(task, true)).toBe(false);
    expect(flow.onNotice).toHaveBeenCalledWith('connection lost');
  });
});
