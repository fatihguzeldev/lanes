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
it('captures a color-only command and restores the preview after rejection', async () => {
  let finish!: (value: null) => void;
  harness.submit.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const popover = render().find((node) => node.props.label === 'reading color')!;
  const picker = popover.props.children(vi.fn());
  const pending = picker.props.onChange('#bd91a1');
  expect(harness.submit).toHaveBeenCalledExactlyOnceWith(
    { kind: 'label.update', labelId: 'label', expectedRevision: 3, input: { color: '#bd91a1' } },
    'local',
  );
  expect(
    render().find((node) => node.props.label === 'reading color')!.props.trigger.props.value,
  ).toBe('#bd91a1');
  finish(null);
  await pending;
  expect(
    render().find((node) => node.props.label === 'reading color')!.props.trigger.props.value,
  ).toBe('#82966f');
});
it('finishes a name write before closing and preserves its captured revision', async () => {
  render()
    .find((node) => node.props['aria-label'] === 'edit reading')!
    .props.onClick();
  const nodes = render();
  const draft = nodes.find((node) => node.props.onReview)!;
  let finish!: (value: { state: string }) => void;
  harness.submit.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = draft.props.onSubmit('books', '#82966f', 'same-receipt');
  const dialog = nodes.find((node) => node.props.title === 'labels')!;
  expect(dialog.props.pending).toBeUndefined();
  dialog.props.onClose();
  expect(close).not.toHaveBeenCalled();
  expect(harness.submit).toHaveBeenCalledExactlyOnceWith(
    {
      kind: 'label.update',
      labelId: 'label',
      expectedRevision: 3,
      input: { name: 'books', color: '#82966f' },
    },
    'local',
    'same-receipt',
  );
  finish({ state: 'succeeded' });
  await pending;
  render();
  expect(close).toHaveBeenCalledOnce();
});
it('keeps a rejected name draft visible instead of completing its queued close', async () => {
  render()
    .find((node) => node.props['aria-label'] === 'edit reading')!
    .props.onClick();
  const nodes = render();
  let finish!: (value: null) => void;
  harness.submit.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = nodes
    .find((node) => node.props.onReview)!
    .props.onSubmit('books', '#82966f', 'receipt');
  nodes.find((node) => node.props.title === 'labels')!.props.onClose();
  harness.error = 'could not save';
  finish(null);
  await pending;
  expect(render().find((node) => node.props.onReview)?.props.error).toBe('could not save');
  expect(close).not.toHaveBeenCalled();
});
