import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BoardSchema } from '../../../contracts/board';
import { Icon } from '../../../../../shared/ui/icon/Icon';
import { BoardNavigation, BoardNavigationSkeleton } from '../BoardNavigation';

const board = BoardSchema.parse({
  id: 'board',
  accountId: 'account',
  title: 'reading',
  isMain: false,
  emoji: null,
  color: '#d49765',
  backgroundUrl: null,
  position: 0,
  revision: 1,
  createdAt: '2026-11-06T00:00:00Z',
});
const glyph = renderToStaticMarkup(createElement(Icon, { name: 'board', size: 18 }));
function render(loading: boolean, emoji: string | null = null) {
  return renderToStaticMarkup(
    createElement(BoardNavigation, {
      resource: {
        items: loading ? [] : [{ ...board, emoji }],
        status: loading ? 'loading' : 'ready',
        error: '',
        nextCursor: null,
        async reload() {},
        async loadMore() {},
      },
      selectedBoardId: board.id,
      writable: true,
      onCreate() {},
      onSelect() {},
      onReorder() {},
    }),
  );
}

describe('board navigation loading', () => {
  it('keeps the known board glyph while only its unknown name is a placeholder', () => {
    const html = renderToStaticMarkup(createElement(BoardNavigationSkeleton));
    expect(html).toContain(`<span class="board-navigation__symbol">${glyph}</span>`);
    expect(html).toContain('skeleton board-navigation__placeholder-line');
    expect(html).not.toContain('board-navigation__placeholder-symbol');
    expect(html).toContain('your boards');
  });

  it('uses the same icon while the mounted navigation waits for board names', () => {
    const loading = render(true);
    expect(loading.split(glyph)).toHaveLength(4);
    expect(loading).not.toContain(board.title);
    expect(render(false)).toContain(glyph);
  });

  it('preserves the loaded custom emoji and color without another icon or placeholder', () => {
    const html = render(false, '📚');
    expect(html).toContain('style="--board-color:#d49765">📚</span>');
    expect(html).not.toContain(glyph);
    expect(html).not.toContain('skeleton');
    expect(html).toContain('class="active"');
  });
});
