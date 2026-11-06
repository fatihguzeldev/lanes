export type PlaybackContext = {
  signal: AbortSignal;
  wait(milliseconds: number): Promise<void>;
  registerAnimation(animation: Animation): void;
  checkpoint(): void;
};

type Timer = ReturnType<typeof setTimeout>;
type Platform = {
  now(): number;
  setTimer(callback: () => void, milliseconds: number): Timer;
  cancelTimer(timer: Timer): void;
};
type Waiter = {
  at: number;
  timer: Timer | null;
  resolve(): void;
  reject(reason: unknown): void;
};

export class PlaybackClock {
  private readonly controller = new AbortController();
  private readonly waiters = new Set<Waiter>();
  private readonly animations = new Set<Animation>();
  private paused = false;
  private elapsedBeforePause = 0;
  private resumedAt: number;

  constructor(
    private readonly platform: Platform = {
      now: () => performance.now(),
      setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
      cancelTimer: (timer) => clearTimeout(timer),
    },
  ) {
    this.resumedAt = platform.now();
  }

  get signal() {
    return this.controller.signal;
  }
  private get elapsed() {
    return this.elapsedBeforePause + (this.paused ? 0 : this.platform.now() - this.resumedAt);
  }
  checkpoint() {
    this.signal.throwIfAborted();
  }
  async wait(milliseconds: number) {
    this.checkpoint();
    await new Promise<void>((resolve, reject) => {
      const waiter = { at: this.elapsed + milliseconds, timer: null, resolve, reject };
      this.waiters.add(waiter);
      this.schedule(waiter);
    });
    this.checkpoint();
  }
  private schedule(waiter: Waiter) {
    if (this.paused) return;
    waiter.timer = this.platform.setTimer(
      () => {
        this.waiters.delete(waiter);
        waiter.resolve();
      },
      Math.max(0, waiter.at - this.elapsed),
    );
  }
  pause() {
    if (this.paused || this.signal.aborted) return;
    this.elapsedBeforePause = this.elapsed;
    this.paused = true;
    for (const waiter of this.waiters) {
      if (waiter.timer !== null) this.platform.cancelTimer(waiter.timer);
      waiter.timer = null;
    }
    for (const animation of this.animations)
      if (animation.playState === 'running') animation.pause();
  }
  resume() {
    if (!this.paused || this.signal.aborted) return;
    this.paused = false;
    this.resumedAt = this.platform.now();
    for (const waiter of this.waiters) this.schedule(waiter);
    for (const animation of this.animations) if (animation.playState === 'paused') animation.play();
  }
  registerAnimation(animation: Animation) {
    if (this.signal.aborted) {
      animation.cancel();
      this.checkpoint();
    }
    this.animations.add(animation);
    const release = () => this.animations.delete(animation);
    void animation.finished.then(release, release);
    if (this.paused && animation.playState === 'running') animation.pause();
  }
  abort() {
    if (this.signal.aborted) return;
    this.controller.abort();
    for (const waiter of this.waiters) {
      if (waiter.timer !== null) this.platform.cancelTimer(waiter.timer);
      waiter.reject(this.signal.reason);
    }
    this.waiters.clear();
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
  }
}
