import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import { inspectWorkbookContainer } from './container';
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  TransferParseError,
} from '../contracts/parsing';
import type {
  ImportCell,
  ImportIssue,
  ImportTable,
  WorkbookSelection,
  WorkbookTables,
} from '../contracts/parsing';

XLSX.set_cptable(cptable);
const maxCells = 1_000_000;
const compoundMagic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ssf = XLSX.SSF as {
  get_table(): Record<number, string>;
  is_date(format: string): boolean;
  parse_date_code(
    value: number,
    options: { date1904: boolean },
  ): { y: number; m: number; d: number; H: number; M: number; S: number; u: number } | null;
};
function invalid(): never {
  throw new TransferParseError(
    'invalid_workbook',
    'the workbook could not be read safely. open it in its source application and save a fresh xlsx copy.',
  );
}
function bounds(): never {
  throw new TransferParseError(
    'table_bounds',
    'the selected table exceeds 10,000 rows, 256 columns or 1,000,000 cells. select a smaller range or save a smaller workbook.',
  );
}
function unsupported(): never {
  throw new TransferParseError(
    'unsupported_container',
    'the file contents do not match the selected workbook format. open it in its source application and save an xlsx copy.',
  );
}
function encrypted(): never {
  throw new TransferParseError(
    'encrypted_container',
    'encrypted workbooks are not supported. remove the password and save an unencrypted copy.',
  );
}
function isCompound(bytes: Uint8Array): boolean {
  return compoundMagic.every((value, index) => bytes[index] === value);
}
function inspectBiff(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 0,
    records = 0;
  while (position + 4 <= bytes.length) {
    if (++records > 1_000_000)
      throw new TransferParseError(
        'table_bounds',
        'this legacy workbook has too many records. save the selected range as a smaller workbook.',
      );
    const type = view.getUint16(position, true),
      length = view.getUint16(position + 2, true);
    if (type === 0x002f) encrypted();
    position += 4;
    if (position + length > bytes.length) invalid();
    position += length;
  }
}
function inspectLegacy(bytes: Uint8Array, format: string): void {
  if (isCompound(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 512 || ![9, 12].includes(view.getUint16(30, true))) invalid();
    const sectorSize = 2 ** view.getUint16(30, true),
      sectors = Math.ceil(bytes.length / sectorSize);
    if (
      view.getUint32(44, true) > sectors ||
      view.getUint32(64, true) > sectors ||
      view.getUint32(72, true) > sectors
    )
      invalid();
    let parsed: { FileIndex: { name: string; content?: Uint8Array | number[] }[] };
    try {
      parsed = (
        XLSX.CFB as { read(data: Uint8Array, options: { type: 'array' }): typeof parsed }
      ).read(bytes, { type: 'array' });
    } catch {
      return invalid();
    }
    if (
      parsed.FileIndex.some((entry) => ['EncryptionInfo', 'EncryptedPackage'].includes(entry.name))
    )
      encrypted();
    const workbook = parsed.FileIndex.find(
      (entry) => entry.name === 'Workbook' || entry.name === 'Book',
    );
    if (format !== 'xls' || !workbook?.content) unsupported();
    inspectBiff(
      workbook.content instanceof Uint8Array ? workbook.content : new Uint8Array(workbook.content),
    );
    return;
  }
  if (format !== 'xls' || bytes.length < 4) unsupported();
  const type = bytes[0]! | (bytes[1]! << 8);
  if (![0x0009, 0x0209, 0x0409, 0x0809].includes(type)) unsupported();
  inspectBiff(bytes);
}
function range(input: string): XLSX.Range {
  if (!/^[A-Za-z]{1,3}[1-9]\d{0,6}(?::[A-Za-z]{1,3}[1-9]\d{0,6})?$/.test(input))
    throw new TransferParseError(
      'invalid_range',
      'select a bounded a1 cell range, such as A1:F200.',
    );
  const value = XLSX.utils.decode_range(input);
  if (value.s.r > value.e.r || value.s.c > value.e.c)
    throw new TransferParseError('invalid_range', 'the range end must follow its start.');
  if (value.e.r > 1_048_575 || value.e.c > 16_383) bounds();
  const rows = value.e.r - value.s.r + 1,
    columns = value.e.c - value.s.c + 1;
  if (rows > MAX_TABLE_ROWS || columns > MAX_TABLE_COLUMNS || rows * columns > maxCells) bounds();
  return value;
}
function dateValue(
  cell: XLSX.CellObject,
  date1904: boolean,
  issue: (code: string, message: string) => void,
): ImportCell {
  const numberFormat =
    typeof cell.z === 'string'
      ? cell.z
      : typeof cell.z === 'number'
        ? ssf.get_table()[cell.z]
        : undefined;
  if (typeof cell.v !== 'number' || !numberFormat || !ssf.is_date(numberFormat))
    return typeof cell.v === 'number' && Number.isFinite(cell.v) ? cell.v : null;
  const parsed = ssf.parse_date_code(cell.v, { date1904 });
  if (
    !parsed ||
    parsed.y < 1 ||
    parsed.y > 9999 ||
    parsed.d < 1 ||
    parsed.m < 1 ||
    parsed.m > 12 ||
    (parsed.y === 1900 && parsed.m === 2 && parsed.d === 29)
  ) {
    issue(
      'invalid_cached_date',
      'this cached spreadsheet date is not a valid calendar date. choose a replacement or omit it in preview.',
    );
    return null;
  }
  const two = (value: number) => String(value).padStart(2, '0');
  const format = numberFormat.replace(/"[^"]*"|\\./g, '').toLowerCase();
  const hasDate = /[yd]/.test(format) || (/m/.test(format) && !/[hs]/.test(format)),
    time = `${two(parsed.H)}:${two(parsed.M)}`;
  if (!hasDate) return time;
  const day = `${String(parsed.y).padStart(4, '0')}-${two(parsed.m)}-${two(parsed.d)}`;
  if (parsed.H || parsed.M || parsed.S || parsed.u) {
    issue(
      'cached_datetime',
      'this cell contains a date and a time. map both explicitly or choose a date-only value in preview.',
    );
    return `${day}T${time}:${two(parsed.S)}`;
  }
  return day;
}
function cellValue(
  cell: XLSX.CellObject | undefined,
  date1904: boolean,
  issue: (code: string, message: string) => void,
): ImportCell {
  if (!cell) return null;
  if (cell.f && cell.v == null) {
    issue(
      'formula_without_value',
      'this formula has no cached value. replace it with a value or omit the field in preview.',
    );
    return null;
  }
  if (cell.t === 'e') {
    issue(
      'cell_error',
      'this spreadsheet cell contains an error. replace it or omit the field in preview.',
    );
    return null;
  }
  if (cell.v === undefined || cell.v === null) return null;
  if (typeof cell.v === 'string' || typeof cell.v === 'boolean') return cell.v;
  if (typeof cell.v === 'number') return dateValue(cell, date1904, issue);
  issue(
    'unsupported_cell',
    'this cell type cannot be imported as a value. convert it to text in the source workbook.',
  );
  return null;
}

