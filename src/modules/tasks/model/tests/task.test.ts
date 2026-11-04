import { describe, expect, it } from 'vitest';
import {
  CreateTaskSchema,
  LabelInputSchema,
  TaskPatchSchema,
  TaskSchema,
  type Task,
  type TaskCapabilities,
} from '../../contracts/task';
import {
  applyTaskPatch,
  countOpenTasks,
  getBlockingState,
  normalizeLabelName,
  selectTasksWithContext,
  sortTasks,
  validateDependencyGraph,
  validateHierarchy,
  validateLabelUniqueness,
} from '../task';

const capabilities: TaskCapabilities = {
  canEdit: true,
  canEditNotes: true,
  canMove: true,
  canDelete: true,
  canHaveChildren: true,
  canNest: true,
  assignmentSource: null,
  sourceUrl: null,
  restriction: null,
};
function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    accountId: 'account-a',
    listId: 'list-a',
    parentId: null,
    title: id,
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
    revision: 1,
    provider: {
      id: `google-${id}`,
      listId: 'google-list-a',
      etag: 'v1',
      position: id,
      updatedAt: '2026-11-02T12:00:00Z',
    },
    capabilities: { ...capabilities },
    unsupportedHierarchy: false,
    ...overrides,
  };
}
const daily = {
  frequency: 'daily' as const,
  interval: 1,
  anchorDay: '2026-11-02',
  zone: 'Europe/Istanbul',
  weekStart: 1 as const,
  weekdays: [],
  end: { type: 'never' as const },
};

it('treats retained missing blockers as unknown even when their cached completion says done', () => {
  const blocker = task('blocker', { completed: true });
  blocker.provider.missing = true;
  expect(getBlockingState(task('dependent', { blockedBy: ['blocker'] }), [blocker]).state).toBe(
    'unknown',
  );
});

describe('task input contracts', () => {
  it('trims outside title whitespace while preserving notes and unicode', () => {
    const result = CreateTaskSchema.parse({
      accountId: 'account-a',
      listId: 'list-a',
      title: '  birkaç düşünce 🌱  ',
      notes: 'first line\n  second line\n',
    });
    expect(result.title).toBe('birkaç düşünce 🌱');
    expect(result.notes).toBe('first line\n  second line\n');
    expect(result).toMatchObject({
      parentId: null,
      priority: 'none',
      starred: false,
      labelIds: [],
      blockedBy: [],
    });
  });
  it('counts title and note limits as unicode code points', () => {
    expect(
      CreateTaskSchema.safeParse({
        accountId: 'a',
        listId: 'l',
        title: '🌱'.repeat(1_024),
        notes: 'é'.repeat(8_192),
      }).success,
    ).toBe(true);
    expect(
      CreateTaskSchema.safeParse({ accountId: 'a', listId: 'l', title: '🌱'.repeat(1_025) })
        .success,
    ).toBe(false);
    expect(
      CreateTaskSchema.safeParse({
        accountId: 'a',
        listId: 'l',
        title: 'title',
        notes: 'x'.repeat(8_193),
      }).success,
    ).toBe(false);
  });
  it('rejects blank creation titles but accepts an external empty title in a retained task', () => {
    expect(CreateTaskSchema.safeParse({ accountId: 'a', listId: 'l', title: ' \n ' }).success).toBe(
      false,
    );
    expect(TaskSchema.safeParse(task('external', { title: '' })).success).toBe(true);
  });
  it('rejects unknown patch fields and an empty patch', () => {
    expect(TaskPatchSchema.safeParse({ provider: { etag: 'forged' } }).success).toBe(false);
    expect(TaskPatchSchema.safeParse({}).success).toBe(false);
  });
  it('does not add defaults to a patch', () => {
    expect(TaskPatchSchema.parse({ starred: true })).toEqual({ starred: true });
  });
  it('requires a scheduled day for a newly created time or repeat rule', () => {
    expect(
      CreateTaskSchema.safeParse({
        accountId: 'a',
        listId: 'l',
        title: 'title',
        scheduledTime: '09:30',
        timeZone: 'Europe/Istanbul',
      }).success,
    ).toBe(false);
    expect(
      CreateTaskSchema.safeParse({ accountId: 'a', listId: 'l', title: 'title', repeatRule: daily })
        .success,
    ).toBe(false);
  });
  it('forbids independent repeat rules on nested subtasks', () => {
    expect(
      CreateTaskSchema.safeParse({
        accountId: 'a',
        listId: 'l',
        parentId: 'p',
        title: 'child',
        scheduledDay: '2026-11-02',
        repeatRule: daily,
      }).success,
    ).toBe(false);
  });
  it('limits labels and blockers without silently deduplicating submitted ids', () => {
    expect(
      TaskPatchSchema.safeParse({ labelIds: Array.from({ length: 21 }, (_, i) => String(i)) })
        .success,
    ).toBe(false);
    expect(
      TaskPatchSchema.safeParse({ blockedBy: Array.from({ length: 51 }, (_, i) => String(i)) })
        .success,
    ).toBe(false);
    expect(TaskPatchSchema.safeParse({ labelIds: ['same', 'same'] }).success).toBe(false);
  });
});

