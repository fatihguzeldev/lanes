import { describe, expect, it } from 'vitest';
import {
  applicationCapacityMessage,
  templateTaskDate,
  unchangedInputIdentity,
} from './template-model';

describe('template application drafts', () => {
  it('requires a fresh complete inventory and counts reserved slots', () => {
    expect(
      applicationCapacityMessage(2, { known: null, reserved: 0, available: null, stale: true }),
    ).toMatch(/refresh/);
    expect(
      applicationCapacityMessage(2, { known: 1998, reserved: 1, available: 1, stale: false }),
    ).toMatch(/2.*1/);
    expect(
      applicationCapacityMessage(1, { known: 1998, reserved: 1, available: 1, stale: false }),
    ).toBe('');
  });
  it('shows negative relative dates without clamping and omits dates explicitly', () => {
    const dated = { dayOffset: -2, scheduledTime: '09:30', timeZone: 'Europe/Istanbul' };
    expect(templateTaskDate(dated, '2026-11-02', true)).toBe('2026-10-31 · 09:30 Europe/Istanbul');
    expect(templateTaskDate(dated, '2026-11-02', false)).toBe('no date');
    expect(templateTaskDate({ ...dated, dayOffset: null }, '2026-11-02', true)).toBe('no date');
  });
  it('reuses only the unchanged captured command identity after ambiguous responses', () => {
    const first = unchangedInputIdentity(null, { title: 'one' }, () => 'first');
    expect(unchangedInputIdentity(first, { title: 'one' }, () => 'second')).toBe(first);
    expect(unchangedInputIdentity(first, { title: 'two' }, () => 'second')).toEqual({
      fingerprint: '{"title":"two"}',
      id: 'second',
    });
  });
});
