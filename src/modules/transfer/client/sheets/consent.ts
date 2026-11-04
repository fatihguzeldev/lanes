import { z } from 'zod';
import { request } from '../../../../client/http';
import { escaped } from '../transfer-context';
export function googleAuthorizationHref(value: string): string {
  const authorization = new URL(value);
  if (
    authorization.protocol !== 'https:' ||
    authorization.hostname !== 'accounts.google.com' ||
    authorization.username ||
    authorization.password ||
    authorization.port
  )
    throw new Error('the authorization address is invalid. reload lanes before authorizing.');
  return authorization.href;
}
export async function sheetsConsent(
  accountId: string,
  purpose: 'sheets_import' | 'sheets_export',
  signal: AbortSignal,
  destinationAccountId = accountId,
) {
  const result = await request(
    '/auth/google/start',
    z.object({ authorizationUrl: z.string().url() }).strict(),
    {
      method: 'POST',
      body: {
        purpose,
        accountId,
        returnPath: `/?portability=${purpose === 'sheets_import' ? 'import' : 'export'}&account=${escaped(destinationAccountId)}&source=${escaped(accountId)}`,
      },
      signal,
    },
  );
  window.location.assign(googleAuthorizationHref(result.authorizationUrl));
}
