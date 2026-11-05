export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function readViewport(): ViewportRect {
  const visual = window.visualViewport;
  return {
    left: visual?.offsetLeft ?? 0,
    top: visual?.offsetTop ?? 0,
    width: visual?.width ?? document.documentElement.clientWidth,
    height: visual?.height ?? window.innerHeight,
  };
}

export function observeViewport(changed: (bounds: ViewportRect) => void) {
  const update = () => changed(readViewport());
  const visual = window.visualViewport;
  window.addEventListener('resize', update);
  visual?.addEventListener('resize', update);
  visual?.addEventListener('scroll', update);
  update();
  return () => {
    window.removeEventListener('resize', update);
    visual?.removeEventListener('resize', update);
    visual?.removeEventListener('scroll', update);
  };
}

export function applyViewport(element: HTMLElement, bounds: ViewportRect) {
  for (const [key, value] of Object.entries({
    ...bounds,
    right: Math.max(0, document.documentElement.clientWidth - bounds.left - bounds.width),
    bottom: Math.max(0, window.innerHeight - bounds.top - bounds.height),
  }))
    element.style.setProperty(`--viewport-${key}`, `${value}px`);
}
