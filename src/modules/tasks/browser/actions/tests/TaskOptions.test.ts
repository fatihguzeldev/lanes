import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskOptions } from '../TaskOptions';
import type { Task } from '../../../contracts/task';

const task = {
  id: 'task',
  title: 'read',
  completed: false,
  starred: false,
  revision: 1,
  capabilities: { canMove: true, canDelete: true },
} as Task;
function render(completed = false) {
  return renderToStaticMarkup(
    createElement(TaskOptions, {
      task: { ...task, completed },
      anchor: {} as HTMLElement,
      writable: true,
      localWritable: true,
      onToggleStar: async () => true,
      onClose() {},
      onHistory() {},
      onOpen() {},
      onDuplicate() {},
      onMove() {},
      onDelete() {},
    }),
  );
}
describe('task secondary actions', () => {
  it('leaves completion on the checkbox and keeps editing and movement discoverable', () => {
    const html = render();
    expect(html).toContain('open task');
    expect(html).toContain('move task');
    expect(html).not.toContain('>complete<');
    expect(render(true)).not.toContain('>reopen<');
  });
});
