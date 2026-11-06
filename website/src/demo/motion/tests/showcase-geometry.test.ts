import { describe, expect, it } from 'vitest';
import { showcasePoint } from '../showcase-geometry';

describe('measured showcase cursor targets', () => {
  const stage = { left: 80, top: 160, width: 600, height: 400 };

  it('keeps a pointer in the control padding and an I-beam at the text start', () => {
    const target = { left: 180, top: 220, width: 140, height: 30 };
    expect(showcasePoint(target, stage, 'pointer')).toEqual({ x: 230, y: 79.5 });
    expect(showcasePoint(target, stage, 'text')).toEqual({ x: 110, y: 79.5 });
  });

  it('uses current stage bounds after page scroll instead of fixed page coordinates', () => {
    expect(
      showcasePoint(
        { left: 180, top: 120, width: 140, height: 30 },
        { ...stage, top: 60 },
        'pointer',
      ),
    ).toEqual({ x: 230, y: 79.5 });
  });

  it('targets the visible portion of a clipped control on a narrow stage', () => {
    expect(
      showcasePoint(
        { left: 270, top: 200, width: 100, height: 44 },
        { left: 20, top: 160, width: 280, height: 400 },
        'pointer',
      ),
    ).toEqual({ x: 270, y: 68.6 });
  });

  it('centers inside tiny controls and rejects hidden or off-stage targets', () => {
    expect(showcasePoint({ left: 90, top: 170, width: 8, height: 8 }, stage, 'pointer')).toEqual({
      x: 14,
      y: 15.2,
    });
    expect(
      showcasePoint({ left: 800, top: 170, width: 30, height: 30 }, stage, 'pointer'),
    ).toBeNull();
    expect(showcasePoint({ left: 90, top: 170, width: 0, height: 0 }, stage, 'pointer')).toBeNull();
  });
});
