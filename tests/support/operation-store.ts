import type { D1Database } from '@cloudflare/workers-types';
import { OperationStore } from '../../src/modules/operations/server/journal/store';
import { CommandRetention } from '../../src/modules/tasks/server/commands/retention';
import { TaskListReservations } from '../../src/modules/tasks/server/operations/list-reservations';

/** Test composition uses the same inventory and retention capabilities as the worker. */
export function createOperationStore(db: D1Database): OperationStore {
  return new OperationStore(db, {
    lists: new TaskListReservations(db),
    captures: new CommandRetention(db),
  });
}
