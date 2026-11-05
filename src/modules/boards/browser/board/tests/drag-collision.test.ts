import { describe, expect, it } from 'vitest';
import { defaultCollisionDetection, type CollisionDetector } from '@dnd-kit/collision';
import { taskCollision } from '../drag-collision';

function input(pointerX: number, activatorEvent: Event | null) {
  return {
    droppable: {
      id: 'list',
      shape: {
        center: { x: 50, y: 50 },
        area: 10_000,
        containsPoint: ({ x, y }: { x: number; y: number }) =>
          x >= 0 && x <= 100 && y >= 0 && y <= 100,
      },
    },
    dragOperation: {
      activatorEvent,
      position: { current: { x: pointerX, y: 25 } },
      shape: { current: { area: 10_000, intersectionArea: () => 5_000 } },
    },
  } as unknown as Parameters<CollisionDetector>[0];
}

describe('board task collision', () => {
  it('rejects pointer drops outside a list even when the lifted card overlaps it', () => {
    const drag = input(120, Object.assign(new Event('pointerdown'), { pointerId: 1 }));
    expect(defaultCollisionDetection(drag)).not.toBeNull();
    expect(taskCollision(drag)).toBeNull();
  });

  it('accepts a pointer inside the drop target', () => {
    const drag = input(25, Object.assign(new Event('pointerdown'), { pointerId: 1 }));
    expect(taskCollision(drag)).toEqual(defaultCollisionDetection(drag));
    expect(taskCollision(drag)?.id).toBe('list');
  });

  it('keeps shape-based collision available for keyboard movement', () => {
    const drag = input(120, new Event('keydown'));
    expect(taskCollision(drag)).toEqual(defaultCollisionDetection(drag));
    expect(taskCollision(drag)?.id).toBe('list');
  });
});
