import { movesAcknowledged, type TaskMoveList, type QueuedTaskMove } from './task-move-model';

export function createTaskMoveQueue(
  save: (move: QueuedTaskMove) => Promise<boolean>,
  changed: (moves: readonly QueuedTaskMove[]) => void,
  failed: (error: unknown) => void,
  runTask?: (taskId: string, work: () => Promise<boolean>) => Promise<boolean>,
) {
  let moves: QueuedTaskMove[] = [];
  let draining = false;
  let disposed = false;
  const scheduled = new Map<
    string,
    {
      start(): void;
      result: Promise<{ saved: boolean } | { error: unknown }>;
    }
  >();
  const publish = () => {
    if (!disposed) changed([...moves]);
  };
  function discardDependent(failedMove: QueuedTaskMove) {
    const affected = new Set([
      failedMove.intent.taskId,
      ...failedMove.children.map((task) => task.id),
    ]);
    const discarded = new Set([failedMove.id]);
    for (const move of moves) {
      if (move.confirmed || move.id === failedMove.id) continue;
      if (
        ![
          move.intent.taskId,
          move.intent.previousTaskId,
          move.intent.parentId,
          move.intent.sourceParentId,
        ].some((id) => id && affected.has(id))
      )
        continue;
      discarded.add(move.id);
      affected.add(move.intent.taskId);
      move.children.forEach((task) => affected.add(task.id));
    }
    moves = moves.filter((move) => !discarded.has(move.id));
    for (const id of discarded) {
      scheduled.get(id)?.start();
      scheduled.delete(id);
    }
    publish();
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (; !disposed;) {
        const next = moves.find((move) => !move.confirmed);
        if (!next) break;
        try {
          const reserved = scheduled.get(next.id);
          reserved?.start();
          const outcome = reserved ? await reserved.result : { saved: await save(next) };
          if ('error' in outcome) throw outcome.error;
          scheduled.delete(next.id);
          if (!outcome.saved) {
            discardDependent(next);
            continue;
          }
          next.confirmed = true;
          publish();
        } catch (error) {
          if (disposed) return;
          discardDependent(next);
          failed(error);
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
      if (runTask) {
        let start!: () => void;
        const ready = new Promise<void>((resolve) => {
          start = resolve;
        });
        const result = runTask(move.intent.taskId, async () => {
          await ready;
          return !disposed && moves.includes(move) ? save(move) : false;
        }).then(
          (saved) => ({ saved }),
          (error: unknown) => ({ error }),
        );
        scheduled.set(move.id, { start, result });
      }
      publish();
      void drain();
    },
    reconcile(columns: readonly TaskMoveList[], _scope: string) {
      const retained = moves.filter(
        (move) => !move.confirmed || !movesAcknowledged(columns, [move]),
      );
      if (retained.length !== moves.length) {
        moves = retained;
        publish();
      }
    },
    dispose() {
      disposed = true;
      moves = [];
      for (const pending of scheduled.values()) pending.start();
      scheduled.clear();
    },
  };
}
