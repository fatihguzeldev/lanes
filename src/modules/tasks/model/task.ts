import { z } from 'zod';
import {
  TaskPatchSchema,
  type BlockingState,
  type Label,
  type ModelIssue,
  type ModelIssueCode,
  type Task,
  type TaskFilter,
  type TaskPatch,
  type TaskSelection,
  type TaskSelectionOptions,
  type TaskSort,
} from '../contracts/task';
import { TaskScheduleSchema } from '../contracts/planning';

const key = (accountId: string, id: string): string => JSON.stringify([accountId, id]);
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const normalizeTaskSearchText = (value: string): string =>
  value.normalize('NFC').toLowerCase();
const searchText = normalizeTaskSearchText;
const hasOwn = (value: object, field: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, field);

function invalidPatch(field: string, message: string): never {
  throw new z.ZodError([{ code: 'custom', path: [field], message }]);
}

export function applyTaskPatch(current: Task, input: TaskPatch): Task {
  const patch = TaskPatchSchema.parse(input);
  const changes = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const providerFields = ['title', 'notes', 'listId', 'parentId', 'scheduledDay'];
  if (!current.capabilities.canEdit && providerFields.some((field) => hasOwn(changes, field))) {
    invalidPatch(
      'title',
      current.capabilities.restriction ?? 'provider fields are read-only for this task',
    );
  }
  if (!current.capabilities.canEditNotes && hasOwn(changes, 'notes')) {
    invalidPatch('notes', 'notes cannot be edited for this task');
  }
  if (
    !current.capabilities.canMove &&
    ((patch.listId !== undefined && patch.listId !== current.listId) ||
      (patch.parentId !== undefined && patch.parentId !== current.parentId))
  )
    invalidPatch('listId', 'this task cannot be moved');
  if (!current.capabilities.canNest && patch.parentId && patch.parentId !== current.parentId) {
    invalidPatch('parentId', 'this task cannot be nested');
  }

  const next: Task = { ...current };
  Object.assign(next, changes);
  if (patch.scheduledDay === null) {
    next.scheduledTime = null;
    next.timeZone = null;
    next.repeatRule = null;
  }
  TaskScheduleSchema.parse({
    scheduledDay: next.scheduledDay,
    scheduledTime: next.scheduledTime,
    timeZone: next.timeZone,
    repeatRule: next.repeatRule,
  });
  if (next.parentId && next.repeatRule)
    invalidPatch('repeatRule', 'a nested subtask cannot repeat independently');
  return next;
}

export function normalizeLabelName(value: string): string {
  return searchText(value.trim());
}

export function validateLabelUniqueness(
  labels: readonly Label[],
  proposed: { accountId: string; name: string; id?: string },
): boolean {
  const name = normalizeLabelName(proposed.name);
  return !labels.some(
    (label) =>
      label.accountId === proposed.accountId &&
      label.id !== proposed.id &&
      normalizeLabelName(label.name) === name,
  );
}

function indexedTasks(tasks: readonly Task[]): Map<string, Task> {
  const result = new Map<string, Task>();
  for (const task of tasks) {
    const identity = key(task.accountId, task.id);
    const existing = result.get(identity);
    if (!existing || task.revision > existing.revision) result.set(identity, task);
  }
  return result;
}

function issue(
  task: Task,
  code: ModelIssueCode,
  message: string,
  relatedTaskId?: string,
): ModelIssue {
  return {
    accountId: task.accountId,
    taskId: task.id,
    code,
    message,
    ...(relatedTaskId === undefined ? {} : { relatedTaskId }),
  };
}

function duplicateIssues(tasks: readonly Task[]): ModelIssue[] {
  const seen = new Set<string>();
  const issues: ModelIssue[] = [];
  for (const task of tasks) {
    const identity = key(task.accountId, task.id);
    if (seen.has(identity))
      issues.push(issue(task, 'duplicate_task_id', 'a task identity occurs more than once'));
    seen.add(identity);
  }
  return issues;
}

// Iterative traversal keeps invalid/deep imported graphs from exhausting the stack.
function cycleIssues(
  tasks: ReadonlyMap<string, Task>,
  edges: (task: Task) => readonly string[],
  code: 'hierarchy_cycle' | 'dependency_cycle',
): ModelIssue[] {
  const colors = new Map<string, 'visiting' | 'done'>();
  const issues: ModelIssue[] = [];
  for (const [identity, start] of tasks) {
    if (colors.has(identity)) continue;
    const stack: { task: Task; edges: readonly string[]; index: number }[] = [
      { task: start, edges: edges(start), index: 0 },
    ];
    colors.set(identity, 'visiting');
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const nextId = frame.edges[frame.index++];
      if (nextId === undefined) {
        colors.set(key(frame.task.accountId, frame.task.id), 'done');
        stack.pop();
        continue;
      }
      const nextKey = key(frame.task.accountId, nextId);
      const next = tasks.get(nextKey);
      if (!next) continue;
      if (colors.get(nextKey) === 'visiting') {
        issues.push(
          issue(
            frame.task,
            code,
            code === 'hierarchy_cycle'
              ? 'the parent graph contains a cycle'
              : 'the dependency graph contains a cycle',
            next.id,
          ),
        );
      } else if (!colors.has(nextKey)) {
        colors.set(nextKey, 'visiting');
        stack.push({ task: next, edges: edges(next), index: 0 });
      }
    }
  }
  return issues;
}

