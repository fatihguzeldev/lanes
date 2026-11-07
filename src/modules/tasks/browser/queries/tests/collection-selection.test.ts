import { describe, expect, it } from 'vitest';
import { CreateTaskSchema, type Task, type TaskList } from '../../../contracts/task';
import type { PendingTaskChange } from '../../changes/useTaskChanges';
import { collectionCreationMatches, selectCollectionTasks } from '../collection-selection';
const task = {
  ...CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'a task' }),
  id: 'task',
  revision: 1,
  completed: false,
  provider: { position: '1' },
} as Task;
const options = { accountId: 'account', today: '2026-11-07', query: 'work', filter: {} };
const change = (
  patch: PendingTaskChange['input']['patch'],
  selected = task,
): PendingTaskChange => ({
  id: 1,
  task: selected,
  input: {
    accountId: 'account',
    taskId: selected.id,
    listId: selected.listId,
    expectedRevision: 1,
    patch,
  },
  confirmedAfter: null,
});
describe('collection selection during context reads', () => {
  it('retains a server list-name match before the list metadata has loaded', () => {
    const selected = selectCollectionTasks([task], options, [task.id], []);
    expect(selected.tasks).toEqual([task]);
    expect(selected.matchedTaskIds).toEqual([task.id]);
  });
  it('still applies optimistic completion and star filters immediately', () => {
    const completed = { ...task, completed: true };
    expect(
      selectCollectionTasks(
        [completed],
        { ...options, filter: { completion: 'open' } },
        [task.id],
        [change({ completed: true })],
      ).tasks,
    ).toEqual([]);
    expect(
      selectCollectionTasks(
        [{ ...task, starred: false }],
        { ...options, filter: { starred: true } },
        [task.id],
        [change({ starred: false })],
      ).tasks,
    ).toEqual([]);
  });
  it('rechecks text edits instead of restoring their previous server match', () => {
    const edited = { ...task, title: 'different title' };
    expect(
      selectCollectionTasks([edited], options, [task.id], [change({ title: edited.title })]).tasks,
    ).toEqual([]);
    const lists = [{ id: 'list', accountId: 'account', title: 'work' }] as TaskList[];
    expect(
      selectCollectionTasks(
        [edited],
        { ...options, lists },
        [task.id],
        [change({ title: edited.title })],
      ).tasks,
    ).toEqual([edited]);
  });
  it('keeps matching children with their parent until context arrives', () => {
    const child = { ...task, id: 'child', parentId: task.id };
    const result = selectCollectionTasks([task, child], options, [child.id], []);
    expect(result.tasks).toEqual([task, child]);
    expect(result.contextTaskIds).toEqual([task.id]);
    expect(
      selectCollectionTasks(
        [task, child],
        options,
        [child.id],
        [change({ title: 'different parent title' })],
      ).tasks,
    ).toEqual([]);
  });
  it('does not preserve a server text match after movement changes its list context', () => {
    const moved = { ...task, listId: 'another-list' };
    expect(
      selectCollectionTasks([moved], options, [task.id], [], undefined, new Set([task.id])).tasks,
    ).toEqual([]);
  });
  it('drops old server context after a new query no longer returns the match', () => {
    expect(selectCollectionTasks([task], options, [], []).tasks).toEqual([]);
  });
});

describe('pending creation collection filters', () => {
  const creation = {
    id: 1,
    input: CreateTaskSchema.parse({
      accountId: 'account',
      listId: 'list',
      title: 'ring64',
      scheduledDay: '2026-11-07',
      starred: true,
      priority: 'high',
      labelIds: ['label'],
    }),
    confirmedAfter: null,
  };
  it('shows captured input immediately in matching today and starred views', () => {
    expect(
      collectionCreationMatches(creation, {
        ...options,
        query: '',
        filter: { scheduled: { kind: 'today' }, starred: true },
      }),
    ).toBe(true);
    expect(
      collectionCreationMatches(creation, {
        ...options,
        query: '',
        filter: { scheduled: { kind: 'none' } },
      }),
    ).toBe(false);
    expect(
      collectionCreationMatches(creation, { ...options, query: '', filter: { starred: false } }),
    ).toBe(false);
  });
  it('uses desired completion and hides a local deletion without constructing a task identity', () => {
    expect(
      collectionCreationMatches({ ...creation, completed: true }, { ...options, query: '' }),
    ).toBe(false);
    expect(
      collectionCreationMatches(
        { ...creation, completed: true },
        { ...options, query: '', filter: { completion: 'completed' } },
      ),
    ).toBe(true);
    expect(
      collectionCreationMatches({ ...creation, deleted: true }, { ...options, query: '' }),
    ).toBe(false);
    expect(collectionCreationMatches(creation, { ...options, query: '', accountId: 'other' })).toBe(
      false,
    );
  });
  it('searches the captured title, notes and already known list and label names', () => {
    expect(collectionCreationMatches(creation, { ...options, query: 'RING64' })).toBe(true);
    expect(collectionCreationMatches(creation, { ...options, query: 'work' })).toBe(false);
    expect(
      collectionCreationMatches(creation, {
        ...options,
        query: 'work',
        lists: [{ id: 'list', accountId: 'account', title: 'work' }] as TaskList[],
      }),
    ).toBe(true);
    expect(
      collectionCreationMatches(creation, {
        ...options,
        query: 'research',
        labels: [
          { id: 'label', accountId: 'account', name: 'research', color: '#000', revision: 1 },
        ],
      }),
    ).toBe(true);
  });
  it('shares priority, label and dependency filtering with confirmed tasks', () => {
    expect(
      collectionCreationMatches(creation, {
        ...options,
        query: '',
        filter: { priorities: ['low'] },
      }),
    ).toBe(false);
    expect(
      collectionCreationMatches(creation, {
        ...options,
        query: '',
        filter: { labelIds: ['other'] },
      }),
    ).toBe(false);
    expect(
      collectionCreationMatches(creation, {
        ...options,
        query: '',
        filter: { dependencyStates: ['unblocked'] },
      }),
    ).toBe(true);
  });
});
