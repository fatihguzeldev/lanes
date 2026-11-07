import { useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Task } from '../../../tasks/contracts/task';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import type { PlacementChoice } from './placement-model';

/** Destination browsing owns selection; the account's task queue owns captured moves. */
export function useTaskPlacement(options: {
  account: ConnectionSummary;
  onMoveTask(task: Task, choice: PlacementChoice): boolean;
}) {
  const [selection, setSelection] = useState<{
    task: Task;
    anchor: HTMLElement;
    boardId: string | null;
  } | null>(null);
  const [error, setError] = useState('');
  const connection = useServerConnection();
  const enabled = options.account.state === 'connected' && connection === 'reachable';
  return {
    selection,
    enabled,
    error,
    open(task: Task, anchor: HTMLElement, boardId: string | null) {
      if (
        task.accountId !== options.account.id ||
        !task.capabilities.canMove ||
        task.unsupportedHierarchy
      )
        return;
      setError('');
      setSelection({ task, anchor, boardId });
    },
    close() {
      setSelection(null);
    },
    reload() {
      setError('');
    },
    choose(choice: PlacementChoice) {
      if (!selection || !enabled) return;
      if (options.onMoveTask(selection.task, choice)) {
        setSelection(null);
        setError('');
      } else setError('this destination is no longer available.');
    },
  };
}
export type TaskPlacement = ReturnType<typeof useTaskPlacement>;