export function validateHierarchy(tasks: readonly Task[]): ModelIssue[] {
  const index = indexedTasks(tasks);
  const unscopedIds = new Set(tasks.map((task) => task.id));
  const issues = duplicateIssues(tasks);
  for (const task of index.values()) {
    if (!task.parentId) continue;
    if (task.parentId === task.id)
      issues.push(issue(task, 'self_parent', 'a task cannot be its own parent', task.parentId));
    const parent = index.get(key(task.accountId, task.parentId));
    if (!parent) {
      issues.push(
        issue(
          task,
          unscopedIds.has(task.parentId) ? 'cross_account_parent' : 'missing_parent',
          unscopedIds.has(task.parentId)
            ? 'the parent belongs to another account'
            : 'the parent is missing from the proposed hierarchy',
          task.parentId,
        ),
      );
      continue;
    }
    if (parent.listId !== task.listId)
      issues.push(
        issue(
          task,
          'cross_list_parent',
          'a parent and subtask must be in the same list',
          parent.id,
        ),
      );
    if (parent.parentId)
      issues.push(issue(task, 'nested_parent', 'a subtask cannot also be a parent', parent.id));
    if (!parent.capabilities.canHaveChildren)
      issues.push(
        issue(
          task,
          'children_not_supported',
          'the selected parent cannot have subtasks',
          parent.id,
        ),
      );
    if (!task.capabilities.canNest)
      issues.push(issue(task, 'nesting_not_supported', 'this task cannot be nested', parent.id));
  }
  return [
    ...issues,
    ...cycleIssues(index, (task) => (task.parentId ? [task.parentId] : []), 'hierarchy_cycle'),
  ];
}

// The caller must validate and commit edges under one durable account graph revision.
export function validateDependencyGraph(tasks: readonly Task[]): ModelIssue[] {
  const index = indexedTasks(tasks);
  const unscopedIds = new Set(tasks.map((task) => task.id));
  const issues = duplicateIssues(tasks);
  for (const task of index.values()) {
    if (task.blockedBy.length > 50)
      issues.push(issue(task, 'too_many_dependencies', 'a task may have at most 50 blockers'));
    for (const id of new Set(task.blockedBy)) {
      if (id === task.id)
        issues.push(issue(task, 'self_dependency', 'a task cannot block itself', id));
      if (index.has(key(task.accountId, id))) continue;
      const foreign = unscopedIds.has(id);
      issues.push(
        issue(
          task,
          foreign ? 'cross_account_dependency' : 'missing_dependency',
          foreign
            ? 'a blocker belongs to another account'
            : 'a blocker is missing from the proposed graph',
          id,
        ),
      );
    }
  }
  return [...issues, ...cycleIssues(index, (task) => task.blockedBy, 'dependency_cycle')];
}

function blockingState(task: Task, index: ReadonlyMap<string, Task>): BlockingState {
  const openBlockers: Task[] = [];
  const missingBlockerIds: string[] = [];
  for (const id of new Set(task.blockedBy)) {
    const blocker = index.get(key(task.accountId, id));
    if (!blocker || blocker.provider.missing) missingBlockerIds.push(id);
    else if (!blocker.completed) openBlockers.push(blocker);
  }
  return {
    state: openBlockers.length ? 'blocked' : missingBlockerIds.length ? 'unknown' : 'unblocked',
    openBlockers,
    missingBlockerIds,
  };
}

export function getBlockingState(task: Task, tasks: readonly Task[]): BlockingState {
  return blockingState(task, indexedTasks(tasks));
}

export function getBlockingStates(
  tasks: readonly Task[],
  relatedTasks: readonly Task[] = tasks,
): Map<Task, BlockingState> {
  const index = indexedTasks(relatedTasks);
  return new Map(tasks.map((task) => [task, blockingState(task, index)]));
}

function matchesFilter(
  task: Task,
  filter: TaskFilter,
  today: string,
  index: ReadonlyMap<string, Task>,
): boolean {
  const completion = filter.completion ?? 'open';
  if ((completion === 'open' && task.completed) || (completion === 'completed' && !task.completed))
    return false;
  if (filter.listIds?.length && !filter.listIds.includes(task.listId)) return false;
  if (filter.priorities?.length && !filter.priorities.includes(task.priority)) return false;
  if (filter.starred !== undefined && filter.starred !== task.starred) return false;
  if (filter.labelIds?.length) {
    const match = (id: string) => task.labelIds.includes(id);
    if (!(filter.labelMatch === 'all' ? filter.labelIds.every(match) : filter.labelIds.some(match)))
      return false;
  }
  if (
    filter.dependencyStates?.length &&
    !filter.dependencyStates.includes(blockingState(task, index).state)
  )
    return false;
  const scheduled = filter.scheduled;
  if (scheduled?.kind === 'none' && task.scheduledDay !== null) return false;
  if (scheduled?.kind === 'today' && task.scheduledDay !== today) return false;
  if (
    scheduled?.kind === 'overdue' &&
    (task.completed || !task.scheduledDay || task.scheduledDay >= today)
  )
    return false;
  if (
    scheduled?.kind === 'range' &&
    (!task.scheduledDay || task.scheduledDay < scheduled.from || task.scheduledDay > scheduled.to)
  )
    return false;
  return true;
}

