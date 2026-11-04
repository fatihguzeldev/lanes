import type { OperationSummary } from '../operation-contract';

export interface CompletedDeletionAcknowledgements {
  permanent: boolean;
  openChildren: boolean;
  assignments: boolean;
}
export interface CompletedDeletionConsequences {
  totalDeleteCount: number;
  openDescendantCount: number;
  assignedTaskCount: number;
}

export function completedDeletionAcknowledged(
  counts: CompletedDeletionConsequences,
  acknowledgements: CompletedDeletionAcknowledgements,
): boolean {
  return (
    counts.totalDeleteCount > 0 &&
    acknowledgements.permanent &&
    (counts.openDescendantCount === 0 || acknowledgements.openChildren) &&
    (counts.assignedTaskCount === 0 || acknowledgements.assignments)
  );
}

/** Unknown outcomes and long provider backoffs return control to the owner instead of spinning. */
export function mayAdvanceCompletedDeletion(
  operation: Pick<
    OperationSummary,
    'state' | 'finished' | 'inputSealed' | 'cancelRequested' | 'nextAttemptAt'
  >,
  now: number,
): boolean {
  return (
    !operation.finished &&
    operation.inputSealed &&
    !operation.cancelRequested &&
    ['accepted', 'running', 'partial'].includes(operation.state) &&
    (operation.nextAttemptAt === null || operation.nextAttemptAt <= now + 2_000)
  );
}
