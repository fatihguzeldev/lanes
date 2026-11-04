import { z } from 'zod';
import { recordServerConnection } from './connectivity';
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly operationId?: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}
const ErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    operationId: z.string().optional(),
    retryable: z.boolean(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const deadline = setTimeout(
    () => controller.abort(new DOMException('request deadline exceeded', 'TimeoutError')),
    20_000,
  );
  try {
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'x-lanes-api': '1',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      if (controller.signal.aborted || !(error instanceof SyntaxError)) throw error;
      json = null;
    }
    if (!response.ok) {
      const parsed = ErrorSchema.safeParse(json);
      if (parsed.success) {
        recordServerConnection('reachable');
        if (parsed.data.error.code === 'unauthenticated' && typeof window !== 'undefined')
          window.dispatchEvent(new Event('lanes.session-expired'));
        throw new RequestError(
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.requestId,
          parsed.data.error.operationId,
          parsed.data.error.fields,
        );
      }
      recordServerConnection('unreachable');
      throw new RequestError(
        'server_unavailable',
        'lanes could not reach its server. your unsent work stays here.',
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      recordServerConnection('incompatible');
      throw new RequestError(
        'response_invalid',
        'this page and server do not agree. reload lanes before making another change.',
      );
    }
    recordServerConnection('reachable');
    return parsed.data;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof RequestError) throw error;
    recordServerConnection('unreachable');
    throw new RequestError(
      'server_unavailable',
      'lanes could not reach its server. your unsent work stays here.',
    );
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', cancel);
  }
}

export async function checkServerConnection(): Promise<void> {
  await request('/api/health', z.object({ service: z.literal('lanes'), apiVersion: z.literal(1) }));
}
