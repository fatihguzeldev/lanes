import type { ViewportRect } from '../viewport/viewport';

interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function placePopover(
  anchor: AnchorRect,
  panel: { width: number; height: number },
  viewport: ViewportRect,
  align: 'start' | 'end' = 'start',
  margin = 12,
): { left: number; top: number; maxHeight: number } {
  const gap = 6;
  const right = viewport.left + viewport.width,
    bottom = viewport.top + viewport.height;
  const below = Math.max(0, bottom - anchor.bottom - gap - margin),
    above = Math.max(0, anchor.top - viewport.top - gap - margin);
  const upwards = panel.height > below && above > below;
  const maxHeight = Math.min(viewport.height - margin * 2, upwards ? above : below);
  const height = Math.min(panel.height, maxHeight);
  return {
    left: Math.max(
      viewport.left + margin,
      Math.min(
        align === 'end' ? anchor.right - panel.width : anchor.left,
        right - panel.width - margin,
      ),
    ),
    top: Math.max(
      viewport.top + margin,
      Math.min(upwards ? anchor.top - gap - height : anchor.bottom + gap, bottom - height - margin),
    ),
    maxHeight: Math.max(0, maxHeight),
  };
}
