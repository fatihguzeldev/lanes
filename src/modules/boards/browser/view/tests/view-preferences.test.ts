import { describe, expect, it } from 'vitest';
import {
  defaultBoardView,
  readBoardView,
  readStartBoard,
  saveBoardView,
  saveStartBoard,
} from '../view-preferences';
function store() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}
describe('browser board preferences', () => {
  it('keeps account start choices and board views separate, including delimiter-like identities', () => {
    const storage = store();
    saveStartBoard('a', 'b', storage);
    saveStartBoard('a:b', 'c', storage);
    saveBoardView('a', 'b:c', { ...defaultBoardView, view: 'list', showCounts: false }, storage);
    expect(readStartBoard('a', storage)).toBe('b');
    expect(readStartBoard('a:b', storage)).toBe('c');
    expect(readBoardView('a', 'b:c', storage)).toMatchObject({ view: 'list', showCounts: false });
    expect(readBoardView('a:b', 'c', storage)).toEqual(defaultBoardView);
    saveStartBoard('a', null, storage);
    expect(readStartBoard('a', storage)).toBeNull();
    expect(readBoardView('a', 'b:c', storage).view).toBe('list');
  });
  it('falls back for corrupt or unavailable browser storage without breaking the workspace', () => {
    const storage = store();
    storage.setItem('lanes.boards:["a","b"]', '{bad');
    expect(readBoardView('a', 'b', storage)).toEqual(defaultBoardView);
    storage.setItem(
      'lanes.boards:["a","b"]',
      '{"view":"unexpected","showCounts":false,"showNotes":"false"}',
    );
    expect(readBoardView('a', 'b', storage)).toMatchObject({
      view: 'board',
      showCounts: false,
      showNotes: true,
    });
    const denied = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(readStartBoard('a', denied)).toBeNull();
    expect(() => saveBoardView('a', 'b', defaultBoardView, denied)).not.toThrow();
  });
});
