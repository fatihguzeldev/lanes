import { describe, expect, it, vi } from 'vitest';
import type { GoogleTaskDTO, GoogleTasksFetch } from '../google-tasks';
import { GoogleTasksClient, GoogleTasksError } from '../google-tasks';

const task = (extra: Record<string, unknown> = {}) => ({
  kind: 'tasks#task',
  id: 'task-1',
  etag: '"task-v1"',
  title: 'a task',
  status: 'needsAction',
  position: '00000000000000000001',
  updated: '2026-11-02T12:00:00.000Z',
  ...extra,
});
const list = (extra: Record<string, unknown> = {}) => ({
  kind: 'tasks#taskList',
  id: 'list-1',
  etag: '"list-v1"',
  title: 'a list',
  updated: '2026-11-02T12:00:00.000Z',
  ...extra,
});
const client = (fetcher: GoogleTasksFetch) =>
  new GoogleTasksClient({ accessToken: 'server-access-secret', fetch: fetcher });
const errorResponse = (status: number, reason?: string) =>
  Response.json(
    {
      error: {
        code: status,
        message: 'private-provider-body server-access-secret',
        ...(reason ? { errors: [{ reason, message: 'private-provider-body' }] } : {}),
      },
    },
    { status },
  );

describe('google tasks reads', () => {
  it('returns one bounded task-list page and preserves opaque next-page tokens', async () => {
    const requests: URL[] = [];
    const api = client(async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      return Response.json(
        url.searchParams.has('pageToken')
          ? { items: [list({ id: 'list-2' })] }
          : { items: [list()], nextPageToken: '+opaque/next?token=' },
      );
    });
    const first = await api.listTaskLists();
    expect(first.items[0]?.id).toBe('list-1');
    expect(first.nextPageToken).toBe('+opaque/next?token=');
    expect(requests).toHaveLength(1);
    const second = await api.listTaskLists({ pageToken: first.nextPageToken! });
    expect(second.nextPageToken).toBeNull();
    expect(requests[0]?.searchParams.get('maxResults')).toBe('1000');
    expect(requests[1]?.searchParams.get('pageToken')).toBe('+opaque/next?token=');
  });

  it('reads the provider default list through its documented alias', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () =>
      Response.json(list({ id: 'actual-default-id' })),
    );
    expect((await client(fetcher).getTaskList('@default')).id).toBe('actual-default-id');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe(
      '/tasks/v1/users/@me/lists/@default',
    );
  });

  it('sets every inventory flag explicitly and encodes provider ids and pagination filters', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () =>
      Response.json({
        items: [task(), { id: 'deleted-1', deleted: true }],
        nextPageToken: 'next-token',
      }),
    );
    const page = await client(fetcher).listTasks('opaque/list?name#fragment', {
      pageToken: 'opaque+token',
      updatedMin: '2026-11-01T11:12:13Z',
    });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/tasks/v1/lists/opaque%2Flist%3Fname%23fragment/tasks');
    expect(url.searchParams.get('maxResults')).toBe('100');
    for (const flag of ['showAssigned', 'showHidden', 'showCompleted', 'showDeleted'])
      expect(url.searchParams.get(flag)).toBe('true');
    expect(url.searchParams.get('updatedMin')).toBe('2026-11-01T11:12:13Z');
    expect(url.searchParams.get('pageToken')).toBe('opaque+token');
    expect(page.items[1]).toMatchObject({ id: 'deleted-1', deleted: true });
  });

  it('keeps empty titles and assignment facts without following a provider-supplied URL', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () =>
      Response.json(
        task({
          title: '',
          selfLink: 'https://attacker.example/private',
          assignmentInfo: {
            surfaceType: 'DOCUMENT',
            linkToTask: 'https://docs.google.com/document/d/example',
            driveResourceInfo: { driveFileId: 'document-id' },
          },
        }),
      ),
    );
    const item = await client(fetcher).getTask('list/a', 'task/b?c');
    expect(item.title).toBe('');
    expect(item.assignmentInfo?.surfaceType).toBe('DOCUMENT');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).origin).toBe('https://tasks.googleapis.com');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe(
      '/tasks/v1/lists/list%2Fa/tasks/task%2Fb%3Fc',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds page sizes and rejects dot-segment ids before sending a request', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () => Response.json({ items: [] }));
    const api = client(fetcher);
    await expect(api.listTaskLists({ maxResults: 1001 })).rejects.toMatchObject({
      code: 'validation_failed',
      outcome: 'rejected',
    });
    await expect(api.listTasks('list', { maxResults: 101 })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(api.getTask('..', 'task')).rejects.toMatchObject({ code: 'validation_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed inventory without returning a partial page', async () => {
    await expect(
      client(async () => Response.json({ items: [list(), list({ id: 'second' })] })).listTaskLists({
        maxResults: 1,
      }),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    await expect(
      client(async () =>
        Response.json({ items: [{ id: 'task', status: 'invented-state' }] }),
      ).listTasks('list'),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
  });

  it('gets a token once for each dispatched request and never puts it in the URL', async () => {
    const token = vi.fn(async () => 'server-access-secret');
    const fetcher = vi.fn<GoogleTasksFetch>(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer server-access-secret');
        expect(init?.redirect).toBe('manual');
        return Response.json(task());
      },
    );
    await new GoogleTasksClient({ accessToken: token, fetch: fetcher }).getTask('list', 'task');
    expect(token).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('server-access-secret');
  });
});

describe('narrow provider writes', () => {
  it('creates and renames lists without introducing task or lanes fields', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () => Response.json(list()));
    const api = client(fetcher);
    await api.createTaskList({ title: 'new list' });
    await api.patchTaskList('list-1', { title: 'renamed' }, { etag: '"list-v1"' });
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'PATCH']);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ title: 'new list' });
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('If-Match')).toBe('"list-v1"');
  });

  it('uses the caller-supplied previous sibling when appending a task', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () => Response.json(task()));
    await client(fetcher).createTask(
      'list',
      { title: 'write the note', notes: 'line one\nline two', dueDay: '2026-11-03' },
      { parent: 'parent/opaque', previous: 'last/sibling' },
    );
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('parent')).toBe('parent/opaque');
    expect(url.searchParams.get('previous')).toBe('last/sibling');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      title: 'write the note',
      notes: 'line one\nline two',
      due: '2026-11-03T00:00:00.000Z',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('patches only submitted fields and distinguishes a cleared date from an omitted date', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () => Response.json(task()));
    const api = client(fetcher);
    await api.patchTask('list', 'task', { notes: 'plain text 🪴' }, { etag: '"task-v1"' });
    await api.patchTask('list', 'task', {
      notes: '',
      dueDay: null,
      status: 'needsAction',
      completed: null,
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      notes: 'plain text 🪴',
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      notes: '',
      due: null,
      status: 'needsAction',
      completed: null,
    });
  });

  it('rejects metadata and invalid calendar days rather than hiding them in notes', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () => Response.json(task()));
    const api = client(fetcher);
    const metadata = { notes: 'keep this text', starred: true };
    await expect(api.patchTask('list', 'task', metadata)).rejects.toMatchObject({
      code: 'validation_failed',
      outcome: 'rejected',
    });
    await expect(
      api.createTask('list', { title: 'bad date', dueDay: '2026-02-30' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      api.patchTask('list', 'task', { dueDay: '2026-11-03T15:00:00Z' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      api.patchTask('list', 'task', { notes: 'okay' }, { etag: '*' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the real cross-list move endpoint and returns the new provider identity unchanged', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () =>
      Response.json(task({ id: 'moved-task-id' })),
    );
    const moved = await client(fetcher).moveTask('source/list', 'original/task', {
      destinationTasklist: 'destination/list',
      parent: 'parent/id',
      previous: 'previous/id',
    });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/tasks/v1/lists/source%2Flist/tasks/original%2Ftask/move');
    expect(url.searchParams.get('destinationTasklist')).toBe('destination/list');
    expect(url.searchParams.get('parent')).toBe('parent/id');
    expect(url.searchParams.get('previous')).toBe('previous/id');
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(moved.id).toBe('moved-task-id');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects documented restrictions when the caller supplies a known assigned task', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () => Response.json(task()));
    const api = client(fetcher);
    const assigned = task({ assignmentInfo: { surfaceType: 'DOCUMENT' } }) as GoogleTaskDTO;
    await expect(
      api.patchTask('list', 'task', { notes: 'not supported' }, { knownTask: assigned }),
    ).rejects.toMatchObject({ code: 'validation_failed', outcome: 'rejected' });
    await expect(
      api.moveTask('list', 'task', { parent: 'parent' }, { knownTask: assigned }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      api.createTask(
        'list',
        { title: 'child' },
        { parent: 'assigned-parent', knownParent: assigned },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('deletes known resources without substituting clear or a copy-and-delete sequence', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () => new Response(null, { status: 204 }));
    const api = client(fetcher);
    await api.deleteTask('list', 'task', { etag: '"v1"' });
    await api.deleteTaskList('list');
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['DELETE', 'DELETE']);
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('/clear');
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('If-Match')).toBe('"v1"');
  });
});

describe('definitive rejection and uncertain outcomes', () => {
  it.each([
    { status: 400, reason: undefined, code: 'validation_failed', retryable: false },
    { status: 401, reason: undefined, code: 'reconnect_required', retryable: false },
    { status: 403, reason: undefined, code: 'forbidden', retryable: false },
    {
      status: 403,
      reason: 'insufficientPermissions',
      code: 'permission_required',
      retryable: false,
    },
    {
      status: 403,
      reason: 'userRateLimitExceeded',
      code: 'provider_rate_limited',
      retryable: true,
    },
    { status: 403, reason: 'dailyLimitExceeded', code: 'provider_rate_limited', retryable: true },
    { status: 403, reason: 'storageQuotaExceeded', code: 'storage_unavailable', retryable: false },
    { status: 403, reason: 'quotaExceeded', code: 'provider_unavailable', retryable: false },
    { status: 404, reason: undefined, code: 'not_found', retryable: false },
    { status: 412, reason: undefined, code: 'conflict', retryable: false },
    { status: 429, reason: undefined, code: 'provider_rate_limited', retryable: true },
  ])(
    'preserves the actual rejected status without exposing a body: $status/$reason',
    async ({ status, reason, code, retryable }) => {
      const fetcher = vi.fn<GoogleTasksFetch>(async () => errorResponse(status, reason));
      const failure = client(fetcher).createTask('list', { title: 'new task' });
      await expect(failure).rejects.toMatchObject({ code, status, retryable, outcome: 'rejected' });
      try {
        await failure;
      } catch (error) {
        expect(String(error)).not.toMatch(/private-provider-body|server-access-secret/);
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps rate, daily and explicit storage reasons distinct', async () => {
    for (const [reason, limitKind] of [
      ['userRateLimitExceeded', 'rate'],
      ['dailyLimitExceeded', 'daily'],
      ['storageQuotaExceeded', 'storage'],
      ['quotaExceeded', 'unknown'],
    ] as const) {
      await expect(
        client(async () => errorResponse(403, reason)).createTaskList({ title: 'list' }),
      ).rejects.toMatchObject({ limitKind });
    }
    await expect(
      client(async () => new Response('not-json', { status: 403 })).createTaskList({
        title: 'list',
      }),
    ).rejects.toMatchObject({ code: 'forbidden', outcome: 'rejected' });
  });

  it.each(['network', 'timeout', 'invalid-json', 'invalid-schema', 'server-error'] as const)(
    'does not retry an ambiguous dispatched create: %s',
    async (failure) => {
      const fetcher = vi.fn<GoogleTasksFetch>(async () => {
        if (failure === 'network') throw new Error('private transport token');
        if (failure === 'timeout') throw new DOMException('private timeout details', 'AbortError');
        if (failure === 'invalid-json')
          return new Response('private invalid provider body', { status: 200 });
        if (failure === 'invalid-schema') return Response.json({ id: 42 });
        return errorResponse(503);
      });
      const result = client(fetcher).createTask('list', { title: 'do not duplicate me' });
      await expect(result).rejects.toMatchObject({
        code: 'outcome_uncertain',
        retryable: false,
        outcome: 'uncertain',
      });
      try {
        await result;
      } catch (error) {
        expect(String(error)).not.toContain('private');
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('marks a read transport failure retryable and never turns not-found into creation', async () => {
    await expect(
      client(async () => {
        throw new Error('private transport failure');
      }).getTask('list', 'task'),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true, outcome: 'rejected' });
    const fetcher = vi.fn<GoogleTasksFetch>(async () => errorResponse(404));
    await expect(client(fetcher).getTask('list', 'missing-task')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a retry-after hint bounded and never invents a mutation retry', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '9999999999' } }),
    );
    await expect(
      client(fetcher).patchTask('list', 'task', { title: 'retained draft' }),
    ).rejects.toMatchObject({ retryAfterSeconds: 86_400, outcome: 'rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const now = Date.parse('2026-11-02T12:00:00Z');
    const dateHint = new GoogleTasksClient({
      accessToken: 'token',
      now: () => now,
      fetch: async () =>
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': 'Mon, 02 Nov 2026 12:00:42 GMT' },
        }),
    });
    await expect(dateHint.getTask('list', 'task')).rejects.toMatchObject({ retryAfterSeconds: 42 });
  });

  it('treats a redirect, timeout response or malformed delete result as an uncertain write', async () => {
    for (const status of [302, 408]) {
      await expect(
        client(async () => new Response(null, { status })).deleteTask('list', 'task'),
      ).rejects.toMatchObject({ code: 'outcome_uncertain', outcome: 'uncertain' });
    }
    await expect(
      client(async () => Response.json({ unexpected: true })).deleteTask('list', 'task'),
    ).rejects.toMatchObject({ code: 'outcome_uncertain', outcome: 'uncertain' });
  });

  it('does not dispatch a write when its request signal has already been cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<GoogleTasksFetch>(async () => Response.json(task()));
    const api = client(fetcher);
    await expect(
      api.patchTask('list', 'task', { title: 'unsent' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ outcome: 'rejected' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not call a pre-dispatch credential failure an uncertain mutation', async () => {
    const fetcher = vi.fn<GoogleTasksFetch>(async () => Response.json(task()));
    const api = new GoogleTasksClient({
      accessToken: async () => {
        throw new Error('private token-acquisition error');
      },
      fetch: fetcher,
    });
    const failure = api.createTask('list', { title: 'not dispatched' });
    await expect(failure).rejects.toMatchObject({ outcome: 'rejected' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('caps response bodies and cancels the stream instead of retaining an outgoing connection', async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1025));
      },
      cancel: cancelled,
    });
    const api = new GoogleTasksClient({
      accessToken: 'token',
      maxResponseBytes: 1024,
      fetch: async () => new Response(stream),
    });
    await expect(api.getTask('list', 'task')).rejects.toBeInstanceOf(GoogleTasksError);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
