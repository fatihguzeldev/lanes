import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../shared/contracts/errors';
import {
  GoogleSheetsClient,
  GoogleSheetsError,
  GOOGLE_SHEETS_EXPORT_SCOPE,
  GOOGLE_SHEETS_IMPORT_SCOPE,
  parseSheetRange,
  parseSpreadsheetId,
} from './sheets';

const id = 'spreadsheet_1234567890';
const metadata = {
  spreadsheetId: id,
  properties: { title: 'work', locale: 'tr_TR', timeZone: 'Europe/Istanbul' },
  sheets: [
    {
      properties: {
        sheetId: 4,
        title: "owner's work",
        gridProperties: { rowCount: 2000, columnCount: 26 },
      },
    },
  ],
};
const response = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, ...(headers ? { headers } : {}) });
function fixture(
  value: unknown = metadata,
  extra: Partial<ConstructorParameters<typeof GoogleSheetsClient>[0]> = {},
) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(value));
  const client = new GoogleSheetsClient({ accessToken: 'server-token', fetch: fetcher, ...extra });
  return { fetcher, client };
}
const grid = (rows: unknown[], extra = {}) => ({
  spreadsheetId: id,
  sheets: [
    {
      properties: { sheetId: 4, title: "owner's work" },
      data: [{ startRow: 9, startColumn: 1, rowData: rows, ...extra }],
    },
  ],
});

