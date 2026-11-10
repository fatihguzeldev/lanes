/** Observations cannot replace list state while an issued command still owns its resources. */
export const noCapturedCommand = (account: string, list: string): string =>
  `NOT EXISTS(SELECT 1 FROM tasks_command_resources resources JOIN tasks_operations operation ON operation.id=resources.operation_id WHERE operation.account_id=${account} AND resources.list_id=${list} AND operation.state IN ('accepted','running','partial','reconnect_required','blocked_by_limit','uncertain'))`;
