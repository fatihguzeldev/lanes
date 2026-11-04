interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function placePopover(
  anchor: AnchorRect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'start' | 'end' = 'start',
): { left: number; top: number; maxHeight: number } {
  const margin = 12,
    gap = 6;
  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin),
    above = Math.max(0, anchor.top - gap - margin);
  const upwards = panel.height > below && above > below;
  const maxHeight = Math.min(viewport.height - margin * 2, upwards ? above : below);
  const height = Math.min(panel.height, maxHeight);
  return {
    left: Math.max(
      margin,
      Math.min(
        align === 'end' ? anchor.right - panel.width : anchor.left,
        viewport.width - panel.width - margin,
      ),
    ),
    top: Math.max(
      margin,
      Math.min(
        upwards ? anchor.top - gap - height : anchor.bottom + gap,
        viewport.height - height - margin,
      ),
    ),
    maxHeight: Math.max(0, maxHeight),
  };
}
