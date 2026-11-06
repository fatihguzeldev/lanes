import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { TaskFilters } from '../TaskFilters';
import type { TaskFilter } from '../../../../tasks/contracts/task';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
}));
const change = vi.fn();
const clear = vi.fn();
type Element = ReactElement<Record<string, any>>;
function controls(filter: TaskFilter = {}) {
  const nodes: Element[] = [];
  const walk = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, any>>(child)) return;
      nodes.push(child);
      walk(child.props.children);
    });
  walk(
    TaskFilters({
      filter,
      lists: [],
      labels: [],
      today: '2026-11-06',
      onChange: change,
      onClear: clear,
      onMoreLists: vi.fn(),
      onMoreLabels: vi.fn(),
    }),
  );
  return nodes;
}
beforeEach(() => vi.clearAllMocks());
it('applies a selection directly without submitting or closing a form', () => {
  const nodes = controls();
  nodes.find((node) => node.props['aria-label'] === 'star')!.props.onChange('true');
  expect(change).toHaveBeenCalledExactlyOnceWith({ starred: true });
  expect(nodes.some((node) => node.type === 'form' || node.props.type === 'submit')).toBe(false);
});
it('removes the default completion filter', () => {
  controls({ completion: 'all' })
    .find((node) => node.props['aria-label'] === 'completion')!
    .props.onChange('open');
  expect(change).toHaveBeenCalledExactlyOnceWith({});
});
it('keeps an invalid date range out of the active query', () => {
  const nodes = controls({ scheduled: { kind: 'range', from: '2026-11-05', to: '2026-11-06' } });
  nodes
    .find((node) => node.props.type === 'date')!
    .props.onChange({ target: { value: '2026-11-07' } });
  expect(change).not.toHaveBeenCalled();
});
it('applies a corrected date range and clears directly', () => {
  const nodes = controls({ scheduled: { kind: 'range', from: '2026-11-05', to: '2026-11-06' } });
  nodes
    .find((node) => node.props.type === 'date')!
    .props.onChange({ target: { value: '2026-11-04' } });
  expect(change).toHaveBeenCalledExactlyOnceWith({
    scheduled: { kind: 'range', from: '2026-11-04', to: '2026-11-06' },
  });
  nodes
    .find((node) => node.type === 'button' && node.props.children === 'clear all')!
    .props.onClick();
  expect(clear).toHaveBeenCalledOnce();
});