describe('narrow task patches', () => {
  it('changes only submitted fields and preserves provider identity and unrelated metadata', () => {
    const before = task('a', {
      notes: 'keep\nthis',
      starred: true,
      priority: 'high',
      labelIds: ['label'],
    });
    const after = applyTaskPatch(before, { title: '  new title  ' });
    expect(after).toEqual({ ...before, title: 'new title' });
    expect(before.title).toBe('a');
  });
  it('distinguishes explicit clearing from omitted fields', () => {
    const before = task('a', {
      notes: 'note',
      scheduledDay: '2026-11-02',
      scheduledTime: '09:30',
      timeZone: 'Europe/Istanbul',
      repeatRule: daily,
    });
    expect(applyTaskPatch(before, { notes: '' })).toMatchObject({
      notes: '',
      scheduledDay: '2026-11-02',
      scheduledTime: '09:30',
      repeatRule: daily,
    });
    expect(applyTaskPatch(before, { scheduledDay: null })).toMatchObject({
      notes: 'note',
      scheduledDay: null,
      scheduledTime: null,
      timeZone: null,
      repeatRule: null,
    });
  });
  it('validates schedule changes against the retained day rather than requiring a full replacement', () => {
    const before = task('a', { scheduledDay: '2026-11-02' });
    expect(
      applyTaskPatch(before, { scheduledTime: '09:30', timeZone: 'Europe/Istanbul' }).scheduledDay,
    ).toBe('2026-11-02');
    expect(() =>
      applyTaskPatch(task('a'), { scheduledTime: '09:30', timeZone: 'Europe/Istanbul' }),
    ).toThrow();
  });
  it('keeps assigned notes read-only while allowing lanes metadata', () => {
    const assigned = task('assigned', {
      capabilities: {
        ...capabilities,
        canEditNotes: false,
        assignmentSource: 'docs',
        sourceUrl: 'https://docs.google.com/document/d/example/edit',
      },
    });
    expect(() => applyTaskPatch(assigned, { notes: 'overwrite' })).toThrow();
    expect(applyTaskPatch(assigned, { priority: 'high' }).priority).toBe('high');
  });
  it('rejects unsupported movement and nesting instead of silently reparenting', () => {
    expect(() =>
      applyTaskPatch(task('a', { capabilities: { ...capabilities, canMove: false } }), {
        listId: 'another',
      }),
    ).toThrow();
    expect(() =>
      applyTaskPatch(task('a', { capabilities: { ...capabilities, canNest: false } }), {
        parentId: 'p',
      }),
    ).toThrow();
  });
  it('rejects a contradictory clear-day patch', () => {
    expect(TaskPatchSchema.safeParse({ scheduledDay: null, scheduledTime: '09:00' }).success).toBe(
      false,
    );
  });
  it('refuses nesting an active repeating occurrence without stopping its rule', () => {
    const before = task('a', { scheduledDay: '2026-11-02', repeatRule: daily });
    expect(() => applyTaskPatch(before, { parentId: 'parent' })).toThrow();
    expect(applyTaskPatch(before, { parentId: 'parent', repeatRule: null }).parentId).toBe(
      'parent',
    );
  });
});

