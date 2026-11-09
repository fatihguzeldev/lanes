import { newOperationId } from './operation-identity';
import { useEffect, useRef, useState } from 'react';
import { OperationSummarySchema, type OperationSummary } from '../../contracts/receipt';
import { request, RequestError } from '../../../../shared/browser/http/http';
import { serverConnection } from '../../../../shared/browser/connectivity/connectivity';

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

export function useCommands(
  accountId: string,
  clockOffset: number,
  onChanged: () => void,
  options: { independent?: boolean } = {},
) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [latest, setLatest] = useState<OperationSummary | null>(null);
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(() => new Set());
  const [errorDetails, setErrorDetailsState] = useState<RequestError | null>(null);
  const lastError = useRef<RequestError | null>(null);
  const setErrorDetails = (details: RequestError | null) => {
    lastError.current = details;
    setErrorDetailsState(details);
  };
  const alive = useRef(true),
    callback = useRef(onChanged);
  callback.current = onChanged;
  const aborts = useRef(new Set<AbortController>());
  const pendingTasks = useRef(new Map<string, number>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const waiting = useRef(0);
  const generation = useRef(0);
  const received = useRef(new Map<string, OperationSummary>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      waiting.current = 0;
      queue.current = Promise.resolve();
      aborts.current.forEach((controller) => controller.abort());
      aborts.current.clear();
      pendingTasks.current.clear();
      received.current.clear();
    };
  }, [accountId]);
  function enqueue<T>(run: () => Promise<T>, cancelled: T): Promise<T> {
    const owner = generation.current;
    waiting.current++;
    setBusy(true);
    const result = (options.independent ? Promise.resolve() : queue.current).then(() =>
      alive.current && generation.current === owner ? run() : cancelled,
    );
    if (!options.independent) queue.current = result.catch(() => undefined);
    return result.finally(() => {
      if (alive.current && generation.current === owner && --waiting.current === 0) setBusy(false);
    });
  }
  const base = `/api/accounts/${encodeURIComponent(accountId)}`;
  function publish(operation: OperationSummary, signal: AbortSignal, monitoringStopped = false) {
    if (!alive.current || signal.aborted) return;
    const refresh = commandNeedsRefresh(
      received.current.get(operation.id) ?? null,
      operation,
      monitoringStopped,
    );
    received.current.set(operation.id, operation);
    setLatest(operation);
    if (refresh) callback.current();
  }
  async function follow(
    operation: OperationSummary,
    signal: AbortSignal,
  ): Promise<OperationSummary> {
    const deadline = Date.now() + 30_000;
    const serverNow = () => Date.now() + clockOffset;
    while (
      progressing.has(operation.state) &&
      !operation.finished &&
      Date.now() < deadline &&
      !signal.aborted
    ) {
      if (operation.nextAttemptAt && operation.nextAttemptAt - serverNow() > 2_000) break;
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
        const timer = setTimeout(done, Math.max(350, (operation.nextAttemptAt ?? 0) - serverNow()));
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
  function submit(
    command: unknown,
    category: 'local' | 'provider',
    identity = newOperationId(clockOffset),
    onFailure?: (error: RequestError) => void,
  ): Promise<OperationSummary | null> {
    const captured = structuredClone(command);
    return enqueue(() => submitCaptured(captured, category, identity, onFailure), null);
  }
  async function submitCaptured(
    command: unknown,
    category: 'local' | 'provider',
    identity?: string,
    onFailure?: (error: RequestError) => void,
  ): Promise<OperationSummary | null> {
    if (serverConnection() !== 'reachable') {
      const message =
        serverConnection() === 'incompatible'
          ? 'reload lanes before making another change.'
          : 'the server connection is paused. check the connection before submitting. your draft stays here.';
      setError(message);
      const details = new RequestError('connection_paused', message);
      setErrorDetails(details);
      onFailure?.(details);
      return null;
    }
    const controller = new AbortController();
    aborts.current.add(controller);
    setError('');
    setErrorDetails(null);
    setLatest(null);
    const taskId =
      command &&
      typeof command === 'object' &&
      (!('kind' in command) || command.kind !== 'task.duplicate') &&
      'taskId' in command &&
      typeof command.taskId === 'string'
        ? command.taskId
        : null;
    if (taskId) pendingTasks.current.set(taskId, (pendingTasks.current.get(taskId) ?? 0) + 1);
    setPendingTaskIds(new Set(pendingTasks.current.keys()));
    const operationId = identity ?? newOperationId(clockOffset);
    try {
      const admitted = await request(`${base}/commands/${category}`, OperationSummarySchema, {
        method: 'POST',
        body: { operationId, command },
        signal: controller.signal,
      });
      if (!alive.current || controller.signal.aborted) return null;
      publish(admitted, controller.signal);
      const result = category === 'provider' ? await follow(admitted, controller.signal) : admitted;
      if (!alive.current || controller.signal.aborted) return null;
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
        const details = new RequestError(
          result.error?.code ?? result.state,
          message,
          undefined,
          result.id,
        );
        setErrorDetails(details);
        onFailure?.(details);
      }
      return result;
    } catch (error) {
      if (!controller.signal.aborted && alive.current) {
        const details = commandRequestError(error, operationId);
        setError(details.message);
        setErrorDetails(details);
        let recovered = false;
        if (details.operationId && details.code !== 'unauthenticated') {
          try {
            const recorded = await request(
              `${base}/operations/${encodeURIComponent(operationId)}`,
              OperationSummarySchema,
              { signal: controller.signal },
            );
            if (!alive.current || controller.signal.aborted) return null;
            publish(recorded, controller.signal);
            recovered = true;
            if (recorded.state === 'succeeded') {
              setError('');
              setErrorDetails(null);
              return recorded;
            }
          } catch {
            /* A missing or unreachable receipt keeps the same identity for an unchanged-input retry. */
          }
        }
        if (!recovered && alive.current && !controller.signal.aborted) callback.current();
        if (alive.current && !controller.signal.aborted) onFailure?.(details);
      }
      return null;
    } finally {
      aborts.current.delete(controller);
      received.current.delete(operationId);
      if (alive.current && !controller.signal.aborted) {
        if (taskId) {
          const remaining = (pendingTasks.current.get(taskId) ?? 0) - 1;
          if (remaining > 0) pendingTasks.current.set(taskId, remaining);
          else pendingTasks.current.delete(taskId);
        }
        setPendingTaskIds(new Set(pendingTasks.current.keys()));
      }
    }
  }
  function advance(operationId: string): Promise<void> {
    return enqueue(() => advanceCaptured(operationId), undefined);
  }
  async function advanceCaptured(operationId: string): Promise<void> {
    const controller = new AbortController();
    aborts.current.add(controller);
    setError('');
    setErrorDetails(null);
    try {
      const operation = await request(
        `${base}/operations/${encodeURIComponent(operationId)}/advance`,
        OperationSummarySchema,
        { method: 'POST', body: {}, signal: controller.signal },
      );
      if (!alive.current || controller.signal.aborted) return;
      publish(operation, controller.signal);
      const result = await follow(operation, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      publish(result, controller.signal, true);
    } catch (error) {
      if (!controller.signal.aborted && alive.current) {
        const details = commandRequestError(error, operationId);
        setError(details.message);
        setErrorDetails(details);
        callback.current();
      }
    } finally {
      aborts.current.delete(controller);
      received.current.delete(operationId);
    }
  }
  return {
    submit,
    advance,
    busy,
    isBusy: () => waiting.current > 0,
    error,
    errorDetails,
    getErrorDetails: () => lastError.current,
    latest,
    pendingTaskIds,
    clearError: () => {
      setError('');
      setErrorDetails(null);
    },
  };
}
