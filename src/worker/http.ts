import { z } from 'zod';
import { AppError } from '../contracts/errors';
import type { ErrorEnvelope } from '../contracts/http';
import { GoogleTasksError } from '../modules/tasks/server/provider';
import { GoogleSheetsError } from '../modules/transfer/server/sheets';

const maxInputBytes = 64 * 1024;

export function parseValue<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new AppError(
      'validation_failed',
      'check the requested values.',
      400,
      false,
      Object.fromEntries(
        parsed.error.issues
          .slice(0, 20)
          .map((issue) => [issue.path.join('.') || 'input', issue.message]),
      ),
    );
  return parsed.data;
}

export function requireSameOrigin(request: Request, origin: string): void {
  if (
    request.headers.get('origin') !== origin ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    throw new AppError('forbidden', 'start this action from your lanes instance.', 403);
  }
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    throw new AppError('validation_failed', 'send this action as json.', 415);
  }
  const advertisedLength = Number(request.headers.get('content-length'));
  if (advertisedLength > maxInputBytes)
    throw new AppError('validation_failed', 'this action exceeds the 64 kib input limit.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('validation_failed', 'this action needs an input body.', 400);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxInputBytes) {
        await reader.cancel();
        throw new AppError('validation_failed', 'this action exceeds the 64 kib input limit.', 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const result = schema.safeParse(JSON.parse(text));
    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues.slice(0, 20))
        fields[issue.path.join('.') || 'input'] = issue.message;
      throw new AppError('validation_failed', 'check the highlighted fields.', 400, false, fields);
    }
    return result.data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('validation_failed', 'this action needs valid utf-8 json.', 400);
  } finally {
    reader.releaseLock();
  }
}

export function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set('content-type', 'application/json; charset=utf-8');
  result.set('cache-control', 'no-store');
  result.set('x-content-type-options', 'nosniff');
  result.set('referrer-policy', 'no-referrer');
  return new Response(JSON.stringify(data), { status, headers: result });
}

export function errorResponse(error: unknown, requestId: string): Response {
  const failure =
    error instanceof GoogleTasksError || error instanceof GoogleSheetsError
      ? new AppError(error.code, error.message, error.status ?? 503, error.retryable)
      : error;
  const known = failure instanceof AppError;
  const body: ErrorEnvelope = {
    error: {
      code: known ? failure.code : 'internal_error',
      message: known ? failure.message : 'lanes could not complete this request.',
      requestId,
      retryable: known && failure.retryable,
      ...(known && failure.fields ? { fields: failure.fields } : {}),
      ...(known && failure.operationId ? { operationId: failure.operationId } : {}),
    },
  };
  return jsonResponse(body, known ? failure.status : 500);
}

export function pageOptions(url: URL) {
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
    throw new AppError('validation_failed', 'choose a page size from 1 to 100.', 400);
  return { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) };
}
