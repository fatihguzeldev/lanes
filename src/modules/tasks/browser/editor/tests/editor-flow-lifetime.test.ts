import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskEditorFlow } from '../TaskEditorFlow';
import { TaskEditorWorkspace } from '../TaskEditorWorkspace';
import type { TaskEditorController, TaskEditorSession } from '../useTaskEditor';
import { CreateTaskSchema } from '../../../contracts/task';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next;
      },
    ];
  },
  useRef: (current: unknown) => (hooks.slots[hooks.index++] ??= { current }),
  useLayoutEffect: (effect: () => void) => hooks.effects.push(effect),
}));
const session = (id: number) =>
  ({
    id,
    selection: {
      task: { id: `task-${id}`, title: `task ${id}` },
      list: { id: 'list' },
      boardId: 'board',
    },
  }) as TaskEditorSession;
type WorkspaceUI = ReactElement<ComponentProps<typeof TaskEditorWorkspace>>;
function mount() {
  let current: TaskEditorSession | null = session(1);
  const changed = vi.fn(),
    notice = vi.fn(),
    accountsChanged = vi.fn();
  const controller = {
    get session() {
      return current;
    },
    get selection() {
      return current?.selection ?? null;
    },
    dirty: false,
    saving: false,
    setDirty: vi.fn(),
    setSaving: vi.fn(),
    close: vi.fn((id: number) => {
      if (current?.id === id) current = null;
    }),
    closeSaved: vi.fn((id: number) => {
      if (current?.id === id) current = null;
    }),
    open: vi.fn(),
    create: vi.fn(),
    createSubtask: vi.fn(),
    recoverCreate: vi.fn(),
    editCreation: vi.fn(),
  } as unknown as TaskEditorController;
  const props = {
    controller,
    creations: {
      items: [] as import('../../creation/useTaskCreations').PendingTaskCreation[],
      start: vi.fn(),
      confirm: vi.fn(),
      remove: vi.fn(),
      fail: vi.fn(),
      finish: vi.fn(),
      hold: vi.fn(),
      acknowledge: vi.fn(),
      update: vi.fn(),
      retainEditor: vi.fn(() => vi.fn()),
      run: vi.fn(),
      busy: false,
      hasDrafts: false,
      discardDrafts: vi.fn(),
    },
    edits: {
      items: [],
      start: vi.fn(),
      confirm: vi.fn(),
      remove: vi.fn(),
      run: vi.fn(),
      project: vi.fn((task) => task),
    },
    account: { id: 'account' } as ComponentProps<typeof TaskEditorFlow>['account'],
    boardId: 'board',
    labels: [],
    version: 0,
    clockOffset: 0,
    guard: (action: () => void) => action(),
    onChanged: changed,
    onAccountsChanged: accountsChanged,
    onNotice: notice,
    onInspect() {},
    onOpenTask() {},
    onToggleComplete() {},
    onDelete() {},
  };
  const render = (active = true) => {
    hooks.index = 0;
    const view = TaskEditorFlow({ ...props, active }) as ReactElement<{
      children: [WorkspaceUI[]];
    }>;
    return view.props.children[0];
  };
  return {
    controller,
    render,
    changed,
    notice,
    accountsChanged,
    creations: props.creations,
    edits: props.edits,
    select(id: number) {
      current = session(id);
      render();
      hooks.effects.at(-1)!();
    },
  };
}

