import { useCallback, useState } from 'react';
import type { Task } from '../../../tasks/contracts/task';
import { readTask } from '../../../tasks/browser/queries/references';
import { HistoryPanel, type HistoryPanelProps } from './HistoryPanel';

export interface HistoryDialogController {
  visible: boolean;
  task: Task | null;
  open: (task?: Task | null) => void;
  close: () => void;
}

export function useHistoryDialog(): HistoryDialogController {
  const [selection, setSelection] = useState<{ visible: boolean; task: Task | null }>({
    visible: false,
    task: null,
  });
  const open = useCallback((task: Task | null = null) => {
    setSelection({ visible: true, task });
  }, []);
  const close = useCallback(() => {
    setSelection((previous) => ({ ...previous, visible: false }));
  }, []);
  return { ...selection, open, close };
}

interface Props extends Omit<HistoryPanelProps, 'task' | 'onClose' | 'onOpenTask'> {
  controller: HistoryDialogController;
  onOpenTask: (task: Task) => void;
  onNotice: (message: string) => void;
}

export function HistoryDialog({ controller, onOpenTask, onNotice, ...props }: Props) {
  if (!controller.visible) return null;
  return (
    <HistoryPanel
      {...props}
      task={controller.task}
      onClose={controller.close}
      onOpenTask={(reference) => {
        if (reference.accountId !== props.account.id) return;
        void readTask(props.account.id, reference.taskId)
          .then((task) => {
            controller.close();
            onOpenTask(task);
          })
          .catch((error) =>
            onNotice(
              error instanceof Error
                ? error.message
                : 'this task is no longer available. its recorded history is retained.',
            ),
          );
      }}
    />
  );
}
