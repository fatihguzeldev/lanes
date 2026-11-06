import { z } from 'zod';
import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../shared/contracts/errors';
import { StartOAuthSchema } from '../../modules/accounts/contracts/authorization';
import { initializeTaskWorkspace } from '../../modules/tasks/server/lifecycle/workspace';
import type { Configuration } from '../configuration/env';
import type { Services } from '../composition/services';
import { jsonResponse, readJson } from '../protocol/http';
import { readSessionSnapshot } from '../session';
function redirect(origin: string, path: string, cookies: string[] = []): Response {
  const headers = new Headers({
    location: new URL(path, origin).href,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export async function authenticationRoute(
  request: Request,
  url: URL,
  db: D1Database,
  config: Configuration,
  services: Pick<Services, 'accounts' | 'boards' | 'sync'>,
): Promise<Response | null> {
  const { accounts, boards, sync } = services;
  if (url.pathname === '/auth/google/start' && request.method === 'POST') {
    const result = await accounts.oauth.startOAuth(
      request,
      await readJson(request, StartOAuthSchema),
    );
    return jsonResponse({ authorizationUrl: result.authorizationUrl }, 200, {
      'set-cookie': result.cookie,
    });
  }
  if (url.pathname === '/auth/google/callback' && request.method === 'GET') {
    try {
      const result = await accounts.oauth.finishOAuth(request);
      if (result.connectedAccountId) {
        try {
          await initializeTaskWorkspace(db, result.connectedAccountId);
          await boards.ensureMainBoard(result.connectedAccountId);
          await sync.requestRefresh(result.connectedAccountId, { reason: 'reconnect' });
        } catch {
          // The grant has been saved. Keep it, and retry workspace initialization on entry.
          return redirect(config.origin, '/?connection_setup=pending', result.cookies);
        }
      }
      return redirect(config.origin, result.redirectPath, result.cookies);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'internal_error';
      return redirect(config.origin, '/?auth_error=' + encodeURIComponent(code));
    }
  }
  if (url.pathname === '/api/session' && request.method === 'GET') {
    return jsonResponse(await readSessionSnapshot(request, accounts));
  }
  return null;
}

/** The request owner requires a session before reaching sign-out. */
export async function signOutRoute(
  request: Request,
  url: URL,
  accounts: Services['accounts'],
): Promise<Response | null> {
  if (url.pathname === '/auth/signout' && request.method === 'POST') {
    await readJson(request, z.object({}).strict());
    const result = await accounts.sessions.signOut(request);
    const headers = new Headers();
    for (const cookie of result.cookies) headers.append('set-cookie', cookie);
    return jsonResponse({ signedOut: true }, 200, headers);
  }
  return null;
}
