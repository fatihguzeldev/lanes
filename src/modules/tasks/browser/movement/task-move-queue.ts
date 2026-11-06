import { movesAcknowledged, type TaskMoveList, type QueuedTaskMove } from './task-move-model';

export function createTaskMoveQueue(
  save: (move: QueuedTaskMove) => Promise<boolean>,
  changed: (moves: readonly QueuedTaskMove[]) => void,
  failed: (error: unknown) => void,
) {
  let moves: QueuedTaskMove[] = [];
  let draining = false;
  let disposed = false;
  const publish = () => {
    if (!disposed) changed([...moves]);
  };
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (; !disposed;) {
        const next = moves.find((move) => !move.confirmed);
        if (!next) break;
        try {
          if (!(await save(next))) {
            moves = moves.filter((move) => move.confirmed);
            publish();
            break;
          }
          next.confirmed = true;
          publish();
        } catch (error) {
          if (disposed) return;
          // Later unsent positions may depend on this one. Keep only confirmed work.
          moves = moves.filter((move) => move.confirmed);
          publish();
          failed(error);
          break;
        }
      }
    } finally {
      draining = false;
      publish();
    }
  }
  return {
    enqueue(move: QueuedTaskMove) {
      if (disposed) return;
      moves.push(move);
      publish();
      void drain();
    },
    reconcile(columns: readonly TaskMoveList[], scope: string) {
      const retained = moves.filter(
        (move) => !move.confirmed || (move.scope === scope && !movesAcknowledged(columns, [move])),
      );
      if (retained.length !== moves.length) {
        moves = retained;
        publish();
      }
    },
    dispose() {
      disposed = true;
      moves = [];
    },
  };
}
