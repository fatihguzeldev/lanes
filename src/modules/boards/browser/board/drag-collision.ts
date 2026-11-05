import {
  defaultCollisionDetection,
  pointerIntersection,
  type CollisionDetector,
} from '@dnd-kit/collision';

export const taskCollision: CollisionDetector = (input) => {
  const event = input.dragOperation.activatorEvent;
  return event && 'pointerId' in event
    ? pointerIntersection(input)
    : defaultCollisionDetection(input);
};
