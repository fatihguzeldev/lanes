import { request } from '../../../../shared/browser/http/http';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { OperationPageSchema } from '../../contracts/receipt';

export function useUnfinishedChanges(accountId: string, version: number) {
  const base = `/api/accounts/${encodeURIComponent(accountId)}`;
  return usePagedResource(
    `${accountId}:unfinished-saves`,
    (cursor, signal) =>
      request(
        `${base}/operations?active=1&limit=10${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
        OperationPageSchema,
        { signal },
      ),
    (item) => item.id,
    version,
  );
}
