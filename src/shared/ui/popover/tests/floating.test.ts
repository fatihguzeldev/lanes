import { describe, expect, it } from 'vitest';
import { placePopover } from '../floating';

const viewport = { width: 800, height: 600 };

describe('popover placement', () => {
  it('opens below its trigger and aligns either edge', () => {
    const anchor = { left: 120, right: 180, top: 40, bottom: 70 };
    expect(placePopover(anchor, { width: 200, height: 150 }, viewport)).toMatchObject({
      left: 120,
      top: 76,
    });
    expect(placePopover(anchor, { width: 200, height: 150 }, viewport, 'end').left).toBe(12);
  });

  it('flips above a low trigger rather than covering the viewport edge', () => {
    const position = placePopover(
      { left: 650, right: 700, top: 550, bottom: 580 },
      { width: 200, height: 180 },
      viewport,
    );
    expect(position).toMatchObject({ left: 588, top: 364 });
  });

  it('limits a long menu to the available side and keeps narrow viewports usable', () => {
    const position = placePopover(
      { left: 290, right: 310, top: 160, bottom: 190 },
      { width: 296, height: 700 },
      { width: 320, height: 480 },
    );
    expect(position).toEqual({ left: 12, top: 196, maxHeight: 272 });
  });
});
