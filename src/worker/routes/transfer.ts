import type { ConnectionSummary } from '../../modules/accounts/contracts/connection';
import type { Services } from '../composition/services';
import { jsonResponse } from '../protocol/http';
import { transferImportRoute } from './transfer/imports';
import { accountTransferRoute } from './transfer/accounts';
import { sheetsTransferRoute } from './transfer/sheets';
import { csvExportRoute } from './transfer/csv';
import { archiveTransferRoute } from './transfer/archives';

/** Resolves transfer route families; their bounded input protocols stay with each handler. */
export async function transferRoute(
  request: Request,
  url: URL,
  route: string[],
  account: ConnectionSummary,
  ownerSubject: string,
  services: Services,
): Promise<Response | null> {
  if (route[3] !== 'transfer') return null;
  const context = { request, url, route, account, ownerSubject };
  const { transfer } = services;
  if (route.length === 5 && route[4] === 'capacity' && request.method === 'GET')
    return jsonResponse(await services.operations.lists.capacity(account.id));
  if (route[4] === 'imports' || route[4] === 'labels')
    return transferImportRoute(context, transfer.imports, services.queries);
  if (route[4] === 'accounts')
    return accountTransferRoute(context, transfer.accountTransfers, services.accounts);
  if (route[4] === 'sheets' || (route[4] === 'exports' && route[5] === 'sheets'))
    return sheetsTransferRoute(context, services.sheetsClientFor, transfer.sheetsExports);
  if (route[4] === 'exports' && route[5] === 'csv') return csvExportRoute(context, transfer.csv);
  if (route[4] === 'archives') return archiveTransferRoute(context, transfer);
  return null;
}
