import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Confirmation } from '../Confirmation';
import { PromptDialog } from '../PromptDialog';

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
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.values[index] ??= { current: initial };
    return hooks.values[index];
  },
}));
vi.mock('../operation-identity', () => ({ newOperationId: () => 'captured-identity' }));

type Element = ReactElement<{
  children?: unknown;
  onClick?: () => void;
  onSubmit?: (event: { preventDefault(): void }) => void;
}>;
function find(
  view: unknown,
  type: string,
  predicate: (view: Element) => boolean = () => true,
): Element {
  if (Array.isArray(view)) {
    for (const child of view) {
      try {
        return find(child, type, predicate);
      } catch {}
    }
  } else if (view && typeof view === 'object' && 'props' in view) {
    const element = view as Element;
    if (element.type === type && predicate(element)) return element;
    return find(element.props.children, type, predicate);
  }
  throw new Error(`missing ${type}`);
}

beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
});

describe('confirmed presentation dismissal', () => {
  it('closes at capture, keeps one identity, and does not wait for the receipt', () => {
    const submit = vi.fn(() => new Promise<boolean>(() => {})),
      close = vi.fn();
    const view = Confirmation({
      choice: { title: 'delete', message: 'sure?', confirmLabel: 'delete', onConfirm: submit },
      clockOffset: 0,
      onClose: close,
    });
    const confirm = find(view, 'button', (node) => node.props.children === 'delete');
    confirm.props.onClick!();
    confirm.props.onClick!();
    expect(close).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledExactlyOnceWith('captured-identity');
  });

  it('keeps invalid confirmation text editable before capture', () => {
    const submit = vi.fn(),
      close = vi.fn(),
      validate = vi.fn(() => 'enter the board name');
    const view = PromptDialog({
      prompt: { title: 'delete', label: 'name', initial: '', validate, submit },
      clockOffset: 0,
      onClose: close,
    });
    find(view, 'form').props.onSubmit!({ preventDefault() {} });
    expect(validate).toHaveBeenCalledWith('');
    expect(close).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('closes a valid prompt without waiting for its background save', () => {
    const submit = vi.fn(() => new Promise<boolean>(() => {})),
      close = vi.fn();
    const view = PromptDialog({
      prompt: { title: 'delete', label: 'name', initial: 'board', submit },
      clockOffset: 0,
      onClose: close,
    });
    const form = find(view, 'form');
    form.props.onSubmit!({ preventDefault() {} });
    form.props.onSubmit!({ preventDefault() {} });
    expect(close).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledExactlyOnceWith('board', 'captured-identity');
  });
});
