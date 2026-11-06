import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentClockOffset, readEntryBootstrap } from '../entry-bootstrap';

const document = (value: string | null) => ({
  getElementById: () => (value === null ? null : ({ textContent: value } as HTMLElement)),
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('document session bootstrap', () => {
  it('accepts only a validated session or a typed entry error', () => {
    const session = { configured: true, authenticated: false, serverTime: 90700 };
    expect(readEntryBootstrap(document(JSON.stringify({ state: 'ready', session })))).toEqual({
      state: 'ready',
      session,
    });
    expect(readEntryBootstrap(document('{"state":"error","message":"try again"}'))).toEqual({
      state: 'error',
      message: 'try again',
    });
    for (const value of [
      null,
      '',
      '{',
      '{}',
      '{"state":"ready","session":{"authenticated":true}}',
      '{"state":"error","message":""}',
    ]) {
      expect(readEntryBootstrap(document(value))).toBeNull();
    }
  });
  it('does not treat delayed JavaScript download as server clock skew', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    vi.stubGlobal('performance', {
      timeOrigin: 90000,
      getEntriesByType: () => [{ responseStart: 200 }],
    });
    expect(documentClockOffset(90700)).toBe(500);
    vi.setSystemTime(280000);
    expect(documentClockOffset(90700)).toBe(500);
  });
  it('uses receipt time if document navigation timing is unavailable', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    vi.stubGlobal('performance', { getEntriesByType: () => [] });
    expect(documentClockOffset(100500)).toBe(500);
    vi.stubGlobal('performance', undefined);
    expect(documentClockOffset(100500)).toBe(500);
  });
});
