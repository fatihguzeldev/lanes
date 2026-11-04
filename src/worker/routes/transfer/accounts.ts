import type { Services } from '../../composition/services';
import type { AccountRouteContext } from '../context';

import { z } from 'zod';

import { ResourceIdSchema } from '../../../shared/contracts/identity';
import { OperationIdSchema } from '../../../modules/operations/contracts/receipt';
import { jsonResponse, readJson } from '../../protocol/http';
const id = ResourceIdSchema.max(1024),
  empty = z.object({}).strict();
export async function accountTransferRoute(
  context: AccountRouteContext,
  accountTransfers: Services['transfer']['accountTransfers'],
  accounts: Services['accounts'],
): Promise<Response | null> {
  const { request, route, account, ownerSubject } = context;
  const accountId = account.id,
    method = request.method;
  if (route[4] === 'accounts') {
    if (route.length === 5 && method === 'POST') {
      const input = await readJson(
        request,
        z
          .object({
            id: OperationIdSchema,
            sourceAccountId: id,
            listIds: z.array(id).min(1).max(100),
            includeCompleted: z.boolean().default(true),
          })
          .strict(),
      );
      await accounts.connections.getConnectionSummary(request, input.sourceAccountId);
      return jsonResponse(
        await accountTransfers.begin({
          ...input,
          ownerSubject,
          destinationAccountId: accountId,
        }),
        202,
      );
    }
    if (route.length === 7 && route[5] && route[6] === 'capture' && method === 'POST') {
      await readJson(request, empty);
      return jsonResponse(await accountTransfers.captureNext(route[5], accountId));
    }
  }
  return null;
}
