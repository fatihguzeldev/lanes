import { z } from 'zod';
import type { AccountService } from '../../modules/accounts/server';
import type { AccountLifecycle } from '../../modules/accounts/lifecycle';
import { RemoveAccountSchema } from '../../modules/accounts/lifecycle-contract';
import { jsonResponse, readJson } from '../http';

/** The owner session is already verified. Completion receipts survive the connection row. */
export async function lifecycleRoute(
  request: Request,
  route: string[],
  accounts: AccountService,
  lifecycle: AccountLifecycle,
): Promise<Response | null> {
  const accountId = route[2];
  if (!accountId || route[3] !== 'lifecycle') return null;
  if (route.length === 4 && request.method === 'GET') {
    const status = await lifecycle.status(accountId);
    if (!status.disconnect && !status.removal)
      await accounts.getConnectionSummary(request, accountId);
    return jsonResponse(status);
  }
  if (request.method !== 'POST') return null;
  if (route.length === 5 && route[4] === 'disconnect') {
    await readJson(request, z.object({ confirm: z.literal(true) }).strict());
    await accounts.getConnectionSummary(request, accountId);
    return jsonResponse(await lifecycle.startDisconnect(accountId), 202);
  }
  if (route.length === 5 && route[4] === 'remove') {
    const input = await readJson(request, RemoveAccountSchema);
    await accounts.getConnectionSummary(request, accountId);
    return jsonResponse(await lifecycle.startRemoval(accountId, input), 202);
  }
  if (
    route.length === 6 &&
    route[5] === 'advance' &&
    (route[4] === 'disconnect' || route[4] === 'remove')
  ) {
    await readJson(request, z.object({}).strict());
    return jsonResponse(
      route[4] === 'disconnect'
        ? await lifecycle.advanceDisconnect(accountId)
        : await lifecycle.advanceRemoval(accountId),
    );
  }
  return null;
}
