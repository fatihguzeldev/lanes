import type { ComponentProps, ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TaskMenu } from '../TaskMenu';
import type { Task } from '../../../contracts/task';

describe('task menu destination lifetime', () => {
  it('keeps task actions mounted while browsing a cascade and closes its presentation with the parent', () => {
    const task = { id: 'task', title: 'read' } as Task;
    const close = vi.fn();
    const closeMove = vi.fn();
    const move = vi.fn();
    const menu = TaskMenu({
      controller: { task, anchor: {} as HTMLElement, close, open: vi.fn() } as ComponentProps<
        typeof TaskMenu
      >['controller'],
      writable: true,
      localWritable: true,
      onToggleStar: async () => true,
      onHistory() {},
      onOpen() {},
      onDuplicate() {},
      onDelete() {},
      onMove: move,
      onMoveClose: closeMove,
    }) as ReactElement<{ onMove(task: Task, anchor: HTMLElement): void; onClose(): void }>;
    const trigger = {} as HTMLElement;
    menu.props.onMove(task, trigger);
    expect(move).toHaveBeenCalledWith(task, trigger);
    expect(close).not.toHaveBeenCalled();
    menu.props.onClose();
    expect(closeMove).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
