import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

describe('browser server connection', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('preserves a caller cancellation without reporting an outage', async () => {
    const { request } = await import('../http');
    const { serverConnection } = await import('../../connectivity/connectivity');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_path, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            });
          }),
      ),
    );
    const controller = new AbortController();
    const pending = request('/api/session', z.object({}), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(serverConnection()).toBe('reachable');
  });
  it('does not mistake an interrupted response body for an incompatible deployment', async () => {
    const { request } = await import('../http');
    const { serverConnection } = await import('../../connectivity/connectivity');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path, options) => ({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            }),
          ),
      })),
    );
    const controller = new AbortController();
    const pending = request('/api/session', z.object({}), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(serverConnection()).toBe('reachable');
  });
  it('bounds a stalled request and disables submission until a real response arrives', async () => {
    vi.useFakeTimers();
    const { request } = await import('../http');
    const { serverConnection } = await import('../../connectivity/connectivity');
    const fetch = vi.fn(
      (_path, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const rejected = expect(request('/api/change', z.object({}))).rejects.toMatchObject({
      code: 'server_unavailable',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(serverConnection()).toBe('unreachable');
    fetch.mockResolvedValueOnce(Response.json({ service: 'lanes', apiVersion: 1 }) as never);
    await request(
      '/api/health',
      z.object({ service: z.literal('lanes'), apiVersion: z.literal(1) }),
    );
    expect(serverConnection()).toBe('reachable');
  });
  it('distinguishes network failure from a reachable provider or validation error', async () => {
    const { request } = await import('../http');
    const { serverConnection } = await import('../../connectivity/connectivity');
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network failed'))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: 'provider_unavailable',
              message: 'google is unavailable.',
              requestId: 'test',
              retryable: true,
            },
          },
          { status: 503 },
        ),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(request('/api/change', z.object({}))).rejects.toMatchObject({
      code: 'server_unavailable',
    });
    expect(serverConnection()).toBe('unreachable');
    await expect(request('/api/change', z.object({}))).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect(serverConnection()).toBe('reachable');
  });
  it('keeps an incompatible client read-only until reload, even when health succeeds', async () => {
    const { request } = await import('../http');
    const { serverConnection } = await import('../../connectivity/connectivity');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(Response.json({ unexpected: true }))),
    );
    await expect(
      request('/api/change', z.object({ confirmed: z.literal(true) })),
    ).rejects.toMatchObject({ code: 'response_invalid' });
    expect(serverConnection()).toBe('incompatible');
    await request('/api/health', z.object({ unexpected: z.literal(true) }));
    expect(serverConnection()).toBe('incompatible');
  });
});
