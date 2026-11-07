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
import { BoardCommandSchema } from '../../contracts/commands';
import { ProviderCommandSchema } from '../../../tasks/contracts/provider-commands';

type Change =
  | { kind: 'board'; source: Board; patch: BoardPatch }
  | { kind: 'list-color'; source: BoardList; color: string }
  | { kind: 'list-title'; source: BoardList; title: string }
  | { kind: 'board-order'; source: Board; position: number }
  | { kind: 'list-placement'; source: BoardList; boardId: string; position?: number };
type Attempt = Change & { id: number; confirmed: boolean };
const isBoard = (change: Change) => change.kind === 'board' || change.kind === 'board-order';
const isMembership = (change: Change) =>
  change.kind === 'list-color' || change.kind === 'list-placement';
const key = (change: Change) => `${isBoard(change) ? 'board' : 'list'}:${change.source.id}`;
const revision = (change: Change) =>
  'membershipRevision' in change.source && isMembership(change)
    ? change.source.membershipRevision
    : change.source.revision;
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
        (attempt.kind === 'board' || attempt.kind === 'board-order') &&
        value.id === attempt.source.id &&
        value.accountId === attempt.source.accountId &&
        (!attempt.confirmed || value.revision <= attempt.source.revision)
          ? attempt.kind === 'board'
            ? patchBoard(shown, attempt.patch)
            : { ...shown, position: attempt.position }
          : shown,
      value,
    );
  }
  function list(value: BoardList): BoardList {
    return current.current.reduce(
      (shown, attempt) =>
        (attempt.kind === 'list-color' ||
          attempt.kind === 'list-title' ||
          attempt.kind === 'list-placement') &&
        value.id === attempt.source.id &&
        value.accountId === attempt.source.accountId &&
        (!attempt.confirmed ||
          (isMembership(attempt) ? value.membershipRevision : value.revision) <= revision(attempt))
          ? {
              ...shown,
              ...(attempt.kind === 'list-color'
                ? { color: attempt.color }
                : attempt.kind === 'list-title'
                  ? { title: attempt.title }
                  : {
                      boardId: attempt.boardId,
                      ...(attempt.position === undefined ? {} : { position: attempt.position }),
                    }),
            }
          : shown,
      value,
    );
  }
  useEffect(() => {
    const items = current.current.filter((attempt) => {
      if (!attempt.confirmed) return true;
      const source = isBoard(attempt)
        ? options.board?.id === attempt.source.id
          ? options.board
          : options.boards.find((item) => item.id === attempt.source.id)
        : options.lists.find((item) => item.id === attempt.source.id);
      if (!source) return true;
      const read =
        isMembership(attempt) && 'membershipRevision' in source
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
        const latest = isBoard(attempt)
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
          if (
            settled.current.has(key(attempt)) ||
            (isBoard(attempt) && settled.current.has('board-order')) ||
            (isMembership(attempt) && settled.current.has('list-placement'))
          ) {
            const controller = new AbortController();
            readFlight.current = controller;
            const base = `/api/accounts/${encodeURIComponent(options.accountId)}`;
            if (isBoard(attempt))
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
          if (attempt.kind === 'board') {
            const baseline = attempt.source;
            const currentBoard = source as Board;
            if (
              Object.keys(attempt.patch).some(
                (field) => currentBoard[field as keyof Board] !== baseline[field as keyof Board],
              )
            )
              throw new Error(
                'this board changed elsewhere. review it before applying these fields.',
              );
          } else if (attempt.kind === 'list-title' && source.title !== attempt.source.title)
            throw new Error(
              'this list name changed elsewhere. review it before applying this name.',
            );
          else if (
            attempt.kind === 'list-color' &&
            'color' in source &&
            source.color !== attempt.source.color
          )
            throw new Error(
              'this list color changed elsewhere. review it before applying this color.',
            );
          rebased = { ...attempt, source } as Attempt;
          const command =
            rebased.kind === 'board'
              ? captureBoardChange(rebased.source, rebased.patch)
              : rebased.kind === 'board-order'
                ? BoardCommandSchema.parse({
                    kind: 'board.reorder',
                    boardId: rebased.source.id,
                    revision: rebased.source.revision,
                    position: rebased.position,
                  })
                : rebased.kind === 'list-placement'
                  ? BoardCommandSchema.parse({
                      kind: 'list.placement',
                      listId: rebased.source.id,
                      revision: rebased.source.membershipRevision,
                      boardId: rebased.boardId,
                      ...(rebased.position === undefined ? {} : { position: rebased.position }),
                    })
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
          if (rebased.kind === 'board-order' || rebased.kind === 'list-placement')
            settled.current.add(rebased.kind);
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
    pending: attempts.some((attempt) => !attempt.confirmed),
    pendingForBoard(boardId: string) {
      return current.current.some(
        (attempt) =>
          !attempt.confirmed &&
          (isBoard(attempt)
            ? attempt.source.id === boardId
            : 'boardId' in attempt.source &&
              (attempt.source.boardId === boardId ||
                (attempt.kind === 'list-placement' && attempt.boardId === boardId))),
      );
    },
    orderedBoards(values: readonly Board[]) {
      let shown = values.map((item) => board(item)!);
      for (const attempt of current.current) {
        if (attempt.kind !== 'board-order') continue;
        const value = values.find((item) => item.id === attempt.source.id);
        if (!value || (attempt.confirmed && value.revision > attempt.source.revision)) continue;
        const index = shown.findIndex((item) => item.id === value.id);
        const [moved] = shown.splice(index, 1);
        shown.splice(Math.min(attempt.position, shown.length), 0, moved!);
      }
      return shown.map((item, position) => ({ ...item, position }));
    },
    orderedLists(values: readonly BoardList[], boardId = options.board?.id) {
      const known = new Map(values.map((item) => [item.id, item]));
      for (const attempt of current.current)
        if (
          attempt.kind === 'list-placement' &&
          attempt.boardId === boardId &&
          !known.has(attempt.source.id)
        )
          known.set(attempt.source.id, attempt.source);
      let shown = [...known.values()]
        .map(list)
        .filter((item) => !boardId || item.boardId === boardId);
      for (const attempt of current.current) {
        if (attempt.kind !== 'list-placement' || attempt.boardId !== boardId) continue;
        const value = known.get(attempt.source.id);
        if (
          !value ||
          (attempt.confirmed && value.membershipRevision > attempt.source.membershipRevision)
        )
          continue;
        const index = shown.findIndex((item) => item.id === value.id);
        if (index < 0) continue;
        const [moved] = shown.splice(index, 1);
        shown.splice(Math.min(attempt.position ?? shown.length, shown.length), 0, moved!);
      }
      return shown.map((item, position) => ({ ...item, position }));
    },
    reorderBoard(source: Board, position: number) {
      if (!Number.isSafeInteger(position) || position < 0) return false;
      return capture({ kind: 'board-order', source, position });
    },
    placeList(source: BoardList, boardId: string, position?: number) {
      if (!boardId || (position !== undefined && (!Number.isSafeInteger(position) || position < 0)))
        return false;
      if (list(source).boardId === boardId && position === undefined) return true;
      return capture({
        kind: 'list-placement',
        source,
        boardId,
        ...(position === undefined ? {} : { position }),
      });
    },
    isSaving: () => saving.current || queue.current.length > 0,
    board,
    list,
    async updateBoard(source: Board, input: BoardPatch) {
      try {
        const command = captureBoardChange(board(source)!, input);
        return !command || capture({ kind: 'board', source: board(source)!, patch: command.input });
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
        return (
          !command || capture({ kind: 'list-color', source: list(source), color: command.color })
        );
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
          capture({ kind: 'list-title', source: list(source), title: command.title })
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
