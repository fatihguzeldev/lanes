import {
  Children,
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { Popover } from '../../../../../shared/ui/popover/Popover';
import { TaskLabelPicker, TaskLabelChips } from '../TaskLabelPicker';

let surface: ComponentProps<typeof Popover>;
vi.mock('../../../../../shared/ui/popover/Popover', () => ({
  Popover: (props: ComponentProps<typeof Popover>) => {
    surface = props;
    return createElement(
      'div',
      null,
      props.trigger,
      typeof props.children === 'function'
        ? props.children(vi.fn(), {} as HTMLElement)
        : props.children,
    );
  },
}));
const labels = [
  { id: 'reading', accountId: 'account', name: 'reading', color: '#82966f', revision: 1 },
  { id: 'work', accountId: 'account', name: 'work', color: '#849aaf', revision: 1 },
];
const base = { labels, selected: [] as string[], disabled: false, onToggle: vi.fn() };
function nodes(node: ReactNode): Record<string, any>[] {
  const result: Record<string, any>[] = [];
  Children.forEach(node, (child) => {
    if (isValidElement<Record<string, any>>(child)) {
      result.push(child.props);
      result.push(...nodes(child.props.children));
    }
  });
  return result;
}
function choices(props: Partial<ComponentProps<typeof TaskLabelPicker>> = {}) {
  renderToStaticMarkup(createElement(TaskLabelPicker, { ...base, ...props }));
  if (typeof surface.children !== 'function') throw new Error('expected picker content');
  return nodes(surface.children(vi.fn(), {} as HTMLElement));
}
beforeEach(() => vi.clearAllMocks());
it('keeps selected labels removable when the selection reaches twenty', () => {
  const controls = choices({
    selected: ['reading', ...Array.from({ length: 19 }, (_, i) => 'unloaded-' + i)],
  });
  expect(controls.find((item) => item['aria-label'] === 'reading')?.disabled).toBe(false);
  expect(controls.find((item) => item['aria-label'] === 'work')?.disabled).toBe(true);
  controls.find((item) => item['aria-label'] === 'reading')?.onClick();
  expect(base.onToggle).toHaveBeenCalledExactlyOnceWith('reading');
});
it('prevents adding a label being deleted, while allowing removal', () => {
  expect(
    choices({ deleting: new Set(['reading']) }).find((item) => item['aria-label'] === 'reading')
      ?.disabled,
  ).toBe(true);
  expect(
    choices({ deleting: new Set(['reading']), selected: ['reading'] }).find(
      (item) => item['aria-label'] === 'reading',
    )?.disabled,
  ).toBe(false);
});
it('offers creation directly in an empty picker without a quota counter', () => {
  const manage = vi.fn();
  const controls = choices({ labels: [], onManage: manage });
  controls.find((item) => Children.toArray(item.children).includes('new label'))?.onClick();
  expect(manage).toHaveBeenCalledExactlyOnceWith(expect.any(Object), true);
  const html = renderToStaticMarkup(
    createElement(TaskLabelPicker, { ...base, labels: [], onManage: manage }),
  );
  expect(html).not.toContain('0/20');
  expect(html).toContain('search labels');
});
it('preserves unloaded label ids as removable chips and follows the read-only state', () => {
  const html = renderToStaticMarkup(
    createElement(TaskLabelChips, { ...base, selected: ['reading', 'unloaded'], disabled: true }),
  );
  expect(html).toContain('remove reading');
  expect(html).toContain('remove unloaded label');
  expect(html.match(/disabled=""/g)).toHaveLength(2);
  expect(renderToStaticMarkup(createElement(TaskLabelChips, base))).toBe('');
});

it('does not submit the task when enter is pressed in label search', () => {
  const preventDefault = vi.fn();
  choices()
    .find((item) => item['aria-label'] === 'search labels')!
    .onKeyDown({ key: 'Enter', preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
});

it('offers the remaining label pages without claiming the list is empty', () => {
  const loadMore = vi.fn();
  const controls = choices({
    labels: [],
    page: { nextCursor: 'next', status: 'ready', error: '', loadMore, reload: vi.fn() },
  });
  controls.find((item) => item.children === 'more labels')!.onClick();
  expect(loadMore).toHaveBeenCalledOnce();
  expect(controls.some((item) => item.children === 'no labels yet.')).toBe(false);
});
