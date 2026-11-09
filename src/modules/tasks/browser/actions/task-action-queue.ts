import type { Task } from '../../contracts/task';

export type TaskQuickIntent = (
  | { task: Task; field: 'starred' | 'completed'; value: boolean }
  | { task: Pick<Task, 'id' | 'accountId'>; field: 'scheduledDay'; value: string | null }
) & { changeId?: string };

export function createTaskActionQueue(
  save: (intent: TaskQuickIntent) => Promise<boolean>,
  busy: (pending: boolean) => void,
  failed: (error: unknown) => void,
) {
  type Job = { intent: TaskQuickIntent; resolve: (saved: boolean) => void };
  const queues = new Map<string, Job[]>();
  let pending = 0;
  let disposed = false;
  async function drain(key: string, jobs: Job[]) {
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
        pending--;
        job.resolve(saved);
        if (!saved) {
          pending -= jobs.length;
          jobs.splice(0).forEach((next) => next.resolve(false));
        }
      }
    } finally {
      if (queues.get(key) === jobs) queues.delete(key);
      if (!disposed && pending === 0) busy(false);
    }
  }
  return {
    enqueue(intent: TaskQuickIntent): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      return new Promise((resolve) => {
        const key = JSON.stringify([intent.task.accountId, intent.task.id]);
        let jobs = queues.get(key);
        const running = !!jobs;
        if (!jobs) queues.set(key, (jobs = []));
        jobs.push({ intent, resolve });
        if (pending++ === 0) busy(true);
        if (!running) void drain(key, jobs);
      });
    },
    dispose() {
      disposed = true;
      queues.forEach((jobs) => jobs.forEach((job) => job.resolve(false)));
      queues.clear();
      pending = 0;
    },
  };
}
