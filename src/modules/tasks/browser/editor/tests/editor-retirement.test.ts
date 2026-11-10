import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskEditorWorkspace } from '../TaskEditorWorkspace';
import type { TaskEditor } from '../TaskEditor';
import { CreateTaskSchema, type Task } from '../../../contracts/task';

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as Array<() => unknown>,
  commands: {
    busy: false,
    latest: null as {
      id: string;
      state: string;
      finished?: boolean;
      confirmedSteps?: number;
    } | null,
    error: '',
    errorDetails: null as { operationId: string } | null,
    submit: vi.fn(),
    clearError: vi.fn(),
  },
  repeat: { busy: false, error: '', run: vi.fn() },
  request: vi.fn(),
  identities: [] as string[],
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.index++;
    if (!(index in state.slots))
      state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      state.slots[index],
      (next: unknown) => {
        state.slots[index] = typeof next === 'function' ? next(state.slots[index]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = state.index++;
    state.slots[index] ??= { current: initial };
    return state.slots[index];
  },
  useMemo: (value: () => unknown) => value(),
  useEffect: () => {},
  useLayoutEffect: (effect: () => unknown) => state.effects.push(effect),
}));
vi.mock('../../../../operations/browser/submission/useCommands', () => ({
  useCommands: () => state.commands,
}));
vi.mock('../../../../operations/browser/submission/operation-identity', () => ({
  newOperationId: () => state.identities.shift() ?? 'receipt',
}));
vi.mock('../../../../../shared/browser/connectivity/useServerConnection', () => ({
  useServerConnection: () => 'reachable',
}));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: state.request }));
vi.mock('../../planning/useRecurrenceWork', () => ({ useRecurrenceWork: () => state.repeat }));
vi.mock('../../queries/useTaskQuery', () => ({
  useTaskQuery: () => ({
    page: { items: [], nextCursor: null, coverage: { complete: true } },
    status: 'ready',
    error: '',
    loaded: true,
  }),
}));
vi.mock('../../../../../shared/browser/resources/usePagedResource', () => ({
  usePagedResource: () => ({
    items: [],
    status: 'ready',
    loaded: true,
    error: '',
    coverage: { stale: false },
    nextCursor: null,
  }),
}));

function mount(
  inlineCreate = false,
  runEdit?: ComponentProps<typeof TaskEditorWorkspace>['runEdit'],
  creating = false,
) {
  const retire = vi.fn(),
    saved = vi.fn(),
    preview = vi.fn(),
    submitted = vi.fn(),
    editPreview = vi.fn();
  const props = {
    account: { id: 'account', state: 'connected', planningZone: 'UTC' },
    selection: {
      task: inlineCreate || creating ? null : { id: 'task', title: 'old title', blockedBy: [] },
      list: { id: 'list' },
      ...(inlineCreate ? { inlineCreate: true } : {}),
    },
    presented: true,
    boardId: null,
    labels: [],
    version: 0,
    clockOffset: 0,
    onBusyChange: vi.fn(),
    onRetire: retire,
    onSaved: saved,
    onSubmitted: submitted,
    onCreatePending: preview,
    onEditPending: editPreview,
    ...(runEdit ? { runEdit } : {}),
    onDirtyChange: vi.fn(),
    onChanged() {},
    onClose() {},
    onOpenTask() {},
    onToggleComplete() {},
    onDelete() {},
    onCreateSubtask() {},
    onManageLabels() {},
    onInspectChange() {},
  } as unknown as ComponentProps<typeof TaskEditorWorkspace>;
  const render = (presented = true) => {
    state.index = 0;
    state.effects = [];
    const view = TaskEditorWorkspace({ ...props, presented });
    state.effects.forEach((effect) => effect());
    return view as ReactElement<{
      children: ReactElement<ComponentProps<typeof TaskEditor>>;
    }> | null;
  };
  const save = (baseline?: Task) => {
    let resolve!: (result: unknown) => void;
    state.commands.submit.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render()!.props.children.props.onSave({
      accountId: 'account',
      listId: 'list',
      taskId: 'task',
      expectedRevision: 1,
      patch: { title: 'updated' },
      ...(baseline ? { baseline, expectedRevision: baseline.revision } : {}),
    });
    return resolve;
  };
  return { retire, saved, preview, submitted, editPreview, render, save, props };
}

