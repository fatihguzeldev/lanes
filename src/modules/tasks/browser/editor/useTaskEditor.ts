import { useState } from 'react';
import type { Task } from '../../contracts/task';
import type { EditorLocation, EditorSelection } from './editor-contract';

export function useTaskEditor(
  resolveLocation: (listId: string) => Promise<EditorLocation>,
  onNotice: (message: string) => void,
) {
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [dirty, setDirty] = useState(false);
  const select = (next: EditorSelection) => {
    setSelection(next);
    setDirty(false);
  };
  const resolve = (
    listId: string,
    loaded: EditorLocation | undefined,
    finish: (location: EditorLocation) => void,
    fallback: string,
  ) => {
    if (loaded) finish(loaded);
    else
      void resolveLocation(listId)
        .then(finish)
        .catch((error) => onNotice(error instanceof Error ? error.message : fallback));
  };
  return {
    selection,
    dirty,
    setDirty,
    open(task: Task, loaded?: EditorLocation) {
      resolve(
        task.listId,
        loaded,
        (location) => select({ task, ...location }),
        'this task’s list could not be opened.',
      );
    },
    create(listId: string, initialDay: string | null, loaded?: EditorLocation) {
      resolve(
        listId,
        loaded,
        (location) => select({ task: null, ...location, initialDay }),
        'the selected list could not be opened.',
      );
    },
    createSubtask(task: Task) {
      if (!selection) return;
      select({
        task: null,
        list: selection.list,
        parent: task,
        ...(selection.boardId ? { boardId: selection.boardId } : {}),
      });
    },
    close() {
      setSelection(null);
      setDirty(false);
    },
  };
}
export type TaskEditorController = ReturnType<typeof useTaskEditor>;
