import { Children, isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  taskError: '',
  contextError: '',
  reload: vi.fn(),
  retry: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useMemo: (read: () => unknown) => read(),
  useEffect: () => {},
}));
vi.mock('../useTaskQuery', () => ({
  useTaskQuery: () => ({
    page: { items: [], matchedTaskIds: [], providerCoverage: { complete: true } },
    status: state.taskError ? 'error' : 'ready',
    settled: true,
    error: state.taskError,
    reload: state.reload,
  }),
}));
vi.mock('../useTaskListContexts', () => ({
  useTaskListContexts: () => ({
    items: [],
    contexts: [],
    settled: true,
    error: state.contextError,
    retry: state.retry,
  }),
}));

import { TaskCollectionWorkspace } from '../TaskCollectionWorkspace';

function retryButton() {
  const tree = TaskCollectionWorkspace({
    account: { id: 'account' },
    labels: [],
    filter: {},
    query: '',
    sort: 'manual',
    version: 0,
  } as unknown as Parameters<typeof TaskCollectionWorkspace>[0]);
  const error = Children.toArray(tree.props.children).find(
    (child) => isValidElement(child) && (child.props as { role?: string }).role === 'alert',
  ) as ReactElement<{ children: ReactElement[] }>;
  return error.props.children[1] as ReactElement<{ onClick(): void }>;
}

describe('collection failure recovery', () => {
  beforeEach(() => {
    state.taskError = '';
    state.contextError = '';
    vi.clearAllMocks();
  });

  it('retries failed list context without reloading successful task data', () => {
    state.contextError = 'could not load list context';
    retryButton().props.onClick();
    expect(state.retry).toHaveBeenCalledOnce();
    expect(state.reload).not.toHaveBeenCalled();
  });

  it('retries only task data when its context is already available', () => {
    state.taskError = 'could not load tasks';
    retryButton().props.onClick();
    expect(state.reload).toHaveBeenCalledOnce();
    expect(state.retry).not.toHaveBeenCalled();
  });

  it('retries both failed resources', () => {
    state.taskError = 'could not load tasks';
    state.contextError = 'could not load list context';
    retryButton().props.onClick();
    expect(state.reload).toHaveBeenCalledOnce();
    expect(state.retry).toHaveBeenCalledOnce();
  });
});
