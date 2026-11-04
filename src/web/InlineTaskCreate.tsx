import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { TaskList } from '../modules/tasks/contracts';
import { Icon } from '../ui/Icon';
import {
  captureInlineTask,
  inlineCreateWasRejected,
  type InlineTaskAttempt,
} from './inline-task-create';
import { newOperationId, useCommands } from './useCommands';
import './InlineTaskCreate.css';

interface Props {
  accountId: string;
  list: TaskList;
  clockOffset: number;
  enabled: boolean;
  onCreated: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onInspect?: (identity: string) => void;
}

export function InlineTaskCreate({
  accountId,
  list,
  clockOffset,
  enabled,
  onCreated,
  onDirtyChange,
  onInspect,
}: Props) {
  const [open, setOpen] = useState(false),
    [title, setTitle] = useState(''),
    [validation, setValidation] = useState(''),
    [attempt, setAttempt] = useState<InlineTaskAttempt | null>(null);
  const input = useRef<HTMLInputElement>(null),
    submitting = useRef(false),
    dirtyChanged = useRef(onDirtyChange);
  dirtyChanged.current = onDirtyChange;
  const commands = useCommands(accountId, clockOffset, onCreated);
  const rejected = inlineCreateWasRejected(
    commands.latest?.id === attempt?.identity ? commands.latest : null,
    commands.errorDetails?.code,
    Boolean(commands.errorDetails?.operationId),
  );
  const locked = attempt !== null && !rejected;
  const dirty = title.trim().length > 0 || locked;
  useEffect(() => {
    dirtyChanged.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyChanged.current?.(false), []);
  useEffect(() => {
    if (open && !commands.busy) input.current?.focus();
  }, [open, commands.busy]);

  async function save() {
    if (!enabled || submitting.current || commands.busy || list.accountId !== accountId) return;
    let captured: InlineTaskAttempt;
    try {
      captured =
        locked && attempt
          ? attempt
          : captureInlineTask(list, title, () => newOperationId(clockOffset));
    } catch (error) {
      setValidation(
        error instanceof z.ZodError
          ? (error.issues[0]?.message ?? 'enter a title')
          : 'check the task title.',
      );
      return;
    }
    setValidation('');
    setAttempt(captured);
    submitting.current = true;
    try {
      const result = await commands.submit(captured.command, 'provider', captured.identity);
      if (result?.state === 'succeeded') {
        setTitle('');
        setAttempt(null);
        commands.clearError();
      }
    } finally {
      submitting.current = false;
    }
  }

  if (!open)
    return (
      <button
        className="inline-task-create__open"
        type="button"
        disabled={!enabled && !title && !attempt}
        onClick={() => setOpen(true)}
      >
        <Icon name="plus" size={13} />
        {title ? 'continue task' : 'add a task'}
      </button>
    );

  return (
    <form
      className="inline-task-create"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="inline-task-create__field">
        <Icon name="plus" size={13} />
        <input
          ref={input}
          aria-label={`new task in ${list.title || 'untitled list'}`}
          placeholder="add a task…"
          value={title}
          readOnly={locked || commands.busy}
          disabled={!enabled}
          onChange={(event) => {
            if (rejected) setAttempt(null);
            setTitle(event.target.value);
            setValidation('');
            commands.clearError();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              setOpen(false);
            }
          }}
          autoComplete="off"
          aria-invalid={Boolean(validation || commands.error)}
        />
        <button
          type="submit"
          aria-label={`save task in ${list.title || 'untitled list'}`}
          disabled={!enabled || commands.busy || (!locked && !title.trim())}
        >
          <Icon name={commands.busy ? 'sync' : 'check'} size={14} />
        </button>
      </div>
      {(validation || commands.error) && (
        <div className="inline-task-create__error" role="alert">
          <p>{validation || (locked ? 'this task has not been confirmed yet.' : commands.error)}</p>
          {locked && (
            <button type="submit" disabled={!enabled || commands.busy}>
              check again
            </button>
          )}
          {locked && onInspect && attempt && (
            <button type="button" onClick={() => onInspect(attempt.identity)}>
              review save
            </button>
          )}
        </div>
      )}
    </form>
  );
}
