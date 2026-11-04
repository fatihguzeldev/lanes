import { expect, it } from 'vitest';
import { decodeSheetsDraft } from './source-draft';
it('restores only bounded recent spreadsheet choices for still-owned accounts', () => {
  const value = {
    createdAt: 1000,
    sourceAccountId: 'source',
    spreadsheet: 'spreadsheet-id',
    selectedSheets: ['home'],
    ranges: { home: 'A1:D10' },
  };
  expect(decodeSheetsDraft(JSON.stringify(value), ['source'], 2000)).toEqual(value);
  expect(decodeSheetsDraft(JSON.stringify(value), ['other'], 2000)).toBeNull();
  expect(decodeSheetsDraft(JSON.stringify(value), ['source'], 86401000)).toBeNull();
  expect(
    decodeSheetsDraft(
      JSON.stringify({ ...value, token: 'not a supported draft field' }),
      ['source'],
      2000,
    ),
  ).toBeNull();
});
