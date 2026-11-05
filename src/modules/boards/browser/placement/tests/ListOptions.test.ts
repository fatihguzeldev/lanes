import type { ReactElement } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ListOptions } from '../ListOptions';
import { Submenu } from '../../../../../shared/ui/submenu/Submenu';
import type { Board, BoardList } from '../../../contracts/board';

const list = {
  id: 'list',
  accountId: 'account',
  boardId: 'main',
  title: 'todo',
  membershipRevision: 7,
} as BoardList;
const boards = [
  { id: 'main', accountId: 'account', title: 'main' },
  { id: 'work', accountId: 'account', title: 'work' },
  { id: 'foreign', accountId: 'other', title: 'other account' },
] as Board[];
function props() {
  return {
    list,
    boards,
    lists: [list],
    anchor: {} as HTMLElement,
    loadedListCount: 1,
    writable: true,
    localWritable: true,
    submit: vi.fn(async () => true),
    guard: (action: () => void) => action(),
    onPrompt: vi.fn(),
    onClose: vi.fn(),
    onDuplicate: vi.fn(),
    onDeleteCompleted: vi.fn(),
    onDelete: vi.fn(async () => {}),
  };
}
type UI = ReactElement<Record<string, any>>;
function destination(options: ReturnType<typeof props>) {
  const root = ListOptions(options) as UI;
  const items = (root.props.children as UI).props.children as UI[];
  return items.find((item) => item.type === Submenu)!;
}

describe('list destination submenu', () => {
  it('shows a collapsed action instead of an always-visible destination select', () => {
    const html = renderToStaticMarkup(createElement(ListOptions, props()));
    expect(html).toContain('aria-label="move to board"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('other account');
  });

  it('preserves account scope and skips the current board', () => {
    const menu = destination(props());
    const choices = menu.props.children as UI[];
    expect(choices).toHaveLength(2);
    expect(choices[0]!.props.disabled).toBe(true);
    expect(choices[1]!.props.disabled).toBe(false);
    expect(destination({ ...props(), list: { ...list, isDefault: true } }).props.disabled).toBe(
      true,
    );
  });

  it('submits a revision-guarded placement and dismisses only when confirmed', async () => {
    const options = props();
    const choices = destination(options).props.children as UI[];
    choices[1]!.props.onClick();
    expect(options.submit).toHaveBeenCalledWith({
      kind: 'list.placement',
      listId: 'list',
      boardId: 'work',
      revision: 7,
    });
    await Promise.resolve();
    expect(options.onClose).toHaveBeenCalledOnce();
    options.submit.mockResolvedValue(false);
    options.onClose.mockClear();
    choices[1]!.props.onClick();
    await Promise.resolve();
    expect(options.onClose).not.toHaveBeenCalled();
  });
});
