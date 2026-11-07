import type { ReactElement, ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateDialog, useTemplateDialog } from '../TemplateDialog';
import type { TemplateWorkspace } from '../TemplateWorkspace';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.values[index],
      (next: unknown) => {
        hooks.values[index] = next;
      },
    ];
  },
}));
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
});

describe('template presentation lifetime', () => {
  it('keeps its admitted command owner after closing, with no mounted dialog view', () => {
    const render = () => {
      hooks.index = 0;
      return useTemplateDialog();
    };
    render().show();
    const props = {
      controller: render(),
      account: { id: 'account' },
      clockOffset: 0,
      version: 0,
      guard: (action: () => void) => action(),
      onChanged() {},
      onInspect() {},
      onRefreshInventory() {},
    } as unknown as ComponentProps<typeof TemplateDialog>;
    const open = TemplateDialog(props)!;
    expect(
      (open.props.children as ReactElement<ComponentProps<typeof TemplateWorkspace>>).props
        .presented,
    ).toBe(true);
    props.controller.close();
    const closed = TemplateDialog({ ...props, controller: render() })!;
    const workspace = closed.props.children as ReactElement<
      ComponentProps<typeof TemplateWorkspace>
    >;
    expect(workspace.type).toBe((open.props.children as ReactElement).type);
    expect(workspace.props.presented).toBe(false);
  });

  it('hides a retained account’s template presentation while keeping its owner', () => {
    const render = () => {
      hooks.index = 0;
      return useTemplateDialog();
    };
    render().show();
    const view = TemplateDialog({
      controller: render(),
      account: { id: 'account' },
      clockOffset: 0,
      version: 0,
      active: false,
      guard() {},
      onChanged() {},
      onInspect() {},
      onRefreshInventory() {},
    } as unknown as ComponentProps<typeof TemplateDialog>)!;
    expect(
      (view.props.children as ReactElement<ComponentProps<typeof TemplateWorkspace>>).props
        .presented,
    ).toBe(false);
  });
});
