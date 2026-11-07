import { AnchoredPopover } from '../../../../shared/ui/popover/Popover';
import type { TaskPlacement } from './useTaskPlacement';
import { TaskMoveDestinations, type TaskMoveWorkspace } from './TaskMoveDestinations';
import './TaskMovePicker.css';

export function TaskMovePicker({
  controller,
  workspace,
  embedded = false,
}: {
  controller: TaskPlacement;
  workspace: TaskMoveWorkspace;
  embedded?: boolean;
}) {
  const selection = controller.selection!;
  const task = selection.task;
  const disabled = !controller.enabled || !task.capabilities.canMove || task.unsupportedHierarchy;
  const body = (
    <div className="popover__menu">
      <TaskMoveDestinations
        controller={controller}
        task={task}
        disabled={disabled}
        boardId={selection.boardId}
        workspace={workspace}
      />
      {controller.error && (
        <div className="task-move-picker__error" role="alert">
          <p>{controller.error}</p>
          <button type="button" onClick={controller.reload}>
            try again
          </button>
        </div>
      )}
      {(!task.capabilities.canMove || task.unsupportedHierarchy) && (
        <p className="task-move-picker__error">
          {task.capabilities.restriction || 'google does not allow moving this task.'}
        </p>
      )}
    </div>
  );
  return embedded ? (
    body
  ) : (
    <AnchoredPopover
      anchor={selection.anchor}
      label={`move ${task.title || 'task'}`}
      onClose={controller.close}
      className="task-move-picker"
    >
      {body}
    </AnchoredPopover>
  );
}
