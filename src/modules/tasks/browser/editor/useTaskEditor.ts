import { useRef, useState } from 'react';
import type { Task } from '../../contracts/task';
import type { EditorLocation, EditorSelection } from './editor-contract';

export interface TaskEditorSession {
  id: number;
  selection: EditorSelection;
}

export function useTaskEditor(
  resolveLocation: (listId: string) => Promise<EditorLocation>,
  onNotice: (message: string) => void,
) {
  const [session, setSession] = useState<TaskEditorSession | null>(null);
  const [dirty, changeDirty] = useState(false);
  const [saves, setSaves] = useState<ReadonlySet<number>>(() => new Set());
  const nextId = useRef(0);
  const intent = useRef(0);
  const current = useRef(session);
  current.current = session;
  const select = (next: EditorSelection) => {
    const selected = { id: ++nextId.current, selection: next };
    current.current = selected;
    setSession(selected);
    changeDirty(false);
  };
  const resolve = (
    listId: string,
    loaded: EditorLocation | undefined,
    finish: (location: EditorLocation) => void,
    fallback: string,
  ) => {
    const generation = ++intent.current;
    const apply = (location: EditorLocation) => {
      if (generation === intent.current) finish(location);
    };
    if (loaded) apply(loaded);
    else
      void resolveLocation(listId)
        .then(apply)
        .catch((error) => {
          if (generation === intent.current)
            onNotice(error instanceof Error ? error.message : fallback);
        });
  };
  const dismiss = (id: number | undefined) => {
    if (current.current?.id !== id) return;
    current.current = null;
    setSession(null);
    changeDirty(false);
  };
  return {
    session,
    selection: session?.selection ?? null,
    dirty,
    saving: saves.size > 0,
    setDirty(value: boolean, id = current.current?.id) {
      if (current.current?.id === id) changeDirty(value);
    },
    setSaving(id: number, busy: boolean) {
      setSaves((previous) => {
        if (previous.has(id) === busy) return previous;
        const next = new Set(previous);
        if (busy) next.add(id);
        else next.delete(id);
        return next;
      });
    },
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
      const selection = current.current?.selection;
      if (!selection) return;
      intent.current++;
      select({
        task: null,
        list: selection.list,
        parent: task,
        ...(selection.boardId ? { boardId: selection.boardId } : {}),
      });
    },
    close(id = current.current?.id) {
      if (current.current?.id !== id) return;
      intent.current++;
      dismiss(id);
    },
    closeSaved(id: number) {
      dismiss(id);
    },
  };
}
export type TaskEditorController = ReturnType<typeof useTaskEditor>;
