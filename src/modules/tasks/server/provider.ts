import { z } from 'zod';
import { AppError } from '../../../contracts/errors';
import type { ErrorCode } from '../../../contracts/http';
import { CalendarDateSchema } from '../planning-contract';

const base = 'https://tasks.googleapis.com/tasks/v1';
const opaqueId = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => value !== '.' && value !== '..' && !/[\x00-\x1f\x7f]/.test(value));
const timestamp = z.iso.datetime({ offset: true });
const text = z.string();

/** Provider-only observations. Optional fields remain absent, including on deletion tombstones. */
export const GoogleTaskSchema = z.object({
  id: opaqueId,
  kind: z.literal('tasks#task').optional(),
  etag: text.optional(),
  title: text.optional(),
  notes: text.optional(),
  status: z.enum(['needsAction', 'completed']).optional(),
  due: timestamp.optional(),
  completed: timestamp.optional(),
  updated: timestamp.optional(),
  parent: opaqueId.optional(),
  position: text.optional(),
  deleted: z.boolean().optional(),
  hidden: z.boolean().optional(),
  selfLink: text.optional(),
  webViewLink: text.optional(),
  links: z
    .array(z.object({ type: text.optional(), description: text.optional(), link: text.optional() }))
    .max(1000)
    .optional(),
  assignmentInfo: z
    .object({
      surfaceType: text.optional(),
      linkToTask: text.optional(),
      driveResourceInfo: z
        .object({ driveFileId: text.optional(), resourceKey: text.optional() })
        .optional(),
      spaceInfo: z.object({ space: text.optional() }).optional(),
    })
    .optional(),
});
export type GoogleTaskDTO = z.infer<typeof GoogleTaskSchema>;
export const GoogleTaskListSchema = z.object({
  id: opaqueId,
  kind: z.literal('tasks#taskList').optional(),
  etag: text.optional(),
  title: text.optional(),
  updated: timestamp.optional(),
  selfLink: text.optional(),
});
export type GoogleTaskListDTO = z.infer<typeof GoogleTaskListSchema>;
export interface GoogleProviderPage<T> {
  items: T[];
  nextPageToken: string | null;
  etag?: string;
}

export type GoogleTasksErrorCode = Extract<
  ErrorCode,
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'permission_required'
  | 'reconnect_required'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'storage_unavailable'
  | 'outcome_uncertain'
>;
export type ProviderLimitKind = 'rate' | 'daily' | 'storage' | 'unknown';
interface FailureOptions {
  status?: number | null;
  retryable?: boolean;
  outcome?: 'rejected' | 'uncertain';
  limitKind?: ProviderLimitKind;
  retryAfterSeconds?: number;
}
const failureMessages: Record<GoogleTasksErrorCode, string> = {
  validation_failed:
    'google does not support the submitted task or list change. check its fields and restrictions.',
  not_found: 'google could not find this task or list at its recorded address.',
  conflict: 'this task or list changed. refresh it before reapplying the edit.',
  forbidden: 'google did not permit this action. check account and organization permissions.',
  permission_required: 'this google account has not granted the permission this action needs.',
  reconnect_required:
    'google rejected the access token. refresh its authorization or reconnect the account.',
  provider_rate_limited: 'google is limiting requests. wait before retrying.',
  provider_unavailable:
    'google could not return a valid result. retained workspace data is unchanged.',
  storage_unavailable:
    'google reported an explicit storage bound. inspect available capacity before retrying.',
  outcome_uncertain:
    'google may have accepted this change. inspect its operation and provider state before deciding whether to try again.',
};

