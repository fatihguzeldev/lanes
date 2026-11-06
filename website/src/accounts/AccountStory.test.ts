import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoAccountMenu } from '../demo/DemoAccountMenu';
import { PreviewTaskDialogs } from '../details/PreviewTaskDialogs';
import { TaskCard } from '../details/TaskCard';
import { AccountStory } from './AccountStory';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (initial: unknown) => ({ current: initial }),
  useLayoutEffect: () => {},
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next;
      },
    ];
  },
}));

function elements(node: ReactNode): ReactElement[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement(child)
      ? [child, ...elements((child.props as { children?: ReactNode }).children)]
      : [],
  );
}
function render() {
  hooks.index = 0;
  const nodes = elements(AccountStory());
  const menu = nodes.find((node) => node.type === DemoAccountMenu)!.props as ComponentProps<
    typeof DemoAccountMenu
  >;
  const cards = nodes
    .filter((node) => node.type === TaskCard)
    .map((node) => node.props as ComponentProps<typeof TaskCard>);
  const dialogs = nodes.find((node) => node.type === PreviewTaskDialogs)!.props as ComponentProps<
    typeof PreviewTaskDialogs
  >;
  const lists = nodes
    .filter((node) => (node.props as { className?: string }).className === 'account-story__list')
    .map((node) => (node.props as { 'aria-label': string })['aria-label']);
  return { menu, cards, lists, dialogs, editor: cards[0]!.editor };
}

describe('account workspace', () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.index = 0;
  });

  it('changes four tasks and their two lists with the selected account', () => {
    const personal = render();
    expect(personal.menu.account.email).toBe('fatih@personal.example');
    expect(personal.cards).toHaveLength(4);
    expect(personal.lists).toEqual(['weekend plans', 'life admin']);
    personal.menu.onSelect('work');
    const work = render();
    expect(work.menu.account.email).toBe('fatih@work.example');
    expect(work.cards).toHaveLength(4);
    expect(work.lists).toEqual(['in progress', 'follow up']);
    expect(
      work.cards.every(({ task }) => !personal.cards.some((card) => card.task.id === task.id)),
    ).toBe(true);
    work.menu.onSelect('personal');
    expect(render().cards.map(({ task }) => task)).toEqual(personal.cards.map(({ task }) => task));
  });

  it('retains saved edits, completion and stars in their owning accounts', () => {
    const first = render().cards[0]!.task;
    render().editor.open(first);
    render().editor.patch({ title: 'find a new trail' });
    render().editor.save();
    const second = render().cards[1]!.task;
    render().editor.complete(second, true);
    render().menu.onSelect('work');
    const work = render().cards[0]!.task;
    render().editor.star(work, true);
    render().menu.onSelect('personal');
    expect(render().cards.find(({ task }) => task.id === first.id)?.task.title).toBe(
      'find a new trail',
    );
    expect(render().cards.find(({ task }) => task.id === second.id)?.task.completed).toBe(true);
    render().menu.onSelect('work');
    expect(render().cards.find(({ task }) => task.id === work.id)?.task.starred).toBe(true);
  });

  it('protects a dirty draft before switching accounts', () => {
    render().editor.open(render().cards[0]!.task);
    render().editor.patch({ notes: 'keep this draft' });
    render().menu.onSelect('work');
    expect(render().menu.account.id).toBe('personal');
    render().dialogs.onKeepEditing();
    expect(render().editor.draft?.notes).toBe('keep this draft');
    render().menu.onSelect('work');
    render().dialogs.onDiscard();
    expect(render().menu.account.id).toBe('work');
    expect(render().editor.draft).toBeNull();
  });
});
