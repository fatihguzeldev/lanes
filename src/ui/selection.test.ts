import { describe, expect, it } from 'vitest';
import { findChoice, stepChoice } from './selection';

const choices = [
  { value: 'manual', label: 'manual' },
  { value: 'date', label: 'scheduled', disabled: true },
  { value: 'priority', label: 'priority' },
  { value: 'title', label: 'title' },
];

describe('selection navigation', () => {
  it('skips disabled choices and wraps at both edges', () => {
    expect(stepChoice(choices, 0, 1)).toBe(2);
    expect(stepChoice(choices, 3, 1)).toBe(0);
    expect(stepChoice(choices, 0, -1)).toBe(3);
    expect(stepChoice(choices, -1, 1)).toBe(0);
    expect(stepChoice(choices, -1, -1)).toBe(3);
  });

  it('has no active choice when every option is disabled or missing', () => {
    expect(stepChoice([], -1, 1)).toBe(-1);
    expect(stepChoice([{ value: 'none', label: 'none', disabled: true }], 0, 1)).toBe(-1);
  });

  it('typeahead wraps, ignores disabled options, and matches case-insensitively', () => {
    expect(findChoice(choices, 'PRI', 3)).toBe(2);
    expect(findChoice(choices, 'scheduled', 0)).toBe(-1);
    expect(findChoice(choices, 'not found', 0)).toBe(-1);
  });
});
