import { AppError } from '../shared/contracts/errors';
import { parseConfiguration, type Env } from './configuration/env';
import { createServices } from './composition/services';
import { errorResponse, jsonResponse, pageOptions, requireSameOrigin } from './protocol/http';
import { authenticationRoute, signOutRoute } from './routes/auth';
import { accountRoute } from './routes/account';
import { databaseUsage } from './transport/database-usage';
import { documentResponse } from './document';
function parts(path: string): string[] {
  try {
    return path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new AppError('validation_failed', 'this resource address is invalid.', 400);
  }
}
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    ['/', '/index.html'].includes(url.pathname)
  )
    return documentResponse(request, env);
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/'))
    return env.ASSETS.fetch(request);
  try {
    if (request.method === 'GET' && url.pathname === '/api/health')
      return jsonResponse({ service: 'lanes', apiVersion: 1 });
    let config;
    try {
      config = parseConfiguration(env);
    } catch (error) {
      if (
        request.method === 'GET' &&
        url.pathname === '/api/session' &&
        error instanceof AppError &&
        error.code === 'installation_unavailable'
      ) {
        return jsonResponse({ configured: false, authenticated: false, serverTime: Date.now() });
      }
      throw error;
    }
    const route = parts(url.pathname);
    const syncRead = route[0] === 'api' && route[1] === 'accounts' && route[3] === 'sync';
    const usage =
      syncRead && url.searchParams.get('status') === '1' && url.searchParams.get('changes') === '1'
        ? databaseUsage(env.DB)
        : null;
    const bindings = usage ? { ...env, DB: usage.db } : env;
    const services = createServices(
      bindings,
      config,
      syncRead ? 10 : 4,
      usage ? () => usage.used : undefined,
    );
    const { accounts } = services;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      requireSameOrigin(request, config.origin);
      if (request.headers.get('x-lanes-api') !== '1')
        throw new AppError('conflict', 'reload lanes before submitting another change.', 409);
    }
    const authentication = await authenticationRoute(request, url, bindings.DB, config, services);
    if (authentication) return authentication;
    const owner = await accounts.sessions.requireSession(request);
    const signOut = await signOutRoute(request, url, accounts);
    if (signOut) return signOut;
    if (url.pathname === '/api/accounts' && request.method === 'GET')
      return jsonResponse(
        await accounts.connections.listConnectionSummaries(request, pageOptions(url)),
      );
    const response = await accountRoute(
      request,
      url,
      route,
      owner.subject,
      services,
      bindings.DB,
      config,
    );
    if (response) return response;

    throw new AppError('not_found', 'this lanes action is not available at this address.', 404);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
