import { useState } from 'react';
import {
  defaultBoardView,
  readBoardView,
  saveBoardView,
  type BoardViewPreferences,
} from './view-preferences';

export function useBoardViewPreferences(accountId: string, boardId: string | null) {
  const key = JSON.stringify([accountId, boardId]);
  const [storedView, setStoredView] = useState<{
    key: string;
    value: BoardViewPreferences;
  } | null>(null);
  const [completedFor, setCompletedFor] = useState<string | null>(null);
  const layout = boardId
    ? storedView?.key === key
      ? storedView.value
      : readBoardView(accountId, boardId)
    : defaultBoardView;
  return {
    preferences: completedFor === key ? { ...layout, view: 'completed' as const } : layout,
    returnToBoard() {
      setCompletedFor(null);
    },
    update(patch: Partial<BoardViewPreferences>) {
      if (!boardId) return;
      const { view, ...appearance } = patch;
      if (view === 'completed') setCompletedFor(key);
      else if (view) setCompletedFor(null);
      if (view === 'completed' && !Object.keys(appearance).length) return;
      const next = {
        ...layout,
        ...appearance,
        ...(view && view !== 'completed' ? { view } : {}),
      };
      setStoredView({ key, value: next });
      saveBoardView(accountId, boardId, next);
    },
  };
}
