import { useEffect, useRef, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { TemplateScheduleSummary } from '../../contracts/template';
import {
  TemplateCommandSchema,
  templateResultIds,
  type TemplateCommand,
} from '../../contracts/template-commands';
import type { useCommands } from '../../../operations/browser/submission/useCommands';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { serverConnection } from '../../../../shared/browser/connectivity/connectivity';
import { localWritable, type PersonalTemplate } from './template-model';

type Change = { identity: string; command: TemplateCommand; confirmed: boolean };
export type TemplateFailure = {
  identity: string;
  command: TemplateCommand;
  message: string;
  operationId?: string;
  retryable: boolean;
};
type Chain = { base: number; next: number; waiting: number; failure: TemplateFailure | null };
function resource(command: TemplateCommand, identity: string) {
  if (command.kind === 'template.schedule.create')
    return `schedule:${templateResultIds(identity).scheduleId}`;
  if (command.kind === 'template.list.create' || command.kind === 'template.board.create')
    return `${command.kind.split('.')[1]}:${templateResultIds(identity).templateId}`;
  return 'templateId' in command
    ? `${command.kind.split('.')[1]}:${command.templateId}`
    : 'scheduleId' in command
      ? `schedule:${command.scheduleId}`
      : null;
}
function previewTemplate(
  template: PersonalTemplate,
  command: TemplateCommand,
): PersonalTemplate | null {
  if (
    !('templateId' in command) ||
    command.templateId !== template.id ||
    !command.kind.startsWith(`template.${template.kind}.`)
  )
    return template;
  if (command.kind.endsWith('.delete')) return null;
  if (command.kind === 'template.list.update' || command.kind === 'template.board.update')
    return {
      ...template,
      ...(command.input.name !== undefined ? { name: command.input.name } : {}),
      ...(command.input.description !== undefined
        ? { description: command.input.description }
        : {}),
      revision: command.revision + 1,
    };
  return template;
}
function previewSchedule(
  schedule: TemplateScheduleSummary,
  command: TemplateCommand,
): TemplateScheduleSummary | null {
  if (!('scheduleId' in command) || command.scheduleId !== schedule.id) return schedule;
  if (command.kind === 'template.schedule.delete') return null;
  if (command.kind === 'template.schedule.update') {
    const patch = command.input;
    return {
      ...schedule,
      ...(patch.template !== undefined ? { template: patch.template } : {}),
      ...(patch.boardId !== undefined ? { boardId: patch.boardId } : {}),
      ...(patch.timing !== undefined ? { timing: patch.timing } : {}),
      ...(patch.useRelativeDates !== undefined ? { useRelativeDates: patch.useRelativeDates } : {}),
      ...(patch.listPrefix !== undefined ? { listPrefix: patch.listPrefix } : {}),
      revision: command.revision + 1,
      nextRunAt: null,
    };
  }
  if (command.kind === 'template.schedule.pause' || command.kind === 'template.schedule.resume')
    return {
      ...schedule,
      state: command.kind.endsWith('.pause') ? 'paused' : 'active',
      revision: command.revision + 1,
      nextRunAt: null,
      pauseReason: null,
    };
  return schedule;
}

/** Captured template writes outlive their forms; only confirmed predecessors advance revisions. */
export function useTemplateChanges({
  account,
  clockOffset,
  commands,
  templates,
  schedules,
  onChanged,
  onFailure,
}: {
  account: ConnectionSummary;
  clockOffset: number;
  commands: Pick<ReturnType<typeof useCommands>, 'submit' | 'getErrorDetails'>;
  templates: PersonalTemplate[];
  schedules: TemplateScheduleSummary[];
  onChanged: () => void;
  onFailure: (failure: TemplateFailure) => void;
}) {
  const [changes, setChanges] = useState<Change[]>([]),
    [failures, setFailures] = useState<TemplateFailure[]>([]),
    [validation, setValidation] = useState('');
  const queue = useRef<Promise<unknown>>(Promise.resolve()),
    chains = useRef(new Map<string, Chain>());
  const callbacks = useRef({ onChanged, onFailure });
  callbacks.current = { onChanged, onFailure };
  useEffect(() => {
    // Keep a confirmed preview until the corresponding read has caught up.
    setChanges((current) => {
      const remaining = current.filter((change) => {
        if (!change.confirmed) return true;
        const command = change.command;
        if ('templateId' in command) {
          const item = templates.find(
            (item) =>
              item.id === command.templateId && command.kind.startsWith(`template.${item.kind}.`),
          );
          return command.kind.endsWith('.delete')
            ? Boolean(item)
            : !item || item.revision <= command.revision;
        }
        if ('scheduleId' in command) {
          const item = schedules.find((item) => item.id === command.scheduleId);
          return command.kind.endsWith('.delete')
            ? Boolean(item)
            : !item || item.revision <= command.revision;
        }
        const ids = templateResultIds(change.identity);
        return command.kind === 'template.schedule.create'
          ? !schedules.some((item) => item.id === ids.scheduleId)
          : !templates.some((item) => item.id === ids.templateId);
      });
      return remaining.length === current.length ? current : remaining;
    });
  }, [templates, schedules]);
  const pending = changes.some((change) => !change.confirmed);
  useEffect(() => {
    if (!pending) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [pending]);
  const fail = (failure: TemplateFailure) => {
    setChanges((current) => current.filter((change) => change.identity !== failure.identity));
    setFailures((current) => [...current, failure]);
    callbacks.current.onFailure(failure);
  };
  function mutate(input: TemplateCommand): boolean {
    if (!localWritable(account) || serverConnection() !== 'reachable') {
      setValidation('check this account’s connection before saving.');
      return false;
    }
    const parsed = TemplateCommandSchema.safeParse(input);
    if (!parsed.success) {
      setValidation(parsed.error.issues[0]?.message ?? 'check these fields.');
      return false;
    }
    const command = structuredClone(parsed.data),
      identity = newOperationId(clockOffset),
      key = resource(command, identity);
    let chain: Chain | undefined;
    if (key && command.kind.endsWith('.create')) {
      chain = { base: 0, next: 0, waiting: 1, failure: null };
      chains.current.set(key, chain);
    }
    if (key && 'revision' in command) {
      chain = chains.current.get(key);
      if (!chain) {
        chain = { base: command.revision, next: command.revision, waiting: 0, failure: null };
        chains.current.set(key, chain);
      }
      if (chain.failure || (command.revision !== chain.base && command.revision !== chain.next)) {
        setValidation('review the latest values before saving this change.');
        return false;
      }
      command.revision = chain.next++;
      chain.waiting++;
    }
    setValidation('');
    const captured = { identity, command, confirmed: false };
    setChanges((current) => [...current, captured]);
    const run = async () => {
      try {
        if (chain?.failure) {
          fail({
            identity,
            command,
            message: 'an earlier change could not save. review this draft before trying again.',
            ...(chain.failure.operationId ? { operationId: chain.failure.operationId } : {}),
            retryable: chain.failure.retryable,
          });
          return;
        }
        const result = await commands.submit(command, 'local', identity);
        if (result?.state === 'succeeded') {
          setChanges((current) =>
            current.map((change) =>
              change.identity === identity ? { ...change, confirmed: true } : change,
            ),
          );
          callbacks.current.onChanged();
        } else {
          const error = commands.getErrorDetails();
          const failure: TemplateFailure = {
            identity,
            command,
            message:
              error?.message ??
              result?.error?.message ??
              'this change could not be confirmed. review its save before trying again.',
            ...(error?.operationId || result?.id
              ? { operationId: error?.operationId ?? result!.id }
              : {}),
            retryable:
              (!error?.operationId && !result) ||
              Boolean(result?.finished && result.state === 'failed' && result.confirmedSteps === 0),
          };
          if (chain) chain.failure = failure;
          fail(failure);
        }
      } catch (caught) {
        const failure: TemplateFailure = {
          identity,
          command,
          message: caught instanceof Error ? caught.message : 'this change could not be confirmed.',
          operationId: identity,
          retryable: false,
        };
        if (chain) chain.failure = failure;
        fail(failure);
      } finally {
        if (chain && --chain.waiting === 0 && key && chains.current.get(key) === chain)
          chains.current.delete(key);
      }
    };
    queue.current = queue.current.then(run, run);
    return true;
  }
  const visibleTemplates = changes.reduce(
    (items, change) =>
      items.flatMap((item) => {
        if (
          change.confirmed &&
          'templateId' in change.command &&
          item.revision > change.command.revision
        )
          return [item];
        const next = previewTemplate(item, change.command);
        return next ? [next] : [];
      }),
    templates,
  );
  const createdSchedules: TemplateScheduleSummary[] = changes.flatMap((change) => {
    const command = change.command;
    if (command.kind !== 'template.schedule.create') return [];
    const id = templateResultIds(change.identity).scheduleId;
    if (schedules.some((schedule) => schedule.id === id)) return [];
    return [
      {
        id,
        accountId: account.id,
        template: command.input.template,
        boardId: command.input.boardId,
        timing: command.input.timing,
        useRelativeDates: command.input.useRelativeDates,
        listPrefix: command.input.listPrefix,
        state: account.state === 'connected' ? ('active' as const) : ('paused' as const),
        pauseReason: null,
        revision: 0,
        nextRunAt: null,
        lastClaimedDay: null,
        lastResolvedDay: null,
        catchUpRequired: false,
        activeRunId: null,
      },
    ];
  });
  const visibleSchedules = changes.reduce(
    (items, change) =>
      items.flatMap((item) => {
        if (
          change.confirmed &&
          'scheduleId' in change.command &&
          item.revision > change.command.revision
        )
          return [item];
        const next = previewSchedule(item, change.command);
        return next ? [next] : [];
      }),
    [...schedules, ...createdSchedules],
  );
  return {
    mutate,
    error: validation,
    templates: visibleTemplates,
    schedules: visibleSchedules,
    failures,
    createdTemplates: changes.flatMap((change) => {
      const command = change.command;
      if (command.kind !== 'template.list.create' && command.kind !== 'template.board.create')
        return [];
      const id = templateResultIds(change.identity).templateId;
      return templates.some((item) => item.id === id)
        ? []
        : [
            {
              id,
              kind:
                command.kind === 'template.list.create' ? ('list' as const) : ('board' as const),
              name: command.input.name,
              description: command.input.description,
            },
          ];
    }),
    dismissFailure: (identity: string) =>
      setFailures((current) => current.filter((failure) => failure.identity !== identity)),
  };
}
