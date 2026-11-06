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
    [error, setError] = useState('');
  const [attempt, setAttempt] = useState<PlacementAttempt | null>(null),
    [confirmation, setConfirmation] = useState<PlacementAttempt | null>(null);
  const commands = useCommands(options.account.id, options.clockOffset, options.onChanged);
  const connection = useServerConnection();
  const flight = useRef(false);
  const sourceRead = useRef<AbortController | null>(null);
  const moved = useRef(options.onMoved);
  moved.current = options.onMoved;
  useEffect(
    () => () => {
      sourceRead.current?.abort();
      sourceRead.current = null;
    },
    [options.account.id],
  );
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
      sourceRead.current?.abort();
      sourceRead.current = null;
      setSource(null);
      setSourceLoading(false);
      setError('');
      setSelection({ task, anchor, boardId });
    },
    close() {
      sourceRead.current?.abort();
      sourceRead.current = null;
      setSourceLoading(false);
      setSelection(null);
      setConfirmation(null);
    },
    reload() {
      setSource(null);
      setError('');
    },
    async choose(choice: PlacementChoice) {
      if (!selection || !enabled || commands.busy || locked || flight.current || sourceRead.current)
        return;
      const abort = new AbortController();
      sourceRead.current = abort;
      setSourceLoading(true);
      setError('');
      let captured: PlacementAttempt;
      try {
        const base = `/api/accounts/${encodeURIComponent(options.account.id)}/tasks/${encodeURIComponent(selection.task.id)}`;
        const [task, preview] = await Promise.all([
          request(base, TaskSchema, { signal: abort.signal }),
          request(`${base}/consequences`, TaskConsequencesSchema, { signal: abort.signal }),
        ]);
        if (abort.signal.aborted) return;
        if (
          task.id !== selection.task.id ||
          task.accountId !== options.account.id ||
          preview.taskId !== task.id ||
          preview.revision !== task.revision
        )
          throw new Error(
            'this task changed while checking the move. choose the destination again.',
          );
        setSource({ task, preview });
        captured = captureTaskPlacement(task, preview, choice, () =>
          newOperationId(options.clockOffset),
        );
      } catch (error) {
        if (!abort.signal.aborted)
          setError(error instanceof Error ? error.message : 'check this destination.');
        return;
      } finally {
        if (sourceRead.current === abort) {
          sourceRead.current = null;
          setSourceLoading(false);
        }
      }
      if (captured.subtaskCount) setConfirmation(captured);
      else await execute(captured);
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
