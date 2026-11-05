import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAccountInitial,
  readAccountInitial,
  rememberAccountInitial,
} from '../account-initial';

function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}

afterEach(() => vi.unstubAllGlobals());

describe('retained account initial', () => {
  it('retains only the confirmed account reference and initial for a reload', () => {
    const values = storage();
    rememberAccountInitial({ id: 'first', displayName: 'Fatih' });
    expect(readAccountInitial('first')).toBe('F');
    expect(readAccountInitial(null)).toBe('F');
    expect([...values.values()]).toEqual([JSON.stringify({ accountId: 'first', initial: 'F' })]);
  });

  it('never shows the previous initial for a different selected account', () => {
    storage();
    rememberAccountInitial({ id: 'first', displayName: 'Fatih' });
    expect(readAccountInitial('second')).toBeNull();
    expect(readAccountInitial(null)).toBeNull();
    rememberAccountInitial({ id: 'second', displayName: 'Another account' });
    expect(readAccountInitial('second')).toBe('A');
  });

  it('clears the hint when private session state is discarded', () => {
    storage();
    rememberAccountInitial({ id: 'first', displayName: 'Fatih' });
    clearAccountInitial();
    expect(readAccountInitial(null)).toBeNull();
  });

  it('ignores malformed stored data and unavailable storage', () => {
    const values = storage();
    for (const value of ['broken', '{}', '{"accountId":"first","initial":"private data"}']) {
      values.set('lanes.account-initial', value);
      expect(readAccountInitial(null)).toBeNull();
    }
    vi.stubGlobal('sessionStorage', {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    });
    expect(readAccountInitial(null)).toBeNull();
    expect(() => rememberAccountInitial({ id: 'first', displayName: 'Fatih' })).not.toThrow();
    expect(() => clearAccountInitial()).not.toThrow();
  });
});
