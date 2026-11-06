import { useEffect, useRef, useState, type RefObject } from 'react';
import { PlaybackClock, type PlaybackContext } from './playback-clock';

export type { PlaybackContext } from './playback-clock';
export type PlaybackStatus = 'waiting' | 'playing' | 'paused' | 'finished' | 'interactive';

type Options = {
  rootRef: RefObject<HTMLElement | null>;
  run(context: PlaybackContext): Promise<void>;
  onReplay?(): void;
  suspended?: boolean;
};

export function useShowcasePlayback({ rootRef, run, onReplay, suspended = false }: Options) {
  const [status, setStatus] = useState<PlaybackStatus>('waiting');
  const state = useRef<PlaybackStatus>('waiting');
  const latest = useRef({ run, onReplay });
  latest.current = { run, onReplay };
  const clock = useRef<PlaybackClock | null>(null);
  const mounted = useRef(false);
  const environment = useRef({
    intersecting: false,
    eligible: false,
    visible: true,
    reduced: false,
    manuallyPaused: false,
    started: false,
    suspended,
  });

  function transition(next: PlaybackStatus) {
    if (state.current === next) return;
    state.current = next;
    setStatus(next);
  }
  function synchronize() {
    const current = clock.current;
    const flags = environment.current;
    if (!current) {
      if (
        !flags.started &&
        flags.eligible &&
        flags.visible &&
        !flags.reduced &&
        !flags.manuallyPaused &&
        !flags.suspended
      )
        start();
      return;
    }
    if (state.current === 'finished' || current.signal.aborted) return;
    if (flags.manuallyPaused || flags.suspended || !flags.visible || !flags.intersecting) {
      current.pause();
      transition('paused');
    } else {
      current.resume();
      transition('playing');
    }
  }
  function takeOver() {
    environment.current.started = true;
    clock.current?.abort();
    clock.current = null;
    transition('interactive');
  }
  function start() {
    if (clock.current) return;
    environment.current.started = true;
    environment.current.manuallyPaused = false;
    const current = new PlaybackClock();
    clock.current = current;
    transition('playing');
    synchronize();
    const context: PlaybackContext = {
      signal: current.signal,
      wait: (milliseconds) => current.wait(milliseconds),
      registerAnimation: (animation) => current.registerAnimation(animation),
      checkpoint: () => current.checkpoint(),
    };
    void (async () => {
      await current.wait(0);
      await latest.current.run(context);
      current.checkpoint();
      if (mounted.current && clock.current === current) transition('finished');
    })().catch((error: unknown) => {
      if (current.signal.aborted || clock.current !== current || !mounted.current) return;
      console.error('showcase playback failed', error);
      takeOver();
    });
  }

  useEffect(() => {
    mounted.current = true;
    const flags = environment.current;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const visibility = () => {
      flags.visible = !document.hidden;
      synchronize();
    };
    const reducedMotion = () => {
      flags.reduced = motion.matches;
      if (motion.matches) {
        flags.started = true;
        if (clock.current) takeOver();
      } else synchronize();
    };
    visibility();
    reducedMotion();
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        flags.intersecting = entry.isIntersecting;
        flags.eligible = entry.isIntersecting && entry.intersectionRatio >= 0.95;
        synchronize();
      },
      { threshold: [0, 0.95] },
    );
    if (rootRef.current) observer.observe(rootRef.current);
    document.addEventListener('visibilitychange', visibility);
    motion.addEventListener('change', reducedMotion);
    return () => {
      mounted.current = false;
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      motion.removeEventListener('change', reducedMotion);
      clock.current?.abort();
      clock.current = null;
    };
  }, [rootRef]);

  useEffect(() => {
    environment.current.suspended = suspended;
    synchronize();
  }, [suspended]);

  return {
    status,
    start,
    takeOver,
    pause() {
      environment.current.manuallyPaused = true;
      synchronize();
    },
    resume() {
      environment.current.manuallyPaused = false;
      synchronize();
    },
    replay() {
      clock.current?.abort();
      clock.current = null;
      latest.current.onReplay?.();
      start();
    },
  };
}
