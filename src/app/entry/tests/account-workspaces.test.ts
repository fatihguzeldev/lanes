import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountWorkspaces } from '../AccountWorkspaces';
import type { Workspace } from '../../workspace/Workspace';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.values[index] ??= { current: initial };
    return hooks.values[index];
  },
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
function mount() {
  const account = (id: string) => ({ id, displayName: id, email: `${id}@example.com` });
  const a = account('a'),
    b = account('b');
  const props = {
    selected: a,
    accounts: [a, b],
    clockOffset: 0,
    theme: 'light',
    loadingInitial: null,
    onTheme() {},
    onSelectAccount: vi.fn(),
    onAuthorize() {},
    onAccountsChanged() {},
    onSignOut() {},
  } as unknown as ComponentProps<typeof AccountWorkspaces>;
  const render = (selected = a) => {
    hooks.index = 0;
    return AccountWorkspaces({ ...props, selected: selected as typeof props.selected });
  };
  function owners(view: ReturnType<typeof render>) {
    return (
      view.props.children[0] as ReactElement<{
        children: ReactElement<ComponentProps<typeof Workspace>>;
      }>[]
    ).map((node) => node.props.children);
  }
  return { a, b, render, owners, props };
}

describe('account mutation owner lifetime', () => {
  it('keeps only visited account owners and preserves the previous owner when switching', () => {
    const app = mount();
    expect(app.owners(app.render()).map((owner) => owner.props.account.id)).toEqual(['a']);
    const owners = app.owners(app.render(app.b));
    expect(owners.map((owner) => [owner.key, owner.props.active])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('makes an inactive account failure visible without bypassing the normal account guard', () => {
    const app = mount();
    app.render();
    const a = app.owners(app.render(app.b))[0]!;
    a.props.onBackgroundNotice!('could not save', 'receipt-a');
    const notice = app.render(app.b).props.children[1] as ReactElement<{
      children: ReactElement<{ onClick(): void }>[];
    }>;
    expect(notice).toBeTruthy();
    notice.props.children[1]!.props.onClick();
    expect(app.props.onSelectAccount).not.toHaveBeenCalled();
    expect(app.render(app.b).props.children[1]).toBeFalsy();
  });
});
