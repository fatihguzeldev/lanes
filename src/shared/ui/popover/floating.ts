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

export function placeSubmenu(
  anchor: AnchorRect,
  panel: { width: number; height: number },
  viewport: ViewportRect,
  margin = 12,
): { left: number; top: number; maxHeight: number } {
  const gap = 4;
  const right = viewport.left + viewport.width - margin;
  const bottom = viewport.top + viewport.height - margin;
  const left = viewport.left + margin;
  const availableRight = right - anchor.right - gap;
  const availableLeft = anchor.left - gap - left;
  const opensLeft = panel.width > availableRight && availableLeft > availableRight;
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const height = Math.min(panel.height, maxHeight);
  return {
    left: Math.max(
      left,
      Math.min(
        opensLeft ? anchor.left - gap - panel.width : anchor.right + gap,
        right - panel.width,
      ),
    ),
    top: Math.max(viewport.top + margin, Math.min(anchor.top, bottom - height)),
    maxHeight,
  };
}
