import type { Task } from '../../contracts/task';
import { request, RequestError } from '../../../../shared/browser/http/http';
import { OperationSummarySchema } from '../../../operations/contracts/receipt';
import { readTask } from '../queries/references';
import {
  applyConfirmedPhase,
  editableFields,
  intentConfirmed,
  intentFor,
  sameField,
  type CreationRecord,
} from './creation-state';

interface RecoveryOwner {
  current(): CreationRecord | undefined;
  update(change: (creation: CreationRecord) => CreationRecord): void;
}

/** Receipt recovery can confirm captured work or admit a corrected, definitely unsent phase. */
export async function recoverCreationFollowup(
  accountId: string,
  task: Task,
  owner: RecoveryOwner,
): Promise<Task | undefined> {
  let creation = owner.current();
  if (!creation?.blockedFollowup) return creation ? task : undefined;
  const listId = creation.submittedInput.listId;
  const blocked = creation.blockedFollowup;
  if (blocked.intent.deleted)
    throw new RequestError(
      'creation_followup',
      'this new task still has a change that needs checking.',
      undefined,
      blocked.operationId,
    );
  let rejected = blocked.rejected && !blocked.operationId;
  if (blocked.operationId) {
    const receipt = await request(
      `/api/accounts/${encodeURIComponent(accountId)}/operations/${encodeURIComponent(blocked.operationId)}`,
      OperationSummarySchema,
    );
    creation = owner.current();
    if (!creation) return;
    if (receipt.accountId !== accountId || receipt.id !== blocked.operationId)
      throw new RequestError(
        'creation_followup',
        'this new task still has a change that needs checking.',
        undefined,
        blocked.operationId,
      );
    rejected = receipt.finished && receipt.state === 'failed' && receipt.confirmedSteps === 0;
    if (!rejected && receipt.state !== 'succeeded')
      throw new RequestError(
        'creation_followup',
        'this new task still has a change that needs checking.',
        undefined,
        blocked.operationId,
      );
  }
  if (rejected) {
    owner.update((item) => ({ ...item, blockedFollowup: { ...blocked, rejected: true } }));
    const { input: desiredInput, expectedGraphRevision } = creation;
    const corrected =
      editableFields.some(
        (field) => !sameField(field, desiredInput[field], blocked.input[field]),
      ) ||
      (blocked.intent.patch.blockedBy !== undefined &&
        expectedGraphRevision !== blocked.expectedGraphRevision);
    if (!corrected)
      throw new RequestError(
        'creation_followup',
        'edit this new task before trying its change again.',
        undefined,
        blocked.operationId,
      );
  }
  if (blocked.operationId && !rejected) {
    owner.update((item) =>
      applyConfirmedPhase(item, blocked.input, blocked.intent, blocked.operationId),
    );
  }
  if (blocked.operationId || rejected) {
    task = await readTask(accountId, task.id);
    creation = owner.current();
    if (!creation) return;
    if (task.accountId !== accountId || task.listId !== listId)
      throw new Error('the saved task moved before its queued changes finished.');
  }
  if (rejected) {
    const patch = intentFor(task, creation).patch;
    if (
      Object.keys(patch).some(
        (field) => !sameField(field, task[field as keyof Task], blocked.task[field as keyof Task]),
      )
    )
      throw new RequestError(
        'creation_followup',
        'this task changed before its corrected edit could save. open its current values to review it.',
        undefined,
        blocked.operationId,
      );
    owner.update((item) => {
      const { blockedFollowup: _blocked, failure: _failure, ...saved } = item;
      return saved;
    });
    return task;
  }
  if (blocked.operationId) return task;
  if (!intentConfirmed(task, blocked.intent))
    throw new RequestError(
      'creation_followup',
      'this new task still has a change that needs checking.',
      undefined,
      blocked.operationId,
    );
  owner.update((item) => applyConfirmedPhase(item, blocked.input, blocked.intent));
  return task;
}
