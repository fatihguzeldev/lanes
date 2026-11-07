import { useRef, useState } from 'react';
import type { Task } from '../../../tasks/contracts/task';
import type { CalendarRescheduleIntent } from './CalendarView';

interface DateChange {
  id: number;
  task: Task;
  day: string | null;
  confirmedAfter: number | null;
}

export function useCalendarReschedules(
  accountId: string,
  tasks: readonly Task[],
  version: number,
  readVersion: number | undefined,
  save: (intent: CalendarRescheduleIntent) => Promise<boolean> | void,
) {
  const [changes, setChanges] = useState<DateChange[]>([]);
  const sequence = useRef(0);
  const currentVersion = useRef(version);
  currentVersion.current = version;
  const acknowledged = (change: DateChange) =>
    change.confirmedAfter !== null &&
    ((readVersion !== undefined && readVersion > change.confirmedAfter) ||
      tasks.some(
        (task) =>
          task.accountId === change.task.accountId &&
          task.id === change.task.id &&
          task.revision > change.task.revision &&
          task.scheduledDay === change.day,
      ));
  const active = changes.filter(
    (change) => change.task.accountId === accountId && !acknowledged(change),
  );
  const projected = new Map(tasks.map((task) => [task.id, task]));
  for (const change of active) {
    const task = projected.get(change.task.id) ?? change.task;
    projected.set(task.id, {
      ...task,
      scheduledDay: change.day,
      ...(change.day === null ? { scheduledTime: null, timeZone: null, repeatRule: null } : {}),
    });
  }
  return {
    tasks: [...projected.values()],
    taskIds: [...new Set(active.map((change) => change.task.id))],
    async reschedule(intent: CalendarRescheduleIntent): Promise<boolean> {
      const task = projected.get(intent.taskId);
      if (
        intent.accountId !== accountId ||
        !task ||
        task.accountId !== accountId ||
        task.listId !== intent.listId
      )
        return false;
      if (task.scheduledDay === intent.scheduledDay) return true;
      const id = ++sequence.current;
      setChanges((previous) => [
        ...previous.filter((change) => !acknowledged(change)),
        { id, task, day: intent.scheduledDay, confirmedAfter: null },
      ]);
      let saved = false;
      try {
        saved = (await save(intent)) === true;
      } finally {
        const confirmedAfter = currentVersion.current;
        setChanges((previous) =>
          saved
            ? previous.map((change) => (change.id === id ? { ...change, confirmedAfter } : change))
            : previous.filter((change) => change.id !== id),
        );
      }
      return saved;
    },
  };
}
