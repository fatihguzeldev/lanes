import { BoardCommandSchema } from '../../contracts/commands';
import type { OperationSummary } from '../../../operations/contracts/receipt';

export function captureBoardCreation(title: string, identity: () => string) {
  const command = BoardCommandSchema.parse({ kind: 'board.create', input: { title } });
  return { command, identity: identity() };
}

export function boardCreationRejected(
  receipt: Pick<OperationSummary, 'state' | 'finished' | 'confirmedSteps'> | null,
  code: string | undefined,
  hasReceipt: boolean,
): boolean {
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
