import { useEffect, useRef, useState } from 'react';
import type { Board } from '../../contracts/board';
import { boardCreationRejected } from './board-creation';
import { useCommands } from '../../../operations/browser/submission/useCommands';

export interface CreationEntry {
  identity: string;
  command: unknown;
  title: string;
  boardId?: string;
  board?: Board;
  rejected: boolean;
  state: 'queued' | 'confirmed' | 'failed';
  confirmedAfter: number | null;
  error: string;
}

/** The draft is a separate lifetime from every captured create and its receipt. */
export function useCreationQueue(options: {
  accountId: string;
  clockOffset: number;
  version: number;
  inventoryReady: boolean;
  boardId?: string | null;
  category: 'local' | 'provider';
  onChanged(): void;
  onNotice(message: string): void;
  onInspect(id: string): void;
}) {
  const commands = useCommands(options.accountId, options.clockOffset, options.onChanged);
  const [entries, setEntries] = useState<CreationEntry[]>([]);
  const current = useRef(entries);
  const queue = useRef<CreationEntry[]>([]);
  const flight = useRef(false);
  const alive = useRef(true);
  const environment = useRef({ ...options, commands });
  environment.current = { ...options, commands };
  const update = (items: CreationEntry[]) => {
    current.current = items;
    setEntries(items);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queue.current = [];
    };
  }, []);
  useEffect(() => {
    if (!options.inventoryReady) return;
    const remaining = current.current.filter(
      (entry) =>
        entry.state !== 'confirmed' ||
        entry.confirmedAfter === null ||
        options.version <= entry.confirmedAfter ||
        (entry.boardId !== undefined && entry.boardId !== options.boardId),
    );
    if (remaining.length !== current.current.length) update(remaining);
  }, [entries, options.version, options.inventoryReady, options.boardId]);
  async function drain() {
    if (flight.current) return;
    flight.current = true;
    try {
      while (alive.current && queue.current.length) {
        const entry = queue.current.shift()!;
        let confirmed = false;
        let rejected = false;
        let error = '';
        try {
          const result = await environment.current.commands.submit(
            entry.command,
            environment.current.category,
            entry.identity,
          );
          confirmed = result?.state === 'succeeded';
          const details = environment.current.commands.getErrorDetails?.();
          rejected = boardCreationRejected(result, details?.code, !!details?.operationId);
          if (!confirmed)
            error =
              environment.current.commands.error ||
              'this save has not been confirmed. review it before trying again.';
        } catch (cause) {
          error = cause instanceof Error ? cause.message : 'this save could not finish.';
        }
        if (!alive.current) break;
        update(
          current.current.map((item) =>
            item.identity === entry.identity
              ? {
                  ...entry,
                  state: confirmed ? 'confirmed' : 'failed',
                  confirmedAfter: confirmed ? environment.current.version : null,
                  error,
                  rejected,
                }
              : item,
          ),
        );
        if (confirmed) environment.current.onChanged();
        else environment.current.onNotice(error);
      }
    } finally {
      flight.current = false;
    }
  }
  return {
    entries,
    isSaving: () => flight.current || queue.current.length > 0,
    enqueue(input: Omit<CreationEntry, 'state' | 'confirmedAfter' | 'error' | 'rejected'>) {
      if (!alive.current || current.current.some((item) => item.identity === input.identity))
        return;
      const entry: CreationEntry = {
        ...input,
        state: 'queued',
        confirmedAfter: null,
        error: '',
        rejected: false,
      };
      update([...current.current, entry]);
      queue.current.push(entry);
      void drain();
    },
    takeRejected(identity: string) {
      const entry = current.current.find(
        (item) => item.identity === identity && item.state === 'failed' && item.rejected,
      );
      if (!entry) return;
      update(current.current.filter((item) => item.identity !== identity));
      return entry;
    },
    retry(identity: string) {
      const entry = current.current.find((item) => item.identity === identity);
      if (!entry || entry.state !== 'failed' || entry.rejected) return;
      const captured: CreationEntry = { ...entry, state: 'queued', error: '' };
      update(current.current.map((item) => (item.identity === identity ? captured : item)));
      queue.current.push(captured);
      void drain();
    },
    inspect(identity: string) {
      options.onInspect(identity);
    },
  };
}
