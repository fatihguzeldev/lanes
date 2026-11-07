import { expect, it } from 'vitest';
import type { Task } from '../../../contracts/task';
import type { PendingTaskChange, TaskPresentationPatch } from '../useTaskChanges';
import { projectSubtaskSummary } from '../project-subtask-summary';
const parent = { id: 'parent', accountId: 'account', parentId: null, completed: false } as Task;
const first = { id: 'first', accountId: 'account', parentId: 'parent', completed: false } as Task;
const second = { id: 'second', accountId: 'account', parentId: 'parent', completed: true } as Task;
const summary = { total: 100, open: 80, complete: false };
function change(task: Task, patch: TaskPresentationPatch): PendingTaskChange {
  return {
    id: task.id,
    task,
    input: {
      accountId: task.accountId,
      taskId: task.id,
      listId: 'list',
      expectedRevision: 1,
      patch,
    },
    confirmedAfter: null,
  };
}
it('preserves the aggregate for 100 children when only two are loaded', () => {
  expect(
    projectSubtaskSummary(parent, summary, [parent, first, second], [parent, first, second], []),
  ).toEqual(summary);
});
it('changes only the loaded child contribution and preserves the other 98 children', () => {
  expect(
    projectSubtaskSummary(
      parent,
      summary,
      [first, second],
      [{ ...first, completed: true }, second],
      [change(first, { completed: true })],
    ),
  ).toEqual({ total: 100, open: 79, complete: false });
});
it('subtracts a deleted open child once and restores the aggregate when its action rolls back', () => {
  expect(
    projectSubtaskSummary(
      parent,
      summary,
      [first, second],
      [second],
      [change(first, { removed: true })],
    ),
  ).toEqual({ total: 99, open: 79, complete: false });
  expect(projectSubtaskSummary(parent, summary, [first, second], [first, second], [])).toEqual(
    summary,
  );
});
it('completes the whole checklist including unloaded children', () => {
  expect(
    projectSubtaskSummary(
      { ...parent, completed: true },
      summary,
      [first, second],
      [{ ...first, completed: true }, second],
      [change(parent, { completed: true })],
    ),
  ).toEqual({ total: 100, open: 0, complete: false });
});
it('reopens one child after parent completion without reopening its siblings', () => {
  const changes = [change(parent, { completed: true }), change(second, { completed: false })];
  expect(
    projectSubtaskSummary(
      parent,
      summary,
      [first, second],
      [
        { ...first, completed: true },
        { ...second, completed: false },
      ],
      changes,
    ),
  ).toEqual({ total: 100, open: 1, complete: false });
});
it('reopening the parent alone preserves the completed children', () => {
  expect(
    projectSubtaskSummary(
      parent,
      { ...summary, open: 0 },
      [{ ...first, completed: true }, second],
      [{ ...first, completed: true }, second],
      [change({ ...parent, completed: true }, { completed: false })],
    ),
  ).toEqual({ ...summary, open: 0 });
});
it('uses the captured baseline for a changed child not present in the loaded page', () => {
  expect(
    projectSubtaskSummary(
      parent,
      summary,
      [],
      [{ ...first, completed: true }],
      [change(first, { completed: true })],
    ),
  ).toEqual({ total: 100, open: 79, complete: false });
});
it('ignores an acknowledged completion when the server already supplied the updated aggregate', () => {
  const completed = { ...first, completed: true };
  const pending = { ...change(first, { completed: true }), confirmedAfter: 2 };
  expect(
    projectSubtaskSummary(parent, { ...summary, open: 79 }, [completed], [completed], [pending], 3),
  ).toEqual({ ...summary, open: 79 });
});
