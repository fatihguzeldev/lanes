import { beforeEach, expect, it, vi } from 'vitest';
import type { Label } from '../../../contracts/task';
import { useLabelChanges } from '../useLabelChanges';
const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as any[],
  effects: [] as (() => void)[],
  identity: 0,
}));
const read = vi.hoisted(() => vi.fn());
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const slot = (harness.slots[harness.cursor++] ??= { value: initial });
    return [slot.value, (next: unknown) => (slot.value = next)];
  },
  useRef(initial: unknown) {
    return (harness.slots[harness.cursor++] ??= { current: initial });
  },
  useEffect(effect: () => void) {
    harness.effects.push(effect);
  },
}));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: read }));
vi.mock('../../../../operations/browser/submission/operation-identity', () => ({
  newOperationId: () => `identity-${++harness.identity}`,
}));
const label: Label = {
  id: 'label',
  accountId: 'account',
  name: 'reading',
  color: '#82966f',
  revision: 3,
};
const submit = vi.fn(),
  error = vi.fn(),
  deleted = vi.fn();
function render(labels: readonly Label[] = [label]) {
  harness.cursor = 0;
  harness.effects = [];
  const result = useLabelChanges({
    accountId: 'account',
    clockOffset: 0,
    version: 0,
    labels,
    inventoryReady: true,
    submit,
    onError: error,
    onChanged: vi.fn(),
    onDeleted: deleted,
  });
  harness.effects.forEach((effect) => effect());
  return result;
}
const flush = async () => {
  for (let n = 0; n < 6; n++) await Promise.resolve();
};
beforeEach(() => {
  harness.slots = [];
  harness.identity = 0;
  submit.mockReset();
  error.mockReset();
  read.mockReset();
  deleted.mockReset();
  submit.mockResolvedValue({ state: 'succeeded' });
  read.mockResolvedValue({ items: [{ ...label, revision: 9, color: '#bd91a1' }] });
});
it('accepts rapid color/name changes and rebases the next command from the actual resource revision', async () => {
  let finish!: (result: { state: string }) => void;
  submit.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  render().change(label, { color: '#bd91a1' });
  render().change(label, { name: 'books' });
  expect(render().labels[0]).toMatchObject({ color: '#bd91a1', name: 'books' });
  expect(submit).toHaveBeenCalledOnce();
  finish({ state: 'succeeded' });
  await flush();
  expect(submit.mock.calls[1]?.[0]).toEqual({
    kind: 'label.update',
    labelId: 'label',
    expectedRevision: 9,
    input: { name: 'books' },
  });
  expect(read).toHaveBeenCalledExactlyOnceWith(
    '/api/accounts/account/labels/resolve',
    expect.anything(),
    { method: 'POST', body: { ids: ['label'] } },
  );
});
it('rolls back a rejected change and dependent work without dropping an independent label create', async () => {
  let finish!: (result: null) => void;
  submit.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  render().change(label, { color: '#bd91a1' });
  render().change(label, { name: 'books' });
  render().create('projects', '#82966f');
  finish(null);
  await flush();
  expect(submit).toHaveBeenCalledTimes(2);
  expect(render().labels.map((item) => item.name)).toEqual(['reading', 'projects']);
  expect(render().failures).toHaveLength(2);
  expect(render().failures[1]?.input).toEqual({ name: 'books' });
  expect(render().failures[1]?.command).toBeUndefined();
});
it('uses the admitted deterministic label identity for edits captured before creation finishes', async () => {
  let finish!: (result: { state: string }) => void;
  submit.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  render().create('projects', '#82966f');
  const created = render().labels.find((item) => item.name === 'projects')!;
  expect(created.id).toBe('label:identity-1');
  render().change(created, { color: '#bd91a1' });
  read.mockResolvedValueOnce({ items: [created] });
  finish({ state: 'succeeded' });
  await flush();
  expect(submit.mock.calls[1]?.[0]).toMatchObject({
    labelId: created.id,
    expectedRevision: 0,
    input: { color: '#bd91a1' },
  });
});
it('does not overwrite a label field changed elsewhere while a prior action was saving', async () => {
  let finish!: (result: { state: string }) => void;
  submit.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  render().change(label, { color: '#bd91a1' });
  render().change(label, { name: 'books' });
  read.mockResolvedValueOnce({
    items: [{ ...label, color: '#bd91a1', name: 'someone else renamed this', revision: 10 }],
  });
  finish({ state: 'succeeded' });
  await flush();
  expect(submit).toHaveBeenCalledOnce();
  expect(render().failures[0]?.input).toEqual({ name: 'books' });
  expect(error).toHaveBeenCalledWith(expect.stringContaining('changed elsewhere'), undefined);
});
