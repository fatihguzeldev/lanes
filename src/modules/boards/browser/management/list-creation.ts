import { ProviderCommandSchema } from '../../../tasks/contracts/provider-commands';
import type { Board } from '../../contracts/board';
import type { OperationSummary } from '../../../operations/contracts/receipt';

export function captureListCreation(board: Board, title: string, identity: () => string) {
  const command = ProviderCommandSchema.parse({
    kind: 'list.create',
    title,
    boardId: board.id,
    boardRevision: board.revision,
  });
  return { accountId: board.accountId, command, identity: identity() };
}

export function listCreationRejected(
  receipt: Pick<OperationSummary, 'state' | 'finished' | 'confirmedSteps'> | null,
  code: string | undefined,
  hasReceipt: boolean,
) {
  if (receipt)
    return (
      receipt.finished &&
      ['failed', 'cancelled'].includes(receipt.state) &&
      receipt.confirmedSteps === 0
    );
  return (
    !hasReceipt &&
    ['validation_failed', 'conflict', 'not_found', 'connection_paused', 'forbidden'].includes(
      code ?? '',
    )
  );
}
