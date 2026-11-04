import { newOperationId } from '../client/operation-identity';
import { useEffect, useRef, useState } from 'react';
import { OperationSummarySchema, type OperationSummary } from '../modules/tasks/operation-contract';
import { request, RequestError } from '../client/http';
import { serverConnection } from '../client/connectivity';

const progressing = new Set(['accepted', 'running', 'partial']);
export function commandNeedsRefresh(
  previous: OperationSummary | null,
  current: OperationSummary,
  monitoringStopped = false,
): boolean {
  const same = previous?.id === current.id ? previous : null;
  return (
    (monitoringStopped && !current.finished && progressing.has(current.state)) ||
    current.confirmedSteps !== (same?.confirmedSteps ?? 0) ||
    (current.finished && !same?.finished) ||
    (!progressing.has(current.state) && same?.state !== current.state)
  );
}

export function commandRequestError(error: unknown, operationId: string): RequestError {
  if (
    error instanceof RequestError &&
    !['server_unavailable', 'response_invalid'].includes(error.code)
  )
    return error;
  const recorded = error instanceof RequestError ? error : null;
  return new RequestError(
    recorded?.code ?? 'server_unavailable',
    recorded?.code === 'response_invalid'
      ? recorded.message
      : 'connection lost while saving. check this change before trying again.',
    recorded?.requestId,
    recorded?.operationId ?? operationId,
    recorded?.fields,
  );
}

export function useCommands(accountId: string, clockOffset: number, onChanged: () => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [latest, setLatest] = useState<OperationSummary | null>(null);
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(() => new Set());
  const [errorDetails, setErrorDetails] = useState<RequestError | null>(null);
  const alive = useRef(true),
    callback = useRef(onChanged);
  callback.current = onChanged;
  const abort = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const received = useRef<OperationSummary | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, [accountId]);
  const base = `/api/accounts/${encodeURIComponent(accountId)}`;
  function publish(operation: OperationSummary, signal: AbortSignal, monitoringStopped = false) {
    if (!alive.current || signal.aborted) return;
    const refresh = commandNeedsRefresh(received.current, operation, monitoringStopped);
    received.current = operation;
    setLatest(operation);
    if (refresh) callback.current();
  }
  async function follow(
    operation: OperationSummary,
    signal: AbortSignal,
  ): Promise<OperationSummary> {
    const deadline = Date.now() + 30_000;
    while (
      progressing.has(operation.state) &&
      !operation.finished &&
      Date.now() < deadline &&
      !signal.aborted
    ) {
      if (operation.nextAttemptAt && operation.nextAttemptAt - Date.now() > 2_000) break;
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        };
        const timer = setTimeout(done, Math.max(350, (operation.nextAttemptAt ?? 0) - Date.now()));
        signal.addEventListener('abort', cancel, { once: true });
      });
      operation = await request(
        `${base}/operations/${encodeURIComponent(operation.id)}/advance`,
        OperationSummarySchema,
        { method: 'POST', body: {}, signal },
      );
      publish(operation, signal);
    }
    return operation;
  }
  async function submit(
    command: unknown,
    category: 'local' | 'provider',
    identity?: string,
  ): Promise<OperationSummary | null> {
    if (submitting.current) return null;
    if (serverConnection() !== 'reachable') {
      const message =
        serverConnection() === 'incompatible'
          ? 'reload lanes before making another change.'
          : 'the server connection is paused. check the connection before submitting. your draft stays here.';
      setError(message);
      setErrorDetails(new RequestError('connection_paused', message));
      return null;
    }
    submitting.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setErrorDetails(null);
    setLatest(null);
    const taskId =
      command &&
      typeof command === 'object' &&
      'taskId' in command &&
      typeof command.taskId === 'string'
        ? command.taskId
        : null;
    setPendingTaskIds(new Set(taskId ? [taskId] : []));
    const operationId = identity ?? newOperationId(clockOffset);
    try {
      const admitted = await request(`${base}/commands/${category}`, OperationSummarySchema, {
        method: 'POST',
        body: { operationId, command },
        signal: controller.signal,
      });
      publish(admitted, controller.signal);
      const result = category === 'provider' ? await follow(admitted, controller.signal) : admitted;
      publish(result, controller.signal, true);
      if (result.state !== 'succeeded' && alive.current) {
        const message =
          result.error?.message ??
          (result.state === 'uncertain'
            ? 'google may have saved this change. check the result before trying again.'
            : result.finished
              ? result.confirmedSteps > 0
                ? 'some changes were saved. review the result.'
                : result.state === 'cancelled'
                  ? 'this change was stopped.'
                  : 'this change could not be saved. review the result before trying again.'
              : progressing.has(result.state)
                ? 'this change is still saving. check its status before trying again.'
                : 'saving is paused. check this change before trying again.');
        setError(message);
        setErrorDetails(
          new RequestError(result.error?.code ?? result.state, message, undefined, result.id),
        );
      }
      return result;
    } catch (error) {
      if (!controller.signal.aborted && alive.current) {
        const details = commandRequestError(error, operationId);
        setError(details.message);
        setErrorDetails(details);
        let recovered = false;
        if (!(error instanceof RequestError && error.code === 'unauthenticated')) {
          try {
            const recorded = await request(
              `${base}/operations/${encodeURIComponent(operationId)}`,
              OperationSummarySchema,
              { signal: controller.signal },
            );
            publish(recorded, controller.signal);
            recovered = true;
          } catch {
            /* A missing or unreachable receipt keeps the same identity for an unchanged-input retry. */
          }
        }
        if (!recovered && alive.current && !controller.signal.aborted) callback.current();
      }
      return null;
    } finally {
      submitting.current = false;
      if (alive.current) {
        setBusy(false);
        setPendingTaskIds(new Set());
      }
    }
  }
  async function advance(operationId: string): Promise<void> {
    if (submitting.current) return;
    submitting.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setErrorDetails(null);
    try {
      const operation = await request(
        `${base}/operations/${encodeURIComponent(operationId)}/advance`,
        OperationSummarySchema,
        { method: 'POST', body: {}, signal: controller.signal },
      );
      publish(operation, controller.signal);
      const result = await follow(operation, controller.signal);
      publish(result, controller.signal, true);
    } catch (error) {
      if (!controller.signal.aborted && alive.current) {
        const details = commandRequestError(error, operationId);
        setError(details.message);
        setErrorDetails(details);
        callback.current();
      }
    } finally {
      submitting.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  }
  return {
    submit,
    advance,
    busy,
    error,
    errorDetails,
    latest,
    pendingTaskIds,
    clearError: () => {
      setError('');
      setErrorDetails(null);
    },
  };
}
