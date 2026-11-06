import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackClock } from '../playback-clock';

function animation(state: AnimationPlayState = 'running') {
  const result = {
    playState: state,
    finished: new Promise<Animation>(() => {}),
    pause: vi.fn(() => {
      result.playState = 'paused';
    }),
    play: vi.fn(() => {
      result.playState = 'running';
    }),
    cancel: vi.fn(() => {
      result.playState = 'idle';
    }),
  };
  return result as typeof result & Animation;
}

describe('showcase active-time clock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => vi.useRealTimers());

  it('resumes a wait from its remaining duration rather than skipping hidden time', async () => {
    const clock = new PlaybackClock();
    const done = vi.fn();
    const waiting = clock.wait(1000).then(done);
    await vi.advanceTimersByTimeAsync(400);
    clock.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).not.toHaveBeenCalled();

    clock.resume();
    await vi.advanceTimersByTimeAsync(599);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toHaveBeenCalledOnce();
  });

  it('holds waits created while paused and treats repeated pause/resume calls as no-ops', async () => {
    const clock = new PlaybackClock();
    clock.pause();
    clock.pause();
    const done = vi.fn();
    const waiting = clock.wait(200).then(done);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).not.toHaveBeenCalled();

    clock.resume();
    clock.resume();
    await vi.advanceTimersByTimeAsync(199);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toHaveBeenCalledOnce();
  });

  it('keeps concurrent cursor and story waits on the same paused clock', async () => {
    const clock = new PlaybackClock();
    const cursor = vi.fn();
    const story = vi.fn();
    const cursorWait = clock.wait(100).then(cursor);
    const storyWait = clock.wait(300).then(story);
    await vi.advanceTimersByTimeAsync(50);
    clock.pause();
    await vi.advanceTimersByTimeAsync(1000);
    clock.resume();
    await vi.advanceTimersByTimeAsync(50);
    await cursorWait;
    expect(cursor).toHaveBeenCalledOnce();
    expect(story).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await storyWait;
    expect(story).toHaveBeenCalledOnce();
  });

  it('aborts pending waits, cancels timers and prevents delayed state writes', async () => {
    const clock = new PlaybackClock();
    const write = vi.fn();
    const result = clock
      .wait(100)
      .then(write)
      .catch((error: DOMException) => error);
    clock.abort();

    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
    await expect(clock.wait(10)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('checks cancellation again after a timer fires but before its continuation writes', async () => {
    const clock = new PlaybackClock();
    const write = vi.fn();
    const result = clock
      .wait(0)
      .then(write)
      .catch((error: DOMException) => error);
    vi.advanceTimersByTime(0);
    clock.abort();

    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(write).not.toHaveBeenCalled();
  });

  it('pauses and resumes running WAAPI animations and cancels them on abort', () => {
    const clock = new PlaybackClock();
    const moving = animation();
    const finished = animation('finished');
    clock.registerAnimation(moving);
    clock.registerAnimation(finished);
    clock.pause();
    expect(moving.pause).toHaveBeenCalledOnce();
    expect(finished.pause).not.toHaveBeenCalled();
    clock.resume();
    expect(moving.play).toHaveBeenCalledOnce();
    expect(finished.play).not.toHaveBeenCalled();
    clock.abort();
    expect(moving.cancel).toHaveBeenCalledOnce();
    expect(finished.cancel).toHaveBeenCalledOnce();
  });

  it('immediately pauses an animation registered during a paused beat', () => {
    const clock = new PlaybackClock();
    const moving = animation();
    clock.pause();
    clock.registerAnimation(moving);
    expect(moving.pause).toHaveBeenCalledOnce();
    clock.resume();
    expect(moving.play).toHaveBeenCalledOnce();
    clock.abort();
  });

  it('releases settled animations while keeping active animations pausable and abortable', async () => {
    const clock = new PlaybackClock();
    const finished = animation('finished');
    const cancelled = animation();
    const active = animation();
    let finish!: () => void;
    let cancel!: () => void;
    finished.finished = new Promise((resolve) => {
      finish = () => resolve(finished);
    });
    cancelled.finished = new Promise((_, reject) => {
      cancel = () => reject(new DOMException('cancelled', 'AbortError'));
    });
    clock.registerAnimation(finished);
    clock.registerAnimation(cancelled);
    clock.registerAnimation(active);
    finish();
    cancelled.cancel();
    cancel();
    await Promise.resolve();

    clock.pause();
    expect(active.pause).toHaveBeenCalledOnce();
    clock.resume();
    expect(active.play).toHaveBeenCalledOnce();
    clock.abort();
    expect(finished.cancel).not.toHaveBeenCalled();
    expect(cancelled.cancel).toHaveBeenCalledOnce();
    expect(active.cancel).toHaveBeenCalledOnce();
  });

  it('cancels and rejects an animation registered by an abandoned run', () => {
    const clock = new PlaybackClock();
    const moving = animation();
    clock.abort();

    expect(() => clock.registerAnimation(moving)).toThrowError(/abort/i);
    expect(moving.cancel).toHaveBeenCalledOnce();
  });
});
