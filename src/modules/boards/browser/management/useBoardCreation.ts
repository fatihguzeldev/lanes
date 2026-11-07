import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { useCreationQueue } from './useCreationQueue';
import { captureBoardCreation } from './board-creation';

export function useBoardCreation(options: {
  accountId: string;
  clockOffset: number;
  version: number;
  inventoryReady: boolean;
  onChanged(): void;
  onNotice(message: string): void;
  onInspect(id: string): void;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [validation, setValidation] = useState('');
  const draft = useRef({ open, title });
  draft.current = { open, title };
  const jobs = useCreationQueue({ ...options, category: 'local' });
  const dirtyCallback = useRef(options.onDirtyChange);
  dirtyCallback.current = options.onDirtyChange;
  const dirty = open && Boolean(title.trim());
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);
  const discard = () => {
    draft.current = { ...draft.current, open: false, title: '' };
    setOpen(false);
    setTitle('');
    setValidation('');
  };
  function save(notifyValidation = false) {
    const value = draft.current;
    if (!value.open) return;
    if (!value.title.trim()) {
      discard();
      return;
    }
    try {
      const captured = captureBoardCreation(value.title, () => newOperationId(options.clockOffset));
      jobs.enqueue({ ...captured, title: value.title.trim() });
      discard();
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? (error.issues[0]?.message ?? 'check the board name.')
          : 'check the board name.';
      setValidation(message);
      if (notifyValidation) options.onNotice(message);
    }
  }
  return {
    open,
    title,
    dirty,
    error: validation,
    previews: jobs.entries,
    isSaving: jobs.isSaving,
    inspect: jobs.inspect,
    retry: jobs.retry,
    editFailed(identity: string) {
      if (draft.current.open && draft.current.title.trim()) {
        options.onNotice('finish this name before opening another draft.');
        return;
      }
      const entry = jobs.takeRejected(identity);
      if (!entry) return;
      draft.current = { open: true, title: entry.title };
      setTitle(entry.title);
      setValidation('');
      setOpen(true);
    },
    show() {
      draft.current = { ...draft.current, open: true };
      setOpen(true);
    },
    close: discard,
    discard,
    change(value: string) {
      draft.current = { ...draft.current, title: value };
      setTitle(value);
      setValidation('');
    },
    save,
    finish() {
      if (validation) return;
      save(true);
    },
  };
}

export type BoardCreation = ReturnType<typeof useBoardCreation>;
