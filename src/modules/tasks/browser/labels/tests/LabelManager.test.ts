import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { LabelManager } from '../LabelManager';
import type { ConnectionSummary } from '../../../../accounts/contracts/connection';

const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  submit: vi.fn(),
  busy: false,
  error: '',
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots))
      harness.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      harness.slots[index],
      (value: any) => {
        harness.slots[index] = typeof value === 'function' ? value(harness.slots[index]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    return (harness.slots[harness.cursor++] ??= { current: initial });
  },
  useEffect(effect: () => void) {
    harness.effects.push(effect);
  },
}));
vi.mock('../../../../../shared/browser/connectivity/useServerConnection', () => ({
  useServerConnection: () => 'reachable',
}));
vi.mock('../../../../operations/browser/submission/useCommands', () => ({
  useCommands: () => ({ busy: harness.busy, error: harness.error, submit: harness.submit }),
}));
vi.mock('../../../../../shared/browser/resources/usePagedResource', () => ({
  usePagedResource: (scope: string) => ({
    items: scope.endsWith('manage-labels')
      ? [{ id: 'label', accountId: 'account', name: 'reading', color: '#82966f', revision: 3 }]
      : [],
    loaded: true,
    status: 'ready',
    error: '',
  }),
}));
type Element = ReactElement<Record<string, any>>;
const close = vi.fn();
function render() {
  harness.cursor = 0;
  harness.effects = [];
  const root = LabelManager({
    account: { id: 'account', state: 'connected' } as ConnectionSummary,
    anchor: {} as HTMLElement,
    version: 0,
    clockOffset: 0,
    onChanged: vi.fn(),
    onClose: close,
  });
  harness.effects.forEach((effect) => effect());
  const nodes: Element[] = [];
  const walk = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, any>>(child)) return;
      nodes.push(child);
      walk(child.props.children);
    });
  walk(root);
  return nodes;
}
beforeEach(() => {
  harness.slots = [];
  harness.busy = false;
  harness.error = '';
  harness.submit.mockReset();
  close.mockClear();
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
it('captures a color-only command, closes the picker immediately, and rolls back after rejection', async () => {
  let finish!: (value: null) => void;
  harness.submit.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  const popover = render().find((node) => node.props.label === 'reading color')!;
  const closePicker = vi.fn();
  const picker = popover.props.children(closePicker);
  await picker.props.onChange('#bd91a1');
  expect(closePicker).toHaveBeenCalledOnce();
  expect(harness.submit).toHaveBeenCalledExactlyOnceWith(
    { kind: 'label.update', labelId: 'label', expectedRevision: 3, input: { color: '#bd91a1' } },
    'local',
    expect.any(String),
  );
  expect(
    render().find((node) => node.props.label === 'reading color')!.props.trigger.props.value,
  ).toBe('#bd91a1');
  expect(render().find((node) => node.props['aria-label'] === 'edit reading')!.props.disabled).toBe(
    false,
  );
  finish(null);
  await flush();
  expect(
    render().find((node) => node.props.label === 'reading color')!.props.trigger.props.value,
  ).toBe('#82966f');
});
it('hides a captured name edit immediately and keeps its owner while closed', async () => {
  render()
    .find((node) => node.props['aria-label'] === 'edit reading')!
    .props.onClick();
  const draft = render().find((node) => node.props.onSubmit)!;
  let finish!: (value: { state: string }) => void;
  harness.submit.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  await draft.props.onSubmit('books', '#82966f');
  const nodes = render();
  expect(nodes.some((node) => node.props.onSubmit)).toBe(false);
  expect(nodes.find((node) => node.type === 'strong')?.props.children).toBe('books');
  expect(nodes.find((node) => node.props.className === 'label-manager__new')!.props.disabled).toBe(
    false,
  );
  nodes.find((node) => node.props.label === 'labels')!.props.onClose();
  expect(render().some((node) => node.props.label === 'labels')).toBe(false);
  expect(close).not.toHaveBeenCalled();
  finish({ state: 'succeeded' });
  await flush();
  render();
  expect(close).toHaveBeenCalledOnce();
});
it('accepts a second new label while the first is still queued', async () => {
  render()
    .find((node) => node.props.className === 'label-manager__new')!
    .props.onClick();
  let finish!: (value: { state: string }) => void;
  harness.submit
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    .mockResolvedValue({ state: 'succeeded' });
  await render()
    .find((node) => node.props.onSubmit)!
    .props.onSubmit('books', '#82966f');
  render()
    .find((node) => node.props.className === 'label-manager__new')!
    .props.onClick();
  await render()
    .find((node) => node.props.onSubmit)!
    .props.onSubmit('projects', '#bd91a1');
  const captured = render();
  expect(
    captured.filter((node) => node.type === 'strong').map((node) => node.props.children),
  ).toEqual(['reading', 'books', 'projects']);
  expect(harness.submit).toHaveBeenCalledOnce();
  finish({ state: 'succeeded' });
  await flush();
  expect(harness.submit).toHaveBeenCalledTimes(2);
});
it('keeps failure recovery separate from a newer draft and retries the exact captured command', async () => {
  render()
    .find((node) => node.props['aria-label'] === 'edit reading')!
    .props.onClick();
  let finish!: (value: null) => void;
  harness.submit
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    .mockResolvedValue({ state: 'succeeded' });
  await render()
    .find((node) => node.props.onSubmit)!
    .props.onSubmit('books', '#82966f');
  render()
    .find((node) => node.props.className === 'label-manager__new')!
    .props.onClick();
  finish(null);
  await flush();
  const nodes = render();
  expect(nodes.find((node) => node.props.onSubmit)!.props.label).toBeNull();
  nodes
    .find((node) => node.type === 'button' && node.props.children === 'retry this save')!
    .props.onClick();
  await flush();
  expect(harness.submit.mock.calls[1]).toEqual(harness.submit.mock.calls[0]);
});
