import { describe, expect, it } from 'vitest';
import { placePopover } from '../floating';

const viewport = { left: 0, top: 0, width: 800, height: 600 };

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
      { left: 0, top: 0, width: 320, height: 480 },
    );
    expect(position).toEqual({ left: 12, top: 196, maxHeight: 272 });
  });

  it('keeps menus inside a panned visual viewport with the keyboard open', () => {
    const position = placePopover(
      { left: 180, right: 220, top: 350, bottom: 380 },
      { width: 260, height: 300 },
      { left: 80, top: 200, width: 320, height: 240 },
    );
    expect(position).toEqual({ left: 128, top: 212, maxHeight: 132 });
  });

  it('never returns negative height when very little space is visible', () => {
    const position = placePopover(
      { left: 0, right: 20, top: 0, bottom: 20 },
      { width: 180, height: 100 },
      { left: 0, top: 0, width: 100, height: 16 },
    );
    expect(position.maxHeight).toBe(0);
    expect(position.top).toBe(12);
  });

  it('uses the shared gutter for both placement and available space', () => {
    expect(
      placePopover(
        { left: 290, right: 310, top: 160, bottom: 190 },
        { width: 280, height: 700 },
        { left: 0, top: 0, width: 320, height: 480 },
        'start',
        20,
      ),
    ).toEqual({ left: 20, top: 196, maxHeight: 264 });
  });
});
