import { request } from '../../../../shared/browser/http/http';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { LabelPageSchema } from '../../contracts/query';

export function useLabels(accountId: string, version: number) {
  const base = `/api/accounts/${encodeURIComponent(accountId)}`;
  return usePagedResource(
    `${accountId}:labels`,
    (cursor, signal) =>
      request(
        `${base}/labels${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        LabelPageSchema,
        { signal },
      ),
    (label) => label.id,
    version,
  );
}

export type LabelPickerPage = Pick<
  ReturnType<typeof useLabels>,
  'nextCursor' | 'status' | 'error' | 'loadMore' | 'reload'
>;
