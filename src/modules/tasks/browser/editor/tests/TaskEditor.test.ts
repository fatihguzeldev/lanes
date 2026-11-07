import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useOutsideDismiss } from '../../../../../shared/ui/dismiss/useOutsideDismiss';
import { TaskSchema } from '../../../contracts/task';
import { TaskEditor } from '../TaskEditor';
import type { TaskEditorProps } from '../editor-contract';
import type { FormEvent, KeyboardEvent } from 'react';

const handlers = vi.hoisted(() => ({
  title: null as ((event: KeyboardEvent<HTMLTextAreaElement>) => void) | null,
  submit: null as ((event: FormEvent<HTMLFormElement>) => void) | null,
}));
vi.mock('react/jsx-dev-runtime', async (original) => {
  const runtime = await original<typeof import('react/jsx-dev-runtime')>();
  const capture = (...args: Parameters<typeof runtime.jsxDEV>) => {
    const [type, props] = args;
    const fields = props as {
      className?: string;
      onKeyDown?: typeof handlers.title;
      onSubmit?: typeof handlers.submit;
    };
    if (type === 'textarea' && fields.className === 'task-editor__title')
      handlers.title = fields.onKeyDown ?? null;
    if (type === 'form' && fields.className === 'task-editor')
      handlers.submit = fields.onSubmit ?? null;
    return runtime.jsxDEV(...args);
  };
  return { ...runtime, jsxDEV: capture };
});

vi.mock('../../../../../shared/ui/dismiss/useOutsideDismiss', () => ({
  useOutsideDismiss: vi.fn(),
}));

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
    expect(html).toContain('aria-label="labels"');
    expect(html).toContain('aria-label="priority"');
    expect(html).not.toContain('labels and priority');
    expect(html).not.toContain('task-editor__metadata-row');
    expect(html).toContain('aria-label="dependencies"');
    expect(html).toContain('aria-label="checklist"');
    expect(html).toContain('role="checkbox"');
  });
  it('finishes an unchanged title with enter without submitting a write', () => {
    const onClose = vi.fn(),
      onSave = vi.fn();
    render({ onClose, onSave });
    handlers.title!({
      nativeEvent: { isComposing: false },
      key: 'Enter',
      shiftKey: false,
      preventDefault() {},
      currentTarget: {
        form: {
          requestSubmit: () =>
            handlers.submit!({ preventDefault() {} } as FormEvent<HTMLFormElement>),
        },
      },
    } as unknown as KeyboardEvent<HTMLTextAreaElement>);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
  it('retains the draft fields and explicit error on failed saves', () => {
    const html = render({ error: { code: 'conflict', message: 'the task changed' } });
    expect(html).toContain('read a chapter');
    expect(html).toContain('take notes');
    expect(html).toContain('your draft is still here. the task changed');
  });
  it('opens a new inline task with its details available and no approval footer', () => {
    const html = render({ task: null, inlineCreate: true });
    expect(html).toContain('aria-label="new task"');
    expect(html).toContain('placeholder="details"');
    expect(html).toContain('aria-label="schedule"');
    expect(html).not.toContain('task-editor__footer');
    expect(html).not.toContain('type="submit"');
  });
  it('keeps subtask scope clear without offering a nested checklist', () => {
    const html = render({ task: { ...task, parentId: 'parent' } });
    expect(html).not.toContain('aria-label="checklist"');
    expect(html).toContain('aria-label="dependencies"');
  });

  it('delegates an outside click to the supplied guarded close action', () => {
    const onClose = vi.fn();
    render({ onClose });
    const dismissal = vi.mocked(useOutsideDismiss).mock.calls.at(-1);
    expect(dismissal?.[2]?.enabled).toBe(true);
    dismissal?.[1]();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps an initial save admission open until its receipt is captured', () => {
    render({ pending: true, submitted: false });
    expect(vi.mocked(useOutsideDismiss).mock.calls.at(-1)?.[2]?.enabled).toBe(false);
  });

  it('allows closing after a pending save has a captured receipt', () => {
    const html = render({ pending: true, submitted: true });
    expect(vi.mocked(useOutsideDismiss).mock.calls.at(-1)?.[2]?.enabled).toBe(true);
    expect(html).not.toContain('saving…');
    expect(html).not.toContain('saving your changes');
  });
});
