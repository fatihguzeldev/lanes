import { showcasePoint } from './showcase-geometry';
import './showcase-motion.css';

type CursorKind = 'pointer' | 'text';
type MoveOptions = { duration?: number; kind?: CursorKind };
const travel = 'cubic-bezier(0.45, 0, 0.1, 1)';

export function createShowcaseMotion(
  root: HTMLElement,
  signal: AbortSignal,
  track?: (animation: Animation) => void,
) {
  const layer = document.createElement('div');
  layer.className = 'showcase-motion';
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  const cursor = document.createElement('div');
  cursor.className = 'showcase-motion__cursor';
  // The pointer and I-beam geometry come from Stageshow's system cursor kit.
  cursor.innerHTML = `<div class="showcase-motion__press"><svg class="showcase-motion__pointer" width="24" height="24" viewBox="0 0 32 32" fill="none"><g transform="translate(10 7)"><path d="m6.148 18.473 1.863-1.003 1.615-.839-2.568-4.816h4.332l-11.379-11.408v16.015l3.316-3.221z" fill="var(--color-paper)"/><path d="m6.431 17 1.765-.941-2.775-5.202h3.604l-8.025-8.043v11.188l2.53-2.442z" fill="currentColor"/></g></svg><svg class="showcase-motion__text" width="10" height="16" viewBox="0 0 10 16" fill="none"><path d="M3 1H7M3 15H7M5 1V15" stroke="var(--color-paper)" stroke-width="2.6" stroke-linecap="round"/><path d="M3 1H7M3 15H7M5 1V15" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg></div>`;
  layer.append(cursor);
  const previousPosition = root.style.position;
  const positioned = getComputedStyle(root).position === 'static';
  if (positioned) root.style.position = 'relative';
  root.append(layer);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animations = new Set<Animation>();
  const cleanups = new Set<() => void>();
  let disposed = false;
  let point: { x: number; y: number } | null = null;
  let kind: CursorKind = 'pointer';

  function checkpoint() {
    signal.throwIfAborted();
    if (disposed) throw new DOMException('showcase motion stopped', 'AbortError');
  }
  async function animate(element: Element, frames: Keyframe[], timing: KeyframeAnimationOptions) {
    checkpoint();
    const animation = element.animate(frames, { fill: 'both', ...timing });
    animations.add(animation);
    try {
      track?.(animation);
      await animation.finished;
      checkpoint();
    } finally {
      animations.delete(animation);
      animation.cancel();
    }
  }
  function targetPoint(selector: string, nextKind: CursorKind) {
    const stage = layer.getBoundingClientRect();
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      const next = showcasePoint(element.getBoundingClientRect(), stage, nextKind);
      if (next && element.getClientRects().length) return next;
    }
    throw new Error(`showcase target is not visible: ${selector}`);
  }
  function translation(at: { x: number; y: number }) {
    return `translate3d(${at.x}px, ${at.y}px, 0)`;
  }
  async function move(selector: string, options: MoveOptions = {}) {
    checkpoint();
    if (reduced) return;
    const nextKind = options.kind ?? 'pointer';
    const next = targetPoint(selector, nextKind);
    const duration = options.duration ?? 420;
    const from = point ?? next;
    const showing = cursor.style.visibility === 'visible';
    cursor.style.visibility = 'visible';
    cursor.style.transform = translation(next);
    cursor.style.opacity = '1';
    const pending = [
      animate(
        cursor,
        [
          { transform: translation(from), opacity: showing ? 1 : 0 },
          { transform: translation(next), opacity: 1 },
        ],
        { duration, easing: travel },
      ),
    ];
    if (nextKind !== kind) {
      for (const [name, selector] of [
        ['pointer', '.showcase-motion__pointer'],
        ['text', '.showcase-motion__text'],
      ] as const) {
        const glyph = cursor.querySelector<SVGElement>(selector)!;
        glyph.style.opacity = name === nextKind ? '1' : '0';
        pending.push(
          animate(
            glyph,
            [{ opacity: name === kind ? 1 : 0 }, { opacity: name === nextKind ? 1 : 0 }],
            {
              duration: Math.min(120, duration),
              delay: Math.max(0, duration - 120),
              easing: 'ease-out',
            },
          ),
        );
      }
    }
    kind = nextKind;
    point = next;
    await Promise.all(pending);
  }
  async function press(selector: string) {
    checkpoint();
    if (reduced) return;
    const next = targetPoint(selector, kind);
    if (
      cursor.style.visibility !== 'visible' ||
      !point ||
      Math.hypot(next.x - point.x, next.y - point.y) > 1
    )
      await move(selector, { duration: 180, kind });
    await animate(
      cursor.querySelector('.showcase-motion__press')!,
      [
        { transform: 'scale(1)' },
        { transform: 'scale(0.9)', offset: 0.35 },
        { transform: 'scale(1)' },
      ],
      { duration: 180, easing: 'ease-out' },
    );
  }
  function snapshot(element: HTMLElement) {
    const bounds = element.getBoundingClientRect();
    const stage = layer.getBoundingClientRect();
    const clone = element.cloneNode(true) as HTMLElement;
    const originals = [element, ...element.querySelectorAll<HTMLElement>('*')];
    const copies = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
    originals.forEach((original, index) => {
      const copy = copies[index]!;
      const style = getComputedStyle(original);
      for (const property of style)
        copy.style.setProperty(property, style.getPropertyValue(property));
      copy.removeAttribute('id');
      copy.removeAttribute('data-showcase-key');
      copy.removeAttribute('data-showcase');
      copy.style.animation = 'none';
      copy.style.transition = 'none';
    });
    Object.assign(clone.style, {
      position: 'absolute',
      inset: 'auto',
      left: '0px',
      top: '0px',
      margin: '0px',
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      boxSizing: 'border-box',
      visibility: 'visible',
      transform: translation({ x: bounds.left - stage.left, y: bounds.top - stage.top }),
      pointerEvents: 'none',
    });
    return { element, clone, x: bounds.left - stage.left, y: bounds.top - stage.top };
  }
  function shared() {
    const items = new Map<string, ReturnType<typeof snapshot>>();
    for (const element of root.querySelectorAll<HTMLElement>('[data-showcase-key]')) {
      const key = element.dataset.showcaseKey!;
      const bounds = element.getBoundingClientRect();
      if (!items.has(key) && bounds.width && bounds.height && element.getClientRects().length)
        items.set(key, snapshot(element));
    }
    return items;
  }
  async function transition(update: () => void, options: { duration?: number } = {}) {
    checkpoint();
    if (reduced) {
      update();
      return;
    }
    const before = shared();
    const ghosts = new Set<HTMLElement>();
    const hidden = new Map<HTMLElement, string>();
    const contexts = new Map<HTMLElement, string>();
    const hideElement = (element: HTMLElement) => {
      if (!hidden.has(element)) hidden.set(element, element.style.visibility);
      element.style.visibility = 'hidden';
    };
    const context = () => root.querySelector<HTMLElement>('[data-showcase-view]');
    const cleanup = () => {
      for (const [element, visibility] of hidden) element.style.visibility = visibility;
      for (const [element, opacity] of contexts) element.style.opacity = opacity;
      for (const ghost of ghosts) ghost.remove();
      cleanups.delete(cleanup);
    };
    cleanups.add(cleanup);
    const duration = options.duration ?? 600;
    try {
      for (const item of before.values()) {
        layer.append(item.clone);
        ghosts.add(item.clone);
        hideElement(item.element);
      }
      const oldContext = context();
      if (oldContext) {
        contexts.set(oldContext, oldContext.style.opacity);
        oldContext.style.opacity = '0.35';
        await animate(oldContext, [{ opacity: 1 }, { opacity: 0.35 }], {
          duration: duration * 0.16,
          easing: 'ease-out',
        });
      }
      checkpoint();
      update();
      for (const [element, visibility] of hidden) element.style.visibility = visibility;
      hidden.clear();
      const after = shared();
      const pending: Promise<void>[] = [];
      for (const [key, item] of before) {
        const destination = after.get(key);
        item.clone.style.opacity = '0';
        pending.push(
          animate(
            item.clone,
            [
              { transform: translation(item), opacity: 1 },
              { opacity: 1, offset: 0.65 },
              { transform: translation(destination ?? item), opacity: 0 },
            ],
            { duration: duration * 0.84, easing: travel },
          ),
        );
        if (destination) {
          layer.append(destination.clone);
          ghosts.add(destination.clone);
          hideElement(destination.element);
          pending.push(
            animate(
              destination.clone,
              [
                { transform: translation(item), opacity: 0 },
                { opacity: 0, offset: 0.65 },
                { transform: translation(destination), opacity: 1 },
              ],
              { duration: duration * 0.84, easing: travel },
            ),
          );
        }
      }
      const nextContext = context();
      if (nextContext) {
        if (!contexts.has(nextContext)) contexts.set(nextContext, nextContext.style.opacity);
        nextContext.style.opacity = '1';
        pending.push(
          animate(nextContext, [{ opacity: 0.35 }, { opacity: 1 }], {
            duration: duration * 0.84,
            easing: 'ease-out',
          }),
        );
      }
      await Promise.all(pending);
    } finally {
      cleanup();
    }
  }
  function hide() {
    cursor.style.visibility = 'hidden';
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const animation of animations) animation.cancel();
    animations.clear();
    for (const cleanup of [...cleanups]) cleanup();
    layer.remove();
    if (positioned && root.style.position === 'relative') root.style.position = previousPosition;
    signal.removeEventListener('abort', dispose);
  }
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose();
  return { move, press, transition, hide, dispose };
}
