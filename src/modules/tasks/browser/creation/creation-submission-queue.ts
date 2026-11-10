import { request, RequestError } from '../../../../shared/browser/http/http';
import {
  OperationSummarySchema,
  type OperationSummary,
} from '../../../operations/contracts/receipt';

/** A list's first-position creates keep capture order; unresolved creates fence later inserts. */
export function createCreationSubmissionQueue(accountId: string, active: () => boolean) {
  const submissions = new Map<string, Promise<void>>();
  const blocked = new Map<string, { id: number; operationId?: string }>();
  const run = (
    id: number,
    listId: string,
    submit: () => Promise<OperationSummary | null>,
    error?: () => RequestError | null,
  ): Promise<boolean> => {
    const work = (submissions.get(listId) ?? Promise.resolve()).then(async () => {
      if (!active()) throw new Error('this new task belongs to another account.');
      const earlier = blocked.get(listId);
      if (earlier?.operationId) {
        const receipt = await request(
          `/api/accounts/${encodeURIComponent(accountId)}/operations/${encodeURIComponent(earlier.operationId)}`,
          OperationSummarySchema,
        );
        if (receipt.id !== earlier.operationId || receipt.accountId !== accountId)
          throw new Error('the earlier new task’s save could not be verified for this account.');
        if (
          receipt.state === 'succeeded' ||
          (receipt.finished && receipt.state === 'failed' && receipt.confirmedSteps === 0)
        )
          blocked.delete(listId);
      }
      if (blocked.has(listId))
        throw new Error(
          'an earlier new task’s save needs checking before adding another task to this list.',
        );
      if (!active()) throw new Error('this new task belongs to another account.');
      try {
        const result = await submit();
        if (result?.state === 'succeeded') return true;
        const details = error?.();
        const rejected =
          result?.finished && result.state === 'failed' && result.confirmedSteps === 0;
        const operationId = result?.id ?? details?.operationId;
        if (!rejected && !(details && !details.operationId))
          blocked.set(listId, { id, ...(operationId ? { operationId } : {}) });
        return false;
      } catch (failure) {
        if (!(failure instanceof RequestError) || failure.operationId)
          blocked.set(listId, {
            id,
            ...(failure instanceof RequestError && failure.operationId
              ? { operationId: failure.operationId }
              : {}),
          });
        throw failure;
      }
    });
    const tail = work.then(
      () => {},
      () => {},
    );
    submissions.set(listId, tail);
    void tail.then(() => {
      if (submissions.get(listId) === tail) submissions.delete(listId);
    });
    return work;
  };
  return {
    run,
    confirm(id: number, listId: string) {
      if (blocked.get(listId)?.id === id) blocked.delete(listId);
    },
  };
}
