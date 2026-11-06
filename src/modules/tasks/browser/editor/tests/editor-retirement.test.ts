import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskEditorWorkspace } from '../TaskEditorWorkspace';
import type { TaskEditor } from '../TaskEditor';

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as Array<() => unknown>,
  commands: {
    busy: false,
    latest: null as { id: string; state: string } | null,
    error: '',
    errorDetails: null as { operationId: string } | null,
    submit: vi.fn(),
    clearError: vi.fn(),
  },
  repeat: { busy: false, error: '', run: vi.fn() },
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
  newOperationId: () => 'receipt',
}));
vi.mock('../../../../../shared/browser/connectivity/useServerConnection', () => ({
  useServerConnection: () => 'reachable',
}));
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

function mount(inlineCreate = false) {
  const retire = vi.fn(),
    saved = vi.fn();
  const props = {
    account: { id: 'account', state: 'connected', planningZone: 'UTC' },
    selection: {
      task: inlineCreate ? null : { id: 'task', blockedBy: [] },
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
  const save = () => {
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
    });
    return resolve;
  };
  return { retire, saved, render, save };
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
  });

  it('retires a recovered confirmed receipt even when submit returned null', async () => {
    const editor = mount();
    const resolve = editor.save();
    state.commands.latest = { id: 'receipt', state: 'succeeded' };
    state.commands.error = 'connection lost while saving';
    editor.render(false);
    expect(editor.retire).not.toHaveBeenCalled();
    resolve(null);
    await Promise.resolve();
    editor.render(false);
    expect(editor.retire).toHaveBeenCalledWith(true, null, 'receipt');
    expect(editor.saved).not.toHaveBeenCalled();
  });

  it('does not retire normal success before its awaited continuation completes', async () => {
    const editor = mount();
    const resolve = editor.save();
    state.commands.latest = { id: 'receipt', state: 'succeeded' };
    editor.render(false);
    expect(editor.retire).not.toHaveBeenCalled();
    resolve({ id: 'receipt', state: 'succeeded' });
    await Promise.resolve();
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

  it('does not announce a deliberately discarded creation that was rejected before capture', () => {
    const editor = mount(true);
    state.commands.busy = true;
    editor.render();
    state.commands.busy = false;
    state.commands.error = 'the name was rejected';
    editor.render(false);
    expect(editor.retire).toHaveBeenCalledWith(true, null, null);
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
});