describe('labels', () => {
  it('preserves spelling while checking account-scoped case-insensitive uniqueness', () => {
    const input = LabelInputSchema.parse({ name: '  Études  ', color: '#aabbcc' });
    expect(input.name).toBe('Études');
    expect(normalizeLabelName(input.name)).toBe('études');
    const labels = [{ id: 'one', accountId: 'a', name: 'Études', color: '#aabbcc', revision: 1 }];
    expect(validateLabelUniqueness(labels, { accountId: 'a', name: 'ÉTUDES' })).toBe(false);
    expect(validateLabelUniqueness(labels, { accountId: 'b', name: 'ÉTUDES' })).toBe(true);
    expect(validateLabelUniqueness(labels, { accountId: 'a', name: 'ÉTUDES', id: 'one' })).toBe(
      true,
    );
  });
});

describe('hierarchy validation', () => {
  it('accepts one visible level within an account and list', () => {
    expect(validateHierarchy([task('p'), task('c', { parentId: 'p' })])).toEqual([]);
  });
  it('rejects self-parenting, deeper nesting, and cycles', () => {
    expect(validateHierarchy([task('self', { parentId: 'self' })]).map((i) => i.code)).toContain(
      'self_parent',
    );
    const deep = [task('p'), task('c', { parentId: 'p' }), task('g', { parentId: 'c' })];
    expect(validateHierarchy(deep).map((i) => i.code)).toContain('nested_parent');
    expect(
      validateHierarchy([task('a', { parentId: 'b' }), task('b', { parentId: 'a' })]).map(
        (i) => i.code,
      ),
    ).toContain('hierarchy_cycle');
  });
  it('rejects cross-list and cross-account parents without confusing their ids', () => {
    expect(
      validateHierarchy([task('p'), task('c', { parentId: 'p', listId: 'another-list' })]).map(
        (i) => i.code,
      ),
    ).toContain('cross_list_parent');
    expect(
      validateHierarchy([task('p', { accountId: 'b' }), task('c', { parentId: 'p' })]).map(
        (i) => i.code,
      ),
    ).toContain('cross_account_parent');
  });
  it('rejects a missing parent or a parent that cannot have children', () => {
    expect(validateHierarchy([task('c', { parentId: 'missing' })]).map((i) => i.code)).toContain(
      'missing_parent',
    );
    expect(
      validateHierarchy([
        task('p', {
          capabilities: { ...capabilities, canHaveChildren: false, assignmentSource: 'docs' },
        }),
        task('c', { parentId: 'p' }),
      ]).map((i) => i.code),
    ).toContain('children_not_supported');
  });
});

