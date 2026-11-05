import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyViewport, observeViewport, readViewport } from '../viewport';

afterEach(() => vi.unstubAllGlobals());

function setup(visual = true) {
  const viewport = Object.assign(new EventTarget(), {
    offsetLeft: 80,
    offsetTop: 200,
    width: 320,
    height: 240,
  });
  const browser = Object.assign(new EventTarget(), {
    visualViewport: visual ? viewport : null,
    innerHeight: 600,
  });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', { documentElement: { clientWidth: 800 } });
  return { browser, viewport };
}

describe('visible viewport', () => {
  it('uses the visible dimensions and offsets rather than the document layout', () => {
    setup();
    expect(readViewport()).toEqual({ left: 80, top: 200, width: 320, height: 240 });
  });
  it('falls back to layout bounds when visual viewport is unavailable', () => {
    setup(false);
    expect(readViewport()).toEqual({ left: 0, top: 0, width: 800, height: 600 });
  });
  it('updates for keyboard resize and panning, then detaches all listeners', () => {
    const { viewport, browser } = setup();
    const changed = vi.fn();
    const stop = observeViewport(changed);
    expect(changed).toHaveBeenCalledOnce();
    viewport.height = 160;
    viewport.dispatchEvent(new Event('resize'));
    expect(changed).toHaveBeenLastCalledWith({ left: 80, top: 200, width: 320, height: 160 });
    viewport.offsetTop = 240;
    viewport.dispatchEvent(new Event('scroll'));
    browser.dispatchEvent(new Event('resize'));
    expect(changed).toHaveBeenCalledTimes(4);
    stop();
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
    browser.dispatchEvent(new Event('resize'));
    expect(changed).toHaveBeenCalledTimes(4);
  });
  it('publishes bounds and layout-relative insets for centered and side panels', () => {
    setup();
    const values = new Map<string, string>();
    const element = {
      style: { setProperty: (name: string, value: string) => values.set(name, value) },
    };
    applyViewport(element as unknown as HTMLElement, readViewport());
    expect(Object.fromEntries(values)).toEqual({
      '--viewport-left': '80px',
      '--viewport-top': '200px',
      '--viewport-width': '320px',
      '--viewport-height': '240px',
      '--viewport-right': '400px',
      '--viewport-bottom': '160px',
    });
  });
});
