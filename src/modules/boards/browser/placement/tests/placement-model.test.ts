import { describe, expect, it } from 'vitest';
import { TaskSchema } from '../../../../tasks/contracts/task';
import { BoardListSchema } from '../../../contracts/board';
import {
  captureTaskPlacement,
  placementAttemptRejected,
  type PlacementPreview,
} from '../placement-model';

const task = TaskSchema.parse({
  id: 'task',
  accountId: 'account',
  listId: 'source',
  parentId: null,
  title: 'read',
  notes: '',
  completed: false,
  completedAt: null,
  scheduledDay: null,
  scheduledTime: null,
  timeZone: null,
  repeatRule: null,
  seriesId: null,
  occurrenceId: null,
  labelIds: [],
  priority: 'none',
  starred: false,
  blockedBy: [],
  revision: 7,
  unsupportedHierarchy: false,
  provider: {
    id: 'google-task',
    listId: 'google-source',
    etag: 'etag',
    position: '1',
    updatedAt: null,
  },
  capabilities: {
    canEdit: true,
    canEditNotes: true,
    canMove: true,
    canDelete: true,
    canHaveChildren: true,
    canNest: true,
    assignmentSource: null,
    sourceUrl: null,
    restriction: null,
  },
});
const list = BoardListSchema.parse({
  id: 'destination',
  accountId: 'account',
  title: 'work',
  providerId: 'google-destination',
  providerEtag: null,
  isDefault: false,
  revision: 4,
  boardId: 'board',
  color: '#ffffff',
  position: 0,
  membershipRevision: 1,
});
const preview: PlacementPreview = {
  taskId: task.id,
  revision: task.revision,
  title: task.title,
  subtaskCount: 0,
  openSubtaskCount: 0,
  openBlockerCount: 0,
  openBlockedSubtaskCount: 0,
  unknownBlockerCount: 0,
  assignmentSource: null,
  coverageComplete: true,
};
const parent = { ...task, id: 'parent', listId: list.id, revision: 11 };
const sibling = { ...task, id: 'sibling', listId: list.id, parentId: parent.id, revision: 13 };

describe('task placement capture', () => {
  it('unlocks cancelled work with no confirmed output while retaining uncertain or partial work', () => {
    expect(
      placementAttemptRejected(
        { state: 'cancelled', finished: true, confirmedSteps: 0 },
        undefined,
        true,
      ),
    ).toBe(true);
    expect(
      placementAttemptRejected(
        { state: 'cancelled', finished: true, confirmedSteps: 1 },
        undefined,
        true,
      ),
    ).toBe(false);
    expect(
      placementAttemptRejected(
        { state: 'uncertain', finished: false, confirmedSteps: 0 },
        undefined,
        true,
      ),
    ).toBe(false);
    expect(placementAttemptRejected(null, 'conflict', true)).toBe(false);
  });
  it('keeps explicit parent and previous-sibling revisions for an after placement', () => {
    const attempt = captureTaskPlacement(
      task,
      preview,
      { list, parent, previous: sibling, position: 'after' },
      () => 'same-attempt',
    );
    expect(attempt).toMatchObject({
      identity: 'same-attempt',
      command: {
        kind: 'task.move',
        taskId: 'task',
        revision: 7,
        listId: 'destination',
        listRevision: 4,
        parentId: 'parent',
        parentRevision: 11,
        previousId: 'sibling',
        previousRevision: 13,
        confirmSubtaskCount: 0,
      },
    });
  });
  it('distinguishes first, append, and promotion without inventing a sibling', () => {
    const first = captureTaskPlacement(task, preview, { list, position: 'first' }, () => 'first');
    expect(first.command).toMatchObject({ parentId: null, previousId: null });
    const last = captureTaskPlacement(
      { ...task, parentId: 'old-parent' },
      preview,
      { list, position: 'last' },
      () => 'last',
    );
    expect(last.command).toMatchObject({ parentId: null });
    expect(last.command).not.toHaveProperty('previousId');
  });
  it('rejects cross-account, stale, or incomplete choices before allocating an identity', () => {
    let allocated = 0;
    const identity = () => {
      allocated++;
      return 'unused';
    };
    expect(() =>
      captureTaskPlacement(
        task,
        preview,
        { list: { ...list, accountId: 'other' }, position: 'last' },
        identity,
      ),
    ).toThrow('this account');
    expect(() =>
      captureTaskPlacement(task, { ...preview, revision: 8 }, { list, position: 'last' }, identity),
    ).toThrow('changed');
    expect(() =>
      captureTaskPlacement(
        task,
        { ...preview, coverageComplete: false },
        { list, position: 'last' },
        identity,
      ),
    ).toThrow('source list');
    expect(allocated).toBe(0);
  });
  it('rejects ineligible parents and siblings from another parent or list', () => {
    expect(() =>
      captureTaskPlacement(
        task,
        preview,
        { list, parent: { ...parent, parentId: 'deeper' }, position: 'last' },
        () => 'unused',
      ),
    ).toThrow('top-level parent');
    expect(() =>
      captureTaskPlacement(
        task,
        preview,
        { list, parent, previous: { ...sibling, parentId: null }, position: 'after' },
        () => 'unused',
      ),
    ).toThrow('sibling');
    expect(() =>
      captureTaskPlacement(
        task,
        preview,
        { list, parent, previous: { ...sibling, listId: 'other' }, position: 'after' },
        () => 'unused',
      ),
    ).toThrow('sibling');
  });
  it('keeps parents with children and repeating tasks at the top level', () => {
    expect(() =>
      captureTaskPlacement(
        task,
        { ...preview, subtaskCount: 2 },
        { list, parent, position: 'last' },
        () => 'unused',
      ),
    ).toThrow('top-level parent');
    const repeating = {
      ...task,
      repeatRule: {
        frequency: 'daily' as const,
        interval: 1,
        anchorDay: '2026-11-05',
        zone: 'UTC',
        weekStart: 1 as const,
        weekdays: [],
        end: { type: 'never' as const },
      },
    };
    expect(() =>
      captureTaskPlacement(repeating, preview, { list, parent, position: 'last' }, () => 'unused'),
    ).toThrow('top-level parent');
    const withChildren = captureTaskPlacement(
      task,
      { ...preview, subtaskCount: 2 },
      { list, position: 'last' },
      () => 'tree',
    );
    expect(withChildren.command).toMatchObject({ parentId: null, confirmSubtaskCount: 2 });
  });
});
