import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShowcasePlayback } from '../useShowcasePlayback';
import type { PlaybackContext } from '../playback-clock';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (value: unknown) => {
        hooks.slots[index] = value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.slots[index] ??= { current: initial };
    return hooks.slots[index];
  },
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
    const index = hooks.index++;
    const previous = hooks.slots[index] as unknown[] | undefined;
    if (previous?.every((value, index) => Object.is(value, dependencies[index]))) return;
    hooks.slots[index] = dependencies;
    hooks.effects.push(effect);
  },
}));

let intersect: (ratio: number) => void;
let page: EventTarget & { hidden: boolean };
let motion: EventTarget & { matches: boolean };
const rootRef = { current: {} as HTMLElement };
const cleanups: Array<() => void> = [];
let run: ReturnType<typeof vi.fn<(context: PlaybackContext) => Promise<void>>>;
let reset: ReturnType<typeof vi.fn<() => void>>;
function render(suspended = false) {
  hooks.index = 0;
  const result = useShowcasePlayback({ rootRef, run, onReplay: reset, suspended });
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  return result;
}
function hidden(value: boolean) {
  page.hidden = value;
  page.dispatchEvent(new Event('visibilitychange'));
}

describe('showcase playback lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    hooks.slots = [];
    hooks.index = 0;
    hooks.effects = [];
    page = Object.assign(new EventTarget(), { hidden: false });
    motion = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal('document', page);
    vi.stubGlobal('window', { matchMedia: () => motion });
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = (ratio) =>
            callback(
              [
                {
                  isIntersecting: ratio > 0,
                  intersectionRatio: ratio,
                } as IntersectionObserverEntry,
              ],
              this as unknown as IntersectionObserver,
            );
        }
        observe() {}
        disconnect() {}
      },
    );
    run = vi.fn(async () => {});
    reset = vi.fn();
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await Promise.resolve();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('autoplays once at 55% visibility and keeps its finished state on re-entry', async () => {
    render();
    intersect(0.54);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    intersect(0.55);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    expect(render().status).toBe('finished');
    intersect(0);
    intersect(1);
    expect(run).toHaveBeenCalledOnce();
    expect(render().status).toBe('finished');
  });

  it('pauses hidden time and resumes the same run when it is visible again', async () => {
    const write = vi.fn();
    run = vi.fn(async (context) => {
      await context.wait(1000);
      write();
    });
    render();
    intersect(0.8);
    await vi.advanceTimersByTimeAsync(400);
    hidden(true);
    expect(render().status).toBe('paused');
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).not.toHaveBeenCalled();
    hidden(false);
    expect(render().status).toBe('playing');
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('pauses fully offscreen and resumes below the initial autoplay threshold', async () => {
    const write = vi.fn();
    run = vi.fn(async (context) => {
      await context.wait(1000);
      write();
    });
    render();
    intersect(0.8);
    await vi.advanceTimersByTimeAsync(400);
    intersect(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).not.toHaveBeenCalled();
    expect(render().status).toBe('paused');
    intersect(0.2);
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('suspends autoplay and active time without clearing a manual pause', async () => {
    const write = vi.fn();
    run = vi.fn(async (context) => {
      await context.wait(1000);
      write();
    });
    render(true);
    intersect(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
    render(false);
    await vi.advanceTimersByTimeAsync(400);
    render(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).not.toHaveBeenCalled();
    render(true).pause();
    render(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(render(false).status).toBe('paused');
    render(false).resume();
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledOnce();
  });

  it('keeps a manual pause across visibility and offscreen changes', async () => {
    const write = vi.fn();
    run = vi.fn(async (context) => {
      await context.wait(1000);
      write();
    });
    render();
    intersect(0.8);
    await vi.advanceTimersByTimeAsync(400);
    render().pause();
    hidden(true);
    intersect(0);
    hidden(false);
    intersect(0.2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(render().status).toBe('paused');
    expect(write).not.toHaveBeenCalled();
    render().resume();
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledOnce();
  });

  it('stops before autoplay after user takeover and only restarts on explicit replay', async () => {
    render().takeOver();
    intersect(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    expect(render().status).toBe('interactive');
    render().replay();
    await vi.advanceTimersByTimeAsync(0);
    expect(reset).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('replays from a fresh clock and prevents the previous run from writing', async () => {
    const write = vi.fn();
    run = vi.fn(async (context) => {
      await context.wait(1000);
      write();
    });
    render();
    intersect(1);
    await vi.advanceTimersByTimeAsync(400);
    const firstContext = run.mock.calls[0]![0];
    render().replay();
    expect(firstContext.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(write).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledOnce();
  });

  it('cancels pending story writes when unmounted', async () => {
    const write = vi.fn();
    run = vi.fn(async (context) => {
      await context.wait(1000);
      write();
    });
    render();
    intersect(1);
    await vi.advanceTimersByTimeAsync(400);
    for (const cleanup of cleanups.splice(0)) cleanup();
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disables reduced-motion autoplay while allowing an intentional manual start', async () => {
    motion.matches = true;
    render();
    intersect(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    render().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it('aborts the current run when reduced motion changes and prevents late writes', async () => {
    const write = vi.fn();
    run = vi.fn(async (context) => {
      await context.wait(1000);
      write();
    });
    render();
    intersect(1);
    await vi.advanceTimersByTimeAsync(400);
    motion.matches = true;
    motion.dispatchEvent(new Event('change'));
    expect(render().status).toBe('interactive');
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).not.toHaveBeenCalled();
  });
});