/** No raw provider body, URL, token, or underlying exception is attached to this error. */
export class GoogleTasksError extends Error {
  readonly name = 'GoogleTasksError';
  readonly status: number | null;
  readonly retryable: boolean;
  readonly outcome: 'rejected' | 'uncertain';
  readonly limitKind: ProviderLimitKind | null;
  readonly retryAfterSeconds: number | null;
  constructor(
    readonly code: GoogleTasksErrorCode,
    options: FailureOptions = {},
  ) {
    super(failureMessages[code]);
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.outcome = options.outcome ?? 'rejected';
    this.limitKind = options.limitKind ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export type GoogleTasksFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface GoogleTasksClientOptions {
  accessToken: string | (() => Promise<string>);
  fetch?: GoogleTasksFetch;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}
export interface ProviderRequestOptions {
  signal?: AbortSignal;
}
export interface ProviderMutationOptions extends ProviderRequestOptions {
  /** Sent verbatim. Effective provider-side conditional behavior still requires live verification. */
  etag?: string;
  knownTask?: GoogleTaskDTO;
  knownParent?: GoogleTaskDTO;
}
export interface GoogleTaskPosition extends ProviderRequestOptions {
  parent?: string | null;
  /** Omitted means first sibling, not append. The task owner resolves the last sibling for append. */
  previous?: string | null;
  knownParent?: GoogleTaskDTO;
}
export interface GoogleTaskMove {
  destinationTasklist?: string;
  /** Omitted or null means top level; callers reordering a subtask must retain its parent explicitly. */
  parent?: string | null;
  previous?: string | null;
}
const titleInput = z
  .string()
  .refine((value) => value.trim().length > 0 && [...value].length <= 1024);
const notesInput = z.string().refine((value) => [...value].length <= 8192);
const patchSchema = z
  .object({
    title: titleInput.optional(),
    notes: notesInput.nullable().optional(),
    status: z.enum(['needsAction', 'completed']).optional(),
    completed: timestamp.nullable().optional(),
    dueDay: CalendarDateSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined));
const createSchema = z
  .object({
    title: titleInput,
    notes: notesInput.optional(),
    status: z.enum(['needsAction', 'completed']).optional(),
    completed: timestamp.optional(),
    dueDay: CalendarDateSchema.nullable().optional(),
  })
  .strict();
export type GoogleTaskCreate = z.infer<typeof createSchema>;
export type GoogleTaskPatch = z.infer<typeof patchSchema>;
const listInputSchema = z.object({ title: titleInput }).strict();
const listPageSchema = z.object({
  items: z.array(GoogleTaskListSchema).max(1000).optional(),
  nextPageToken: z.string().max(16_384).optional(),
  etag: text.optional(),
});
const taskPageSchema = z.object({
  items: z.array(GoogleTaskSchema).max(100).optional(),
  nextPageToken: z.string().max(16_384).optional(),
  etag: text.optional(),
});
const taskListOptionsSchema = z
  .object({
    maxResults: z.number().int().min(1).max(1000).default(1000),
    pageToken: z.string().min(1).max(16_384).optional(),
  })
  .strict();
const taskOptionsSchema = z
  .object({
    maxResults: z.number().int().min(1).max(100).default(100),
    pageToken: z.string().min(1).max(16_384).optional(),
    updatedMin: timestamp.optional(),
  })
  .strict();
const moveSchema = z
  .object({
    destinationTasklist: opaqueId.optional(),
    parent: opaqueId.nullable().optional(),
    previous: opaqueId.nullable().optional(),
  })
  .strict();
export type GoogleTaskListPageOptions = z.input<typeof taskListOptionsSchema>;
export type GoogleTaskPageOptions = z.input<typeof taskOptionsSchema>;

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new GoogleTasksError('validation_failed', { status: 422 });
  return result.data;
}
function pathId(id: string): string {
  const value = parse(opaqueId, id);
  return value === '@default'
    ? value
    : encodeURIComponent(value).replace(
        /[!'()*]/g,
        (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
      );
}
function taskBody(input: GoogleTaskCreate | GoogleTaskPatch): Record<string, unknown> {
  const { dueDay, ...fields } = input;
  return {
    ...fields,
    ...(dueDay === undefined ? {} : { due: dueDay === null ? null : dueDay + 'T00:00:00.000Z' }),
  };
}
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* A failed discard must not expose a provider stream exception. */
  }
}
async function boundedBody(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await discard(response);
    throw new Error('oversized response');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error('oversized response');
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    reader.releaseLock();
  }
}
function retryHint(response: Response, now: number): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value || value.length > 100) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 86_400) : undefined;
}
const errorBodySchema = z.object({
  error: z.object({
    errors: z
      .array(z.object({ reason: z.string().max(256).optional() }))
      .max(100)
      .optional(),
    details: z
      .array(z.object({ reason: z.string().max(256).optional() }))
      .max(100)
      .optional(),
  }),
});
async function rejection(response: Response, now: number): Promise<GoogleTasksError> {
  const status = response.status,
    hint = retryHint(response, now);
  if (status === 429) {
    await discard(response);
    return new GoogleTasksError('provider_rate_limited', {
      status,
      retryable: true,
      limitKind: 'rate',
      ...(hint === undefined ? {} : { retryAfterSeconds: hint }),
    });
  }
  let reasons: string[] = [];
  try {
    const json: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(response, 65_536)),
    );
    const parsed = errorBodySchema.safeParse(json);
    if (parsed.success)
      reasons = [...(parsed.data.error.errors ?? []), ...(parsed.data.error.details ?? [])].flatMap(
        (item) => (item.reason ? [item.reason] : []),
      );
  } catch {
    /* The acknowledged HTTP rejection remains authoritative when its body is malformed. */
  }
  const has = (...values: string[]) => reasons.some((reason) => values.includes(reason));
  if (status === 401) return new GoogleTasksError('reconnect_required', { status });
  if (status === 404 || status === 410) return new GoogleTasksError('not_found', { status });
  if (status === 409 || status === 412) return new GoogleTasksError('conflict', { status });
  if (has('dailyLimitExceeded', 'dailyLimitExceededUnreg', 'DAILY_LIMIT_EXCEEDED'))
    return new GoogleTasksError('provider_rate_limited', {
      status,
      retryable: true,
      limitKind: 'daily',
      ...(hint === undefined ? {} : { retryAfterSeconds: hint }),
    });
  if (
    has('rateLimitExceeded', 'userRateLimitExceeded', 'servingLimitExceeded', 'RATE_LIMIT_EXCEEDED')
  )
    return new GoogleTasksError('provider_rate_limited', {
      status,
      retryable: true,
      limitKind: 'rate',
      ...(hint === undefined ? {} : { retryAfterSeconds: hint }),
    });
  // A generic quotaExceeded reason does not establish a task/list storage bound.
  if (has('storageQuotaExceeded', 'STORAGE_QUOTA_EXCEEDED'))
    return new GoogleTasksError('storage_unavailable', { status, limitKind: 'storage' });
  if (has('quotaExceeded', 'QUOTA_EXCEEDED'))
    return new GoogleTasksError('provider_unavailable', { status, limitKind: 'unknown' });
  if (has('insufficientPermissions', 'insufficient_scope', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'))
    return new GoogleTasksError('permission_required', { status });
  if (status === 403) return new GoogleTasksError('forbidden', { status });
  return new GoogleTasksError('validation_failed', { status });
}

/** One method call sends at most one Tasks request. Refresh, retries, budgets and durable intent belong to callers. */
export class GoogleTasksClient {
  private readonly fetcher: GoogleTasksFetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  constructor(private readonly options: GoogleTasksClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 30_000 ||
      !Number.isInteger(this.maxBytes) ||
      this.maxBytes < 1024 ||
      this.maxBytes > 8 * 1024 * 1024
    )
      throw new GoogleTasksError('validation_failed', { status: 422 });
  }

  private failure(write: boolean, status: number | null = null): GoogleTasksError {
    return new GoogleTasksError(write ? 'outcome_uncertain' : 'provider_unavailable', {
      status,
      outcome: write ? 'uncertain' : 'rejected',
      retryable: !write,
    });
  }
  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T> | null,
    query: Record<string, string | number | undefined> = {},
    body?: Record<string, unknown>,
    options: ProviderMutationOptions = {},
  ): Promise<T> {
    const write = method !== 'GET';
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const etag = options.etag;
    if (
      etag !== undefined &&
      (!etag || etag === '*' || etag.length > 8192 || /[\x00-\x1f\x7f]/.test(etag))
    )
      throw new GoogleTasksError('validation_failed', { status: 422 });
    if (this.options.signal?.aborted || options.signal?.aborted)
      throw new GoogleTasksError('conflict', { status: 409 });
    let token: string;
    try {
      token =
        typeof this.options.accessToken === 'string'
          ? this.options.accessToken
          : await this.options.accessToken();
    } catch (error) {
      if (error instanceof AppError || error instanceof GoogleTasksError) throw error;
      throw new GoogleTasksError('provider_unavailable', { retryable: true });
    }
    if (!token || token.length > 16_384 || /[\x00-\x20\x7f]/.test(token))
      throw new GoogleTasksError('reconnect_required', { status: 401 });
    if (this.options.signal?.aborted || options.signal?.aborted)
      throw new GoogleTasksError('conflict', { status: 409 });
    const headers = new Headers({ Accept: 'application/json', Authorization: 'Bearer ' + token });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (etag !== undefined) headers.set('If-Match', etag);
    const signals = [
      AbortSignal.timeout(this.timeoutMs),
      ...(this.options.signal ? [this.options.signal] : []),
      ...(options.signal ? [options.signal] : []),
    ];
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.any(signals),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof AppError || error instanceof GoogleTasksError) throw error;
      throw this.failure(write);
    }
    if (
      response.status === 408 ||
      response.status >= 500 ||
      response.status < 200 ||
      (response.status >= 300 && response.status < 400)
    ) {
      await discard(response);
      throw this.failure(write, response.status);
    }
    if (!response.ok) throw await rejection(response, this.options.now?.() ?? Date.now());
    try {
      const bytes = await boundedBody(response, schema ? this.maxBytes : 1024);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!schema) {
        if (text.trim()) throw new Error('unexpected deletion response');
        return undefined as T;
      }
      const value: unknown = JSON.parse(text);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new Error('invalid response');
      return parsed.data;
    } catch {
      throw this.failure(write, response.status);
    }
  }

  async listTaskLists(
    input: GoogleTaskListPageOptions = {},
    options: ProviderRequestOptions = {},
  ): Promise<GoogleProviderPage<GoogleTaskListDTO>> {
    const value = parse(taskListOptionsSchema, input);
    const page = await this.request(
      'GET',
      '/users/@me/lists',
      listPageSchema,
      value,
      undefined,
      options,
    );
    if ((page.items?.length ?? 0) > value.maxResults) throw this.failure(false, 200);
    return {
      items: page.items ?? [],
      nextPageToken: page.nextPageToken || null,
      ...(page.etag === undefined ? {} : { etag: page.etag }),
    };
  }
  async getTaskList(id: string, options: ProviderRequestOptions = {}): Promise<GoogleTaskListDTO> {
    return this.request(
      'GET',
      '/users/@me/lists/' + pathId(id),
      GoogleTaskListSchema,
      {},
      undefined,
      options,
    );
  }
  async listTasks(
    listId: string,
    input: GoogleTaskPageOptions = {},
    options: ProviderRequestOptions = {},
  ): Promise<GoogleProviderPage<GoogleTaskDTO>> {
    const value = parse(taskOptionsSchema, input);
    const page = await this.request(
      'GET',
      '/lists/' + pathId(listId) + '/tasks',
      taskPageSchema,
      {
        ...value,
        showCompleted: 'true',
        showDeleted: 'true',
        showHidden: 'true',
        showAssigned: 'true',
      },
      undefined,
      options,
    );
    if ((page.items?.length ?? 0) > value.maxResults) throw this.failure(false, 200);
    return {
      items: page.items ?? [],
      nextPageToken: page.nextPageToken || null,
      ...(page.etag === undefined ? {} : { etag: page.etag }),
    };
  }
  async getTask(
    listId: string,
    id: string,
    options: ProviderRequestOptions = {},
  ): Promise<GoogleTaskDTO> {
    return this.request(
      'GET',
      '/lists/' + pathId(listId) + '/tasks/' + pathId(id),
      GoogleTaskSchema,
      {},
      undefined,
      options,
    );
  }
  async createTaskList(
    input: { title: string },
    options: ProviderRequestOptions = {},
  ): Promise<GoogleTaskListDTO> {
    return this.request(
      'POST',
      '/users/@me/lists',
      GoogleTaskListSchema,
      {},
      parse(listInputSchema, input),
      options,
    );
  }
  async patchTaskList(
    id: string,
    input: { title: string },
    options: ProviderMutationOptions = {},
  ): Promise<GoogleTaskListDTO> {
    return this.request(
      'PATCH',
      '/users/@me/lists/' + pathId(id),
      GoogleTaskListSchema,
      {},
      parse(listInputSchema, input),
      options,
    );
  }
  async deleteTaskList(id: string, options: ProviderMutationOptions = {}): Promise<void> {
    await this.request('DELETE', '/users/@me/lists/' + pathId(id), null, {}, undefined, options);
  }
  async createTask(
    listId: string,
    input: GoogleTaskCreate,
    position: GoogleTaskPosition = {},
  ): Promise<GoogleTaskDTO> {
    const value = parse(createSchema, input);
    if (position.parent && position.knownParent?.assignmentInfo)
      throw new GoogleTasksError('validation_failed', { status: 422 });
    const parent = position.parent == null ? undefined : parse(opaqueId, position.parent);
    const previous = position.previous == null ? undefined : parse(opaqueId, position.previous);
    return this.request(
      'POST',
      '/lists/' + pathId(listId) + '/tasks',
      GoogleTaskSchema,
      { parent, previous },
      taskBody(value),
      position,
    );
  }
  async patchTask(
    listId: string,
    id: string,
    input: GoogleTaskPatch,
    options: ProviderMutationOptions = {},
  ): Promise<GoogleTaskDTO> {
    const value = parse(patchSchema, input);
    if (value.notes !== undefined && options.knownTask?.assignmentInfo?.surfaceType === 'DOCUMENT')
      throw new GoogleTasksError('validation_failed', { status: 422 });
    return this.request(
      'PATCH',
      '/lists/' + pathId(listId) + '/tasks/' + pathId(id),
      GoogleTaskSchema,
      {},
      taskBody(value),
      options,
    );
  }
  async deleteTask(
    listId: string,
    id: string,
    options: ProviderMutationOptions = {},
  ): Promise<void> {
    await this.request(
      'DELETE',
      '/lists/' + pathId(listId) + '/tasks/' + pathId(id),
      null,
      {},
      undefined,
      options,
    );
  }
  async moveTask(
    listId: string,
    id: string,
    input: GoogleTaskMove,
    options: ProviderMutationOptions = {},
  ): Promise<GoogleTaskDTO> {
    const value = parse(moveSchema, input);
    if (value.parent && (options.knownTask?.assignmentInfo || options.knownParent?.assignmentInfo))
      throw new GoogleTasksError('validation_failed', { status: 422 });
    if (
      options.knownTask?.hidden &&
      options.knownTask.status === 'completed' &&
      (value.parent || value.previous)
    )
      throw new GoogleTasksError('validation_failed', { status: 422 });
    return this.request(
      'POST',
      '/lists/' + pathId(listId) + '/tasks/' + pathId(id) + '/move',
      GoogleTaskSchema,
      {
        destinationTasklist: value.destinationTasklist,
        parent: value.parent ?? undefined,
        previous: value.previous ?? undefined,
      },
      undefined,
      options,
    );
  }
}
