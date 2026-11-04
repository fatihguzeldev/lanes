import { request } from '../../../shared/browser/http/http';
import type { ConfirmationChoice } from '../../operations/browser/submission/Confirmation';
import { TaskSchema, type Task, type TaskList } from '../contracts';
import { TaskConsequencesSchema, ListConsequencesSchema } from '../consequence-contract';
import {
  RecurrenceStatusSchema,
  RecurrenceAdvanceSchema,
  ReopenPreviewSchema,
  type ReopenPreview,
} from '../recurrence-contract';

export interface TaskActionContext {
  accountId: string;
  submit: (command: unknown, category: 'provider', identity?: string) => Promise<boolean>;
  confirm: (choice: ConfirmationChoice) => void;
  onNotice: (message: string) => void;
  onChanged: () => void;
  onRepeat: () => Promise<unknown>;
  onReopen: (selection: { task: Task; preview: ReopenPreview }) => void;
  onTaskDeleted: () => void;
  onListDeleteReady: () => void;
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
  const toggleComplete = async (task: Task, completed: boolean) => {
    if (!completed) {
      if (task.repeatRule || task.seriesId) {
        try {
          const status = await request(
            `${base}/tasks/${encodeURIComponent(task.id)}/recurrence`,
            RecurrenceStatusSchema.nullable(),
          );
          if (!status?.occurrenceId) {
            await submit(
              { kind: 'task.reopen', taskId: task.id, revision: task.revision },
              'provider',
            );
            return;
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
        } catch (error) {
          onNotice(
            error instanceof Error ? error.message : 'the repeat occurrence could not be checked.',
          );
        }
      } else
        await submit({ kind: 'task.reopen', taskId: task.id, revision: task.revision }, 'provider');
      return;
    }
    try {
      const preview = await request(
        `${base}/tasks/${encodeURIComponent(task.id)}/consequences`,
        TaskConsequencesSchema,
      );
      if (preview.revision !== task.revision) {
        onNotice('this task changed. review its current values before completing it.');
        onChanged();
        return;
      }
      if (!preview.coverageComplete) {
        onNotice('refresh the complete list before completing this task and its checklist.');
        return;
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
            const done = await submit(command, 'provider', identity);
            if (done) void onRepeat();
            return done;
          },
        });
      } else if (await submit(command, 'provider')) void onRepeat();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'completion could not be checked.');
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
        return;
      }
      confirm({
        title: `delete ${preview.title || 'this task'}?`,
        message: `this removes the task${preview.subtaskCount ? ` and ${preview.subtaskCount} subtasks` : ''} from google tasks.${preview.assignmentSource ? ' its source assignment will also be removed.' : ''} this cannot be undone in lanes.`,
        confirmLabel: 'delete task',
        onConfirm: async (identity) => {
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
            onTaskDeleted();
          }
          return done;
        },
      });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'deletion could not be checked.');
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
  const reschedule = async (intent: {
    accountId: string;
    taskId: string;
    revision: number;
    scheduledDay: string | null;
  }) => {
    if (intent.accountId !== accountId) return;
    try {
      const task = await request(`${base}/tasks/${encodeURIComponent(intent.taskId)}`, TaskSchema);
      if (task.revision !== intent.revision) {
        onNotice('this task changed. review its current date before moving it.');
        onChanged();
        return;
      }
      const command = {
        kind: 'task.edit',
        taskId: task.id,
        revision: task.revision,
        patch: { scheduledDay: intent.scheduledDay },
      };
      if (intent.scheduledDay === null && (task.scheduledTime || task.repeatRule))
        confirm({
          title: `remove the date from ${task.title || 'this task'}?`,
          message:
            'its local time and repeat rule will also be removed. an unscheduled task cannot keep either.',
          confirmLabel: 'remove date',
          onConfirm: (identity) => submit(command, 'provider', identity),
        });
      else await submit(command, 'provider');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'the task could not be rescheduled.');
    }
  };

  return { toggleComplete, deleteTask, deleteList, reschedule };
}
