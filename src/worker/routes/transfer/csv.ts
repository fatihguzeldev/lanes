import type { Services } from '../../services';
import type { AccountRouteContext } from '../context';

import { z } from 'zod';
import { CsvExportRequestSchema } from '../../../modules/transfer/export-contract';
import { jsonResponse, readJson } from '../../http';
export async function csvExportRoute(
  context: AccountRouteContext,
  csv: Services['transfer']['csv'],
): Promise<Response | null> {
  const { request, route, account } = context;
  const accountId = account.id,
    method = request.method;
  if (route[4] === 'exports') {
    if (route.length === 7 && route[5] === 'csv' && route[6] === 'page' && method === 'POST') {
      const input = await readJson(
        request,
        z
          .object({
            request: CsvExportRequestSchema,
            cursor: z.string().min(1).max(48000).optional(),
          })
          .strict(),
      );
      return jsonResponse(await csv.page(accountId, input.request, input.cursor));
    }
  }
  return null;
}
