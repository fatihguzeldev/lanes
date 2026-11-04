import { expect, it } from 'vitest';
import { boundedBatches, parseExcludedRows, sheetRangePages } from '../import-input';
it('keeps source positions and splits by utf-8 bytes as well as ten records', () => {
  const records = Array.from({ length: 23 }, (_, position) => ({
    position,
    value: '🌿'.repeat(100),
  }));
  const pages = [...boundedBatches(records, (rows) => ({ tasks: rows }), 1800)];
  expect(pages.flat()).toEqual(records);
  expect(
    pages.every(
      (rows) =>
        rows.length <= 10 &&
        new TextEncoder().encode(JSON.stringify({ tasks: rows })).length <= 1800,
    ),
  ).toBe(true);
  expect(() => [...boundedBatches([{ value: 'x'.repeat(65536) }], (rows) => rows)]).toThrow(
    /one record/,
  );
});
it('requires explicit bounded row exclusions rather than silently trimming input', () => {
  expect(parseExcludedRows('2, 4-6, 5')).toEqual([2, 4, 5, 6]);
  expect(() => parseExcludedRows('6-4')).toThrow(/row/);
  expect(() => parseExcludedRows('0')).toThrow(/row/);
  expect(() => parseExcludedRows('1-10001')).toThrow(/row/);
});
it('pages only the selected rectangular sheet range with its original columns', () => {
  expect(sheetRangePages('B21:D222')).toEqual(['B21:D120', 'B121:D220', 'B221:D222']);
  expect(() => sheetRangePages('A:Z')).toThrow(/range/);
  expect(() => sheetRangePages('A1:ZZ10')).toThrow(/256/);
  expect(() => sheetRangePages('A1:B10001')).toThrow(/10,000/);
});
