import type { ReactElement } from 'react';
import { Children, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ListOptions } from '../ListOptions';
import { Submenu } from '../../../../../shared/ui/submenu/Submenu';
import type { Board, BoardList } from '../../../contracts/board';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => [value, vi.fn()],
}));

const list = {
  id: 'list',
  accountId: 'account',
  boardId: 'main',
  title: 'todo',
  membershipRevision: 7,
  color: '#f1f0e9',
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
    boardPage: {
      nextCursor: null as string | null,
      status: 'ready' as 'loading' | 'ready' | 'error',
      error: '',
      loadMore: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    },
    lists: [list],
    anchor: {} as HTMLElement,
    loadedListCount: 1,
    writable: true,
    localWritable: true,
    submit: vi.fn(async () => true),
    guard: (action: () => void) => action(),
    onColor: vi.fn(async () => true),
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
  return items.find((item) => item.type === Submenu && item.props.label === 'move to board')!;
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
    const choices = Children.toArray(menu.props.children) as UI[];
    expect(choices).toHaveLength(2);
    expect(choices[0]!.props.disabled).toBe(true);
    expect(choices[1]!.props.disabled).toBe(false);
    expect(destination({ ...props(), list: { ...list, isDefault: true } }).props.disabled).toBe(
      true,
    );
  });

  it('submits a revision-guarded placement and dismisses only when confirmed', async () => {
    const options = props();
    const choices = Children.toArray(destination(options).props.children) as UI[];
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

  it('keeps the existing board paging and retry controls inside the destination menu', () => {
    const options = props();
    options.boardPage.nextCursor = 'next-board-page';
    let choices = Children.toArray(destination(options).props.children) as UI[];
    const more = choices.find((item) => item.props['aria-label'] === 'more boards');
    expect(more).toBeDefined();
    more!.props.onClick();
    expect(options.boardPage.loadMore).toHaveBeenCalledOnce();

    options.boardPage.status = 'loading';
    choices = Children.toArray(destination(options).props.children) as UI[];
    expect(choices.find((item) => item.props['aria-label'] === 'more boards')!.props.disabled).toBe(
      true,
    );

    options.boardPage.status = 'error';
    options.boardPage.error = 'could not read boards';
    choices = Children.toArray(destination(options).props.children) as UI[];
    choices.find((item) => item.props['aria-label'] === 'retry boards')!.props.onClick();
    expect(options.boardPage.reload).toHaveBeenCalledOnce();
  });
});
