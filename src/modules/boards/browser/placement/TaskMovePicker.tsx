import { useLayoutEffect, useRef } from 'react';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { AnchoredPopover } from '../../../../shared/ui/popover/Popover';
import type { TaskPlacement } from './useTaskPlacement';
import { TaskMoveDestinations } from './TaskMoveDestinations';
import './TaskMovePicker.css';

export function TaskMovePicker({
  controller,
  embedded = false,
}: {
  controller: TaskPlacement;
  embedded?: boolean;
}) {
  const selection = controller.selection!;
  const task = controller.source?.task ?? selection.task;
  const content = useRef<HTMLDivElement>(null);
  const previousPhase = useRef(false);
  useLayoutEffect(() => {
    const phase = Boolean(controller.confirmation || controller.locked);
    if (phase || previousPhase.current)
      content.current
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus({ preventScroll: true });
    previousPhase.current = phase;
  }, [!!controller.confirmation, controller.locked]);
  const disabled =
    !controller.enabled ||
    !task.capabilities.canMove ||
    task.unsupportedHierarchy ||
    controller.busy ||
    controller.sourceLoading ||
    !controller.source?.preview.coverageComplete ||
    controller.locked;
  const body = (
    <div ref={content} className="popover__menu">
      {controller.confirmation ? (
        <>
          <p className="task-move-picker__message">
            move this task and its {controller.confirmation.subtaskCount} subtasks to{' '}
            {controller.confirmation.listTitle || 'this list'}?
          </p>
          <button type="button" className="popover__item" onClick={controller.cancelConfirmation}>
            <Icon name="left" size={14} /> back
          </button>
          <button
            type="button"
            className="popover__item"
            disabled={controller.busy || !controller.enabled}
            onClick={controller.confirm}
          >
            <Icon name="arrow" size={15} /> move checklist
          </button>
        </>
      ) : controller.locked ? (
        <>
          <p className="task-move-picker__message">
            {controller.busy
              ? 'moving…'
              : 'this move needs checking before another destination is chosen.'}
          </p>
          {!controller.busy && (
            <button
              type="button"
              className="popover__item"
              onClick={controller.retry}
              disabled={!controller.enabled}
            >
              <Icon name="sync" size={14} /> check again
            </button>
          )}
          <button type="button" className="popover__item" onClick={controller.inspect}>
            <Icon name="history" size={14} /> review save
          </button>
        </>
      ) : (
        <TaskMoveDestinations
          controller={controller}
          task={task}
          disabled={disabled}
          boardId={selection.boardId}
        />
      )}
      {controller.error && (
        <div className="task-move-picker__error" role="alert">
          <p>{controller.error}</p>
          {!controller.locked && (
            <button type="button" onClick={controller.reload}>
              try again
            </button>
          )}
        </div>
      )}
      {(!task.capabilities.canMove || task.unsupportedHierarchy) && (
        <p className="task-move-picker__error">
          {task.capabilities.restriction || 'google does not allow moving this task.'}
        </p>
      )}
      {!controller.sourceLoading &&
        controller.source &&
        !controller.source.preview.coverageComplete && (
          <p className="task-move-picker__error">
            refresh the source list before moving this task.
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
