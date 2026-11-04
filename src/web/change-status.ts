import type { OperationSummary } from '../modules/tasks/operation-contract';

export function newestChangeReceipt(
  read: OperationSummary | undefined,
  latest: OperationSummary | null,
): OperationSummary | undefined {
  if (!read) return latest ?? undefined;
  return latest?.id === read.id && latest.updatedAt > read.updatedAt ? latest : read;
}

export function changeLabel(kind: string): string {
  if (kind === 'task.create') return 'new task';
  if (kind === 'task.delete') return 'task deletion';
  if (kind === 'task.complete') return 'task completion';
  if (kind === 'task.reopen') return 'reopening a task';
  if (kind === 'task.move') return 'moving a task';
  if (kind.startsWith('task.')) return 'task changes';
  if (kind === 'list.create') return 'new list';
  if (kind === 'list.delete') return 'list deletion';
  if (kind.startsWith('list.')) return 'list changes';
  if (kind.includes('template')) return 'template changes';
  if (kind.includes('import')) return 'import';
  if (kind.includes('export') || kind.includes('sheet')) return 'export';
  if (kind.includes('copy') || kind.includes('duplicate')) return 'copy';
  return 'saved changes';
}