describe('sheets access boundary', () => {
  it('accepts an id or an exact docs spreadsheet url and never follows its url', async () => {
    expect(parseSpreadsheetId(id)).toBe(id);
    expect(
      parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=4#gid=4`),
    ).toBe(id);
    for (const value of [
      `https://evil.test/${id}`,
      `https://docs.google.com.evil.test/spreadsheets/d/${id}/edit`,
      `http://docs.google.com/spreadsheets/d/${id}/edit`,
      `https://user@docs.google.com/spreadsheets/d/${id}`,
      'a/b',
      '..',
      'a%2fb',
      `https://docs.google.com:443/spreadsheets/d/${id}/../../other`,
      `https://docs.google.com/spreadsheets/d/${id}/export/evil`,
    ])
      expect(() => parseSpreadsheetId(value)).toThrow(GoogleSheetsError);
    const { client, fetcher } = fixture();
    const result = await client.metadata(
      `https://docs.google.com/spreadsheets/d/${id}/edit?evil=https://evil.test`,
    );
    expect(result).toEqual({
      id,
      title: 'work',
      locale: 'tr_TR',
      timeZone: 'Europe/Istanbul',
      sheets: [{ id: 4, title: "owner's work", rowCount: 2000, columnCount: 26 }],
    });
    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin).toBe('https://sheets.googleapis.com');
    expect(url.pathname).toBe('/v4/spreadsheets/' + id);
    expect(url.searchParams.get('fields')).toContain('gridProperties');
    expect(url.searchParams.has('ranges')).toBe(false);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-token');
    expect(init?.redirect).toBe('manual');
    expect(GOOGLE_SHEETS_IMPORT_SCOPE).toBe(
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    );
    expect(GOOGLE_SHEETS_EXPORT_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('rejects malformed metadata and another spreadsheet identity', async () => {
    for (const value of [
      { ...metadata, spreadsheetId: 'other' },
      { ...metadata, sheets: [{ properties: { sheetId: -1, title: 'bad' } }] },
      {
        ...metadata,
        sheets: [
          {
            properties: {
              sheetId: 1,
              title: 'bad',
              gridProperties: { rowCount: -1, columnCount: 10 },
            },
          },
        ],
      },
    ]) {
      await expect(fixture(value).client.metadata(id)).rejects.toMatchObject({
        code: 'provider_unavailable',
        retryable: true,
      });
    }
  });

  it('bounds rectangular selections and makes their coordinates explicit', () => {
    expect(parseSheetRange('$B$50000:$C$50001')).toEqual({
      startRow: 50000,
      endRow: 50001,
      startColumn: 2,
      endColumn: 3,
      rowCount: 2,
      columnCount: 2,
      range: 'B50000:C50001',
    });
    expect(parseSheetRange('ZZY50000:ZZZ50001')).toMatchObject({ rowCount: 2, columnCount: 2 });
    expect(parseSheetRange('A1')).toMatchObject({ rowCount: 1, columnCount: 1, range: 'A1:A1' });
    expect(parseSheetRange('A1:CV10000')).toMatchObject({ rowCount: 10000, columnCount: 100 });
    for (const range of [
      'A:A',
      '1:5',
      'Sheet!A1:B2',
      'B2:A1',
      'A0:B2',
      'A1:IW1',
      'A1:IU10000',
      'A1:B10001',
      'A1:B2,A4:B5',
      'R1C1',
    ])
      expect(() => parseSheetRange(range)).toThrow(GoogleSheetsError);
  });
});

describe('selected sheet values', () => {
  it('reads only the quoted selected sheet/range and keeps cached values without evaluating formulas', async () => {
    const { client, fetcher } = fixture(
      grid([
        {
          values: [
            { effectiveValue: { stringValue: 'task' } },
            { effectiveValue: { stringValue: 'due date' } },
          ],
        },
        {
          values: [
            {
              userEnteredValue: { formulaValue: '=HYPERLINK("https://evil.test","cached")' },
              effectiveValue: { stringValue: 'cached' },
            },
            {
              effectiveValue: { numberValue: 2 },
              effectiveFormat: { numberFormat: { type: 'DATE' } },
            },
          ],
        },
        {
          values: [
            { effectiveValue: { boolValue: false } },
            { effectiveValue: { numberValue: 0 } },
          ],
        },
      ]),
    );
    const table = await client.readRange(id, { sheet: "owner's work", range: 'B10:C12' });
    expect(table).toEqual({
      name: "owner's work",
      startRow: 10,
      rows: [
        ['task', 'due date'],
        ['cached', '1900-01-01'],
        [false, 0],
      ],
      cellIssues: [],
    });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.getAll('ranges')).toEqual(["'owner''s work'!B10:C12"]);
    expect(url.searchParams.get('fields')).toContain('effectiveValue');
    expect(url.searchParams.get('fields')).toContain('formulaValue');
    expect(url.searchParams.get('fields')).not.toContain('hyperlink');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shows missing formula caches, error cells, and date-time precision rather than inventing values', async () => {
    const { client } = fixture(
      grid([
        {
          values: [
            { userEnteredValue: { formulaValue: '=NOW()' } },
            {
              effectiveValue: {
                errorValue: { type: 'DIVIDE_BY_ZERO', message: 'private provider message' },
              },
            },
            {
              effectiveValue: { numberValue: 2.5 },
              effectiveFormat: { numberFormat: { type: 'DATE_TIME' } },
            },
            {
              effectiveValue: { numberValue: 0.5 },
              effectiveFormat: { numberFormat: { type: 'TIME' } },
            },
          ],
        },
      ]),
    );
    const table = await client.readRange(id, { sheet: "owner's work", range: 'B10:E10' });
    expect(table.rows).toEqual([[null, null, '1900-01-01T12:00:00', '12:00']]);
    expect(table.cellIssues?.map((issue) => issue.code)).toEqual([
      'formula_cache_missing',
      'sheet_cell_error',
      'sheet_local_datetime',
    ]);
    expect(table.cellIssues?.[0]?.source).toEqual({ sheet: "owner's work", row: 10, column: 2 });
    expect(JSON.stringify(table)).not.toContain('private provider message');
    expect(JSON.stringify(table)).not.toContain('=NOW');
  });

  it('warns before omitting hidden date times or time seconds', async () => {
    const { client } = fixture(
      grid([
        {
          values: [
            {
              effectiveValue: { numberValue: 2.5 },
              effectiveFormat: { numberFormat: { type: 'DATE' } },
            },
            {
              effectiveValue: { numberValue: 0.50002 },
              effectiveFormat: { numberFormat: { type: 'TIME' } },
            },
          ],
        },
      ]),
    );
    const result = await client.readRange(id, { sheet: "owner's work", range: 'B10:C10' });
    expect(result.rows).toEqual([['1900-01-01', '12:00']]);
    expect(result.cellIssues?.map((issue) => issue.code)).toEqual([
      'sheet_hidden_time',
      'sheet_time_precision',
    ]);
  });

  it('retains empty selected rows and rejects unselected or malformed grid data', async () => {
    const empty = fixture({
      spreadsheetId: id,
      sheets: [{ properties: { sheetId: 4, title: "owner's work" } }],
    });
    expect(
      (await empty.client.readRange(id, { sheet: "owner's work", range: 'B10:C11' })).rows,
    ).toEqual([
      [null, null],
      [null, null],
    ]);
    for (const value of [
      grid([], { startRow: 0 }),
      { spreadsheetId: id, sheets: [{ properties: { title: 'unselected', sheetId: 4 } }] },
      grid([{ values: [{ effectiveValue: { stringValue: 'x', boolValue: true } }] }]),
      grid([{ values: [{ effectiveValue: { stringValue: 1 } }] }]),
      grid(Array.from({ length: 4 }, () => ({}))),
    ])
      await expect(
        fixture(value).client.readRange(id, { sheet: "owner's work", range: 'B10:C12' }),
      ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('can reject formulas during explicit write readback even when their cached value matches', async () => {
    const { client } = fixture(
      grid([
        {
          values: [
            {
              userEnteredValue: { formulaValue: '="same text"' },
              effectiveValue: { stringValue: 'same text' },
            },
          ],
        },
      ]),
    );
    const table = await client.readRange(id, {
      sheet: "owner's work",
      range: 'B10:B10',
      rejectFormulas: true,
    });
    expect(table.rows).toEqual([[null]]);
    expect(table.cellIssues?.[0]?.code).toBe('sheet_formula_present');
  });

  it('requires callers to page large selections and rejects every invalid input before network access', async () => {
    const { client, fetcher } = fixture();
    for (const input of [
      { sheet: 'work', range: 'A1:A101' },
      { sheet: '', range: 'A1' },
      { sheet: 'work\n', range: 'A1' },
      { sheet: 'work', range: 'A:A' },
    ])
      await expect(client.readRange(id, input)).rejects.toMatchObject({
        code: 'validation_failed',
        outcome: 'rejected',
      });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('new spreadsheet export', () => {
  it('creates one new file with captured grid dimensions and constructs its official url', async () => {
    const { client, fetcher } = fixture({
      spreadsheetId: id,
      spreadsheetUrl: 'https://evil.test/private',
      sheets: [
        {
          properties: {
            sheetId: 0,
            title: 'tasks',
            gridProperties: { rowCount: 3001, columnCount: 17 },
          },
        },
      ],
    });
    expect(
      await client.createSpreadsheet({
        title: 'lanes export',
        sheets: [{ title: 'tasks', rowCount: 3001, columnCount: 17 }],
      }),
    ).toEqual({
      id,
      url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
      sheets: [{ id: 0, title: 'tasks', rowCount: 3001, columnCount: 17 }],
    });
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/v4/spreadsheets');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      properties: { title: 'lanes export' },
      sheets: [
        { properties: { title: 'tasks', gridProperties: { rowCount: 3001, columnCount: 17 } } },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('writes strings as RAW without escaping exact text, clearing nulls explicitly', async () => {
    const { client, fetcher } = fixture({
      spreadsheetId: id,
      updatedRange: "'owner''s work'!A5:D6",
      updatedRows: 2,
      updatedColumns: 4,
      updatedCells: 8,
    });
    const values = [
      ['=HYPERLINK("evil")', '+1', '@x', 'plain\nnotes'],
      ['-1', false, 0, null],
    ];
    expect(await client.writeRawRows(id, "owner's work", 5, values)).toEqual({
      updatedRows: 2,
      updatedColumns: 4,
      updatedCells: 8,
    });
    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.searchParams.get('valueInputOption')).toBe('RAW');
    expect(url.searchParams.get('includeValuesInResponse')).toBe('false');
    expect(decodeURIComponent(url.pathname)).toBe(
      `/v4/spreadsheets/${id}/values/'owner''s work'!A5:D6`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      range: "'owner''s work'!A5:D6",
      majorDimension: 'ROWS',
      values: [
        ['=HYPERLINK("evil")', '+1', '@x', 'plain\nnotes'],
        ['-1', false, 0, ''],
      ],
    });
  });

  it('rejects invalid and oversized export chunks before dispatch', async () => {
    const { client, fetcher } = fixture();
    await expect(
      client.writeRawRows(
        id,
        'tasks',
        1,
        Array.from({ length: 11 }, () => ['x']),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(client.writeRawRows(id, 'tasks', 1, [['😀'.repeat(17000)]])).rejects.toMatchObject(
      { code: 'validation_failed' },
    );
    await expect(client.writeRawRows(id, 'tasks', 0, [['x']])).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(client.writeRawRows(id, 'tasks', 1, [[Number.NaN]])).rejects.toMatchObject({
      code: 'validation_failed',
    });
    for (const input of [
      { title: '', sheets: [{ title: 'tasks' }] },
      { title: 'okay', sheets: [{ title: 'bad/name' }] },
      { title: 'okay', sheets: [{ title: 'same' }, { title: 'same' }] },
      { title: 'okay', sheets: [{ title: 'large', rowCount: 100000, columnCount: 256 }] },
    ])
      await expect(client.createSpreadsheet(input)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains an uncertain result when a success receipt names different output or incomplete writes', async () => {
    const created = fixture({
      spreadsheetId: id,
      sheets: [
        {
          properties: {
            sheetId: 0,
            title: 'other',
            gridProperties: { rowCount: 1000, columnCount: 26 },
          },
        },
      ],
    });
    await expect(
      created.client.createSpreadsheet({ title: 'x', sheets: [{ title: 'tasks' }] }),
    ).rejects.toMatchObject({ code: 'outcome_uncertain', retryable: false });
    for (const value of [
      {
        spreadsheetId: 'wrong',
        updatedRange: 'tasks!A1',
        updatedRows: 1,
        updatedColumns: 1,
        updatedCells: 1,
      },
      {
        spreadsheetId: id,
        updatedRange: 'tasks!A1',
        updatedRows: 0,
        updatedColumns: 0,
        updatedCells: 0,
      },
      {
        spreadsheetId: id,
        updatedRange: 'other!A1',
        updatedRows: 1,
        updatedColumns: 1,
        updatedCells: 1,
      },
      {
        spreadsheetId: id,
        updatedRange: 'tasks!B3',
        updatedRows: 1,
        updatedColumns: 1,
        updatedCells: 1,
      },
    ])
      await expect(
        fixture(value).client.writeRawRows(id, 'tasks', 1, [['value']]),
      ).rejects.toMatchObject({ code: 'outcome_uncertain', retryable: false });
  });
});

describe('provider failures and bounded transport', () => {
  it.each([
    [401, 'reconnect_required'],
    [403, 'permission_required'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'provider_rate_limited'],
    [400, 'validation_failed'],
  ] as const)('maps HTTP %s to a sanitized definite rejection', async (status, code) => {
    const fetcher = vi.fn(async () =>
      response(
        { error: { message: 'secret-token private-file', errors: [{ reason: 'forbidden' }] } },
        status,
        { 'retry-after': '12' },
      ),
    );
    const client = new GoogleSheetsClient({ accessToken: 'secret-token', fetch: fetcher });
    const error = await client
      .createSpreadsheet({ title: 'x', sheets: [{ title: 'tasks' }] })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code, status, outcome: 'rejected' });
    expect(String(error)).not.toMatch(/secret-token|private-file/);
    if (status === 429) expect(error).toMatchObject({ retryable: true, retryAfterSeconds: 12 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes rate-limit 403 from optional permission failure', async () => {
    const { client } = fixture(
      {},
      {
        fetch: async () =>
          response({ error: { details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } }, 403),
      },
    );
    await expect(client.metadata(id)).rejects.toMatchObject({
      code: 'provider_rate_limited',
      retryable: true,
      outcome: 'rejected',
    });
  });

  it.each(['network', 'timeout', 'invalid-json', 'invalid-schema', 'oversized', 'server'] as const)(
    'never retries a %s write with an unknown outcome',
    async (kind) => {
      const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (kind === 'network') throw new Error('token and personal data');
        if (kind === 'timeout')
          return new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted secret')), {
              once: true,
            }),
          );
        if (kind === 'invalid-json') return new Response('{not-json');
        if (kind === 'invalid-schema') return response({ spreadsheetId: 3 });
        if (kind === 'oversized') return new Response('x'.repeat(2048));
        return response({}, 503);
      });
      const client = new GoogleSheetsClient({
        accessToken: 'token',
        fetch: fetcher,
        timeoutMs: 5,
        maxResponseBytes: 1024,
      });
      const error = await client
        .createSpreadsheet({ title: 'x', sheets: [{ title: 'tasks' }] })
        .catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: 'outcome_uncertain',
        outcome: 'uncertain',
        retryable: false,
      });
      expect(String(error)).not.toMatch(/personal|token/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('makes failed reads retryable and preserves trusted pre-dispatch budget failures', async () => {
    const { client } = fixture(
      {},
      {
        fetch: async () => {
          throw new Error('network');
        },
      },
    );
    await expect(client.metadata(id)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      outcome: 'rejected',
    });
    const budget = new AppError('provider_rate_limited', 'request budget exhausted', 429, true);
    await expect(
      fixture(
        {},
        {
          fetch: async () => {
            throw budget;
          },
        },
      ).client.createSpreadsheet({ title: 'x', sheets: [{ title: 'tasks' }] }),
    ).rejects.toBe(budget);
  });

  it('rejects bad credentials, cancellation, and configuration without making a request', async () => {
    const fetcher = vi.fn();
    for (const accessToken of ['', 'token\nheader', 'with spaces'])
      await expect(
        new GoogleSheetsClient({ accessToken, fetch: fetcher }).metadata(id),
      ).rejects.toMatchObject({ code: 'reconnect_required', outcome: 'rejected' });
    const signal = AbortSignal.abort();
    await expect(
      new GoogleSheetsClient({ accessToken: 'token', fetch: fetcher, signal }).createSpreadsheet({
        title: 'x',
        sheets: [{ title: 'tasks' }],
      }),
    ).rejects.toMatchObject({ code: 'conflict', outcome: 'rejected' });
    for (const timeoutMs of [0, -1, 30001, Number.NaN])
      expect(() => new GoogleSheetsClient({ accessToken: 'token', timeoutMs })).toThrow(
        GoogleSheetsError,
      );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels over-limit response streams and does not expose body details', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('private'.repeat(200)));
      },
      cancel,
    });
    const { client } = fixture(
      {},
      { maxResponseBytes: 1024, fetch: async () => new Response(stream) },
    );
    await expect(client.metadata(id)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
