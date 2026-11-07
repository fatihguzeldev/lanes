import { useCallback, useRef, useState } from 'react';
import type { CreateTask } from '../../contracts/task';

export interface PendingTaskCreation {
  id: number;
  input: CreateTask;
  confirmedAfter: number | null;
}

export function creationAcknowledged(creation: PendingTaskCreation, readVersion?: number) {
  return creation.confirmedAfter !== null && (readVersion ?? -1) > creation.confirmedAfter;
}

export function useTaskCreations(accountId: string, version: number) {
  const [items, setItems] = useState<PendingTaskCreation[]>([]);
  const currentVersion = useRef(version);
  currentVersion.current = version;
  const start = useCallback(
    (id: number, input: CreateTask) => {
      if (input.accountId !== accountId) return;
      const creation = { id, input: structuredClone(input), confirmedAfter: null };
      setItems((previous) => [creation, ...previous.filter((item) => item.id !== id)]);
    },
    [accountId],
  );
  const confirm = useCallback((id: number) => {
    const confirmedAfter = currentVersion.current;
    setItems((previous) =>
      previous.map((item) =>
        item.id === id && item.confirmedAfter === null ? { ...item, confirmedAfter } : item,
      ),
    );
  }, []);
  const remove = useCallback((id: number) => {
    setItems((previous) =>
      previous.some((item) => item.id === id)
        ? previous.filter((item) => item.id !== id)
        : previous,
    );
  }, []);
  return { items, start, confirm, remove };
}

export type TaskCreationController = ReturnType<typeof useTaskCreations>;
