import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { LabelInputSchema, LabelSchema, type Label } from '../../contracts/task';
import { LabelPatchSchema, type LabelPatch } from '../../contracts/metadata-commands';
import type { OperationSummary } from '../../../operations/contracts/receipt';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { request } from '../../../../shared/browser/http/http';

type Change = {
  identity: string;
  kind: 'create' | 'update' | 'delete';
  source: Label;
  input: LabelPatch;
  confirmed: boolean;
  confirmedAfter: number | null;
  error: string;
  command?: unknown;
};

export function useLabelChanges(options: {
  accountId: string;
  clockOffset: number;
  version: number;
  labels: readonly Label[];
  inventoryReady: boolean;
  submit(command: unknown, identity: string): Promise<OperationSummary | null>;
  onError(message: string, operationId?: string): void;
  onChanged(): void;
  onDeleted(identity: string): Promise<void>;
}) {
  const [changes, setChanges] = useState<Change[]>([]);
  const current = useRef(changes);
  const queue = useRef<Change[]>([]);
  const flight = useRef(false);
  const alive = useRef(true);
  const settled = useRef(new Set<string>());
  const environment = useRef(options);
  environment.current = options;
  const update = (items: Change[]) => {
    current.current = items;
    setChanges(items);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queue.current = [];
    };
  }, []);
  useEffect(() => {
    const remaining = current.current.filter((change) => {
      if (!change.confirmed) return true;
      const read = options.labels.find((label) => label.id === change.source.id);
      if (change.kind === 'create') return !read;
      if (change.kind === 'update') return !read || read.revision <= change.source.revision;
      return (
        !!read ||
        !options.inventoryReady ||
        options.version <= (change.confirmedAfter ?? options.version)
      );
    });
    if (remaining.length !== current.current.length) update(remaining);
  }, [changes, options.labels, options.version, options.inventoryReady]);
  function projected() {
    const shown = new Map(environment.current.labels.map((label) => [label.id, label]));
    for (const change of current.current) {
      if (change.error) continue;
      const actual = environment.current.labels.find((label) => label.id === change.source.id);
      if (change.kind === 'delete') shown.delete(change.source.id);
      else if (change.kind === 'create') {
        if (!shown.has(change.source.id)) shown.set(change.source.id, change.source);
      } else if (!change.confirmed || !actual || actual.revision <= change.source.revision)
        shown.set(change.source.id, {
          ...(shown.get(change.source.id) ?? change.source),
          ...Object.fromEntries(
            Object.entries(change.input).filter(([, value]) => value !== undefined),
          ),
        });
    }
    return [...shown.values()];
  }
  async function drain() {
    if (flight.current) return;
    flight.current = true;
    try {
      while (alive.current && queue.current.length) {
        const change = queue.current.shift()!;
        let captured = change;
        try {
          let source = change.source;
          if (!change.command && change.kind !== 'create' && settled.current.has(source.id)) {
            const response = await request(
              `/api/accounts/${encodeURIComponent(options.accountId)}/labels/resolve`,
              z.object({ items: z.array(LabelSchema).max(100) }).strict(),
              { method: 'POST', body: { ids: [source.id] } },
            );
            const label = response.items.find(
              (item) => item.id === source.id && item.accountId === options.accountId,
            );
            if (!label) throw new Error('this label is no longer available.');
            const fields =
              change.kind === 'delete'
                ? (['name', 'color'] as const)
                : (Object.keys(change.input) as (keyof LabelPatch)[]);
            if (fields.some((field) => label[field] !== change.source[field]))
              throw new Error(
                'this label changed elsewhere. review it before applying these fields.',
              );
            source = label;
          }
          if (!alive.current) break;
          const command =
            change.command ??
            (change.kind === 'create'
              ? { kind: 'label.create', input: change.input }
              : change.kind === 'delete'
                ? {
                    kind: 'label.delete.start',
                    labelId: source.id,
                    expectedRevision: source.revision,
                  }
                : {
                    kind: 'label.update',
                    labelId: source.id,
                    expectedRevision: source.revision,
                    input: change.input,
                  });
          captured = { ...change, source, command };
          const result = await environment.current.submit(command, change.identity);
          if (!alive.current) break;
          if (result?.state !== 'succeeded')
            throw new Error(
              result?.error?.message ??
                'this label change could not be confirmed. review it from the sync menu.',
            );
          settled.current.add(source.id);
          update(
            current.current.map((item) =>
              item.identity === change.identity
                ? {
                    ...captured,
                    confirmed: true,
                    confirmedAfter: environment.current.version,
                  }
                : item,
            ),
          );
          environment.current.onChanged();
          if (change.kind === 'delete') {
            try {
              await environment.current.onDeleted(change.identity);
            } catch (cause) {
              environment.current.onError(
                cause instanceof Error ? cause.message : 'label deletion needs another step.',
              );
            }
          }
        } catch (cause) {
          if (!alive.current) break;
          const error =
            cause instanceof Error ? cause.message : 'this label change could not save.';
          const dependent = new Set(
            queue.current
              .filter((item) => item.source.id === change.source.id)
              .map((item) => item.identity),
          );
          queue.current = queue.current.filter((item) => item.source.id !== change.source.id);
          settled.current.add(change.source.id);
          update(
            current.current.map((item) =>
              item.identity === change.identity
                ? { ...captured, error }
                : dependent.has(item.identity)
                  ? {
                      ...item,
                      error: 'this change was not sent because an earlier label change failed.',
                    }
                  : item,
            ),
          );
          environment.current.onError(
            error,
            captured.command === undefined ? undefined : change.identity,
          );
        }
      }
    } finally {
      flight.current = false;
    }
  }
  function enqueue(kind: Change['kind'], source: Label, input: LabelPatch, identity: string) {
    if (!alive.current || source.accountId !== options.accountId) return false;
    const change: Change = {
      kind,
      source,
      input,
      identity,
      confirmed: false,
      confirmedAfter: null,
      error: '',
    };
    update([...current.current, change]);
    queue.current.push(change);
    void drain();
    return true;
  }
  return {
    labels: projected(),
    failures: changes.filter((change) => change.error),
    isSaving: () => flight.current || queue.current.length > 0,
    create(name: string, color: string) {
      const input = LabelInputSchema.parse({ name, color });
      const identity = newOperationId(options.clockOffset);
      return enqueue(
        'create',
        { ...input, id: `label:${identity}`, accountId: options.accountId, revision: 0 },
        input,
        identity,
      );
    },
    change(source: Label, patch: LabelPatch) {
      const input = LabelPatchSchema.parse(patch);
      const shown = projected().find((label) => label.id === source.id) ?? source;
      if (Object.entries(input).every(([name, value]) => shown[name as keyof Label] === value))
        return true;
      return enqueue('update', shown, input, newOperationId(options.clockOffset));
    },
    remove(source: Label, identity: string) {
      return enqueue('delete', source, {}, identity);
    },
    retry(identity: string) {
      const change = current.current.find((item) => item.identity === identity && item.error);
      if (!change?.command) return;
      const captured = { ...change, error: '' };
      update(current.current.map((item) => (item.identity === identity ? captured : item)));
      queue.current.push(captured);
      void drain();
    },
  };
}
