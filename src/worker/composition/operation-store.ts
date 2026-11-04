import type { D1Database } from '@cloudflare/workers-types';
import { OperationStore } from '../../modules/operations/server/journal/store';
import { CommandRetention } from '../../modules/tasks/server/commands/retention';
import { TaskListReservations } from '../../modules/tasks/server/operations/list-reservations';

/** Resource owners prepare their writes; the receipt journal commits them together. */
export function createOperationStore(db: D1Database): OperationStore {
  return new OperationStore(db, {
    lists: new TaskListReservations(db),
    captures: new CommandRetention(db),
  });
}
