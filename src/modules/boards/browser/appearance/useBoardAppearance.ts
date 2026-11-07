import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  BoardSchema,
  BoardMembershipSchema,
  type Board,
  type BoardList,
  type BoardPatch,
} from '../../contracts/board';
import { TaskListSchema } from '../../../tasks/contracts/task';
import { request } from '../../../../shared/browser/http/http';
import { captureBoardChange, captureListColor } from './appearance-change';
import { ProviderCommandSchema } from '../../../tasks/contracts/provider-commands';

type Change =
  | { kind: 'board'; source: Board; patch: BoardPatch }
  | { kind: 'list-color'; source: BoardList; color: string }
  | { kind: 'list-title'; source: BoardList; title: string };
type Attempt = Change & { id: number; confirmed: boolean };
const key = (change: Change) => `${change.kind === 'board' ? 'board' : 'list'}:${change.source.id}`;
const revision = (change: Change) =>
  change.kind === 'list-color' ? change.source.membershipRevision : change.source.revision;
function patchBoard(value: Board, patch: BoardPatch): Board {
  return {
    ...value,
    title: patch.title ?? value.title,
    color: patch.color ?? value.color,
    emoji: patch.emoji === undefined ? value.emoji : patch.emoji,
    backgroundUrl: patch.backgroundUrl === undefined ? value.backgroundUrl : patch.backgroundUrl,
  };
}

