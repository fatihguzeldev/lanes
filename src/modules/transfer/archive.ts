import {
  ArchiveDocumentSchema,
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  type ArchiveDocument,
  type ArchiveRecord,
} from './archive-contract';
import {
  MAX_IMPORT_FILE_BYTES,
  NormalizedImportPlanSchema,
  TransferParseError,
  type ImportIssue,
  type NormalizedImportPlan,
} from './parse-contract';
import type { LabelInput } from '../tasks/contracts/task';
function fail(code: string, message: string): never {
  throw new TransferParseError(code, message);
}
function checkJsonWork(source: string): void {
  let quoted = false,
    escaped = false,
    depth = 0,
    containers = 0;
  for (const char of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      depth++;
      containers++;
      if (depth > 32 || containers > 250000)
        fail(
          'archive_too_complex',
          'select a smaller archive; its nesting or record work exceeds the supported bound.',
        );
    } else if (char === '}' || char === ']') depth--;
  }
}
function assertAcyclic(nodes: Map<string, { dependencies: string[] }>): void {
  const indegree = new Map<string, number>(),
    dependants = new Map<string, string[]>();
  for (const [key, node] of nodes) {
    const included = node.dependencies.filter((dependency) => nodes.has(dependency));
    indegree.set(key, included.length);
    for (const dependency of included) {
      const list = dependants.get(dependency) ?? [];
      list.push(key);
      dependants.set(dependency, list);
    }
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([key]) => key);
  let visited = 0;
  while (ready.length) {
    const key = ready.pop()!;
    visited++;
    for (const dependant of dependants.get(key) ?? []) {
      const count = indegree.get(dependant)! - 1;
      indegree.set(dependant, count);
      if (!count) ready.push(dependant);
    }
  }
  if (visited !== nodes.size)
    fail('archive_references_invalid', 'the included task dependencies contain a cycle.');
}
/** Browser-safe validation. Each server staging chunk is independently schema-validated again. */
export function validateArchiveDocument(input: unknown): ArchiveDocument {
  const parsed = ArchiveDocumentSchema.safeParse(input);
  if (!parsed.success)
    fail(
      'archive_schema_invalid',
      'this archive has unsupported fields or invalid values. use a supported lanes workspace archive.',
    );
  const document = parsed.data,
    records = new Map<string, ArchiveRecord>();
  for (const record of document.records) {
    if (records.has(record.key))
      fail('archive_references_invalid', 'archive-local identities must be unique.');
    records.set(record.key, record);
  }
  const boards = document.records.filter((record) => record.kind === 'board'),
    lists = document.records.filter((record) => record.kind === 'list'),
    tasks = document.records.filter((record) => record.kind === 'task');
  if (
    document.header.scope.kind === 'account' &&
    boards.filter((board) => board.isMain).length !== 1
  )
    fail(
      'archive_references_invalid',
      'an account archive needs exactly one permanent main board.',
    );
  if (
    document.header.scope.kind === 'board' &&
    !boards.some((board) => board.key === (document.header.scope as { boardKey: string }).boardKey)
  )
    fail('archive_references_invalid', 'the selected board reference is missing.');
  if (
    document.header.includesTaskSnapshots &&
    (tasks.length > 2000 || lists.length > 100 || tasks.some((task) => !task.snapshot))
  )
    fail(
      'archive_snapshots_too_large',
      'one task snapshot selection contains at most 2,000 tasks and100 lists; select a narrower scope.',
    );
  if (!document.header.includesTaskSnapshots && tasks.some((task) => task.snapshot))
    fail(
      'archive_schema_invalid',
      'the archive header must explicitly declare included task snapshots.',
    );
  const providerLists = new Set<string>(),
    providerTasks = new Set<string>();
  for (const list of lists) {
    if (records.get(list.boardKey)?.kind !== 'board')
      fail('archive_references_invalid', 'a list board reference is missing.');
    if (providerLists.has(list.providerId))
      fail(
        'archive_references_invalid',
        'one provider list may have only one archive-local identity.',
      );
    providerLists.add(list.providerId);
  }
  for (const task of tasks) {
    const list = records.get(task.listKey);
    if (list?.kind !== 'list' || list.providerId !== task.provider.listId)
      fail(
        'archive_references_invalid',
        'a task provider-list reference does not match its selected list.',
      );
    const address = JSON.stringify([task.provider.listId, task.provider.id]);
    if (providerTasks.has(address))
      fail(
        'archive_references_invalid',
        'one provider task may have only one archive-local identity.',
      );
    providerTasks.add(address);
    if (task.parentKey) {
      const parent = records.get(task.parentKey);
      if (parent?.kind !== 'task' || parent.listKey !== task.listKey)
        fail(
          'archive_references_invalid',
          'a parent reference is missing or belongs to another list.',
        );
      if (parent.parentKey)
        fail('archive_references_invalid', 'deeper nested hierarchy is not supported.');
      if (task.repeatRule)
        fail('archive_references_invalid', 'a nested task cannot repeat independently.');
    }
    for (const dependency of task.dependencies) {
      const included = records.get(dependency.key);
      if (
        (included && included.kind !== 'task') ||
        (included?.kind === 'task' &&
          (included.provider.id !== dependency.provider.id ||
            included.provider.listId !== dependency.provider.listId)) ||
        dependency.key === task.key
      )
        fail(
          'archive_references_invalid',
          'an included dependency reference has a conflicting identity.',
        );
    }
    if (
      new Set(task.labels.map((label) => label.name.normalize('NFC').toLowerCase())).size !==
      task.labels.length
    )
      fail('archive_references_invalid', 'use each normalized label name once per task.');
  }
  assertAcyclic(
    new Map(
      tasks.map((task) => [
        task.key,
        { dependencies: task.dependencies.map((dependency) => dependency.key) },
      ]),
    ),
  );
  const historyIds = new Set<string>();
  for (const record of document.records) {
    if (record.kind === 'schedule') {
      const template = records.get(record.templateKey);
      if (
        ((template?.kind !== 'template' || template.templateKind !== record.templateKind) &&
          !record.unmatchedReferences?.template) ||
        (records.get(record.boardKey)?.kind !== 'board' && !record.unmatchedReferences?.board)
      )
        fail(
          'archive_references_invalid',
          'a schedule template or destination reference is missing without an explicit unmatched-reference marker.',
        );
    }
    if (record.kind === 'template_list' || record.kind === 'template_task')
      if (records.get(record.templateKey)?.kind !== 'template')
        fail('archive_references_invalid', 'a template content reference is missing.');
    if (record.kind === 'history') {
      if (historyIds.has(record.event.id))
        fail('archive_references_invalid', 'a historical event identity must be unique.');
      historyIds.add(record.event.id);
    }
  }
  for (const template of document.records.filter((record) => record.kind === 'template')) {
    const templateLists = document.records.filter(
        (record): record is Extract<ArchiveRecord, { kind: 'template_list' }> =>
          record.kind === 'template_list' && record.templateKey === template.key,
      ),
      templateTasks = document.records.filter(
        (record): record is Extract<ArchiveRecord, { kind: 'template_task' }> =>
          record.kind === 'template_task' && record.templateKey === template.key,
      );
    if (
      templateLists.length !== template.header.listCount ||
      templateTasks.length !== template.header.taskCount
    )
      fail('archive_references_invalid', 'capture every declared template list and task.');
    const listKeys = new Set(templateLists.map((record) => record.value.key)),
      nodes = new Map(templateTasks.map((record) => [record.value.key, record.value]));
    if (
      listKeys.size !== templateLists.length ||
      nodes.size !== templateTasks.length ||
      new Set(templateLists.map((record) => record.value.position)).size !== templateLists.length ||
      new Set(templateTasks.map((record) => record.value.position)).size !== templateTasks.length
    )
      fail('archive_references_invalid', 'template-local identities and positions must be unique.');
    for (const record of templateTasks) {
      const task = record.value,
        parent = task.parentKey ? nodes.get(task.parentKey) : undefined;
      if (
        !listKeys.has(task.listKey) ||
        (task.parentKey && (!parent || parent.parentKey || parent.listKey !== task.listKey)) ||
        task.dependencyKeys.some((key) => !nodes.has(key) || key === task.key)
      )
        fail(
          'archive_references_invalid',
          'the template has an invalid or deeper hierarchy/dependency reference.',
        );
    }
    assertAcyclic(
      new Map(
        templateTasks.map((record) => [
          record.value.key,
          { dependencies: record.value.dependencyKeys },
        ]),
      ),
    );
  }
  return document;
}
export function parseWorkspaceArchive(bytes: Uint8Array): ArchiveDocument {
  if (bytes.byteLength > MAX_IMPORT_FILE_BYTES)
    fail(
      'file_too_large',
      'a workspace archive may contain at most20 mib. select a narrower scope.',
    );
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '');
  } catch {
    fail('encoding_unsupported', 'a workspace archive must use utf-8 json.');
  }
  checkJsonWork(source!);
  let value: unknown;
  try {
    value = JSON.parse(source!);
  } catch {
    fail('archive_invalid', 'this file is not valid workspace archive json. export it again.');
  }
  if (!value || typeof value !== 'object' || !('header' in value))
    fail('archive_schema_invalid', 'this file is not a lanes workspace archive.');
  const header = (value as { header: unknown }).header;
  if (
    !header ||
    typeof header !== 'object' ||
    !('format' in header) ||
    header.format !== ARCHIVE_FORMAT
  )
    fail('archive_schema_invalid', 'this file is not a lanes workspace archive.');
  if (!('version' in header) || header.version !== ARCHIVE_VERSION)
    fail(
      'archive_version_unsupported',
      'this archive version is not supported. export version1 with a compatible lanes installation.',
    );
  return validateArchiveDocument(value);
}
/** Snapshot copy intentionally creates new task identities; historical events are not applied to copies. */
export function archiveTaskSnapshotPlan(input: unknown): {
  plan: NormalizedImportPlan;
  labelDefinitions: Record<string, LabelInput[]>;
  issues: ImportIssue[];
} {
  const document = validateArchiveDocument(input);
  if (!document.header.includesTaskSnapshots)
    fail(
      'archive_snapshots_missing',
      'this metadata-only archive has no task snapshots. choose metadata restore instead.',
    );
  const lists = document.records.filter((record) => record.kind === 'list'),
    tasks = document.records.filter((record) => record.kind === 'task');
  const listKeys = new Map(lists.map((list, index) => [list.key, 'l' + (index + 1)])),
    taskKeys = new Map(tasks.map((task, index) => [task.key, 't' + (index + 1)])),
    definitions: Record<string, LabelInput[]> = {},
    issues: ImportIssue[] = [];
  const plan = NormalizedImportPlanSchema.safeParse({
    version: 1,
    lists: lists.map((list) => ({ key: listKeys.get(list.key), title: list.title })),
    tasks: tasks.map((task) => {
      const key = taskKeys.get(task.key)!;
      definitions[key] = task.labels.map(({ name, color }) => ({ name, color }));
      const omitted = task.dependencies.filter((dependency) => !taskKeys.has(dependency.key));
      if (omitted.length)
        issues.push({
          severity: 'warning',
          code: 'outside_dependencies',
          message: `${omitted.length} dependency references outside the copied snapshot are omitted.`,
          taskKey: key,
        });
      return {
        key,
        listKey: listKeys.get(task.listKey),
        parentKey: task.parentKey ? taskKeys.get(task.parentKey) : null,
        title: task.snapshot!.title,
        notes: task.snapshot!.notes,
        completed: task.snapshot!.completed,
        completedAt: task.snapshot!.completedAt,
        scheduledDay: task.scheduledDay,
        scheduledTime: task.scheduledTime,
        timeZone: task.timeZone,
        repeatRule: task.repeatRule,
        labels: task.labels.map((label) => label.name),
        priority: task.priority,
        starred: task.starred,
        dependencies: task.dependencies.flatMap((dependency) =>
          taskKeys.has(dependency.key) ? [taskKeys.get(dependency.key)!] : [],
        ),
        order: task.order,
      };
    }),
  });
  if (!plan.success)
    fail(
      'archive_snapshot_creation_invalid',
      'some retained snapshot fields cannot create valid tasks. correct the preview or select metadata restore.',
    );
  return { plan: plan.data, labelDefinitions: definitions, issues };
}
