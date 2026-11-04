import { request } from '../../../../shared/browser/http/http';
import { BoardMembershipSchema } from '../../contracts/board';

export function readListPlacement(accountId: string, listId: string) {
  return request(
    `/api/accounts/${encodeURIComponent(accountId)}/lists/${encodeURIComponent(listId)}/placement`,
    BoardMembershipSchema,
  );
}
