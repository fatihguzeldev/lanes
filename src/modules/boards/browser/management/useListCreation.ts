import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Board } from '../../contracts/board';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { captureListCreation, listCreationRejected } from './list-creation';

export function useListCreation(options: {
  accountId: string;
  board: Board | null;
  clockOffset: number;
  onChanged(): void;
  onNotice(message: string): void;
  onInspect(id: string): void;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const [open, setOpen] = useState(false),
    [target, setTarget] = useState<Board | null>(null),
    [title, setTitle] = useState(''),
    [validation, setValidation] = useState(''),
    [attempt, setAttempt] = useState<ReturnType<typeof captureListCreation> | null>(null);
  const commands = useCommands(options.accountId, options.clockOffset, options.onChanged);
  const flight = useRef(false),
    dirtyCallback = useRef(options.onDirtyChange);
  dirtyCallback.current = options.onDirtyChange;
  const rejected = listCreationRejected(
    commands.latest?.id === attempt?.identity ? commands.latest : null,
    commands.errorDetails?.code,
    !!commands.errorDetails?.operationId,
  );
  const locked = attempt !== null && !rejected;
  const dirty = attempt !== null || (open && Boolean(title.trim()));
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);
  const discard = () => {
    setOpen(false);
    setTarget(null);
    setTitle('');
    setAttempt(null);
    setValidation('');
    commands.clearError();
  };
  async function save(notifyValidation = false) {
    if (flight.current || commands.busy || !target || target.accountId !== options.accountId)
      return;
    if (!locked && !title.trim()) {
      discard();
      return;
    }
    let captured: ReturnType<typeof captureListCreation>;
    try {
      const board = options.board?.id === target.id ? options.board : target;
      captured =
        locked && attempt
          ? attempt
          : captureListCreation(board, title, () => newOperationId(options.clockOffset));
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? (error.issues[0]?.message ?? 'check the list name.')
          : 'check the list name.';
      setValidation(message);
      if (notifyValidation) options.onNotice(message);
      return;
    }
    setAttempt(captured);
    setValidation('');
    flight.current = true;
    try {
      const result = await commands.submit(captured.command, 'provider', captured.identity);
      if (result?.state === 'succeeded') discard();
      else
        options.onNotice(
          'this list has not been confirmed yet. review its save before trying again.',
        );
    } finally {
      flight.current = false;
    }
  }
  return {
    open,
    boardId: target?.id ?? null,
    title,
    dirty,
    busy: commands.busy,
    isSaving: () => flight.current,
    locked,
    error: validation || commands.error,
    show(board: Board) {
      if (board.accountId !== options.accountId) return;
      if (target && target.id !== board.id && (title.trim() || attempt)) {
        options.onNotice('finish the open list entry before creating a list in another board.');
        return;
      }
      setTarget(board);
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    discard,
    change(value: string) {
      if (locked || commands.busy) return;
      setTitle(value);
      setValidation('');
      if (rejected) setAttempt(null);
      commands.clearError();
    },
    inspect() {
      const identity = commands.errorDetails?.operationId ?? attempt?.identity;
      if (identity) options.onInspect(identity);
    },
    save,
    finish() {
      if (locked || commands.busy || validation || commands.error) return;
      return save(true);
    },
  };
}

export type ListCreation = ReturnType<typeof useListCreation>;
