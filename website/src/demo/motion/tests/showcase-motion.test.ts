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
