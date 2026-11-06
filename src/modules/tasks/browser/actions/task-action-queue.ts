import type { Task } from '../../contracts/task';

export interface TaskQuickIntent {
  task: Task;
  field: 'starred' | 'completed';
  value: boolean;
}

export function createTaskActionQueue(
  save: (intent: TaskQuickIntent) => Promise<boolean>,
  busy: (pending: boolean) => void,
  failed: (error: unknown) => void,
) {
  let jobs: Array<{ intent: TaskQuickIntent; resolve: (saved: boolean) => void }> = [];
  let draining = false;
  let disposed = false;
  async function drain() {
    if (draining) return;
    draining = true;
    busy(true);
    try {
      while (jobs.length && !disposed) {
        const job = jobs[0]!;
        let saved = false;
        try {
          saved = await save(job.intent);
        } catch (error) {
          if (!disposed) failed(error);
        }
        if (disposed) return;
        jobs.shift();
        job.resolve(saved);
        if (!saved) {
          jobs = jobs.filter((next) => {
            if (
              next.intent.task.accountId !== job.intent.task.accountId ||
              next.intent.task.id !== job.intent.task.id
            )
              return true;
            next.resolve(false);
            return false;
          });
        }
      }
    } finally {
      draining = false;
      if (!disposed) busy(false);
    }
  }
  return {
    enqueue(intent: TaskQuickIntent): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      return new Promise((resolve) => {
        jobs.push({ intent, resolve });
        void drain();
      });
    },
    dispose() {
      disposed = true;
      jobs.forEach((job) => job.resolve(false));
      jobs = [];
    },
  };
}