describe('task editor command lifetime', () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.index = 0;
    hooks.effects = [];
  });

  it('removes the presentation without unmounting its command owner until retirement', () => {
    const flow = mount();
    const [editor] = flow.render();
    expect(editor!.type).toBe(TaskEditorWorkspace);
    expect(editor!.props.presented).toBe(true);
    editor!.props.onBusyChange(true);
    editor!.props.onClose();
    const [hidden] = flow.render();
    expect(hidden!.key).toBe(editor!.key);
    expect(hidden!.props.presented).toBe(false);
    expect(flow.controller.setSaving).toHaveBeenCalledWith(1, true);
    hidden!.props.onRetire(true, null, null);
    expect(flow.render()).toEqual([]);
    expect(flow.controller.setSaving).toHaveBeenLastCalledWith(1, false);
  });

  it('holds an editor lease until a pending creation editor closes or is replaced', () => {
    const flow = mount();
    const [editor] = flow.render();
    const release = vi.fn();
    flow.creations.retainEditor.mockReturnValue(release);
    flow.controller.editCreation = vi.fn(() => 7) as typeof flow.controller.editCreation;
    editor!.props.onCreatePending!(
      CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'new task' }),
    );
    const open = flow.creations.start.mock.calls[0]![2] as (
      input: ReturnType<typeof CreateTaskSchema.parse>,
    ) => void;
    open(CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'changed' }));
    expect(flow.creations.retainEditor).toHaveBeenCalledWith(1);
    flow.select(8);
    hooks.effects.forEach((effect) => effect());
    expect(release).toHaveBeenCalledOnce();
  });
  it('releases a retained creation editor exactly once on flow unmount', () => {
    const flow = mount();
    const [editor] = flow.render();
    const stop = hooks.effects[0]!() as () => void;
    const release = vi.fn();
    flow.creations.retainEditor.mockReturnValue(release);
    flow.controller.editCreation = vi.fn(() => 7) as typeof flow.controller.editCreation;
    editor!.props.onCreatePending!(
      CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'new task' }),
    );
    (
      flow.creations.start.mock.calls[0]![2] as (
        input: ReturnType<typeof CreateTaskSchema.parse>,
      ) => void
    )(CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'draft' }));
    stop();
    stop();
    expect(release).toHaveBeenCalledOnce();
  });
  it('routes each retained editor create through the account creation queue', () => {
    const flow = mount();
    const [editor] = flow.render();
    const submit = vi.fn(),
      error = vi.fn();
    editor!.props.runCreate!(submit, error);
    expect(flow.creations.run).toHaveBeenCalledWith(1, submit, error);
  });
  it('clears a clean pending editor session when its inactive account retires the presentation', () => {
    const flow = mount();
    flow.controller.session!.selection.task = null;
    flow.controller.session!.selection.pendingCreationId = 42;
    const [hidden] = flow.render(false);
    hidden!.props.onRetire(false, null, null);
    expect(flow.controller.session).toBeNull();
    expect(flow.render(true)).toEqual([]);
  });
  it('does not close a newer editor when an older hidden presentation retires', () => {
    const flow = mount();
    const [old] = flow.render();
    flow.select(2);
    old!.props.onRetire(false, null, null);
    expect(flow.controller.session?.id).toBe(2);
  });

  it('closes a submitted edit immediately while keeping its receipt owner and preview', () => {
    const flow = mount();
    const [editor] = flow.render();
    const input = {
      accountId: 'account',
      taskId: 'task-1',
      listId: 'list',
      expectedRevision: 1,
      patch: { title: 'new title' },
    };
    editor!.props.onEditPending!(input);
    editor!.props.onBusyChange(true);
    editor!.props.onSubmitted!();
    expect(flow.edits.start).toHaveBeenCalledWith(1, editor!.props.selection.task, input);
    expect(flow.controller.session).toBe(null);
    expect(flow.render()[0]!.props.presented).toBe(false);
    expect(flow.edits.remove).not.toHaveBeenCalled();
    editor!.props.onSaved();
    expect(flow.edits.confirm).toHaveBeenCalledWith(1);
    expect(flow.render()).toEqual([]);
  });

  it('gives a new editor a separate owner and scopes late success to the old session', () => {
    const flow = mount();
    const [old] = flow.render();
    old!.props.onClose();
    flow.select(2);
    const [hidden, current] = flow.render();
    expect(hidden!.props.presented).toBe(false);
    expect(current!.props.presented).toBe(true);
    expect(current!.key).not.toBe(hidden!.key);
    old!.props.onSaved();
    expect(flow.controller.closeSaved).toHaveBeenLastCalledWith(1);
    expect(flow.controller.session?.id).toBe(2);
    const [remaining] = flow.render();
    expect(remaining!.key).toBe(current!.key);
    expect(remaining!.props.presented).toBe(true);
    old!.props.onDirtyChange(false);
    expect(flow.controller.setDirty).toHaveBeenCalledWith(false, 1);
  });

  it('reports a hidden failure without reopening it over another editor', () => {
    const flow = mount();
    const [old] = flow.render();
    flow.select(2);
    old!.props.onRetire(true, 'google rejected this change.', 'receipt-1');
    expect(flow.notice).toHaveBeenCalledWith(
      'saving task 1 needs attention. google rejected this change.',
      'receipt-1',
    );
    expect(flow.changed).toHaveBeenCalledOnce();
    expect(flow.controller.session?.id).toBe(2);
    expect(flow.render()).toHaveLength(1);
  });

  it('does not refresh data for a closed editor that never submitted work', () => {
    const flow = mount();
    const [editor] = flow.render();
    editor!.props.onClose();
    editor!.props.onRetire(false, null, null);
    expect(flow.changed).not.toHaveBeenCalled();
    expect(flow.notice).not.toHaveBeenCalled();
  });

  it('keeps a creation through its hidden save and confirms it before the list refresh', () => {
    const flow = mount();
    const [editor] = flow.render();
    const input = CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'ring64' });
    editor!.props.onCreatePending!(input);
    expect(flow.creations.start).toHaveBeenCalledWith(1, input, expect.any(Function));
    editor!.props.onClose();
    expect(flow.creations.remove).not.toHaveBeenCalled();
    editor!.props.onSaved();
    expect(flow.creations.confirm).toHaveBeenCalledWith(1);
    expect(flow.creations.remove).not.toHaveBeenCalled();
    expect(flow.changed).toHaveBeenCalledOnce();
  });

  it('resolves creation identity before asking views to refresh and binds edits to the captured local draft', () => {
    const flow = mount();
    const [editor] = flow.render();
    editor!.props.selection.task = null;
    const input = CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'ring64' });
    editor!.props.onCreatePending!(input);
    const edit = flow.creations.start.mock.calls[0]![2];
    edit({ ...input, title: 'newer title' });
    expect(flow.controller.editCreation).toHaveBeenCalledWith(1, editor!.props.selection, {
      ...input,
      title: 'newer title',
    });
    editor!.props.onSaved('receipt');
    expect(flow.creations.finish).toHaveBeenCalledWith(1, 'receipt');
    expect(flow.creations.confirm).not.toHaveBeenCalled();
    expect(flow.changed).not.toHaveBeenCalled();
  });

  it('retains an uncertain creation and its original receipt without recreating it', () => {
    const flow = mount();
    const [editor] = flow.render();
    editor!.props.selection.task = null;
    const input = CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'ring64' });
    flow.creations.items.push({ id: 1, input, confirmedAfter: null });
    editor!.props.onRetire(true, 'result unknown', 'receipt');
    expect(flow.creations.hold).toHaveBeenCalledWith(1, 'receipt', 'result unknown');
    expect(flow.creations.remove).not.toHaveBeenCalled();
    expect(flow.controller.recoverCreate).not.toHaveBeenCalled();
  });

  it('offers explicit draft editing after a known failed create saved no steps', () => {
    const flow = mount();
    const [editor] = flow.render();
    editor!.props.selection.task = null;
    const input = CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'ring64' });
    flow.creations.items.push({ id: 1, input, confirmedAfter: null });
    editor!.props.onRetire(true, 'invalid parent', 'receipt', true);
    expect(flow.creations.fail).toHaveBeenCalledWith(1, 'invalid parent', expect.any(Function));
    expect(flow.creations.hold).not.toHaveBeenCalled();
    flow.creations.fail.mock.calls[0]![2]();
    expect(flow.controller.recoverCreate).toHaveBeenCalledWith(editor!.props.selection, input);
  });

  it('hides presentation without unmounting an inactive account’s save owner', () => {
    const flow = mount();
    const [active] = flow.render();
    active!.props.onBusyChange(true);
    const [hidden] = flow.render(false);
    expect(hidden!.key).toBe(active!.key);
    expect(hidden!.props.presented).toBe(false);
    expect(flow.controller.setSaving).toHaveBeenLastCalledWith(1, true);
  });

  it('removes a failed creation without changing another session', () => {
    const flow = mount();
    const [editor] = flow.render();
    flow.select(2);
    editor!.props.onRetire(true, 'google rejected this change.', 'receipt-1');
    expect(flow.creations.remove).toHaveBeenCalledWith(1);
    expect(flow.controller.session?.id).toBe(2);
  });
});

it('keeps an unadmitted failed creation recoverable without interrupting a newer editor', () => {
  hooks.slots = [];
  hooks.index = 0;
  hooks.effects = [];
  const flow = mount();
  const [owner] = flow.render();
  owner!.props.selection.task = null;
  const input = CreateTaskSchema.parse({
    accountId: 'account',
    listId: 'list',
    title: 'keep my draft',
  });
  flow.creations.items.push({ id: 1, input, confirmedAfter: null });
  flow.select(2);
  const [hidden] = flow.render();
  hidden!.props.onRetire(true, 'list changed', null);
  expect(flow.creations.remove).not.toHaveBeenCalled();
  expect(flow.creations.fail).toHaveBeenCalledWith(1, 'list changed', expect.any(Function));
  expect(flow.controller.session?.id).toBe(2);
  expect(flow.notice).toHaveBeenCalledWith('couldn’t add keep my draft. list changed');
  const recover = flow.creations.fail.mock.calls[0]![2];
  recover();
  expect(flow.creations.remove).toHaveBeenCalledWith(1);
  expect(flow.controller.recoverCreate).toHaveBeenCalledWith(hidden!.props.selection, input);
});
