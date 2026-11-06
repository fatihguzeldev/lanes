import { describe, expect, it } from 'vitest';
import { colorChoices, colorInk, normalizeColor } from '../colors';

describe('picker colors', () => {
  it('compares short, long and mixed-case hex values consistently', () => {
    expect(normalizeColor(' #AbC ')).toBe('#aabbcc');
    expect(normalizeColor('#AABBCC')).toBe('#aabbcc');
  });
  it.each(['red', '#abcd', '#12345678', 'url(https://example.com)', '#gggggg'])(
    'rejects %s',
    (value) => {
      expect(normalizeColor(value)).toBeNull();
    },
  );
  it('keeps the selected check readable on light and dark swatches', () => {
    expect(colorInk('#fff')).toBe('#202020');
    expect(colorInk('#000')).toBe('#ffffff');
    for (const color of colorChoices) expect(normalizeColor(color.value)).toBe(color.value);
  });
});
