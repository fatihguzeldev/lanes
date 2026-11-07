import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { boardCreationRejected, captureBoardCreation } from './board-creation';

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
  const [open, setOpen] = useState(false),
    [title, setTitle] = useState(''),
    [validation, setValidation] = useState(''),
    [submitted, setSubmitted] = useState(false),
    [confirmedAfter, setConfirmedAfter] = useState<number | null>(null),
    [attempt, setAttempt] = useState<ReturnType<typeof captureBoardCreation> | null>(null);
  const commands = useCommands(options.accountId, options.clockOffset, options.onChanged);
  const flight = useRef(false),
    dirtyCallback = useRef(options.onDirtyChange),
    version = useRef(options.version);
  version.current = options.version;
  dirtyCallback.current = options.onDirtyChange;
  const rejected = boardCreationRejected(
    commands.latest?.id === attempt?.identity ? commands.latest : null,
    commands.errorDetails?.code,
    !!commands.errorDetails?.operationId,
  );
  const locked = attempt !== null && !rejected;
  const acknowledged =
    confirmedAfter !== null && options.inventoryReady && options.version > confirmedAfter;
  const dirty = !submitted && (attempt !== null || (open && Boolean(title.trim())));
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);
  const discard = () => {
    setOpen(false);
    setTitle('');
    setAttempt(null);
    setValidation('');
    setSubmitted(false);
    setConfirmedAfter(null);
    commands.clearError();
  };
  useEffect(() => {
    if (acknowledged) discard();
  }, [confirmedAfter, options.version, options.inventoryReady]);
  async function save(notifyValidation = false) {
    if (flight.current || commands.busy || submitted) return;
    if (!locked && !title.trim()) {
      discard();
      return;
    }
    let captured: ReturnType<typeof captureBoardCreation>;
    try {
      captured =
        locked && attempt
          ? attempt
          : captureBoardCreation(title, () => newOperationId(options.clockOffset));
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? (error.issues[0]?.message ?? 'check the board name.')
          : 'check the board name.';
      setValidation(message);
      if (notifyValidation) options.onNotice(message);
      return;
    }
    setAttempt(captured);
    setValidation('');
    setSubmitted(true);
    flight.current = true;
    try {
      const result = await commands.submit(captured.command, 'local', captured.identity);
      if (result?.state === 'succeeded') {
        setConfirmedAfter(version.current);
        options.onChanged();
      } else {
        setSubmitted(false);
        setOpen(true);
        options.onNotice(
          'this board has not been confirmed yet. review its save before trying again.',
        );
      }
    } finally {
      flight.current = false;
    }
  }
  return {
    open: open && !acknowledged,
    title,
    submitted: submitted && !acknowledged,
    dirty,
    busy: commands.busy,
    isSaving: () => flight.current,
    locked,
    error: validation || commands.error,
    show() {
      if (submitted) return;
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

export type BoardCreation = ReturnType<typeof useBoardCreation>;
