import { describe, expect, it } from 'vitest';
import { timeZoneChoices } from './time-zones';

describe('time zone choices', () => {
  it('keeps UTC and valid current aliases even if they are not in the supported list', () => {
    const choices = timeZoneChoices('US/Eastern');
    expect(choices.some((choice) => choice.value === 'UTC')).toBe(true);
    expect(choices.some((choice) => choice.value === 'US/Eastern')).toBe(true);
    expect(new Set(choices.map((choice) => choice.value)).size).toBe(choices.length);
  });

  it('never offers arbitrary invalid input as a saved option', () => {
    expect(
      timeZoneChoices('anything goes').some((choice) => choice.value === 'anything goes'),
    ).toBe(false);
    expect(
      timeZoneChoices('Europe/Istanbul').some((choice) => choice.value === 'Europe/Istanbul'),
    ).toBe(true);
  });
});