describe('hidden editor retirement', () => {
  beforeEach(() => {
    state.slots = [];
    state.index = 0;
    state.effects = [];
    state.commands.busy = false;
    state.commands.latest = null;
    state.commands.error = '';
    state.commands.errorDetails = null;
    state.commands.submit.mockReset();
    state.repeat.busy = false;
    state.repeat.error = '';
    state.request.mockReset().mockResolvedValue({
      accountId: 'account',
      id: 'task',
      listId: 'list',
      title: 'old title',
      revision: 1,
      blockedBy: [],
      labelIds: [],
    });
    state.identities = [];
  });

  it('retains the validated creation before waiting for server admission', () => {
    const editor = mount(true);
    const input = CreateTaskSchema.parse({
      accountId: 'account',
      listId: 'list',
      title: 'ring64',
    });
    state.commands.submit.mockReturnValue(new Promise(() => {}));
    editor.render()!.props.children.props.onCreate({
      accountId: 'account',
      listRevision: 1,
      input,
    });
    expect(editor.preview).toHaveBeenCalledWith(input);
    expect(state.commands.submit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task.create', previousId: null }),
      'provider',
      'receipt',
    );
    expect(editor.submitted).toHaveBeenCalledOnce();
    expect(editor.saved).not.toHaveBeenCalled();
  });

  it('reports a rejected creation even after its editor has closed', async () => {
    const editor = mount(true);
    state.commands.submit.mockResolvedValue(null);
    editor.render()!.props.children.props.onCreate({
      accountId: 'account',
      listRevision: 1,
      input: CreateTaskSchema.parse({
        accountId: 'account',
        listId: 'list',
        title: 'keep my draft',
      }),
    });
    state.commands.error = 'list changed';
    await Promise.resolve();
    await Promise.resolve();
    editor.render(false);
    expect(editor.retire).toHaveBeenCalledWith(true, 'list changed', null);
  });

  it('finishes the edit interaction before waiting for its background receipt', () => {
    const editor = mount();
    editor.save();
    expect(editor.submitted).toHaveBeenCalledOnce();
    expect(editor.editPreview).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task', patch: { title: 'updated' } }),
    );
    expect(editor.saved).not.toHaveBeenCalled();
    editor.render(false);
    expect(editor.retire).not.toHaveBeenCalled();
  });

  it('closes calendar and subtask creation before admission while its save runs', () => {
    const editor = mount(false, undefined, true);
    const input = CreateTaskSchema.parse({
      accountId: 'account',
      listId: 'list',
      title: 'planned task',
    });
    state.commands.submit.mockReturnValue(new Promise(() => {}));
    editor
      .render()!
      .props.children.props.onCreate({ accountId: 'account', listRevision: 1, input });
    expect(editor.preview).toHaveBeenCalledWith(input);
    expect(editor.submitted).toHaveBeenCalledOnce();
    state.commands.latest = { id: 'receipt', state: 'accepted' };
    state.commands.busy = true;
    editor.render();
    expect(editor.submitted).toHaveBeenCalledOnce();
    editor.render(false);
    expect(editor.retire).not.toHaveBeenCalled();
  });
  it('closes a captured creation while its list queue waits without dispatching it early', async () => {
    const editor = mount(true);
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    editor.props.runCreate = vi.fn(async (submit) => {
      await queued;
      return (await submit())?.state === 'succeeded';
    });
    state.commands.submit.mockResolvedValue({ state: 'succeeded' });
    editor.render()!.props.children.props.onCreate({
      accountId: 'account',
      listRevision: 1,
      input: CreateTaskSchema.parse({
        accountId: 'account',
        listId: 'list',
        title: 'queued new task',
      }),
    });
    expect(editor.submitted).toHaveBeenCalledOnce();
    expect(editor.preview).toHaveBeenCalledOnce();
    expect(state.commands.submit).not.toHaveBeenCalled();
    editor.render(false);
    expect(editor.retire).not.toHaveBeenCalled();
    release();
    for (let step = 0; step < 8; step++) await Promise.resolve();
    expect(state.commands.submit).toHaveBeenCalledOnce();
    expect(editor.saved).toHaveBeenCalledOnce();
  });

  it('leaves an unadmitted calendar creation available for correction', async () => {
    const editor = mount(false, undefined, true);
    const input = CreateTaskSchema.parse({
      accountId: 'account',
      listId: 'list',
      title: 'planned task',
    });
    state.commands.submit.mockResolvedValue(null);
    editor
      .render()!
      .props.children.props.onCreate({ accountId: 'account', listRevision: 1, input });
    state.commands.error = 'the title was rejected';
    await Promise.resolve();
    await Promise.resolve();
    expect(editor.render()!.props.children.props.error?.message).toBe('the title was rejected');
    expect(editor.submitted).toHaveBeenCalledOnce();
    expect(editor.retire).not.toHaveBeenCalled();
  });

  it('rebases an immediate edit after a confirmed move while its old row is still visible', async () => {
    const run = vi.fn(async (_taskId, job: (queued: boolean) => Promise<boolean>) => job(false));
    const editor = mount(false, run);
    state.request.mockResolvedValue({
      accountId: 'account',
      id: 'task',
      listId: 'list',
      title: 'old title',
      revision: 2,
    });
    const resolve = editor.save();
    expect(editor.submitted).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(state.commands.submit).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 2, patch: { title: 'updated' } }),
      'provider',
      'receipt',
    );
    resolve({ state: 'succeeded' });
  });
  it('rebases a queued edit onto its predecessor’s confirmed revision', async () => {
    const run = vi.fn(async (_taskId, job: (queued: boolean) => Promise<boolean>) => job(true));
    const editor = mount(false, run);
    state.request.mockResolvedValue({
      accountId: 'account',
      id: 'task',
      listId: 'list',
      title: 'old title',
      revision: 2,
    });
    const resolve = editor.save();
    expect(editor.submitted).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(state.commands.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task',
        revision: 2,
        patch: { title: 'updated' },
      }),
      'provider',
      'receipt',
    );
    resolve({ state: 'succeeded' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(editor.saved).toHaveBeenCalledOnce();
  });

  it('does not overwrite a changed field while rebasing a queued edit', async () => {
    const run = vi.fn(async (_taskId, job: (queued: boolean) => Promise<boolean>) => job(true));
    const editor = mount(false, run);
    state.request.mockResolvedValue({
      accountId: 'account',
      id: 'task',
      listId: 'list',
      title: 'changed externally',
      revision: 2,
    });
    editor.save();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    editor.render(false);
    expect(state.commands.submit).not.toHaveBeenCalled();
    expect(editor.retire).toHaveBeenCalledWith(
      true,
      'this task changed before its queued edit could save. open it to review the latest values.',
      null,
    );
  });

  it('compares queued edits against an explicitly reviewed draft baseline', async () => {
    const run = vi.fn(async (_taskId, job: (queued: boolean) => Promise<boolean>) => job(true));
    const editor = mount(false, run);
    const baseline = {
      accountId: 'account',
      id: 'task',
      listId: 'list',
      title: 'reviewed title',
      revision: 2,
    } as Task;
    state.request.mockResolvedValue({ ...baseline, revision: 3 });
    const resolve = editor.save(baseline);
    await Promise.resolve();
    expect(state.commands.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 3,
        patch: { title: 'updated' },
      }),
      'provider',
      'receipt',
    );
    expect(state.commands.submit.mock.calls[0]![0]).not.toHaveProperty('baseline');
    resolve({ state: 'succeeded' });
  });

  it('reports when an earlier failed write prevents this queued edit from being sent', async () => {
    const editor = mount(
      false,
      vi.fn(async () => false),
    );
    editor.save();
    await Promise.resolve();
    editor.render(false);
    expect(state.commands.submit).not.toHaveBeenCalled();
    expect(editor.retire).toHaveBeenCalledWith(
      true,
      'couldn’t confirm this change. review its save before trying again.',
      null,
    );
  });

  it('allows correcting a creation rejected before receipt capture', async () => {
    const editor = mount(true);
    state.commands.submit.mockResolvedValue(null);
    const input = CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'first' });
    editor
      .render()!
      .props.children.props.onCreate({ accountId: 'account', listRevision: 1, input });
    await Promise.resolve();
    await Promise.resolve();
    editor.render()!.props.children.props.onCreate({
      accountId: 'account',
      listRevision: 1,
      input: { ...input, title: 'corrected' },
    });
    expect(state.commands.submit).toHaveBeenCalledTimes(2);
    expect(editor.submitted).toHaveBeenCalledTimes(2);
  });

  it('allows an explicit creation retry after a terminal failed receipt', async () => {
    const editor = mount(true);
    const input = CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'first' });
    state.commands.submit.mockResolvedValue({ id: 'receipt', state: 'failed' });
    editor
      .render()!
      .props.children.props.onCreate({ accountId: 'account', listRevision: 1, input });
    await Promise.resolve();
    await Promise.resolve();
    state.commands.latest = { id: 'receipt', state: 'failed', finished: true };
    state.commands.error = 'the title was rejected';
    editor.render()!.props.children.props.onRetryFailed!();
    editor.render()!.props.children.props.onCreate({
      accountId: 'account',
      listRevision: 1,
      input: { ...input, title: 'corrected' },
    });
    expect(state.commands.submit).toHaveBeenCalledTimes(2);
  });

  it('does not let an older failed receipt lock later corrected creation attempts', async () => {
    state.identities = ['receipt', 'retry-receipt'];
    const editor = mount(true);
    const input = CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'first' });
    state.commands.submit.mockResolvedValue({ id: 'receipt', state: 'failed' });
    editor
      .render()!
      .props.children.props.onCreate({ accountId: 'account', listRevision: 1, input });
    await Promise.resolve();
    await Promise.resolve();
    state.commands.latest = { id: 'receipt', state: 'failed', finished: true };
    state.commands.error = 'rejected';
    editor.render()!.props.children.props.onRetryFailed!();
    state.commands.submit.mockResolvedValue(null);
    editor.render()!.props.children.props.onCreate({
      accountId: 'account',
      listRevision: 1,
      input: { ...input, title: 'second' },
    });
    await Promise.resolve();
    await Promise.resolve();
    editor.render()!.props.children.props.onCreate({
      accountId: 'account',
      listRevision: 1,
      input: { ...input, title: 'third' },
    });
    expect(state.commands.submit).toHaveBeenCalledTimes(3);
  });

  it('confirms a recovered successful receipt even when submit returned null', async () => {
    const editor = mount();
    const resolve = editor.save();
    state.commands.latest = { id: 'receipt', state: 'succeeded' };
    state.commands.error = 'connection lost while saving';
    editor.render(false);
    expect(editor.retire).not.toHaveBeenCalled();
    resolve(null);
    await vi.waitFor(() => expect(state.commands.submit).toHaveBeenCalledOnce());
    editor.render(false);
    expect(editor.saved).toHaveBeenCalledOnce();
    expect(editor.retire).not.toHaveBeenCalled();
  });

  it('does not retire normal success before its awaited continuation completes', async () => {
    const editor = mount();
    const resolve = editor.save();
    state.commands.latest = { id: 'receipt', state: 'succeeded' };
    editor.render(false);
    expect(editor.retire).not.toHaveBeenCalled();
    resolve({ id: 'receipt', state: 'succeeded' });
    await vi.waitFor(() => expect(state.commands.submit).toHaveBeenCalledOnce());
    editor.render(false);
    expect(editor.saved).toHaveBeenCalledOnce();
    expect(editor.retire).not.toHaveBeenCalled();
  });

  it('retains a hidden recurrence failure and its available operation identity', () => {
    const editor = mount();
    state.repeat.busy = true;
    editor.render();
    state.repeat.busy = false;
    state.repeat.error = 'repeat work failed';
    state.commands.errorDetails = { operationId: 'repeat-receipt' };
    editor.render(false);
    expect(editor.retire).toHaveBeenCalledWith(true, 'repeat work failed', 'repeat-receipt');
  });

  it('does not announce read errors from an editor that submitted no work', () => {
    const editor = mount();
    state.repeat.error = 'could not read repeat state';
    editor.render(false);
    expect(editor.retire).toHaveBeenCalledWith(false, null, null);
  });

  it('locks an ambiguous submission when its receipt reference is known but unreadable', () => {
    const editor = mount();
    state.commands.errorDetails = { operationId: 'receipt' };
    expect(editor.render()!.props.children.props.submitted).toBe(true);
  });

  it('reports a rejected creation that left before capture', () => {
    const editor = mount(true);
    state.commands.busy = true;
    editor.render();
    state.commands.busy = false;
    state.commands.error = 'the name was rejected';
    editor.render(false);
    expect(editor.retire).toHaveBeenCalledWith(true, 'the name was rejected', null);
  });

  it('closes inline creation when a lost response recovers a confirmed successful receipt', () => {
    const editor = mount(true);
    state.commands.busy = true;
    editor.render();
    state.commands.busy = false;
    state.commands.latest = { id: 'receipt', state: 'succeeded' };
    state.commands.error = 'the original response was lost';
    editor.render();
    editor.render();
    expect(editor.saved).toHaveBeenCalledOnce();
    expect(editor.retire).not.toHaveBeenCalled();
  });

  it('captures edits to an admitted local creation without submitting a second create', () => {
    const editor = mount(true);
    const update = vi.fn(() => true),
      close = vi.fn(),
      dirty = vi.fn();
    editor.props.selection.pendingCreationId = 42;
    editor.props.onUpdateCreation = update;
    editor.props.onClose = close;
    editor.props.onDirtyChange = dirty;
    const input = CreateTaskSchema.parse({
      accountId: 'account',
      listId: 'list',
      title: 'renamed while saving',
    });
    editor
      .render()!
      .props.children.props.onCreate({ accountId: 'account', listRevision: 1, input });
    expect(update).toHaveBeenCalledWith(42, input);
    expect(close).toHaveBeenCalledOnce();
    expect(dirty).toHaveBeenCalledWith(false);
    expect(editor.preview).not.toHaveBeenCalled();
    expect(state.commands.submit).not.toHaveBeenCalled();
  });

  it('keeps a pending creation draft open if its captured record is no longer available', () => {
    const editor = mount(true);
    editor.props.selection.pendingCreationId = 42;
    editor.props.onUpdateCreation = vi.fn(() => false);
    const close = vi.fn(),
      dirty = vi.fn();
    editor.props.onClose = close;
    editor.props.onDirtyChange = dirty;
    editor.render()!.props.children.props.onCreate({
      accountId: 'account',
      listRevision: 1,
      input: CreateTaskSchema.parse({
        accountId: 'account',
        listId: 'list',
        title: 'preserve this edit',
      }),
    });
    expect(close).not.toHaveBeenCalled();
    expect(dirty).not.toHaveBeenCalledWith(false);
    expect(editor.render()!.props.children.props.error?.message).toContain('draft');
  });

  it('distinguishes a definitely rejected zero-step create receipt from uncertainty', () => {
    const editor = mount(true);
    state.commands.busy = true;
    editor.render();
    state.commands.busy = false;
    state.commands.error = 'invalid parent';
    state.commands.latest = { id: 'receipt', state: 'failed', finished: true, confirmedSteps: 0 };
    editor.render(false);
    expect(editor.retire).toHaveBeenCalledWith(true, 'invalid parent', 'receipt', true);
  });
});
