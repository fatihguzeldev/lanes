import type { TaskChangeController } from '../changes/useTaskChanges';
import { request } from '../../../../shared/browser/http/http';
import type { ConfirmationChoice } from '../../../operations/browser/submission/Confirmation';
import { TaskSchema, type Task, type TaskList } from '../../contracts/task';
import { TaskConsequencesSchema, ListConsequencesSchema } from '../../contracts/consequence';
import {
  RecurrenceStatusSchema,
  RecurrenceAdvanceSchema,
  ReopenPreviewSchema,
  type ReopenPreview,
} from '../../contracts/recurrence';

export interface TaskActionContext {
  accountId: string;
  submit: (command: unknown, category: 'local' | 'provider', identity?: string) => Promise<boolean>;
  confirm: (choice: ConfirmationChoice) => void;
  onNotice: (message: string, operationId?: string | null) => void;
  onChanged: () => void;
  onRepeat: () => Promise<unknown>;
  onReopen: (selection: { task: Task; preview: ReopenPreview }) => void;
  onTaskDeleted: (task: Task) => void;
  onListDeleteReady: () => void;
  changes?: TaskChangeController;
}

export function createTaskActions({
  accountId,
  submit,
  confirm,
  onNotice,
  onChanged,
  onRepeat,
  onReopen,
  onTaskDeleted,
  onListDeleteReady,
}: TaskActionContext) {
  const base = `/api/accounts/${encodeURIComponent(accountId)}`;
  const toggleStar = async (task: Task, starred: boolean) => {
    if (task.accountId !== accountId) return false;
    if (task.starred === starred) return true;
    try {
      return await submit(
        {
          kind: 'task.patch',
          taskId: task.id,
          expectedRevision: task.revision,
          patch: { starred },
        },
        'local',
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'couldn’t save this star.');
      return false;
    }
  };
  const toggleComplete = async (task: Task, completed: boolean) => {
    if (task.accountId !== accountId) return false;
    if (task.completed === completed) return true;
    if (!completed) {
      if (task.repeatRule || task.seriesId) {
        try {
          const status = await request(
            `${base}/tasks/${encodeURIComponent(task.id)}/recurrence`,
            RecurrenceStatusSchema.nullable(),
          );
          if (!status?.occurrenceId) {
            return await submit(
              { kind: 'task.reopen', taskId: task.id, revision: task.revision },
              'provider',
            );
          }
          await request(
            `${base}/tasks/${encodeURIComponent(task.id)}/recurrence/advance`,
            RecurrenceAdvanceSchema,
            { method: 'POST', body: {} },
          );
          const preview = await request(
            `${base}/tasks/${encodeURIComponent(task.id)}/recurrence/reopen-preview`,
            ReopenPreviewSchema,
          );
          onReopen({ task, preview });
          return false;
        } catch (error) {
          onNotice(
            error instanceof Error ? error.message : 'the repeat occurrence could not be checked.',
          );
          return false;
        }
      }
      return await submit(
        { kind: 'task.reopen', taskId: task.id, revision: task.revision },
        'provider',
      );
    }
    try {
      const preview = await request(
        `${base}/tasks/${encodeURIComponent(task.id)}/consequences`,
        TaskConsequencesSchema,
      );
      if (preview.revision !== task.revision) {
        onNotice('this task changed. review its current values before completing it.');
        onChanged();
        return false;
      }
      if (!(preview.completionCoverageComplete ?? preview.coverageComplete)) {
        onNotice('refresh the complete list before completing this task and its checklist.');
        return false;
      }
      const command = {
        kind: 'task.complete',
        taskId: task.id,
        revision: preview.revision,
        ...(preview.openBlockerCount || preview.openBlockedSubtaskCount
          ? { confirmBlocked: true }
          : {}),
        confirmOpenSubtaskCount: preview.openSubtaskCount,
      };
      if (
        preview.openSubtaskCount ||
        preview.openBlockerCount ||
        preview.openBlockedSubtaskCount ||
        preview.unknownBlockerCount
      ) {
        return await new Promise<boolean>((resolve) =>
          confirm({
            title: `complete ${preview.title || 'this task'}?`,
            message: [
              preview.openSubtaskCount
                ? `${preview.openSubtaskCount} open subtasks will also complete.`
                : '',
              preview.openBlockerCount
                ? `this task has ${preview.openBlockerCount} open blockers.`
                : '',
              preview.openBlockedSubtaskCount
                ? `${preview.openBlockedSubtaskCount} open subtasks are blocked.`
                : '',
              preview.unknownBlockerCount
                ? `${preview.unknownBlockerCount} blockers have an unresolved identity.`
                : '',
            ]
              .filter(Boolean)
              .join(' '),
            confirmLabel: 'complete',
            onConfirm: async (identity) => {
              try {
                const done = await submit(command, 'provider', identity);
                if (done) void onRepeat();
                resolve(done);
                return done;
              } catch (error) {
                resolve(false);
                throw error;
              }
            },
            onCancel: () => resolve(false),
          }),
        );
      }
      const done = await submit(command, 'provider');
      if (done) void onRepeat();
      return done;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'completion could not be checked.');
      return false;
    }
  };
  const deleteTask = async (task: Task) => {
    try {
      const preview = await request(
        `${base}/tasks/${encodeURIComponent(task.id)}/consequences`,
        TaskConsequencesSchema,
      );
      if (preview.revision !== task.revision || !preview.coverageComplete) {
        onNotice('refresh this task and its complete checklist before deleting it.');
        onChanged();
        return false;
      }
      return await new Promise<boolean>((resolve) =>
        confirm({
          title: `delete ${preview.title || 'this task'}?`,
          message: `this removes the task${preview.subtaskCount ? ` and ${preview.subtaskCount} subtasks` : ''} from google tasks.${preview.assignmentSource ? ' its source assignment will also be removed.' : ''} this cannot be undone in lanes.`,
          confirmLabel: 'delete task',
          onConfirm: async (identity) => {
            try {
              const done = await submit(
                {
                  kind: 'task.delete',
                  taskId: task.id,
                  revision: preview.revision,
                  confirm: true,
                  confirmSubtaskCount: preview.subtaskCount,
                  ...(preview.assignmentSource ? { confirmAssignment: true } : {}),
                },
                'provider',
                identity,
              );
              if (done) {
                onTaskDeleted(task);
              }
              resolve(done);
              return done;
            } catch (error) {
              resolve(false);
              throw error;
            }
          },
          onCancel: () => resolve(false),
        }),
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'deletion could not be checked.');
      return false;
    }
  };
  const deleteList = async (list: TaskList) => {
    try {
      const preview = await request(
        `${base}/lists/${encodeURIComponent(list.id)}/consequences`,
        ListConsequencesSchema,
      );
      if (preview.isDefault || preview.revision !== list.revision || !preview.coverageComplete) {
        onNotice(
          'the default list stays. other lists need a complete fresh inventory before deletion.',
        );
        return;
      }
      onListDeleteReady();
      confirm({
        title: `delete ${preview.title || 'this list'}?`,
        message: `this removes the google tasks list and ${preview.taskCount} tasks.${preview.assignedTaskCount ? ` ${preview.assignedTaskCount} source assignments will also be removed.` : ''} its google content cannot be restored through lanes.`,
        confirmLabel: 'delete list',
        onConfirm: (identity) =>
          submit(
            {
              kind: 'list.delete',
              listId: list.id,
              revision: preview.revision,
              confirm: true,
              confirmTaskCount: preview.taskCount,
              ...(preview.assignedTaskCount ? { confirmAssignments: true } : {}),
            },
            'provider',
            identity,
          ),
      });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'deletion could not be checked.');
    }
  };
  const reschedule = async (
    intent: {
      accountId: string;
      taskId: string;
      revision: number;
      scheduledDay: string | null;
    },
    current?: Task,
  ): Promise<boolean> => {
    if (intent.accountId !== accountId) return false;
    try {
      const task =
        current ??
        (await request(`${base}/tasks/${encodeURIComponent(intent.taskId)}`, TaskSchema));
      if (task.accountId !== accountId || task.id !== intent.taskId) return false;
      if (task.revision !== intent.revision) {
        onNotice('this task changed. review its current date before moving it.');
        onChanged();
        return false;
      }
      if (task.scheduledDay === intent.scheduledDay) return true;
      const command = {
        kind: 'task.edit',
        taskId: task.id,
        revision: task.revision,
        patch: { scheduledDay: intent.scheduledDay },
      };
      if (intent.scheduledDay === null && (task.scheduledTime || task.repeatRule))
        return await new Promise<boolean>((resolve) =>
          confirm({
            title: `remove the date from ${task.title || 'this task'}?`,
            message:
              'its local time and repeat rule will also be removed. an unscheduled task cannot keep either.',
            confirmLabel: 'remove date',
            onConfirm: async (identity) => {
              const saved = await submit(command, 'provider', identity);
              resolve(saved);
              return saved;
            },
            onCancel: () => resolve(false),
          }),
        );
      return await submit(command, 'provider');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'the task could not be rescheduled.');
      return false;
    }
  };

  return { toggleStar, toggleComplete, deleteTask, deleteList, reschedule };
}
