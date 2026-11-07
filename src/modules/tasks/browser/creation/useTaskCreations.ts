import { useCallback, useRef, useState } from 'react';
import type { CreateTask } from '../../contracts/task';

export interface PendingTaskCreation {
  id: number;
  input: CreateTask;
  confirmedAfter: number | null;
  failure?: { message: string; onEdit(): void; onDiscard(): void };
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
  const fail = useCallback(
    (id: number, message: string, onEdit: () => void) => {
      setItems((previous) =>
        previous.map((item) =>
          item.id === id
            ? { ...item, failure: { message, onEdit, onDiscard: () => remove(id) } }
            : item,
        ),
      );
    },
    [remove],
  );
  const discardDrafts = useCallback(
    () => setItems((previous) => previous.filter((item) => !item.failure)),
    [],
  );
  return {
    items,
    start,
    confirm,
    remove,
    fail,
    hasDrafts: items.some((item) => !!item.failure),
    discardDrafts,
  };
}

export type TaskCreationController = ReturnType<typeof useTaskCreations>;
