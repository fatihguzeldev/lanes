import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubStars } from '../github-stars';

afterEach(() => vi.unstubAllGlobals());

describe('github stars', () => {
  it.each([0, 37, 120_000])('reads a real star count of %i', async (count) => {
    vi.stubGlobal('fetch', async () => Response.json({ stargazers_count: count }));
    await expect(fetchGitHubStars(new AbortController().signal)).resolves.toBe(count);
  });

  it.each([
    null,
    [],
    {},
    { stargazers_count: '37' },
    { stargazers_count: -1 },
    { stargazers_count: 1.5 },
    { stargazers_count: Number.MAX_SAFE_INTEGER + 1 },
  ])('does not turn a malformed response into a star count', async (body) => {
    vi.stubGlobal('fetch', async () => Response.json(body));
    await expect(fetchGitHubStars(new AbortController().signal)).rejects.toThrow();
  });

  it('rejects a rate-limited response instead of showing a false zero', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 403 }));
    await expect(fetchGitHubStars(new AbortController().signal)).rejects.toThrow();
  });

  it('propagates cancellation so the link can stop a slow request', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      options.signal?.throwIfAborted();
      return Response.json({ stargazers_count: 1 });
    });
    await expect(fetchGitHubStars(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
