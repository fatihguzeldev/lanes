import type { ReactNode } from 'react';
import type { Task } from '../../contracts/task';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { AnchoredPopover } from '../../../../shared/ui/popover/Popover';
import { Submenu } from '../../../../shared/ui/submenu/Submenu';

interface Props {
  task: Task;
  anchor: HTMLElement;
  writable: boolean;
  localWritable: boolean;
  onToggleStar: (task: Task, starred: boolean) => Promise<boolean>;
  onClose: () => void;
  onHistory: (task: Task) => void;
  onOpen: (task: Task) => void;
  onDuplicate: (task: Task) => void;
  onMove: (task: Task, anchor: HTMLElement) => void;
  moveOpen?: boolean;
  moveMenu?: ReactNode;
  onMoveClose?: () => void;
  onDelete: (task: Task) => void;
}
export function TaskOptions({
  task,
  anchor,
  writable,
  localWritable,
  onToggleStar,
  onClose,
  onHistory,
  onOpen,
  onDuplicate,
  onMove,
  moveOpen,
  moveMenu,
  onMoveClose,
  onDelete,
}: Props) {
  return (
    <AnchoredPopover anchor={anchor} label={task.title || 'task options'} onClose={() => onClose()}>
      <div className="dialog__actions">
        <button
          onClick={() => {
            onHistory(task);
          }}
        >
          <Icon name="history" size={16} /> history
        </button>
        <button
          onClick={() => {
            onOpen(task);
          }}
        >
          <Icon name="pen" size={16} />
          open task
        </button>
        <button
          disabled={!localWritable}
          onClick={() => {
            void onToggleStar(task, !task.starred).then((done) => {
              if (done) onClose();
            });
          }}
        >
          <Icon name="star" size={16} />
          {task.starred ? 'remove star' : 'star task'}
        </button>
        <button
          disabled={!writable}
          onClick={() => {
            onDuplicate(task);
          }}
        >
          <Icon name="copy" size={16} />
          duplicate task
        </button>
        <Submenu
          label="move task"
          trigger={
            <>
              <Icon name="arrow" size={16} />
              <span>move task</span>
            </>
          }
          {...(moveOpen !== undefined ? { open: moveOpen } : {})}
          className="task-move-picker"
          disabled={!writable || !task.capabilities.canMove}
          onOpenChange={(open, trigger) => {
            if (open) onMove(task, trigger);
            else onMoveClose?.();
          }}
        >
          {moveMenu}
        </Submenu>
        <button
          className="danger"
          disabled={!writable || !task.capabilities.canDelete}
          onClick={() => onDelete(task)}
        >
          <Icon name="trash" size={16} />
          delete task
        </button>
      </div>
    </AnchoredPopover>
  );
}
