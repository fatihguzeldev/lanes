import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { useCreationQueue } from './useCreationQueue';
import type { Board } from '../../contracts/board';
import { captureListCreation } from './list-creation';
import { readCreatedList } from './creation-receipt';

export function useListCreation(options: {
  accountId: string;
  board: Board | null;
  clockOffset: number;
  version: number;
  inventoryReady: boolean;
  observedIds: readonly string[];
  onChanged(): void;
  onNotice(message: string): void;
  onInspect(id: string): void;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [validation, setValidation] = useState('');
  const [target, setTarget] = useState<Board | null>(null);
  const draft = useRef({ open, title, target });
  draft.current = { open, title, target };
  const jobs = useCreationQueue({
    ...options,
    category: 'provider',
    resolve: (identity, signal, onAddress) =>
      readCreatedList(options.accountId, identity, signal, onAddress),
  });
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
    if (!value.target || value.target.accountId !== options.accountId) return;
    if (!value.title.trim()) {
      discard();
      return;
    }
    try {
      const board = options.board?.id === value.target.id ? options.board : value.target;
      const captured = captureListCreation(board, value.title, () =>
        newOperationId(options.clockOffset),
      );
      jobs.enqueue({ ...captured, title: value.title.trim(), boardId: board.id, board });
      discard();
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? (error.issues[0]?.message ?? 'check the list name.')
          : 'check the list name.';
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
    resources: jobs.resources,
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
      const board = options.board?.id === entry.boardId ? options.board : entry.board;
      if (!board) return;
      setTarget(board);
      draft.current = { open: true, title: entry.title, target: board };
      setTitle(entry.title);
      setValidation('');
      setOpen(true);
    },
    boardId: target?.id ?? null,
    currentBoardId: options.board?.id ?? null,
    show(board: Board) {
      if (board.accountId !== options.accountId) return;
      if (draft.current.open && draft.current.target?.id !== board.id && draft.current.title.trim())
        save(true);
      setTarget(board);
      draft.current = { ...draft.current, target: board, open: true };
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

export type ListCreation = ReturnType<typeof useListCreation>;
