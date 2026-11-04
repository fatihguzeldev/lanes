import type { Task } from '../../contracts/task';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { AnchoredPopover } from '../../../../shared/ui/popover/Popover';

interface Props {
  task: Task;
  anchor: HTMLElement;
  writable: boolean;
  localWritable: boolean;
  submit: (
    command: unknown,
    category?: 'local' | 'provider',
    identity?: string,
  ) => Promise<boolean>;
  onClose: () => void;
  onHistory: (task: Task) => void;
  onOpen: (task: Task) => void;
  onDuplicate: (task: Task) => void;
  onMove: (task: Task) => void;
  onToggleComplete: (task: Task) => void;
  onDelete: (task: Task) => void;
}
export function TaskOptions({
  task,
  anchor,
  writable,
  localWritable,
  submit,
  onClose,
  onHistory,
  onOpen,
  onDuplicate,
  onMove,
  onToggleComplete,
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
            void submit({
              kind: 'task.patch',
              taskId: task.id,
              expectedRevision: task.revision,
              patch: { starred: !task.starred },
            }).then((done) => {
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
        <button
          disabled={!writable || !task.capabilities.canMove}
          onClick={() => {
            onMove(task);
          }}
        >
          <Icon name="arrow" size={16} />
          move task
        </button>
        <button
          disabled={!writable}
          onClick={() => {
            onToggleComplete(task);
          }}
        >
          <Icon name="check" size={16} />
          {task.completed ? 'reopen' : 'complete'}
        </button>
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
