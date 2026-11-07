import { useCallback, useRef, useState } from 'react';
import type { Task } from '../../contracts/task';
import type { TaskEditorSave } from './editor-contract';

export interface PendingTaskEdit {
  id: number;
  task: Task;
  input: TaskEditorSave;
  confirmedAfter: number | null;
}

export function editAcknowledged(edit: PendingTaskEdit, readVersion?: number) {
  return edit.confirmedAfter !== null && (readVersion ?? -1) > edit.confirmedAfter;
}

export function projectTaskEdits(
  task: Task,
  edits: readonly PendingTaskEdit[],
  readVersion?: number,
): Task {
  return edits.reduce(
    (current, edit) =>
      edit.input.accountId === current.accountId &&
      edit.input.taskId === current.id &&
      !editAcknowledged(edit, readVersion)
        ? Object.assign({}, current, edit.input.patch)
        : current,
    task,
  );
}

/** Submitted drafts stay visible; only confirmed query data owns task revisions. */
export function useTaskEdits(accountId: string, version: number) {
  const [items, setItems] = useState<PendingTaskEdit[]>([]);
  const currentItems = useRef(items);
  currentItems.current = items;
  const currentVersion = useRef(version);
  currentVersion.current = version;
  const tails = useRef(new Map<string, Promise<boolean>>());
  const start = useCallback(
    (id: number, task: Task, input: TaskEditorSave) => {
      if (input.accountId !== accountId || task.accountId !== accountId || input.taskId !== task.id)
        return;
      const edit = {
        id,
        task: structuredClone(task),
        input: structuredClone(input),
        confirmedAfter: null,
      };
      currentItems.current = [...currentItems.current.filter((item) => item.id !== id), edit];
      setItems(currentItems.current);
    },
    [accountId],
  );
  const confirm = useCallback((id: number) => {
    const confirmedAfter = currentVersion.current;
    setItems((previous) =>
      previous.map((item) =>
        item.id === id && item.confirmedAfter === null ? { ...item, confirmedAfter } : item,
      ),
    );
  }, []);
  const remove = useCallback((id: number) => {
    setItems((previous) =>
      previous.some((item) => item.id === id)
        ? previous.filter((item) => item.id !== id)
        : previous,
    );
  }, []);
  const run = useCallback((taskId: string, job: (queued: boolean) => Promise<boolean>) => {
    const previous = tails.current.get(taskId);
    const waitingForRead =
      currentItems.current.filter((item) => item.input.taskId === taskId).length > 1;
    const work = previous
      ? previous.then(
          (saved) => (saved ? job(true) : false),
          () => false,
        )
      : Promise.resolve().then(() => job(waitingForRead));
    tails.current.set(taskId, work);
    const clear = () => {
      if (tails.current.get(taskId) === work) tails.current.delete(taskId);
    };
    void work.then(clear, clear);
    return work;
  }, []);
  return { items, start, confirm, remove, run };
}

export type TaskEditController = ReturnType<typeof useTaskEdits>;
