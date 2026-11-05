import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskSchema } from '../../../contracts/task';
import { TaskEditor } from '../TaskEditor';
import type { TaskEditorProps } from '../editor-contract';

const task = TaskSchema.parse({
  id: 'task',
  accountId: 'account',
  listId: 'list',
  parentId: null,
  title: 'read a chapter',
  notes: 'take notes',
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
  unsupportedHierarchy: false,
  provider: {
    id: 'google-task',
    listId: 'google-list',
    etag: null,
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
const base: TaskEditorProps = {
  open: true,
  accountId: 'account',
  task,
  list: {
    id: 'list',
    accountId: 'account',
    title: 'reading',
    providerId: 'google-list',
    providerEtag: null,
    isDefault: false,
    revision: 1,
  },
  labels: [],
  relatedTasks: [],
  timeZone: 'UTC',
  providerWritesEnabled: true,
  localWritesEnabled: true,
  onClose() {},
  onSave() {},
  onCreate() {},
  onToggleComplete() {},
};
const render = (patch: Partial<TaskEditorProps> = {}) =>
  renderToStaticMarkup(createElement(TaskEditor, { ...base, ...patch }));

describe('direct task editing', () => {
  it('opens the title and notes without a modal or a wall of optional fields', () => {
    const html = render();
    expect(html).toContain('aria-label="edit task"');
    expect(html).toContain('read a chapter');
    expect(html).toContain('take notes');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain('type="time"');
    expect(html).toContain('aria-label="schedule"');
    expect(html).toContain('aria-label="labels and priority"');
    expect(html).toContain('aria-label="dependencies"');
    expect(html).toContain('aria-label="checklist"');
    expect(html).toContain('role="checkbox"');
  });
  it('retains the draft fields and explicit error on failed saves', () => {
    const html = render({ error: { code: 'conflict', message: 'the task changed' } });
    expect(html).toContain('read a chapter');
    expect(html).toContain('take notes');
    expect(html).toContain('your draft is still here. the task changed');
  });
  it('keeps subtask scope clear without offering a nested checklist', () => {
    const html = render({ task: { ...task, parentId: 'parent' } });
    expect(html).not.toContain('aria-label="checklist"');
    expect(html).toContain('aria-label="dependencies"');
  });
});