export function selectTasksWithContext(
  tasks: readonly Task[],
  options: TaskSelectionOptions,
): TaskSelection {
  const index = indexedTasks(tasks);
  const accountTasks = [...index.values()].filter((task) => task.accountId === options.accountId);
  const query = searchText(options.query ?? '').trim();
  const labels = new Map(
    (options.labels ?? [])
      .filter((label) => label.accountId === options.accountId)
      .map((label) => [label.id, label.name]),
  );
  const lists = new Map(
    (options.lists ?? [])
      .filter((list) => list.accountId === options.accountId)
      .map((list) => [list.id, list.title]),
  );
  const matched = new Set<string>();
  const context = new Set<string>();
  for (const task of accountTasks) {
    if (options.listIds && !options.listIds.includes(task.listId)) continue;
    if (!matchesFilter(task, options.filter ?? {}, options.today, index)) continue;
    const parentCandidate = task.parentId
      ? index.get(key(task.accountId, task.parentId))
      : undefined;
    const parent = parentCandidate?.listId === task.listId ? parentCandidate : undefined;
    if (
      query &&
      !searchText(
        [
          task.title,
          task.notes,
          lists.get(task.listId) ?? '',
          parent?.title ?? '',
          ...task.labelIds.map((id) => labels.get(id) ?? ''),
        ].join('\n'),
      ).includes(query)
    )
      continue;
    matched.add(task.id);
    if (parent) context.add(parent.id);
  }
  for (const id of matched) context.delete(id);
  const selected = accountTasks.filter((task) => matched.has(task.id) || context.has(task.id));
  return {
    tasks: sortTasks(selected, 'manual'),
    matchedTaskIds: accountTasks.filter((task) => matched.has(task.id)).map((task) => task.id),
    contextTaskIds: accountTasks.filter((task) => context.has(task.id)).map((task) => task.id),
  };
}

export function countOpenTasks(tasks: readonly Task[], accountId?: string): number {
  let count = 0;
  for (const task of indexedTasks(tasks).values())
    if (!task.completed && (accountId === undefined || task.accountId === accountId)) count++;
  return count;
}

function manualOrder(a: Task, b: Task): number {
  const left = a.provider.position;
  const right = b.provider.position;
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    const compared = compareText(left, right);
    if (compared) return compared;
  }
  return compareText(a.id, b.id);
}

const priorityOrder = { high: 0, medium: 1, low: 2, none: 3 } as const;
function taskComparator(sort: TaskSort): (a: Task, b: Task) => number {
  return (a, b) => {
    let compared = 0;
    if (sort === 'title') compared = compareText(searchText(a.title), searchText(b.title));
    else if (sort === 'scheduled')
      compared =
        compareText(a.scheduledDay ?? '9999-12-31', b.scheduledDay ?? '9999-12-31') ||
        compareText(a.scheduledTime ?? '', b.scheduledTime ?? '');
    else if (sort === 'priority') compared = priorityOrder[a.priority] - priorityOrder[b.priority];
    else if (sort === 'updated')
      compared =
        (b.provider.updatedAt ? Date.parse(b.provider.updatedAt) : -Infinity) -
        (a.provider.updatedAt ? Date.parse(a.provider.updatedAt) : -Infinity);
    return (Number.isNaN(compared) ? 0 : compared) || manualOrder(a, b);
  };
}

// Provider positions are read for display only. Temporary sorts never generate moves.
export function sortTasks(tasks: readonly Task[], sort: TaskSort = 'manual'): Task[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const identity = key(task.accountId, task.listId);
    const group = groups.get(identity);
    if (group) group.push(task);
    else groups.set(identity, [task]);
  }
  const result: Task[] = [];
  const compare = taskComparator(sort);
  for (const group of groups.values()) {
    const ids = new Set(group.map((task) => task.id));
    const children = new Map<string, Task[]>();
    const roots: Task[] = [];
    for (const task of group) {
      if (task.parentId && ids.has(task.parentId)) {
        const siblings = children.get(task.parentId);
        if (siblings) siblings.push(task);
        else children.set(task.parentId, [task]);
      } else roots.push(task);
    }
    const visited = new Set<string>();
    const append = (root: Task): void => {
      const stack = [root];
      while (stack.length) {
        const task = stack.pop();
        if (!task || visited.has(task.id)) continue;
        visited.add(task.id);
        result.push(task);
        stack.push(...[...(children.get(task.id) ?? [])].sort(compare).reverse());
      }
    };
    for (const root of roots.sort(compare)) append(root);
    // Preserve unsupported provider structures for an explicit unsupported-state UI.
    for (const task of [...group].sort(compare)) append(task);
  }
  return result;
}
