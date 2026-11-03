import { useEffect, useRef, useState } from 'react';
import { OperationSummarySchema, type OperationSummary } from '../modules/tasks/operation-contract';
import { request, RequestError } from './http';
import { serverConnection } from './connectivity';

const progressing = new Set(['accepted', 'running', 'partial']);
export const newOperationId = (clockOffset = 0) =>
  `${Math.floor(Date.now() + clockOffset)}:${crypto.randomUUID().replaceAll('-', '')}`;
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
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, [accountId]);
  const base = `/api/accounts/${encodeURIComponent(accountId)}`;
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
      if (alive.current) {
        setLatest(operation);
        callback.current();
      }
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
      setError(
        serverConnection() === 'incompatible'
          ? 'reload lanes before making another change.'
          : 'the server connection is paused. check the connection before submitting. your draft stays here.',
      );
      return null;
    }
    submitting.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setErrorDetails(null);
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
      if (alive.current) {
        setLatest(admitted);
        callback.current();
      }
      const result = category === 'provider' ? await follow(admitted, controller.signal) : admitted;
      if (result.state !== 'succeeded' && alive.current) {
        const message =
          result.error?.message ??
          (result.finished
            ? 'this operation ended with partial output. inspect what was saved.'
            : 'this operation is retained and still needs attention. inspect its progress before repeating it.');
        setError(message);
        setErrorDetails(
          new RequestError(result.error?.code ?? result.state, message, undefined, result.id),
        );
      }
      return result;
    } catch (error) {
      if (!controller.signal.aborted && alive.current) {
        setError(
          error instanceof RequestError
            ? error.message
            : `the server connection stopped. inspect operation ${operationId} before repeating this action.`,
        );
        if (error instanceof RequestError) setErrorDetails(error);
        if (!(error instanceof RequestError && error.code === 'unauthenticated')) {
          try {
            const recorded = await request(
              `${base}/operations/${encodeURIComponent(operationId)}`,
              OperationSummarySchema,
              { signal: controller.signal },
            );
            if (alive.current) setLatest(recorded);
          } catch {
            /* A missing or unreachable receipt keeps the same identity for an unchanged-input retry. */
          }
        }
        callback.current();
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
    try {
      const operation = await request(
        `${base}/operations/${encodeURIComponent(operationId)}/advance`,
        OperationSummarySchema,
        { method: 'POST', body: {}, signal: controller.signal },
      );
      await follow(operation, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && alive.current)
        setError(error instanceof Error ? error.message : 'this work could not continue.');
    } finally {
      submitting.current = false;
      if (alive.current) {
        setBusy(false);
        callback.current();
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
