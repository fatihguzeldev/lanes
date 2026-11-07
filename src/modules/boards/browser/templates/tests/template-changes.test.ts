import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTemplateChanges } from '../useTemplateChanges';
import type { PersonalTemplate } from '../template-model';
import type { ConnectionSummary } from '../../../../accounts/contracts/connection';
import { RequestError } from '../../../../../shared/browser/http/http';
import type { OperationSummary } from '../../../../operations/contracts/receipt';

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  identity: 0,
  effects: [] as Array<() => void>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => void) => hooks.effects.push(effect),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.values[index],
      (next: unknown) => {
        hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.values[index] ??= { current: initial };
    return hooks.values[index];
  },
}));
vi.mock('../../../../operations/browser/submission/operation-identity', () => ({
  newOperationId: () => `identity-${++hooks.identity}`,
}));
vi.mock('../../../../../shared/browser/connectivity/connectivity', () => ({
  serverConnection: () => 'reachable',
}));
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const template = {
  id: 'template',
  accountId: 'account',
  kind: 'list',
  revision: 1,
  name: 'original',
  description: '',
  contentRevision: 1,
} as PersonalTemplate;

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  hooks.values = [];
  hooks.index = 0;
  hooks.identity = 0;
});
function mount() {
  const submit = vi.fn<(...args: unknown[]) => Promise<OperationSummary | null>>(),
    onFailure = vi.fn(),
    changed = vi.fn();
  const options = {
    account: { id: 'account', state: 'connected' } as ConnectionSummary,
    clockOffset: 0,
    commands: { submit, getErrorDetails: (): RequestError | null => null },
    templates: [template],
    schedules: [],
    onChanged: changed,
    onFailure,
  };
  const render = () => {
    hooks.index = 0;
    hooks.effects = [];
    return useTemplateChanges(options);
  };
  return { submit, onFailure, changed, render, options };
}

