import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { readWorkbook } from '../workbook';
import {
  inspectWorkbookContainer,
  inspectNumbersSnappy,
  inspectOdsXml,
  decodeNumbersSnappy,
} from '../container';
import { MAX_IMPORT_EXPANDED_BYTES, MAX_IMPORT_FILE_BYTES } from '../../contracts/parsing';

const fixture = (format: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/workbooks/tasks.${format}`, import.meta.url)));
const workbook = (sheet: XLSX.WorkSheet, second?: XLSX.WorkSheet) => {
  const value = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(value, sheet, 'Tasks');
  if (second) XLSX.utils.book_append_sheet(value, second, 'Other');
  return new Uint8Array(XLSX.write(value, { type: 'array', bookType: 'xlsx', compression: true }));
};

function uint(bytes: Uint8Array, pointer: { offset: number }): number {
  let value = 0,
    shift = 0;
  for (;;) {
    const byte = bytes[pointer.offset++]!;
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return value;
    shift += 7;
  }
}
function fields(bytes: Uint8Array): Map<number, Uint8Array[]> {
  const values = new Map<number, Uint8Array[]>(),
    pointer = { offset: 0 };
  while (pointer.offset < bytes.length) {
    const tag = uint(bytes, pointer),
      wire = tag & 7;
    let start = pointer.offset,
      end = start;
    if (wire === 0) {
      uint(bytes, pointer);
      end = pointer.offset;
    } else if (wire === 2) {
      const length = uint(bytes, pointer);
      start = pointer.offset;
      end = start + length;
    } else end = start + (wire === 1 ? 8 : 4);
    const list = values.get(tag >>> 3) ?? [];
    list.push(bytes.subarray(start, end));
    values.set(tag >>> 3, list);
    pointer.offset = end;
  }
  return values;
}
function numeric(bytes: Uint8Array): number {
  return uint(bytes, { offset: 0 });
}
function rawSnappy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  let length = bytes.length;
  const encoded: number[] = [];
  do {
    encoded.push((length & 127) | (length > 127 ? 128 : 0));
    length = Math.floor(length / 128);
  } while (length);
  const extra: number[] = [];
  let size = bytes.length - 1;
  do {
    extra.push(size & 255);
    size = Math.floor(size / 256);
  } while (size);
  const body = new Uint8Array(
    encoded.length + 1 + (bytes.length < 61 ? 0 : extra.length) + bytes.length,
  );
  body.set(encoded);
  body[encoded.length] = bytes.length < 61 ? (bytes.length - 1) << 2 : (59 + extra.length) << 2;
  let offset = encoded.length + 1;
  if (bytes.length >= 61) {
    body.set(extra, offset);
    offset += extra.length;
  }
  body.set(bytes, offset);
  const framed = new Uint8Array(4 + body.length);
  framed[1] = body.length & 255;
  framed[2] = (body.length >>> 8) & 255;
  framed[3] = (body.length >>> 16) & 255;
  framed.set(body, 4);
  return framed;
}
function numbersWithUncachedFormula(): Uint8Array {
  const entries = unzipSync(fixture('numbers'));
  let changed = false;
  for (const [name, compressed] of Object.entries(entries)) {
    if (!/Tile-.*\.iwa$/.test(name)) continue;
    const bytes = decodeNumbersSnappy(compressed),
      pointer = { offset: 0 };
    while (pointer.offset < bytes.length) {
      const length = uint(bytes, pointer),
        header = fields(bytes.subarray(pointer.offset, pointer.offset + length));
      pointer.offset += length;
      for (const info of header.get(2) ?? []) {
        const metadata = fields(info),
          size = numeric(metadata.get(3)![0]!),
          type = numeric(metadata.get(1)![0]!);
        const payload = bytes.subarray(pointer.offset, pointer.offset + size);
        pointer.offset += size;
        if (type !== 6002) continue;
        for (const rowData of fields(payload).get(5) ?? []) {
          const row = fields(rowData);
          if (numeric(row.get(1)![0]!) !== 1) continue;
          const offsets = row.get(7)?.[0],
            storage = row.get(6)?.[0];
          if (!offsets || !storage) continue;
          const scale = row.get(8)?.[0] && numeric(row.get(8)![0]!) ? 4 : 1;
          const view = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength),
            start = view.getUint16(2, true) * scale,
            end = view.getUint16(4, true) * scale;
          const cell = storage.subarray(start, end);
          if (cell[0] !== 5 || cell.length !== 16) continue;
          cell.fill(0);
          cell[0] = 5;
          new DataView(cell.buffer, cell.byteOffset, cell.byteLength).setUint32(8, 512, true);
          changed = true;
        }
      }
    }
    entries[name] = rawSnappy(bytes);
  }
  expect(changed).toBe(true);
  return zipSync(entries);
}

describe('values-only workbook import', () => {
  it.each(['xlsx', 'xls', 'ods', 'numbers'] as const)(
    'reads a genuine %s fixture',
    async (format) => {
      const parsed = await readWorkbook(fixture(format), format);
      expect(parsed.tables).toHaveLength(1);
      expect(parsed.tables[0]?.rows[0]).toEqual(['Task', 'Notes', 'Due date', 'Completed']);
      expect(parsed.tables[0]?.rows[1]).toEqual([
        'write a note',
        'line one\nline two',
        '2026-11-03',
        false,
      ]);
      expect(parsed.tables[0]?.rows[2]?.[3]).toBe(true);
    },
  );

  it.each(['xlsx', 'xls', 'ods', 'numbers'] as const)(
    'does not use network access while reading %s bytes',
    async (format) => {
      const network = vi.fn(() => {
        throw new Error('unexpected network request');
      });
      vi.stubGlobal('fetch', network);
      try {
        await readWorkbook(fixture(format), format);
        expect(network).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('keeps a hyperlink and external formula inert while using its cached text', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Task', 'Notes'],
      ['linked', 'cached text'],
    ]);
    sheet.A2!.l = { Target: 'https://attacker.example/private' };
    sheet.B2!.f = 'WEBSERVICE("https://attacker.example/private")';
    const network = vi.fn(() => {
      throw new Error('unexpected network request');
    });
    vi.stubGlobal('fetch', network);
    try {
      expect((await readWorkbook(workbook(sheet), 'xlsx')).tables[0]?.rows[1]).toEqual([
        'linked',
        'cached text',
      ]);
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses only explicitly selected sheets and the requested range', async () => {
    const bytes = workbook(
      XLSX.utils.aoa_to_sheet([['ignore'], ['Task', 'Notes'], ['one', 'a'], ['two', 'b']]),
      XLSX.utils.aoa_to_sheet([['Task'], ['other']]),
    );
    const parsed = await readWorkbook(bytes, 'xlsx', [{ sheet: 'Tasks', range: 'A2:B3' }]);
    expect(parsed.tables[0]).toMatchObject({
      name: 'Tasks',
      startRow: 2,
      rows: [
        ['Task', 'Notes'],
        ['one', 'a'],
      ],
    });
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(['Tasks', 'Other']);
  });

  it('shows cached formula values and reports unresolved formulas without evaluating them', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Task', 'Notes'],
      ['cached', ''],
      ['unresolved', ''],
    ]);
    sheet.B2 = { t: 's', f: 'HYPERLINK("https://attacker.example","run")', v: 'cached text' };
    sheet.B3 = { t: 'n', f: 'WEBSERVICE("https://attacker.example")' };
    const parsed = await readWorkbook(workbook(sheet), 'xlsx');
    expect(parsed.tables[0]?.rows[1]?.[1]).toBe('cached text');
    expect(parsed.tables[0]?.rows[2]?.[1]).toBeNull();
    expect(parsed.tables[0]?.cellIssues).toContainEqual(
      expect.objectContaining({
        code: 'formula_without_value',
        source: { sheet: 'Tasks', row: 3, column: 2 },
      }),
    );
  });

  it('identifies an uncached numbers formula even though the vendor discards its formula index', async () => {
    const parsed = await readWorkbook(numbersWithUncachedFormula(), 'numbers');
    expect(parsed.tables[0]?.rows[1]?.[1]).toBeNull();
    expect(parsed.tables[0]?.cellIssues).toContainEqual(
      expect.objectContaining({
        code: 'formula_without_value',
        source: { sheet: 'Tasks', row: 2, column: 2 },
      }),
    );
  });

  it('turns cached workbook dates into iso days without applying a local time zone', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Task', 'Due date'],
      ['dated', 0],
    ]);
    sheet.B2 = {
      t: 'n',
      v: (Date.UTC(2026, 10, 3) - Date.UTC(1899, 11, 30)) / 86_400_000,
      z: 'yyyy-mm-dd',
    };
    const parsed = await readWorkbook(workbook(sheet), 'xlsx');
    expect(parsed.tables[0]?.rows[1]?.[1]).toBe('2026-11-03');
  });

  it('refuses an unbounded declared empty range rather than allocating it', async () => {
    const content = unzipSync(workbook(XLSX.utils.aoa_to_sheet([['Task'], ['small']])));
    content['xl/worksheets/sheet1.xml'] = strToU8(
      strFromU8(content['xl/worksheets/sheet1.xml']!).replace(
        /<dimension ref="[^"]*"\/>/,
        '<dimension ref="A1:XFD1048576"/>',
      ),
    );
    await expect(readWorkbook(zipSync(content), 'xlsx')).rejects.toMatchObject({
      code: 'table_bounds',
    });
  });

  it('reads a bounded range far below the first ten thousand worksheet rows', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([]);
    sheet.A50000 = { t: 's', v: 'Task' };
    sheet.B50000 = { t: 's', v: 'Notes' };
    sheet.A50001 = { t: 's', v: 'selected' };
    sheet.B50001 = { t: 's', v: 'kept' };
    sheet['!ref'] = 'A50000:B50001';
    const parsed = await readWorkbook(workbook(sheet), 'xlsx', [
      { sheet: 'Tasks', range: 'A50000:B50001' },
    ]);
    expect(parsed.tables[0]).toMatchObject({
      startRow: 50000,
      rows: [
        ['Task', 'Notes'],
        ['selected', 'kept'],
      ],
    });
  });

  it('fails rather than silently truncating more than ten thousand cell diagnostics', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([['Task', 'Notes', 'Extra']]);
    for (let row = 2; row <= 5002; row++) {
      sheet[`A${row}`] = { t: 's', v: `task ${row}` };
      sheet[`B${row}`] = { t: 'n', f: '1+1' };
      sheet[`C${row}`] = { t: 'n', f: '1+1' };
    }
    sheet['!ref'] = 'A1:C5002';
    await expect(readWorkbook(workbook(sheet), 'xlsx')).rejects.toMatchObject({
      code: 'too_many_issues',
    });
  });

  it('rejects main-thread browser and server-worker parsing in production', async () => {
    vi.stubGlobal('window', {});
    try {
      await expect(readWorkbook(fixture('xlsx'), 'xlsx')).rejects.toMatchObject({
        code: 'worker_required',
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const test = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await expect(readWorkbook(fixture('xlsx'), 'xlsx')).rejects.toMatchObject({
        code: 'worker_required',
      });
    } finally {
      if (test !== undefined) process.env.VITEST = test;
    }
  });

  it('rejects unknown, reversed and excessive selections', async () => {
    const bytes = fixture('xlsx');
    for (const selection of [
      [{ sheet: 'missing' }],
      [{ sheet: 'Tasks', range: 'B3:A1' }],
      [{ sheet: 'Tasks', range: 'A1:ZZ10000' }],
    ]) {
      await expect(readWorkbook(bytes, 'xlsx', selection)).rejects.toBeDefined();
    }
  });

  it('rejects mismatched formats and arbitrary zip archives', async () => {
    await expect(readWorkbook(fixture('xlsx'), 'numbers')).rejects.toMatchObject({
      code: 'unsupported_container',
    });
    await expect(
      readWorkbook(zipSync({ 'readme.txt': strToU8('not a workbook') }), 'xlsx'),
    ).rejects.toMatchObject({ code: 'unsupported_container' });
    await expect(
      readWorkbook(new Uint8Array(MAX_IMPORT_FILE_BYTES + 1), 'xlsx'),
    ).rejects.toMatchObject({ code: 'file_too_large' });
  });
});

describe('container resource limits', () => {
  it('measures actual expanded zip bytes instead of trusting declared sizes', async () => {
    const bytes = zipSync(
      {
        '[Content_Types].xml': strToU8('types'),
        'xl/workbook.xml': strToU8('workbook'),
        'xl/large.xml': new Uint8Array(4096),
      },
      { level: 9 },
    );
    await expect(
      inspectWorkbookContainer(bytes, 'xlsx', { maxExpandedBytes: 2048 }),
    ).rejects.toMatchObject({ code: 'expanded_too_large' });
  });

  it('rejects encrypted zip entries and unsupported compression before library parsing', async () => {
    const bytes = zipSync({
      '[Content_Types].xml': strToU8('types'),
      'xl/workbook.xml': strToU8('workbook'),
    });
    const encrypted = bytes.slice();
    encrypted[6] = (encrypted[6] ?? 0) | 1;
    await expect(inspectWorkbookContainer(encrypted, 'xlsx')).rejects.toMatchObject({
      code: 'encrypted_container',
    });
  });

  it('validates numbers snappy literal and copy lengths without expanding them', () => {
    const literal = new Uint8Array([0, 5, 0, 0, 3, 8, 97, 98, 99]);
    expect(inspectNumbersSnappy(literal, 100)).toBe(3);
    const copied = new Uint8Array([0, 8, 0, 0, 6, 8, 97, 98, 99, 10, 3, 0]);
    expect(inspectNumbersSnappy(copied, 100)).toBe(6);
    expect(() => inspectNumbersSnappy(copied, 5)).toThrow(
      expect.objectContaining({ code: 'expanded_too_large' }),
    );
    const invalidCopy = new Uint8Array([0, 3, 0, 0, 3, 10, 3]);
    expect(() => inspectNumbersSnappy(invalidCopy, 100)).toThrow(
      expect.objectContaining({ code: 'invalid_container' }),
    );
  });

  it('counts inner numbers expansion in the same total budget as its zip output', async () => {
    const literal = new Uint8Array([0, 5, 0, 0, 3, 8, 97, 98, 99]);
    const bytes = zipSync({ 'Index/Document.iwa': literal });
    await expect(
      inspectWorkbookContainer(bytes, 'numbers', { maxExpandedBytes: 11 }),
    ).rejects.toMatchObject({ code: 'expanded_too_large' });
  });

  it('rejects malformed zip64 sentinels without following untrusted directories', async () => {
    const bytes = zipSync({
      '[Content_Types].xml': strToU8('types'),
      'xl/workbook.xml': strToU8('workbook'),
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(bytes.length - 22 + 10, 65535, true);
    view.setUint16(bytes.length - 22 + 8, 65535, true);
    await expect(inspectWorkbookContainer(bytes, 'xlsx')).rejects.toMatchObject({
      code: 'invalid_container',
    });
  });

  it('rejects ods repeat bombs before a library can allocate their cells', () => {
    expect(() =>
      inspectOdsXml(
        '<table:table-row table:number-rows-repeated="999999999"><table:table-cell office:value-type="string"><text:p>copy</text:p></table:table-cell></table:table-row>',
      ),
    ).toThrow(expect.objectContaining({ code: 'table_bounds' }));
    expect(() =>
      inspectOdsXml(
        '<table:table-row><table:table-cell table:number-columns-repeated="999999999"/></table:table-row>',
      ),
    ).toThrow(expect.objectContaining({ code: 'table_bounds' }));
    expect(() =>
      inspectOdsXml('<!DOCTYPE document [<!ENTITY data SYSTEM "https://attacker.example">]>'),
    ).toThrow(expect.objectContaining({ code: 'invalid_container' }));
  });

  it('rejects malformed protobuf inside a valid snappy frame before the vendor can log and skip it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const bytes = zipSync({ 'Index/Document.iwa': rawSnappy(new Uint8Array([1, 0])) });
      await expect(readWorkbook(bytes, 'numbers')).rejects.toMatchObject({
        code: 'invalid_container',
      });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('rejects forged snappy lengths, truncated chunks and invalid frame types', () => {
    for (const bytes of [
      new Uint8Array([0, 2, 0, 0, 255, 255]),
      new Uint8Array([0, 7, 0, 0, 3]),
      new Uint8Array([1, 1, 0, 0, 0]),
    ]) {
      expect(() => inspectNumbersSnappy(bytes, MAX_IMPORT_EXPANDED_BYTES)).toThrow();
    }
  });
});
