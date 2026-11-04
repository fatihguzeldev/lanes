import { describe, expect, it } from 'vitest';
import {
  orderForPresentation,
  resolveTaskDrop,
  sameDropPosition,
  taskDropSide,
} from '../drag-model';

const sourceTaskIds = ['a', 'b', 'c'];
const drop = (taskId: string, targetTaskId: string | null, side: 'before' | 'after') =>
  resolveTaskDrop({
    taskId,
    sourceListId: 'source',
    destinationListId: 'source',
    sourceTaskIds,
    destinationTaskIds: sourceTaskIds,
    targetTaskId,
    side,
  });

describe('task drag placement', () => {
  it('treats self drops and every representation of the current gap as no action', () => {
    expect(drop('b', 'b', 'before')).toBeNull();
    expect(drop('b', 'b', 'after')).toBeNull();
    expect(drop('b', 'a', 'after')).toBeNull();
    expect(drop('b', 'c', 'before')).toBeNull();
    expect(drop('a', 'b', 'before')).toBeNull();
    expect(drop('a', null, 'before')).toBeNull();
    expect(drop('c', null, 'after')).toBeNull();
  });

  it('resolves both halves of a row to the correct predecessor in the same list', () => {
    expect(drop('c', 'b', 'before')).toEqual({
      listId: 'source',
      previousTaskId: 'a',
      beforeTaskId: 'b',
    });
    expect(drop('a', 'b', 'after')).toEqual({
      listId: 'source',
      previousTaskId: 'b',
      beforeTaskId: 'c',
    });
    expect(taskDropSide(49, { top: 30, height: 40 })).toBe('before');
    expect(taskDropSide(50, { top: 30, height: 40 })).toBe('after');
  });

  it('allows moves to another list, including an empty destination', () => {
    expect(
      resolveTaskDrop({
        taskId: 'b',
        sourceListId: 'source',
        destinationListId: 'other',
        sourceTaskIds,
        destinationTaskIds: [],
        targetTaskId: null,
        side: 'after',
      }),
    ).toEqual({ listId: 'other', previousTaskId: null, beforeTaskId: null });
    expect(
      resolveTaskDrop({
        taskId: 'b',
        sourceListId: 'source',
        destinationListId: 'other',
        sourceTaskIds,
        destinationTaskIds: ['d', 'e'],
        targetTaskId: 'd',
        side: 'after',
      }),
    ).toEqual({ listId: 'other', previousTaskId: 'd', beforeTaskId: 'e' });
  });

  it('never substitutes a missing, completed or child anchor with the end of the list', () => {
    expect(drop('a', 'not-an-open-root', 'before')).toBeNull();
    expect(
      resolveTaskDrop({
        taskId: 'not-in-source',
        sourceListId: 'source',
        destinationListId: 'other',
        sourceTaskIds,
        destinationTaskIds: [],
        targetTaskId: null,
        side: 'after',
      }),
    ).toBeNull();
  });

  it('keeps identical gaps stable across dragover events', () => {
    const position = drop('a', 'b', 'after');
    expect(sameDropPosition(position, drop('a', 'c', 'before'))).toBe(true);
    expect(sameDropPosition(position, drop('a', 'c', 'after'))).toBe(false);
    expect(sameDropPosition(null, null)).toBe(true);
  });
});

describe('manual presentation order', () => {
  it('uses the queued rank without mutating provider positions or dropping unranked tasks', () => {
    const tasks = [
      { id: 'a', position: '01' },
      { id: 'b', position: '02' },
      { id: 'c', position: '03' },
    ];
    expect(orderForPresentation(tasks, ['b', 'missing', 'b', 'a']).map((task) => task.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(tasks).toEqual([
      { id: 'a', position: '01' },
      { id: 'b', position: '02' },
      { id: 'c', position: '03' },
    ]);
  });
});
