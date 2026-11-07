import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Icon } from '../Icon';

describe('type icons', () => {
  it('keeps board and list outlines readable in headings and compact destinations', () => {
    for (const name of ['board', 'list'] as const) {
      for (const size of [16, 18]) {
        const html = renderToStaticMarkup(createElement(Icon, { name, size }));
        expect(html).toContain(`width="${size}" height="${size}"`);
        expect(html).toContain('stroke-width="2"');
      }
    }
  });
});
