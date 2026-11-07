import {
  EntryBootstrapSchema,
  entryUnavailableMessage,
  type EntryBootstrap,
} from '../modules/accounts/contracts/session';
import { AppError } from '../shared/contracts/errors';
import { parseConfiguration, type Env } from './configuration/env';
import { createServices } from './composition/services';
import { readSessionSnapshot } from './session';

function bootstrapTag(bootstrap: EntryBootstrap): string {
  const json = JSON.stringify(bootstrap)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return `<script id="lanes-session" type="application/json">${json}</script>`;
}

function documentHeaders(source?: Headers): Headers {
  const headers = new Headers(source);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'private, no-store');
  headers.set('cdn-cache-control', 'no-store');
  headers.set('cloudflare-cdn-cache-control', 'no-store');
  headers.set('vary', 'Cookie');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  for (const name of ['etag', 'last-modified', 'content-length', 'content-encoding'])
    headers.delete(name);
  return headers;
}

export async function documentResponse(request: Request, env: Env): Promise<Response> {
  let bootstrap;
  try {
    let config;
    try {
      config = parseConfiguration(env);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'installation_unavailable') throw error;
    }
    bootstrap = EntryBootstrapSchema.parse({
      state: 'ready',
      session: config
        ? await readSessionSnapshot(request, createServices(env, config).accounts)
        : { configured: false, authenticated: false, serverTime: Date.now() },
    });
  } catch {
    bootstrap = EntryBootstrapSchema.parse({ state: 'error', message: entryUnavailableMessage });
  }
  const entry =
    bootstrap.state === 'error'
      ? 'error'
      : !bootstrap.session.configured
        ? 'setup'
        : bootstrap.session.authenticated && bootstrap.session.accounts?.items.length
          ? 'workspace'
          : 'signin';
  try {
    const asset = await env.ASSETS.fetch(
      new Request(new URL(`/_entry/${entry}.html`, request.url)),
    );
    if (!asset.ok) throw new Error('entry asset unavailable');
    const html = await asset.text();
    if (!html.includes('<!--lanes-session-->')) throw new Error('entry bootstrap marker missing');
    return new Response(
      request.method === 'HEAD'
        ? null
        : html.replace('<!--lanes-session-->', () => bootstrapTag(bootstrap)),
      {
        status: bootstrap.state === 'error' ? 503 : 200,
        headers: documentHeaders(asset.headers),
      },
    );
  } catch {
    const error = EntryBootstrapSchema.parse({ state: 'error', message: entryUnavailableMessage });
    return new Response(
      request.method === 'HEAD'
        ? null
        : `<!doctype html><html lang="en"><meta charset="utf-8"><title>lanes</title><body>${entryUnavailableMessage}${bootstrapTag(error)}</body></html>`,
      {
        status: 503,
        headers: documentHeaders(),
      },
    );
  }
}