/** Reads local bytes only. Production callers must use parser.worker; no workbook formulas, links or macros are executed. */
export async function readWorkbook(
  bytes: Uint8Array,
  format: 'xlsx' | 'xls' | 'ods' | 'numbers',
  selections?: readonly WorkbookSelection[],
): Promise<WorkbookTables> {
  const worker = globalThis as unknown as {
    constructor?: { name?: string };
    postMessage?: unknown;
  };
  const test = typeof process !== 'undefined' && process.env.VITEST === 'true';
  if (
    typeof window !== 'undefined' ||
    (!test &&
      (worker.constructor?.name !== 'DedicatedWorkerGlobalScope' ||
        typeof worker.postMessage !== 'function'))
  )
    throw new TransferParseError(
      'worker_required',
      'workbook parsing runs in a dedicated browser worker.',
    );
  if (bytes.byteLength > MAX_IMPORT_FILE_BYTES)
    throw new TransferParseError(
      'file_too_large',
      'the file exceeds 20 mib. select a smaller source.',
    );
  if (!bytes.length) invalid();
  const container =
    format === 'xls' || isCompound(bytes)
      ? (inspectLegacy(bytes, format), null)
      : await inspectWorkbookContainer(bytes, format);
  if (
    selections &&
    (!selections.length ||
      selections.length > 100 ||
      new Set(selections.map((selection) => selection.sheet)).size !== selections.length)
  )
    throw new TransferParseError(
      'invalid_selection',
      'choose each workbook sheet once, with an optional bounded range.',
    );
  for (const selection of selections ?? []) {
    if (!selection.sheet || selection.sheet.length > 1024)
      throw new TransferParseError('invalid_selection', 'choose a named workbook sheet.');
    if (selection.range) range(selection.range);
  }
  const rowLimit = selections?.length
    ? Math.max(
        ...selections.map((selection) =>
          selection.range ? range(selection.range).e.r + 1 : MAX_TABLE_ROWS + 1,
        ),
      )
    : MAX_TABLE_ROWS + 1;
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(bytes, {
      type: 'array',
      dense: false,
      cellFormula: true,
      cellHTML: false,
      cellNF: true,
      cellText: false,
      cellDates: false,
      bookVBA: false,
      bookDeps: false,
      bookFiles: false,
      sheetRows: rowLimit,
      ...(selections ? { sheets: selections.map((selection) => selection.sheet) } : {}),
    });
  } catch {
    return invalid();
  }
  if (!book.SheetNames.length || book.SheetNames.length > 1000) invalid();
  const sheets = book.SheetNames.map((name) => ({
    name,
    range: String(book.Sheets[name]?.['!fullref'] ?? book.Sheets[name]?.['!ref'] ?? ''),
  }));
  const selected: readonly WorkbookSelection[] =
    selections ?? book.SheetNames.map((sheet) => ({ sheet }));
  if (selected.length > 100)
    throw new TransferParseError(
      'invalid_selection',
      'select at most 100 workbook sheets for one import.',
    );
  const tables: ImportTable[] = [],
    issues: ImportIssue[] = container?.issues ?? [];
  const formulas = new Set(
    (container?.formulaCells ?? []).map(
      (cell) => `${cell.sheet}\u0000${cell.row}\u0000${cell.column}`,
    ),
  );
  let diagnosticCount = issues.length;
  let selectedCells = 0;
  for (const selection of selected) {
    if (!book.SheetNames.includes(selection.sheet))
      throw new TransferParseError(
        'invalid_selection',
        'a selected workbook sheet was not found. choose it again.',
      );
    const sheet = book.Sheets[selection.sheet];
    if (!sheet) invalid();
    const reference = selection.range ?? sheet['!fullref'] ?? sheet['!ref'];
    if (!reference) {
      tables.push({ name: selection.sheet, rows: [], startRow: 1 });
      continue;
    }
    const selectedRange = range(reference);
    const cells =
      (selectedRange.e.r - selectedRange.s.r + 1) * (selectedRange.e.c - selectedRange.s.c + 1);
    selectedCells += cells;
    if (selectedCells > maxCells) bounds();
    const rows: ImportCell[][] = [],
      cellIssues: ImportIssue[] = [];
    for (let row = selectedRange.s.r; row <= selectedRange.e.r; row++) {
      const output: ImportCell[] = [];
      for (let column = selectedRange.s.c; column <= selectedRange.e.c; column++) {
        const value = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as
          XLSX.CellObject | undefined;
        const knownFormula = formulas.has(`${selection.sheet}\u0000${row + 1}\u0000${column + 1}`);
        output.push(
          cellValue(
            knownFormula && (!value || value.v == null)
              ? { ...value, t: value?.t ?? 'z', f: 'uncached numbers formula' }
              : value,
            book.Workbook?.WBProps?.date1904 === true,
            (code, message) => {
              const issue: ImportIssue = {
                severity: 'warning',
                code,
                message,
                source: { sheet: selection.sheet, row: row + 1, column: column + 1 },
              };
              if (++diagnosticCount > 10_000)
                throw new TransferParseError(
                  'too_many_issues',
                  'this selection has more than 10,000 unresolved cells. select a narrower range or correct the source workbook.',
                );
              cellIssues.push(issue);
            },
          ),
        );
      }
      rows.push(output);
    }
    tables.push({ name: selection.sheet, rows, startRow: selectedRange.s.r + 1, cellIssues });
  }
  return { tables, sheets, issues };
}