export function useBoardAppearance(options: {
  accountId: string;
  board: Board | null;
  boards: readonly Board[];
  lists: readonly BoardList[];
  submit(command: unknown, category: 'local' | 'provider'): Promise<boolean>;
  onNotice(message: string): void;
}) {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const current = useRef(attempts);
  const queue = useRef<Attempt[]>([]);
  const saving = useRef(false);
  const alive = useRef(true);
  const sequence = useRef(0);
  const settled = useRef(new Set<string>());
  const readFlight = useRef<AbortController | null>(null);
  const environment = useRef(options);
  environment.current = options;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queue.current = [];
      readFlight.current?.abort();
    };
  }, []);
  const update = (items: Attempt[]) => {
    current.current = items;
    setAttempts(items);
  };
  function board(value: Board | null): Board | null {
    if (!value) return null;
    return current.current.reduce(
      (shown, attempt) =>
        attempt.kind === 'board' &&
        value.id === attempt.source.id &&
        value.accountId === attempt.source.accountId &&
        (!attempt.confirmed || value.revision <= attempt.source.revision)
          ? patchBoard(shown, attempt.patch)
          : shown,
      value,
    );
  }
  function list(value: BoardList): BoardList {
    return current.current.reduce(
      (shown, attempt) =>
        attempt.kind !== 'board' &&
        value.id === attempt.source.id &&
        value.accountId === attempt.source.accountId &&
        (!attempt.confirmed ||
          (attempt.kind === 'list-color' ? value.membershipRevision : value.revision) <=
            revision(attempt))
          ? {
              ...shown,
              ...(attempt.kind === 'list-color'
                ? { color: attempt.color }
                : { title: attempt.title }),
            }
          : shown,
      value,
    );
  }
  useEffect(() => {
    const items = current.current.filter((attempt) => {
      if (!attempt.confirmed) return true;
      const source =
        attempt.kind === 'board'
          ? options.board?.id === attempt.source.id
            ? options.board
            : options.boards.find((item) => item.id === attempt.source.id)
          : options.lists.find((item) => item.id === attempt.source.id);
      if (!source) return true;
      const read =
        attempt.kind === 'list-color' && 'membershipRevision' in source
          ? source.membershipRevision
          : source.revision;
      return read <= revision(attempt);
    });
    if (items.length !== current.current.length) update(items);
  }, [attempts, options.board, options.boards, options.lists]);

  async function drain() {
    if (saving.current) return;
    saving.current = true;
    try {
      while (alive.current && queue.current.length) {
        const attempt = queue.current.shift()!;
        const latest =
          attempt.kind === 'board'
            ? environment.current.board?.id === attempt.source.id
              ? environment.current.board
              : environment.current.boards.find((item) => item.id === attempt.source.id)
            : environment.current.lists.find((item) => item.id === attempt.source.id);
        let source = attempt.source;
        if (latest) {
          if ('membershipRevision' in source && 'membershipRevision' in latest)
            source = {
              ...source,
              ...(latest.revision > source.revision
                ? { title: latest.title, revision: latest.revision }
                : {}),
              ...(latest.membershipRevision > source.membershipRevision
                ? {
                    color: latest.color,
                    membershipRevision: latest.membershipRevision,
                    boardId: latest.boardId,
                    position: latest.position,
                  }
                : {}),
            };
          else if (latest.revision > source.revision) source = latest;
        }
        let rebased = { ...attempt, source } as Attempt;
        let saved = false;
        try {
          // Receipts confirm completion without returning the resource's current revision.
          if (settled.current.has(key(attempt))) {
            const controller = new AbortController();
            readFlight.current = controller;
            const base = `/api/accounts/${encodeURIComponent(options.accountId)}`;
            if (attempt.kind === 'board')
              source = await request(
                `${base}/boards/${encodeURIComponent(source.id)}`,
                BoardSchema,
                { signal: controller.signal },
              );
            else if (attempt.kind === 'list-title')
              source = {
                ...source,
                ...(await request(
                  `${base}/lists/${encodeURIComponent(source.id)}`,
                  TaskListSchema,
                  { signal: controller.signal },
                )),
              } as BoardList;
            else {
              const membership = await request(
                `${base}/lists/${encodeURIComponent(source.id)}/placement`,
                BoardMembershipSchema,
                { signal: controller.signal },
              );
              source = {
                ...source,
                boardId: membership.boardId,
                color: membership.color,
                position: membership.position,
                membershipRevision: membership.revision,
              } as BoardList;
            }
            readFlight.current = null;
          }
          if (!alive.current) break;
          rebased = { ...attempt, source } as Attempt;
          const command =
            rebased.kind === 'board'
              ? captureBoardChange(rebased.source, rebased.patch)
              : rebased.kind === 'list-color'
                ? captureListColor(rebased.source, rebased.color)
                : ProviderCommandSchema.parse({
                    kind: 'list.rename',
                    listId: rebased.source.id,
                    revision: rebased.source.revision,
                    title: rebased.title,
                  });
          saved =
            !command ||
            (await environment.current.submit(
              command,
              rebased.kind === 'list-title' ? 'provider' : 'local',
            ));
        } catch (error) {
          if (alive.current)
            environment.current.onNotice(
              error instanceof Error ? error.message : 'couldn’t save this change.',
            );
        }
        if (!alive.current) break;
        if (saved) {
          settled.current.add(key(rebased));
          update(
            current.current.map((item) =>
              item.id === attempt.id ? { ...rebased, confirmed: true } : item,
            ),
          );
        } else {
          const resource = key(attempt);
          queue.current = queue.current.filter((item) => key(item) !== resource);
          update(current.current.filter((item) => key(item) !== resource || item.confirmed));
        }
      }
    } finally {
      saving.current = false;
    }
  }
  function capture(change: Change) {
    if (!alive.current || change.source.accountId !== options.accountId) return false;
    const attempt = { ...change, id: ++sequence.current, confirmed: false };
    update([...current.current, attempt]);
    queue.current.push(attempt);
    void drain();
    return true;
  }
  return {
    pending: attempts.length > 0,
    isSaving: () => saving.current || queue.current.length > 0,
    board,
    list,
    async updateBoard(source: Board, input: BoardPatch) {
      try {
        const command = captureBoardChange(board(source)!, input);
        return !command || capture({ kind: 'board', source, patch: command.input });
      } catch (error) {
        options.onNotice(
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'check this appearance.')
            : 'check this appearance.',
        );
        return false;
      }
    },
    async updateListColor(source: BoardList, color: string) {
      try {
        const command = captureListColor(list(source), color);
        return !command || capture({ kind: 'list-color', source, color: command.color });
      } catch {
        options.onNotice('choose a hexadecimal color.');
        return false;
      }
    },
    async updateListTitle(source: BoardList, title: string) {
      try {
        const command = ProviderCommandSchema.parse({
          kind: 'list.rename',
          listId: source.id,
          revision: source.revision,
          title,
        });
        if (command.kind !== 'list.rename') return false;
        return (
          command.title === list(source).title ||
          capture({ kind: 'list-title', source, title: command.title })
        );
      } catch (error) {
        options.onNotice(
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'check the list name.')
            : 'check the list name.',
        );
        return false;
      }
    },
  };
}