describe('template background changes', () => {
  it('accepts immediately and renders captured metadata while its request is unresolved', async () => {
    const owner = mount();
    owner.submit.mockReturnValue(new Promise(() => {}));
    const accepted = owner.render().mutate({
      kind: 'template.list.update',
      templateId: 'template',
      revision: 1,
      input: { name: 'new name' },
    });
    expect(accepted).toBe(true);
    expect(owner.render().templates[0]).toMatchObject({ name: 'new name', revision: 2 });
    await tick();
    expect(owner.submit).toHaveBeenCalledWith(
      expect.objectContaining({ input: { name: 'new name' } }),
      'local',
      'identity-1',
    );
  });

  it('serializes a later edit with the predicted revision and keeps its own identity', async () => {
    const owner = mount();
    let resolve!: (result: OperationSummary) => void;
    owner.submit
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValue({ state: 'succeeded' } as OperationSummary);
    owner.render().mutate({
      kind: 'template.list.update',
      templateId: 'template',
      revision: 1,
      input: { name: 'first' },
    });
    owner.render().mutate({
      kind: 'template.list.update',
      templateId: 'template',
      revision: 2,
      input: { name: 'second' },
    });
    await tick();
    expect(owner.submit).toHaveBeenCalledOnce();
    resolve({ state: 'succeeded' } as OperationSummary);
    await tick();
    expect(owner.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 2, input: { name: 'second' } }),
      'local',
      'identity-2',
    );
    expect(owner.render().templates[0]?.name).toBe('second');
  });

  it('rolls back a failed intent and retains its draft without sending dependent stale edits', async () => {
    const owner = mount();
    owner.submit.mockResolvedValue(null);
    owner.render().mutate({
      kind: 'template.list.update',
      templateId: 'template',
      revision: 1,
      input: { name: 'first' },
    });
    owner.render().mutate({
      kind: 'template.list.update',
      templateId: 'template',
      revision: 2,
      input: { name: 'second' },
    });
    await tick();
    expect(owner.submit).toHaveBeenCalledOnce();
    expect(owner.render().templates[0]?.name).toBe('original');
    expect(owner.render().failures.map((failure) => failure.command)).toHaveLength(2);
    expect(owner.onFailure).toHaveBeenCalled();
  });
  it('keeps confirmed metadata until its read catches up without scheduling another render forever', async () => {
    const owner = mount();
    owner.submit.mockResolvedValue({ state: 'succeeded' } as OperationSummary);
    owner.render().mutate({
      kind: 'template.list.update',
      templateId: 'template',
      revision: 1,
      input: { name: 'new' },
    });
    await tick();
    expect(owner.render().templates[0]?.name).toBe('new');
    hooks.effects.forEach((effect) => effect());
    expect(owner.render().templates[0]?.name).toBe('new');
    owner.options.templates = [{ ...template, revision: 2, name: 'new' }];
    owner.render();
    hooks.effects.forEach((effect) => effect());
    owner.options.templates = [{ ...template, revision: 3, name: 'changed elsewhere' }];
    expect(owner.render().templates[0]?.name).toBe('changed elsewhere');
  });

  it('retains an ambiguous create identity and draft without automatically resending it', async () => {
    const owner = mount();
    owner.submit.mockResolvedValue(null);
    owner.options.commands.getErrorDetails = () =>
      new RequestError('server_unavailable', 'check this save', undefined, 'identity-1');
    owner.render().mutate({
      kind: 'template.list.create',
      input: {
        listId: 'list',
        listRevision: 1,
        name: 'keep this',
        description: 'draft',
        includeCompleted: false,
        dateMode: 'none',
      },
    });
    expect(owner.render().createdTemplates[0]?.name).toBe('keep this');
    await tick();
    expect(owner.render().failures[0]).toMatchObject({
      operationId: 'identity-1',
      retryable: false,
      command: { input: { name: 'keep this', description: 'draft' } },
    });
    expect(owner.submit).toHaveBeenCalledOnce();
    expect(owner.render().createdTemplates).toEqual([]);
  });
  it('keeps the earlier receipt reachable when a dependent change was not sent', async () => {
    const owner = mount();
    owner.submit.mockResolvedValue(null);
    owner.options.commands.getErrorDetails = () =>
      new RequestError('uncertain', 'inspect the first save', undefined, 'first-receipt');
    owner.render().mutate({
      kind: 'template.list.update',
      templateId: 'template',
      revision: 1,
      input: { name: 'first' },
    });
    owner.render().mutate({
      kind: 'template.list.update',
      templateId: 'template',
      revision: 2,
      input: { name: 'second' },
    });
    await tick();
    expect(owner.render().failures).toHaveLength(2);
    expect(owner.onFailure.mock.calls.map(([failure]) => failure.operationId)).toEqual([
      'first-receipt',
      'first-receipt',
    ]);
    expect(owner.render().failures[1]?.retryable).toBe(false);
  });
  it('protects a pending browser queue from page unload while account switching remains independent', async () => {
    const owner = mount();
    owner.submit.mockReturnValue(new Promise(() => {}));
    owner.render().mutate({
      kind: 'template.list.update',
      templateId: 'template',
      revision: 1,
      input: { name: 'new' },
    });
    owner.render();
    hooks.effects.forEach((effect) => effect());
    expect(window.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });
  it('shows a captured schedule immediately and keeps later edits behind its creation', async () => {
    const owner = mount();
    let finish!: (result: OperationSummary | null) => void;
    owner.submit.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    owner.render().mutate({
      kind: 'template.schedule.create',
      input: {
        template: { id: 'template', kind: 'list', contentRevision: 1 },
        boardId: 'board',
        boardRevision: 1,
        timing: { frequency: 'weekly', weekday: 1, zone: 'UTC', startsOn: '2026-11-07' },
        useRelativeDates: true,
        listPrefix: '',
      },
    });
    const schedule = owner.render().schedules[0]!;
    expect(schedule).toMatchObject({ id: 'schedule:identity-1', state: 'active', revision: 0 });
    owner.render().mutate({
      kind: 'template.schedule.pause',
      scheduleId: schedule.id,
      revision: schedule.revision,
    });
    expect(owner.render().schedules[0]?.state).toBe('paused');
    await tick();
    finish(null);
    await tick();
    expect(owner.submit).toHaveBeenCalledOnce();
    expect(owner.render().schedules).toEqual([]);
    expect(owner.render().failures).toHaveLength(2);
  });
});
