import {
  Children,
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Popover } from '../../../../../shared/ui/popover/Popover';
import { WorkspaceViewMenu } from '../WorkspaceViewMenu';

let surface: ComponentProps<typeof Popover>;
vi.mock('../../../../../shared/ui/popover/Popover', () => ({
  Popover: (props: ComponentProps<typeof Popover>) => {
    surface = props;
    return createElement('button', { 'aria-label': props.label }, props.trigger);
  },
}));

const props: ComponentProps<typeof WorkspaceViewMenu> = {
  allowLayout: true,
  view: 'board',
  sort: 'manual',
  filter: {},
  lists: [],
  labels: [],
  today: '2026-11-05',
  moreLists: false,
  moreLabels: false,
  onView: vi.fn(),
  onSort: vi.fn(),
  onFilter: vi.fn(),
  onClear: vi.fn(),
  onMoreLists: vi.fn(),
  onMoreLabels: vi.fn(),
};

function findBoardAction(node: ReactNode): (() => void) | undefined {
  let action: (() => void) | undefined;
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
    if (
      child.type === 'button' &&
      Children.toArray(child.props.children).includes(' board options')
    )
      action = child.props.onClick;
    else action ??= findBoardAction(child.props.children);
  });
  return action;
}

describe('workspace view menu', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps active filters visible and named when the board title is the trigger', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceViewMenu, {
        ...props,
        trigger: 'november',
        label: 'view options for november',
        filter: { starred: true },
      }),
    );
    expect(html).toContain('aria-label="view options for november, filters active"');
    expect(html).toContain('november');
    expect(html).toContain('workspace-view-menu__filter-dot');
  });

  it('does not signal active filters in the default unfiltered menu', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceViewMenu, props));
    expect(html).toContain('aria-label="view options"');
    expect(html).not.toContain('workspace-view-menu__filter-dot');
  });

  it('opens board options from the stable trigger after closing its current menu', () => {
    const order: string[] = [];
    const close = vi.fn(() => order.push('close'));
    const onBoardOptions = vi.fn(() => order.push('board'));
    const anchor = {} as HTMLElement;
    renderToStaticMarkup(createElement(WorkspaceViewMenu, { ...props, onBoardOptions }));
    expect(typeof surface.children).toBe('function');
    if (typeof surface.children !== 'function') throw new Error('expected a menu renderer');
    const action = findBoardAction(surface.children(close, anchor));
    expect(action).toBeDefined();
    action?.();
    expect(onBoardOptions).toHaveBeenCalledWith(anchor);
    expect(order).toEqual(['close', 'board']);
  });
});
