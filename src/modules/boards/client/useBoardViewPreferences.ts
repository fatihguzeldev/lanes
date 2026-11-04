import { useState } from 'react';
import {
  defaultBoardView,
  readBoardView,
  saveBoardView,
  type BoardViewPreferences,
} from './view-preferences';

export function useBoardViewPreferences(accountId: string, boardId: string | null) {
  const [storedView, setStoredView] = useState<{
    boardId: string;
    value: BoardViewPreferences;
  } | null>(null);
  const preferences = boardId
    ? storedView?.boardId === boardId
      ? storedView.value
      : readBoardView(accountId, boardId)
    : defaultBoardView;
  return {
    preferences,
    update(patch: Partial<BoardViewPreferences>) {
      if (!boardId) return;
      const next = { ...preferences, ...patch };
      setStoredView({ boardId, value: next });
      saveBoardView(accountId, boardId, next);
    },
  };
}
