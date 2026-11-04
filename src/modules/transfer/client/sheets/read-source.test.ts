import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionSummary } from '../../../accounts/contracts';
import { readSelectedSheetTables } from './read-source';

const account: ConnectionSummary = {
  id: 'source-account',
  email: 'source@example.com',
  displayName: 'source',
  pictureUrl: null,
  state: 'connected',
  permissions: { tasks: true, sheetsImport: true, sheetsExport: false },
  grantExpiresAt: null,
  planningZone: 'UTC',
  weekStart: 1,
  revision: 1,
};
afterEach(() => vi.unstubAllGlobals());

it('reads only the selected ranges under their source account and combines bounded pages', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const responses = [
    { name: 'work', startRow: 21, rows: [['first']] },
    { name: 'work', startRow: 121, rows: [['second']] },
    { name: 'work', startRow: 221, rows: [['third']] },
    { name: 'home', startRow: 1, rows: [['fourth']] },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json(responses[calls.length - 1]);
    }),
  );
  const progress = vi.fn();
  const tables = await readSelectedSheetTables(
    {
      account,
      accountId: account.id,
      spreadsheetId: 'spreadsheet-id',
      selectedSheets: ['work', 'home'],
      ranges: { work: 'B21:D222', home: 'A1:A1', unselected: 'A1:Z10000' },
    },
    new AbortController().signal,
    progress,
  );
  expect(calls).toEqual(
    ['B21:D120', 'B121:D220', 'B221:D222', 'A1:A1'].map((range, index) => ({
      path: '/api/accounts/source-account/transfer/sheets/range',
      body: { spreadsheetId: 'spreadsheet-id', sheet: index < 3 ? 'work' : 'home', range },
    })),
  );
  expect(tables).toEqual([
    { name: 'work', startRow: 21, rows: [['first'], ['second'], ['third']], cellIssues: [] },
    responses[3],
  ]);
  expect(progress).toHaveBeenCalledTimes(4);
});

it('refuses unreadable sources and empty selections before requesting spreadsheet data', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const source = {
    account,
    accountId: account.id,
    spreadsheetId: 'spreadsheet-id',
    selectedSheets: ['work'],
    ranges: { work: 'A1:A1' },
  };
  for (const unavailable of [
    undefined,
    { ...account, state: 'disconnected' as const },
    {
      ...account,
      permissions: { ...account.permissions, sheetsImport: false },
    },
  ])
    await expect(
      readSelectedSheetTables(
        { ...source, account: unavailable },
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('authorize sheets read access');
  await expect(
    readSelectedSheetTables(
      { ...source, selectedSheets: [] },
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow('select at least one tab');
  expect(fetch).not.toHaveBeenCalled();
});

it('checks the whole selected request bound before reading its first page', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const selectedSheets = Array.from({ length: 11 }, (_, index) => `sheet-${index}`);
  await expect(
    readSelectedSheetTables(
      {
        account,
        accountId: account.id,
        spreadsheetId: 'spreadsheet-id',
        selectedSheets,
        ranges: Object.fromEntries(selectedSheets.map((sheet) => [sheet, 'A1:A10000'])),
      },
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow('1,000 bounded reads');
  expect(fetch).not.toHaveBeenCalled();
});
