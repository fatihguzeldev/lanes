import { useEffect, useRef, useState } from 'react';
import type { Board } from '../../contracts/board';
import { boardCreationRejected } from './board-creation';
import { useCommands } from '../../../operations/browser/submission/useCommands';

export interface CreationEntry<Resource = unknown> {
  identity: string;
  resource?: Resource;
  resourceId?: string;
  receiptConfirmed?: boolean;
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
export function useCreationQueue<
  Resource extends { id: string; accountId: string; revision: number },
>(options: {
  accountId: string;
  clockOffset: number;
  version: number;
  inventoryReady: boolean;
  observedIds: readonly string[];
  resolve(
    identity: string,
    signal: AbortSignal,
    onAddress: (id: string) => void,
  ): Promise<Resource>;
  category: 'local' | 'provider';
  onChanged(): void;
  onNotice(message: string): void;
  onInspect(id: string): void;
}) {
  const commands = useCommands(options.accountId, options.clockOffset, options.onChanged);
  const [entries, setEntries] = useState<CreationEntry<Resource>[]>([]);
  const current = useRef(entries);
  const queue = useRef<CreationEntry<Resource>[]>([]);
  const flight = useRef(false);
  const alive = useRef(true);
  const readFlight = useRef<AbortController | null>(null);
  const environment = useRef({ ...options, commands });
  environment.current = { ...options, commands };
  const update = (items: CreationEntry<Resource>[]) => {
    current.current = items;
    setEntries(items);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queue.current = [];
      readFlight.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!options.inventoryReady) return;
    const remaining = current.current.filter(
      (entry) =>
        !entry.receiptConfirmed ||
        !(entry.resource?.id ?? entry.resourceId) ||
        !options.observedIds.includes((entry.resource?.id ?? entry.resourceId)!),
    );
    if (remaining.length !== current.current.length) update(remaining);
  }, [entries, options.version, options.inventoryReady, options.observedIds]);
  async function drain() {
    if (flight.current) return;
    flight.current = true;
    try {
      while (alive.current && queue.current.length) {
        const entry = queue.current.shift()!;
        let confirmed = false;
        let rejected = false;
        let error = '';
        let resource: Resource | undefined;
        let resourceId = entry.resourceId;
        try {
          const result = entry.receiptConfirmed
            ? null
            : await environment.current.commands.submit(
                entry.command,
                environment.current.category,
                entry.identity,
              );
          confirmed = entry.receiptConfirmed || result?.state === 'succeeded';
          if (confirmed) {
            const abort = new AbortController();
            readFlight.current = abort;
            resource = await environment.current.resolve(entry.identity, abort.signal, (id) => {
              resourceId = id;
            });
            if (resource.accountId !== options.accountId)
              throw new Error('the saved item belongs to another account.');
            readFlight.current = null;
          }
          const details = environment.current.commands.getErrorDetails?.();
          rejected =
            !confirmed && boardCreationRejected(result, details?.code, !!details?.operationId);
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
                  state: confirmed && resource ? 'confirmed' : 'failed',
                  ...(resource ? { resource } : {}),
                  ...(resourceId ? { resourceId } : {}),
                  receiptConfirmed: confirmed,
                  confirmedAfter: confirmed ? environment.current.version : null,
                  error,
                  rejected,
                }
              : item,
          ),
        );
        if (confirmed && resource) environment.current.onChanged();
        else environment.current.onNotice(error);
      }
    } finally {
      flight.current = false;
    }
  }
  return {
    entries,
    resources: entries.flatMap((entry) => (entry.resource ? [entry.resource] : [])),
    observeResource(resource: Resource) {
      if (resource.accountId !== options.accountId) return;
      let changed = false;
      const items = current.current.map((entry) => {
        if (
          (entry.resource?.id ?? entry.resourceId) !== resource.id ||
          (entry.resource && entry.resource.revision >= resource.revision)
        )
          return entry;
        changed = true;
        return { ...entry, resource, state: 'confirmed' as const, error: '' };
      });
      if (changed) update(items);
    },
    isSaving: () => flight.current || queue.current.length > 0,
    enqueue(
      input: Omit<
        CreationEntry<Resource>,
        | 'state'
        | 'confirmedAfter'
        | 'error'
        | 'rejected'
        | 'resource'
        | 'resourceId'
        | 'receiptConfirmed'
      >,
    ) {
      if (!alive.current || current.current.some((item) => item.identity === input.identity))
        return;
      const entry: CreationEntry<Resource> = {
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
      const captured: CreationEntry<Resource> = { ...entry, state: 'queued', error: '' };
      update(current.current.map((item) => (item.identity === identity ? captured : item)));
      queue.current.push(captured);
      void drain();
    },
    inspect(identity: string) {
      options.onInspect(identity);
    },
  };
}
