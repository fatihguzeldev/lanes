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
  const [saves, setSaves] = useState<ReadonlySet<number | 'labels'>>(() => new Set());
  const dirtyNow = useRef(false);
  const savingNow = useRef(saves);
  const nextId = useRef(0);
  const intent = useRef(0);
  const afterCapture = useRef<{ id: number; action(): void } | null>(null);
  const current = useRef(session);
  current.current = session;
  const select = (next: EditorSelection) => {
    afterCapture.current = null;
    const selected = { id: ++nextId.current, selection: next };
    current.current = selected;
    setSession(selected);
    dirtyNow.current = false;
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
    afterCapture.current = null;
    current.current = null;
    setSession(null);
    dirtyNow.current = false;
    changeDirty(false);
  };
  return {
    session,
    selection: session?.selection ?? null,
    dirty,
    saving: saves.size > 0,
    isDirty: () => dirtyNow.current,
    isSaving: () => savingNow.current.size > 0,
    deferCreateExit(action: () => void) {
      const selected = current.current;
      if (
        !selected?.selection.inlineCreate ||
        !dirtyNow.current ||
        !savingNow.current.has(selected.id)
      )
        return false;
      afterCapture.current = { id: selected.id, action };
      return true;
    },
    setDirty(value: boolean, id = current.current?.id) {
      if (current.current?.id === id) {
        dirtyNow.current = value;
        changeDirty(value);
        const deferred = afterCapture.current;
        if (!value && deferred && deferred.id === id) {
          afterCapture.current = null;
          queueMicrotask(() => {
            if (nextId.current === id && !dirtyNow.current) deferred.action();
          });
        }
      }
    },
    setSaving(id: number | 'labels', busy: boolean) {
      if (savingNow.current.has(id) === busy) return;
      const next = new Set(savingNow.current);
      if (busy) next.add(id);
      else next.delete(id);
      savingNow.current = next;
      setSaves(next);
      if (!busy && dirtyNow.current && afterCapture.current?.id === id) afterCapture.current = null;
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
    createInline(location: EditorLocation) {
      intent.current++;
      select({ task: null, ...location, inlineCreate: true });
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
