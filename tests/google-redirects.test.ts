import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { exchangeGoogleCode } from '../src/modules/accounts/server/oauth/google';
import { GoogleTasksClient } from '../src/modules/tasks/server/provider/google-tasks';
import { GoogleSheetsClient } from '../src/modules/transfer/server/sheets';

let origin: string;
let forwarded = 0;
const server = createServer((request, response) => {
  request.resume();
  if (request.url === '/redirect') {
    response.writeHead(307, { Location: origin + '/unexpected' });
    response.end();
  } else {
    forwarded++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  }
});

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  origin = 'http://127.0.0.1:' + address.port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

// Exercise real fetch redirect handling with disposable credentials and a loopback destination.
const transport: typeof fetch = (_input, init) => fetch(origin + '/redirect', init);

it('rejects an OAuth redirect without forwarding the client secret or code', async () => {
  await expect(
    exchangeGoogleCode(
      {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri: 'https://lanes.example/auth/google/callback',
      },
      { code: 'test-code', codeVerifier: 'test-verifier' },
      { fetch: transport },
    ),
  ).rejects.toMatchObject({ code: 'provider_response_invalid' });
  expect(forwarded).toBe(0);
});

it('rejects a Tasks redirect without forwarding the bearer token', async () => {
  await expect(
    new GoogleTasksClient({ accessToken: 'test-token', fetch: transport }).getTask('list', 'task'),
  ).rejects.toMatchObject({ code: 'provider_unavailable', status: 307 });
  expect(forwarded).toBe(0);
});

it('rejects a Sheets redirect without forwarding the bearer token', async () => {
  await expect(
    new GoogleSheetsClient({ accessToken: 'test-token', fetch: transport }).metadata(
      'spreadsheet_1234567890',
    ),
  ).rejects.toMatchObject({ code: 'provider_unavailable', status: 307 });
  expect(forwarded).toBe(0);
});
