import { request } from '../../../../shared/browser/http/http';
import { TaskSchema, TaskListSchema } from '../../contracts/task';

export function readTask(accountId: string, taskId: string) {
  return request(
    `/api/accounts/${encodeURIComponent(accountId)}/tasks/${encodeURIComponent(taskId)}`,
    TaskSchema,
  );
}

export function readTaskList(accountId: string, listId: string) {
  return request(
    `/api/accounts/${encodeURIComponent(accountId)}/lists/${encodeURIComponent(listId)}`,
    TaskListSchema,
  );
}
