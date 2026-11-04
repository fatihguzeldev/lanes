export interface BoardViewPreferences {
  view: 'board' | 'list' | 'calendar' | 'completed';
  showCounts: boolean;
  showCompleted: boolean;
  showNotes: boolean;
}
export const defaultBoardView: BoardViewPreferences = {
  view: 'board',
  showCounts: true,
  showCompleted: true,
  showNotes: true,
};
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function storage(): StorageAccess | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
const key = (accountId: string, boardId?: string) =>
  `lanes.boards:${JSON.stringify([accountId, boardId ?? null])}`;
export function readStartBoard(accountId: string, target = storage()): string | null {
  try {
    const value = target?.getItem(key(accountId));
    return value && value.length <= 1024 ? value : null;
  } catch {
    return null;
  }
}
export function saveStartBoard(
  accountId: string,
  boardId: string | null,
  target = storage(),
): void {
  try {
    if (boardId) target?.setItem(key(accountId), boardId);
    else target?.removeItem(key(accountId));
  } catch {
    /* Browser preferences never prevent navigation. */
  }
}
export function readBoardView(
  accountId: string,
  boardId: string,
  target = storage(),
): BoardViewPreferences {
  try {
    const value: unknown = JSON.parse(target?.getItem(key(accountId, boardId)) ?? 'null');
    if (!value || typeof value !== 'object') return { ...defaultBoardView };
    const record = value as Record<string, unknown>;
    return {
      view: ['board', 'list', 'calendar', 'completed'].includes(String(record.view))
        ? (record.view as BoardViewPreferences['view'])
        : 'board',
      showCounts: typeof record.showCounts === 'boolean' ? record.showCounts : true,
      showCompleted: typeof record.showCompleted === 'boolean' ? record.showCompleted : true,
      showNotes: typeof record.showNotes === 'boolean' ? record.showNotes : true,
    };
  } catch {
    return { ...defaultBoardView };
  }
}
export function saveBoardView(
  accountId: string,
  boardId: string,
  value: BoardViewPreferences,
  target = storage(),
): void {
  try {
    target?.setItem(key(accountId, boardId), JSON.stringify(value));
  } catch {
    /* In-memory preferences remain usable. */
  }
}
