import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { boardCreationRejected, captureBoardCreation, defaultBoardName } from './board-creation';

export function useBoardCreation(options: {
  accountId: string;
  clockOffset: number;
  onChanged(): void;
  onNotice(message: string): void;
  onInspect(id: string): void;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const [open, setOpen] = useState(false),
    [title, setTitle] = useState(defaultBoardName),
    [validation, setValidation] = useState(''),
    [attempt, setAttempt] = useState<ReturnType<typeof captureBoardCreation> | null>(null);
  const commands = useCommands(options.accountId, options.clockOffset, options.onChanged);
  const flight = useRef(false),
    dirtyCallback = useRef(options.onDirtyChange);
  dirtyCallback.current = options.onDirtyChange;
  const rejected = boardCreationRejected(
    commands.latest?.id === attempt?.identity ? commands.latest : null,
    commands.errorDetails?.code,
    !!commands.errorDetails?.operationId,
  );
  const locked = attempt !== null && !rejected;
  const dirty = attempt !== null || (open && title !== defaultBoardName);
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);
  return {
    open,
    title,
    dirty,
    busy: commands.busy,
    locked,
    error: validation || commands.error,
    show() {
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    discard() {
      setOpen(false);
      setTitle(defaultBoardName);
      setAttempt(null);
      setValidation('');
      commands.clearError();
    },
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
    async save() {
      if (flight.current || commands.busy) return;
      let captured: ReturnType<typeof captureBoardCreation>;
      try {
        captured =
          locked && attempt
            ? attempt
            : captureBoardCreation(title, () => newOperationId(options.clockOffset));
      } catch (error) {
        setValidation(
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'check the board name.')
            : 'check the board name.',
        );
        return;
      }
      setAttempt(captured);
      setValidation('');
      flight.current = true;
      try {
        const result = await commands.submit(captured.command, 'local', captured.identity);
        if (result?.state === 'succeeded') {
          setOpen(false);
          setTitle(defaultBoardName);
          setAttempt(null);
          commands.clearError();
        } else
          options.onNotice(
            'this board has not been confirmed yet. reopen the board entry to check its save.',
          );
      } finally {
        flight.current = false;
      }
    },
  };
}

export type BoardCreation = ReturnType<typeof useBoardCreation>;
