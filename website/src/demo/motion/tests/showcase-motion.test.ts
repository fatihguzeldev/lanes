import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShowcaseMotion } from '../showcase-motion';

class TestAnimation {
  finished: Promise<void>;
  finish!: () => void;
  reject!: (reason: unknown) => void;
  cancel = vi.fn(() => this.reject(new DOMException('cancelled', 'AbortError')));

  constructor() {
    this.finished = new Promise((resolve, reject) => {
      this.finish = resolve;
      this.reject = reject;
    });
  }
}

class TestElement {
  className = '';
  innerHTML = '';
  inert = false;
  style = { position: '', visibility: '', transform: '', opacity: '' };
  removed = false;
  children: TestElement[] = [];
  context: TestElement | null = null;
  target: TestElement | null = null;
  rect = { left: 80, top: 160, width: 600, height: 400 };
  animations: TestAnimation[] = [];
  setAttribute() {}
  getBoundingClientRect() {
    return this.rect;
  }
  getClientRects() {
    return [this.rect];
  }
  append(element: TestElement) {
    this.children.push(element);
  }
  remove() {
    this.removed = true;
  }
  querySelector(selector: string) {
    return selector === '[data-showcase-view]' ? this.context : null;
  }
  querySelectorAll(selector: string) {
    return selector === '[data-action]' && this.target ? [this.target] : [];
  }
  animate() {
    const animation = new TestAnimation();
    this.animations.push(animation);
    return animation;
  }
}

function setup(reduced = false) {
  vi.stubGlobal('document', { createElement: () => new TestElement() });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) });
  vi.stubGlobal('getComputedStyle', () => ({ position: 'static' }));
  const root = new TestElement();
  root.target = new TestElement();
  root.target.rect = { left: 180, top: 220, width: 140, height: 30 };
  const controller = new AbortController();
  const registered: TestAnimation[] = [];
  const motion = createShowcaseMotion(
    root as unknown as HTMLElement,
    controller.signal,
    (animation) => registered.push(animation as unknown as TestAnimation),
  );
  return { root, controller, registered, motion };
}

afterEach(() => vi.unstubAllGlobals());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('showcase motion lifetime', () => {
  it('waits for registered native animation completion instead of a wall-clock timeout', async () => {
    const { registered, motion } = setup();
    let finished = false;
    const moving = motion.move('[data-action]').then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(registered).toHaveLength(1);
    registered[0]!.finish();
    await moving;
    expect(finished).toBe(true);
    motion.dispose();
  });

  it('cancels motion and removes its layer when aborted', async () => {
    const { root, registered, motion, controller } = setup();
    const moving = motion.move('[data-action]');
    const rejected = expect(moving).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(registered[0]!.cancel).toHaveBeenCalled();
    expect(root.children[0]!.removed).toBe(true);
    expect(root.style.position).toBe('');
  });

  it('does not advance React state after an interrupted view transition', async () => {
    const { root, motion, controller } = setup();
    root.context = new TestElement();
    const update = vi.fn();
    const switching = motion.transition(update);
    const rejected = expect(switching).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(update).not.toHaveBeenCalled();
    expect(root.context.style.opacity).toBe('');
  });

  it('waits for the React commit before measuring and animating the destination context', async () => {
    const { root, motion } = setup();
    const previous = new TestElement();
    const destination = new TestElement();
    root.context = previous;
    const requested = deferred();
    const committed = deferred();
    const started = deferred();
    const createAnimation = destination.animate.bind(destination);
    vi.spyOn(destination, 'animate').mockImplementation(() => {
      const animation = createAnimation();
      started.resolve();
      return animation;
    });
    const reads = vi.spyOn(root, 'querySelectorAll');
    let finished = false;
    const switching = motion
      .transition(() => {
        requested.resolve();
        return committed.promise;
      })
      .then(() => {
        finished = true;
      });
    previous.animations[0]!.finish();
    await requested.promise;
    root.context = destination;
    await Promise.resolve();

    expect(finished).toBe(false);
    expect(
      reads.mock.calls.filter(([selector]) => selector === '[data-showcase-key]'),
    ).toHaveLength(1);
    expect(destination.animations).toHaveLength(0);

    committed.resolve();
    await started.promise;
    expect(
      reads.mock.calls.filter(([selector]) => selector === '[data-showcase-key]'),
    ).toHaveLength(2);
    expect(destination.animations).toHaveLength(1);
    destination.animations[0]!.finish();
    await switching;
    expect(finished).toBe(true);
    expect(previous.style.opacity).toBe('');
    expect(destination.style.opacity).toBe('');
    motion.dispose();
  });

  it.each([false, true])(
    'does not measure or animate a late commit after abort (reduced motion: %s)',
    async (reduced) => {
      const { root, registered, motion, controller } = setup(reduced);
      const committed = deferred();
      const reads = vi.spyOn(root, 'querySelectorAll');
      const switching = motion.transition(() => committed.promise);
      const rejected = expect(switching).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      const destination = new TestElement();
      root.context = destination;
      committed.resolve();

      await rejected;

      expect(
        reads.mock.calls.filter(([selector]) => selector === '[data-showcase-key]'),
      ).toHaveLength(reduced ? 0 : 1);
      expect(destination.animations).toHaveLength(0);
      expect(destination.style.opacity).toBe('');
      expect(registered).toHaveLength(0);
    },
  );

  it('also awaits the React commit with reduced motion and no animation', async () => {
    const { registered, motion } = setup(true);
    const committed = deferred();
    let finished = false;
    const switching = motion
      .transition(() => committed.promise)
      .then(() => {
        finished = true;
      });
    await Promise.resolve();
    expect(finished).toBe(false);
    committed.resolve();
    await switching;
    expect(finished).toBe(true);
    expect(registered).toHaveLength(0);
    motion.dispose();
  });

  it('keeps reduced-motion updates immediate with no cursor animations', async () => {
    const { registered, motion } = setup(true);
    const update = vi.fn();
    await motion.move('[data-action]');
    await motion.press('[data-action]');
    await motion.transition(update);
    expect(update).toHaveBeenCalledOnce();
    expect(registered).toHaveLength(0);
    motion.dispose();
  });
});
