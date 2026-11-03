import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../contracts/errors';
import { errorResponse, readJson, requireSameOrigin } from './http';

describe('private request boundary', () => {
  it('rejects cross-origin and missing-origin mutations', () => {
    for (const origin of [null, 'https://attacker.example']) {
      const request = new Request('https://lanes.example/api/tasks', {
        method: 'POST',
        headers: origin ? { origin } : {},
      });
      expect(() => requireSameOrigin(request, 'https://lanes.example')).toThrow(AppError);
    }
  });
  it('accepts the exact configured origin, not just the same host prefix', () => {
    expect(() =>
      requireSameOrigin(
        new Request('https://lanes.example/api/tasks', {
          method: 'POST',
          headers: { origin: 'https://lanes.example' },
        }),
        'https://lanes.example',
      ),
    ).not.toThrow();
    expect(() =>
      requireSameOrigin(
        new Request('https://lanes.example/api/tasks', {
          method: 'POST',
          headers: { origin: 'https://lanes.example.attacker.test' },
        }),
        'https://lanes.example',
      ),
    ).toThrow();
  });
  it('bounds streamed JSON independently of a missing content-length', async () => {
    const request = new Request('https://lanes.example/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'a'.repeat(65536) }),
    });
    await expect(readJson(request, z.unknown())).rejects.toMatchObject({
      code: 'validation_failed',
      status: 413,
    });
  });
  it('validates actual data before exposing it to a command', async () => {
    const request = new Request('https://lanes.example/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"title":42}',
    });
    await expect(readJson(request, z.object({ title: z.string() }).strict())).rejects.toMatchObject(
      { code: 'validation_failed' },
    );
  });
  it('does not expose raw exception messages or stack traces', async () => {
    const response = errorResponse(
      new Error('private token secret and database details'),
      'request-1',
    );
    const json = await response.json();
    expect(response.status).toBe(500);
    expect(JSON.stringify(json)).not.toContain('private token');
    expect(json).toMatchObject({
      error: { code: 'internal_error', requestId: 'request-1', retryable: false },
    });
  });
  it('keeps known conflicts distinct and prevents caching private errors', async () => {
    const response = errorResponse(
      new AppError(
        'conflict',
        'the task changed.',
        409,
        false,
        { title: 'refresh this field' },
        'operation-1',
      ),
      'request-2',
    );
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      error: {
        code: 'conflict',
        operationId: 'operation-1',
        fields: { title: 'refresh this field' },
      },
    });
  });
});
