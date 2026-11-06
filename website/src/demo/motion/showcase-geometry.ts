type Rect = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>;

export function showcasePoint(target: Rect, stage: Rect, kind: 'pointer' | 'text') {
  const left = Math.max(target.left, stage.left);
  const top = Math.max(target.top, stage.top);
  const right = Math.min(target.left + target.width, stage.left + stage.width);
  const bottom = Math.min(target.top + target.height, stage.top + stage.height);
  if (right <= left || bottom <= top) return null;
  const inset = Math.min(10, (right - left) / 2);
  return {
    x: (kind === 'text' ? left + inset : right - inset) - stage.left,
    y: top - stage.top + (bottom - top) * 0.65,
  };
}