describe('dependency validation and blocking', () => {
  it('rejects cycles even when the proposed final edge is not a self-reference', () => {
    const graph = [
      task('a', { blockedBy: ['b'] }),
      task('b', { blockedBy: ['c'] }),
      task('c', { blockedBy: ['a'] }),
    ];
    expect(validateDependencyGraph(graph).map((i) => i.code)).toContain('dependency_cycle');
  });
  it('rejects cross-account edges and self dependencies', () => {
    expect(validateDependencyGraph([task('a', { blockedBy: ['a'] })]).map((i) => i.code)).toContain(
      'self_dependency',
    );
    expect(
      validateDependencyGraph([
        task('a', { blockedBy: ['b'] }),
        task('b', { accountId: 'another' }),
      ]).map((i) => i.code),
    ).toContain('cross_account_dependency');
  });
  it('enforces the edge bound and reports missing references without treating them as deletions', () => {
    const tasks = [
      task('a', { blockedBy: Array.from({ length: 51 }, (_, index) => 'blocker-' + index) }),
    ];
    const issues = validateDependencyGraph(tasks);
    expect(issues.map((issue) => issue.code)).toContain('too_many_dependencies');
    expect(issues.filter((issue) => issue.code === 'missing_dependency')).toHaveLength(51);
  });
  it('validates long proposed graphs without recursive stack exhaustion', () => {
    const graph = Array.from({ length: 5_000 }, (_, index) =>
      task(String(index), { blockedBy: index ? [String(index - 1)] : [] }),
    );
    expect(validateDependencyGraph(graph)).toEqual([]);
  });
  it('counts only open blockers and treats a missing blocker as unknown, never unblocked', () => {
    const dependent = task('a', { blockedBy: ['b'] });
    expect(getBlockingState(dependent, [dependent, task('b')]).state).toBe('blocked');
    expect(getBlockingState(dependent, [dependent, task('b', { completed: true })]).state).toBe(
      'unblocked',
    );
    expect(getBlockingState(dependent, [dependent])).toMatchObject({
      state: 'unknown',
      missingBlockerIds: ['b'],
    });
  });
});

describe('task selection', () => {
  it('combines filter types with and and values within a type with or', () => {
    const tasks = [
      task('a', { labelIds: ['one'], priority: 'high', starred: true }),
      task('b', { labelIds: ['two'], priority: 'low', starred: true }),
      task('c', { labelIds: ['one'], priority: 'high' }),
    ];
    const result = selectTasksWithContext(tasks, {
      accountId: 'account-a',
      today: '2026-11-02',
      filter: { labelIds: ['one', 'two'], priorities: ['high', 'medium'], starred: true },
    });
    expect(result.matchedTaskIds).toEqual(['a']);
  });
  it('supports match-all labels explicitly', () => {
    const result = selectTasksWithContext(
      [task('a', { labelIds: ['one', 'two'] }), task('b', { labelIds: ['one'] })],
      {
        accountId: 'account-a',
        today: '2026-11-02',
        filter: { labelIds: ['one', 'two'], labelMatch: 'all' },
      },
    );
    expect(result.matchedTaskIds).toEqual(['a']);
  });
  it('finds matching subtasks by their own day while keeping parent context', () => {
    const result = selectTasksWithContext(
      [task('p'), task('c', { parentId: 'p', scheduledDay: '2026-11-02' })],
      { accountId: 'account-a', today: '2026-11-02', filter: { scheduled: { kind: 'today' } } },
    );
    expect(result.matchedTaskIds).toEqual(['c']);
    expect(result.contextTaskIds).toEqual(['p']);
    expect(result.tasks.map((t) => t.id)).toEqual(['p', 'c']);
  });
  it('keeps a completed parent as context for its open matching child', () => {
    const result = selectTasksWithContext(
      [task('p', { completed: true }), task('c', { parentId: 'p' })],
      { accountId: 'account-a', today: '2026-11-02' },
    );
    expect(result.matchedTaskIds).toEqual(['c']);
    expect(result.contextTaskIds).toEqual(['p']);
    expect(result.tasks.map((task) => task.id)).toEqual(['p', 'c']);
  });
  it('searches notes, label names, list titles, and parent titles without merging accounts', () => {
    const tasks = [
      task('p', { title: 'ÉTUDES' }),
      task('c', { parentId: 'p' }),
      task('foreign', { accountId: 'other', title: 'études' }),
    ];
    expect(
      selectTasksWithContext(tasks, {
        accountId: 'account-a',
        today: '2026-11-02',
        query: 'études',
      }).matchedTaskIds,
    ).toEqual(['p', 'c']);
    expect(
      selectTasksWithContext([task('a', { notes: 'remember DDIA' })], {
        accountId: 'account-a',
        today: '2026-11-02',
        query: 'ddia',
      }).matchedTaskIds,
    ).toEqual(['a']);
    expect(
      selectTasksWithContext([task('a', { labelIds: ['l'] })], {
        accountId: 'account-a',
        today: '2026-11-02',
        query: 'reading',
        labels: [
          { id: 'l', accountId: 'account-a', name: 'Reading', color: '#aabbcc', revision: 1 },
        ],
      }).matchedTaskIds,
    ).toEqual(['a']);
    expect(
      selectTasksWithContext([task('a')], {
        accountId: 'account-a',
        today: '2026-11-02',
        query: 'books',
        lists: [
          {
            id: 'list-a',
            accountId: 'account-a',
            title: 'Books',
            providerId: 'google-list-a',
            providerEtag: null,
            isDefault: false,
            revision: 1,
          },
        ],
      }).matchedTaskIds,
    ).toEqual(['a']);
  });
  it('uses explicit inclusive date boundaries and leaves earlier-today times out of overdue', () => {
    const tasks = [
      task('old', { scheduledDay: '2026-11-01' }),
      task('today', {
        scheduledDay: '2026-11-02',
        scheduledTime: '00:01',
        timeZone: 'Europe/Istanbul',
      }),
      task('future', { scheduledDay: '2026-11-03' }),
    ];
    expect(
      selectTasksWithContext(tasks, {
        accountId: 'account-a',
        today: '2026-11-02',
        filter: { scheduled: { kind: 'overdue' } },
      }).matchedTaskIds,
    ).toEqual(['old']);
    expect(
      selectTasksWithContext(tasks, {
        accountId: 'account-a',
        today: '2026-11-02',
        filter: { scheduled: { kind: 'range', from: '2026-11-02', to: '2026-11-03' } },
      }).matchedTaskIds,
    ).toEqual(['today', 'future']);
  });
  it('excludes completed tasks by default and includes them only when requested', () => {
    const tasks = [task('open'), task('done', { completed: true })];
    expect(
      selectTasksWithContext(tasks, { accountId: 'account-a', today: '2026-11-02' }).matchedTaskIds,
    ).toEqual(['open']);
    expect(
      selectTasksWithContext(tasks, {
        accountId: 'account-a',
        today: '2026-11-02',
        filter: { completion: 'all' },
      }).matchedTaskIds,
    ).toEqual(['open', 'done']);
  });
});

