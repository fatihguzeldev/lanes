import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoardViewPreferences } from '../useBoardViewPreferences';
import { defaultBoardView, readBoardView, saveBoardView } from '../view-preferences';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock('react', () => ({
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = next;
      },
    ];
  },
}));
function render(boardId = 'board') {
  hooks.index = 0;
  return useBoardViewPreferences('account', boardId);
}
beforeEach(() => {
  hooks.index = 0;
  hooks.slots = [];
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  saveBoardView('account', 'board', { ...defaultBoardView, view: 'list' });
});
afterEach(() => vi.unstubAllGlobals());

describe('completed review navigation', () => {
  it('returns to the previous board layout without persisting the review screen', () => {
    render().update({ view: 'completed' });
    expect(render().preferences.view).toBe('completed');
    expect(readBoardView('account', 'board').view).toBe('list');
    render().returnToBoard();
    expect(render().preferences.view).toBe('list');
  });
  it('retains appearance edits during review without replacing the saved layout', () => {
    render().update({ view: 'completed' });
    render().update({ showNotes: false });
    expect(render().preferences).toMatchObject({ view: 'completed', showNotes: false });
    render().returnToBoard();
    expect(render().preferences).toMatchObject({ view: 'list', showNotes: false });
  });
  it('does not trap a reload in completed review', () => {
    render().update({ view: 'completed' });
    hooks.slots = [];
    expect(render().preferences.view).toBe('list');
  });
  it('keeps each board layout when the sidebar leaves review', () => {
    saveBoardView('account', 'other', { ...defaultBoardView, view: 'calendar' });
    render().update({ view: 'completed' });
    render().returnToBoard();
    expect(render('other').preferences.view).toBe('calendar');
    expect(render().preferences.view).toBe('list');
  });
});
