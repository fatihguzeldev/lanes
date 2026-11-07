import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Board, BoardList, BoardPatch } from '../../contracts/board';
import { captureBoardChange, captureListColor } from './appearance-change';

type Change =
  | { kind: 'board'; source: Board; patch: BoardPatch }
  | { kind: 'list'; source: BoardList; color: string };
type Attempt = Change & { confirmed: boolean };

export function useBoardAppearance(options: {
  accountId: string;
  board: Board | null;
  boards: readonly Board[];
  lists: readonly BoardList[];
  submit(command: unknown, category: 'local'): Promise<boolean>;
  onNotice(message: string): void;
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const locked = useRef(false);
  const saving = useRef(false);
  useEffect(() => {
    if (!attempt?.confirmed) return;
    const source =
      attempt.kind === 'board'
        ? options.board?.id === attempt.source.id
          ? options.board
          : options.boards.find((board) => board.id === attempt.source.id)
        : options.lists.find((list) => list.id === attempt.source.id);
    const revision =
      source && ('membershipRevision' in source ? source.membershipRevision : source.revision);
    const previous =
      attempt.kind === 'board' ? attempt.source.revision : attempt.source.membershipRevision;
    if (!source || revision! > previous) {
      locked.current = false;
      setAttempt(null);
    }
  }, [attempt, options.board, options.boards, options.lists]);

  async function save(next: Change, command: unknown) {
    if (locked.current || next.source.accountId !== options.accountId) return false;
    locked.current = true;
    saving.current = true;
    setAttempt({ ...next, confirmed: false });
    try {
      if (await options.submit(command, 'local')) {
        setAttempt((current) => (current ? { ...current, confirmed: true } : null));
        return true;
      }
    } catch (error) {
      options.onNotice(error instanceof Error ? error.message : 'couldn’t save this change.');
    } finally {
      saving.current = false;
    }
    locked.current = false;
    setAttempt(null);
    return false;
  }

  return {
    pending: attempt !== null,
    isSaving: () => saving.current,
    board(value: Board | null): Board | null {
      if (
        !value ||
        attempt?.kind !== 'board' ||
        value.id !== attempt.source.id ||
        value.accountId !== attempt.source.accountId
      )
        return value;
      return {
        ...value,
        title: attempt.patch.title ?? value.title,
        color: attempt.patch.color ?? value.color,
        emoji: attempt.patch.emoji === undefined ? value.emoji : attempt.patch.emoji,
        backgroundUrl:
          attempt.patch.backgroundUrl === undefined
            ? value.backgroundUrl
            : attempt.patch.backgroundUrl,
      };
    },
    list(value: BoardList): BoardList {
      return attempt?.kind === 'list' &&
        value.id === attempt.source.id &&
        value.accountId === attempt.source.accountId
        ? { ...value, color: attempt.color }
        : value;
    },
    async updateBoard(board: Board, input: BoardPatch) {
      try {
        const command = captureBoardChange(board, input);
        return (
          !command || (await save({ kind: 'board', source: board, patch: command.input }, command))
        );
      } catch (error) {
        options.onNotice(
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'check this appearance.')
            : 'check this appearance.',
        );
        return false;
      }
    },
    async updateListColor(list: BoardList, color: string) {
      try {
        const command = captureListColor(list, color);
        return (
          !command || (await save({ kind: 'list', source: list, color: command.color }, command))
        );
      } catch {
        options.onNotice('choose a hexadecimal color.');
        return false;
      }
    },
  };
}