describe('counts and temporary sorts', () => {
  it('includes open subtasks in the count without counting their parent twice', () => {
    expect(
      countOpenTasks(
        [
          task('p'),
          task('a', { parentId: 'p' }),
          task('b', { parentId: 'p', completed: true }),
          task('foreign', { accountId: 'other' }),
        ],
        'account-a',
      ),
    ).toBe(2);
  });
  it('keeps children attached while sorting roots and restores provider manual order', () => {
    const tasks = [
      task('b', {
        title: 'zebra',
        provider: { id: 'b', listId: 'l', etag: null, position: '001', updatedAt: null },
      }),
      task('c', { parentId: 'b', title: 'child' }),
      task('a', {
        title: 'apple',
        provider: { id: 'a', listId: 'l', etag: null, position: '002', updatedAt: null },
      }),
    ];
    expect(sortTasks(tasks, 'title').map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(sortTasks(tasks, 'manual').map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(tasks.map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });
  it('does not hide an unsupported cyclic provider structure while presenting it', () => {
    const tasks = [
      task('a', { parentId: 'b', unsupportedHierarchy: true }),
      task('b', { parentId: 'a', unsupportedHierarchy: true }),
    ];
    expect(new Set(sortTasks(tasks).map((task) => task.id))).toEqual(new Set(['a', 'b']));
  });
  it('uses manual order and stable identity for temporary-sort ties', () => {
    const one = task('one', {
      priority: 'high',
      provider: { id: 'one', listId: 'l', etag: null, position: '002', updatedAt: null },
    });
    const two = task('two', {
      priority: 'high',
      provider: { id: 'two', listId: 'l', etag: null, position: '001', updatedAt: null },
    });
    expect(sortTasks([one, two, task('none')], 'priority').map((t) => t.id)).toEqual([
      'two',
      'one',
      'none',
    ]);
  });
});
