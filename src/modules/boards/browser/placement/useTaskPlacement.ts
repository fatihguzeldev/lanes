import { useEffect, useRef, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import { TaskSchema, type Task } from '../../../tasks/contracts/task';
import { TaskConsequencesSchema } from '../../../tasks/contracts/consequence';
import { request } from '../../../../shared/browser/http/http';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import {
  captureTaskPlacement,
  placementAttemptRejected,
  type PlacementAttempt,
  type PlacementChoice,
  type PlacementPreview,
} from './placement-model';

export function useTaskPlacement(options: {
  account: ConnectionSummary;
  clockOffset: number;
  onChanged(): void;
  onNotice(message: string): void;
  onInspect(id: string): void;
  onMoved?: ((taskId: string) => void) | undefined;
}) {
  const [selection, setSelection] = useState<{
    task: Task;
    anchor: HTMLElement;
    boardId: string | null;
  } | null>(null);
  const [source, setSource] = useState<{ task: Task; preview: PlacementPreview } | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false),
    [error, setError] = useState(''),
    [generation, setGeneration] = useState(0);
  const [attempt, setAttempt] = useState<PlacementAttempt | null>(null),
    [confirmation, setConfirmation] = useState<PlacementAttempt | null>(null);
  const commands = useCommands(options.account.id, options.clockOffset, options.onChanged);
  const connection = useServerConnection();
  const flight = useRef(false);
  const moved = useRef(options.onMoved);
  moved.current = options.onMoved;
  const selectedId = selection?.task.id ?? null;
  useEffect(() => {
    setSource(null);
    setError('');
    if (!selectedId) {
      setSourceLoading(false);
      return;
    }
    const abort = new AbortController();
    setSourceLoading(true);
    const base = `/api/accounts/${encodeURIComponent(options.account.id)}/tasks/${encodeURIComponent(selectedId)}`;
    void Promise.all([
      request(base, TaskSchema, { signal: abort.signal }),
      request(`${base}/consequences`, TaskConsequencesSchema, { signal: abort.signal }),
    ])
      .then(([task, preview]) => {
        if (abort.signal.aborted) return;
        if (
          task.accountId !== options.account.id ||
          preview.taskId !== task.id ||
          preview.revision !== task.revision
        )
          throw new Error('this task changed while opening its destinations. try again.');
        setSource({ task, preview });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setError(error instanceof Error ? error.message : 'couldn’t read this task.');
      })
      .finally(() => {
        if (!abort.signal.aborted) setSourceLoading(false);
      });
    return () => abort.abort();
  }, [selectedId, options.account.id, generation]);
  const receipt = commands.latest?.id === attempt?.identity ? commands.latest : null;
  const rejected = placementAttemptRejected(
    receipt,
    commands.errorDetails?.code,
    !!commands.errorDetails?.operationId,
  );
  const locked = attempt !== null && !rejected;
  const enabled = options.account.state === 'connected' && connection === 'reachable';
  async function execute(captured: PlacementAttempt) {
    if (!enabled || commands.busy || flight.current) return;
    flight.current = true;
    setAttempt(captured);
    setConfirmation(null);
    setError('');
    try {
      const result = await commands.submit(captured.command, 'provider', captured.identity);
      if (result?.state === 'succeeded') {
        setAttempt(null);
        setSelection(null);
        commands.clearError();
        moved.current?.(captured.taskId);
      } else
        options.onNotice('this move has not been confirmed. check its save from the sync menu.');
    } finally {
      flight.current = false;
    }
  }
  return {
    selection,
    source,
    sourceLoading,
    confirmation,
    attempt,
    locked,
    enabled,
    busy: commands.busy,
    error: error || commands.error,
    open(task: Task, anchor: HTMLElement, boardId: string | null) {
      if (commands.busy || flight.current) {
        options.onNotice('wait for this move to finish before choosing another destination.');
        return;
      }
      if (locked && task.id !== attempt?.taskId) {
        options.onNotice('check the previous move from the sync menu before moving another task.');
        return;
      }
      if (
        task.accountId !== options.account.id ||
        !task.capabilities.canMove ||
        task.unsupportedHierarchy
      )
        return;
      if (task.id !== attempt?.taskId || rejected) {
        setAttempt(null);
        commands.clearError();
      }
      setConfirmation(null);
      setSelection({ task, anchor, boardId });
      setGeneration((value) => value + 1);
    },
    close() {
      setSelection(null);
      setConfirmation(null);
    },
    reload() {
      setGeneration((value) => value + 1);
    },
    choose(choice: PlacementChoice) {
      if (!source || !enabled || commands.busy || locked) return;
      try {
        const captured = captureTaskPlacement(source.task, source.preview, choice, () =>
          newOperationId(options.clockOffset),
        );
        if (captured.subtaskCount) setConfirmation(captured);
        else void execute(captured);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'check this destination.');
      }
    },
    cancelConfirmation() {
      setConfirmation(null);
    },
    confirm() {
      if (confirmation) void execute(confirmation);
    },
    retry() {
      if (attempt) void execute(attempt);
    },
    inspect() {
      const identity = commands.errorDetails?.operationId ?? attempt?.identity;
      if (identity) options.onInspect(identity);
    },
  };
}

export type TaskPlacement = ReturnType<typeof useTaskPlacement>;
