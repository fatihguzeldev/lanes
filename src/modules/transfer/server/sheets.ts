import { z } from 'zod';
import { AppError } from '../../../shared/contracts/errors';
import type { ErrorCode } from '../../../shared/contracts/http';
import type { ImportCell, ImportIssue, ImportTable } from '../parse-contract';

export const GOOGLE_SHEETS_IMPORT_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const GOOGLE_SHEETS_EXPORT_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const base = 'https://sheets.googleapis.com/v4';
const idSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const sheetTitle = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value.trim().length > 0 && !/[\x00-\x1f\x7f\[\]:*?/\\]/.test(value));
const positive = z.number().int().min(1).max(20_000_000);
const gridSchema = z.object({ rowCount: positive, columnCount: positive });
const sheetSchema = z.object({
  properties: z.object({
    sheetId: z.number().int().nonnegative(),
    title: sheetTitle,
    gridProperties: gridSchema,
  }),
});
const metadataSchema = z.object({
  spreadsheetId: idSchema,
  properties: z.object({
    title: z.string().max(1024),
    locale: z.string().max(100).optional(),
    timeZone: z.string().max(100).optional(),
  }),
  sheets: z.array(sheetSchema).max(1000),
});
const createdSchema = z.object({
  spreadsheetId: idSchema,
  sheets: z.array(sheetSchema).min(1).max(100),
});
type SheetsErrorCode = Extract<
  ErrorCode,
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'permission_required'
  | 'reconnect_required'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'outcome_uncertain'
>;
const messages: Record<SheetsErrorCode, string> = {
  validation_failed: 'check the spreadsheet, selected range, and submitted values.',
  not_found: 'google could not find the selected spreadsheet under this account.',
  conflict: 'the selected spreadsheet or operation changed. refresh before continuing.',
  permission_required:
    'google did not permit this sheets operation. check the selected account, optional sheets permission, and sheets api setup.',
  reconnect_required:
    'google rejected this account token. refresh its authorization before continuing.',
  provider_rate_limited: 'google is limiting sheets requests. wait before retrying.',
  provider_unavailable: 'google did not return a valid sheet result. retry the read later.',
  outcome_uncertain:
    'google may have accepted this sheets change. inspect the saved operation before trying again.',
};
interface FailureOptions {
  status?: number | null;
  retryable?: boolean;
  outcome?: 'rejected' | 'uncertain';
  retryAfterSeconds?: number;
}

/** Provider data and tokens never become error properties or messages. */
export class GoogleSheetsError extends Error {
  readonly name = 'GoogleSheetsError';
  readonly status: number | null;
  readonly retryable: boolean;
  readonly outcome: 'rejected' | 'uncertain';
  readonly retryAfterSeconds: number | null;
  constructor(
    readonly code: SheetsErrorCode,
    options: FailureOptions = {},
  ) {
    super(messages[code]);
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.outcome = options.outcome ?? 'rejected';
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}
const invalid = () => new GoogleSheetsError('validation_failed', { status: 422 });
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
function encoded(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** A docs URL supplies an identity only; it is never a request destination. */
export function parseSpreadsheetId(value: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw invalid();
  const trimmed = value.trim();
  if (idSchema.safeParse(trimmed).success) return trimmed;
  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'docs.google.com' ||
      url.username ||
      url.password ||
      url.port
    )
      throw invalid();
    const match =
      /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/(?:edit|view|preview|copy|export)?)?$/.exec(
        url.pathname,
      );
    if (!match?.[1]) throw invalid();
    return parse(idSchema, match[1]);
  } catch {
    throw invalid();
  }
}
function columnNumber(value: string): number {
  let number = 0;
  for (const char of value) number = number * 26 + char.charCodeAt(0) - 64;
  return number;
}
function columnName(value: number): string {
  let name = '';
  for (let number = value; number > 0; number = Math.floor((number - 1) / 26))
    name = String.fromCharCode(65 + ((number - 1) % 26)) + name;
  return name;
}
export interface SheetRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
  rowCount: number;
  columnCount: number;
  range: string;
}
/** Coordinates are 1-based; omitted whole-column/whole-sheet selections are not accepted. */
export function parseSheetRange(value: string): SheetRange {
  if (typeof value !== 'string' || value.length > 100) throw invalid();
  const match =
    /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,7})(?::\$?([A-Za-z]{1,3})\$?([1-9]\d{0,7}))?$/.exec(value);
  if (!match?.[1] || !match[2]) throw invalid();
  const startColumn = columnNumber(match[1].toUpperCase()),
    endColumn = columnNumber((match[3] ?? match[1]).toUpperCase());
  const startRow = Number(match[2]),
    endRow = Number(match[4] ?? match[2]);
  const rowCount = endRow - startRow + 1,
    columnCount = endColumn - startColumn + 1;
  if (
    endRow > 20_000_000 ||
    endColumn > 18_278 ||
    rowCount < 1 ||
    rowCount > 10_000 ||
    columnCount < 1 ||
    columnCount > 256 ||
    rowCount * columnCount > 1_000_000
  )
    throw invalid();
  return {
    startRow,
    endRow,
    startColumn,
    endColumn,
    rowCount,
    columnCount,
    range: `${columnName(startColumn)}${startRow}:${columnName(endColumn)}${endRow}`,
  };
}
function quotedSheet(value: string): string {
  return "'" + parse(sheetTitle, value).replaceAll("'", "''") + "'";
}
function sameReturnedRange(value: string, title: string, expected: string): boolean {
  try {
    const separator = value.lastIndexOf('!');
    if (separator < 1) return false;
    const sheet = value.slice(0, separator);
    const unquoted =
      sheet.startsWith("'") && /^'(?:[^']|'')*'$/.test(sheet)
        ? sheet.slice(1, -1).replaceAll("''", "'")
        : sheet;
    return (
      unquoted === title &&
      parseSheetRange(value.slice(separator + 1)).range === parseSheetRange(expected).range
    );
  } catch {
    return false;
  }
}
export interface GoogleSheetMetadata {
  id: number;
  title: string;
  rowCount: number;
  columnCount: number;
}
export interface GoogleSpreadsheetMetadata {
  id: string;
  title: string;
  locale: string | null;
  timeZone: string | null;
  sheets: GoogleSheetMetadata[];
}
export interface CreatedSpreadsheet {
  id: string;
  url: string;
  sheets: GoogleSheetMetadata[];
}
export type GoogleSheetsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface GoogleSheetsClientOptions {
  accessToken: string | (() => Promise<string>);
  fetch?: GoogleSheetsFetch;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}
export interface NewSpreadsheet {
  title: string;
  sheets: readonly { title: string; rowCount?: number; columnCount?: number }[];
}
export interface RawRowsResult {
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* discard failures are not diagnostics. */
  }
}
async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await discard(response);
    throw new Error();
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    reader.releaseLock();
  }
}
function retryAfter(response: Response, now: number): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw || raw.length > 100) return undefined;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - now) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 86_400) : undefined;
}
const rejectionSchema = z.object({
  error: z.object({
    errors: z
      .array(z.object({ reason: z.string().max(256).optional() }))
      .max(100)
      .optional(),
    details: z
      .array(z.object({ reason: z.string().max(256).optional() }))
      .max(100)
      .optional(),
  }),
});
async function rejection(response: Response, now: number): Promise<GoogleSheetsError> {
  const status = response.status;
  let reasons: string[] = [];
  const hint = retryAfter(response, now);
  if (status === 429) {
    await discard(response);
    return new GoogleSheetsError('provider_rate_limited', {
      status,
      retryable: true,
      ...(hint === undefined ? {} : { retryAfterSeconds: hint }),
    });
  }
  try {
    const value = rejectionSchema.safeParse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(response, 65_536)),
      ),
    );
    if (value.success)
      reasons = [...(value.data.error.errors ?? []), ...(value.data.error.details ?? [])].flatMap(
        (item) => (item.reason ? [item.reason] : []),
      );
  } catch {
    /* the HTTP rejection remains definitive when its optional body is invalid. */
  }
  if (
    reasons.some((reason) =>
      [
        'rateLimitExceeded',
        'userRateLimitExceeded',
        'dailyLimitExceeded',
        'RATE_LIMIT_EXCEEDED',
        'DAILY_LIMIT_EXCEEDED',
        'quotaExceeded',
        'QUOTA_EXCEEDED',
      ].includes(reason),
    )
  )
    return new GoogleSheetsError('provider_rate_limited', {
      status,
      retryable: true,
      ...(hint === undefined ? {} : { retryAfterSeconds: hint }),
    });
  if (status === 401) return new GoogleSheetsError('reconnect_required', { status });
  if (status === 403) return new GoogleSheetsError('permission_required', { status });
  if (status === 404 || status === 410) return new GoogleSheetsError('not_found', { status });
  if (status === 409 || status === 412) return new GoogleSheetsError('conflict', { status });
  return new GoogleSheetsError('validation_failed', { status });
}

const extendedSchema = z
  .object({
    stringValue: z.string().optional(),
    numberValue: z.number().finite().optional(),
    boolValue: z.boolean().optional(),
    formulaValue: z.string().optional(),
    errorValue: z.object({ type: z.string().max(256).optional() }).optional(),
  })
  .superRefine((value, context) => {
    if (Object.values(value).filter((item) => item !== undefined).length > 1)
      context.addIssue({ code: 'custom', message: 'a cell value has one type' });
  });
const cellSchema = z.object({
  effectiveValue: extendedSchema.optional(),
  userEnteredValue: z.object({ formulaValue: z.string().optional() }).optional(),
  formattedValue: z.string().optional(),
  effectiveFormat: z
    .object({ numberFormat: z.object({ type: z.string().max(100).optional() }).optional() })
    .optional(),
});
const selectedGridSchema = z.object({
  spreadsheetId: idSchema,
  sheets: z
    .array(
      z.object({
        properties: z.object({ sheetId: z.number().int().nonnegative(), title: sheetTitle }),
        data: z
          .array(
            z.object({
              startRow: z.number().int().nonnegative().optional(),
              startColumn: z.number().int().nonnegative().optional(),
              rowData: z
                .array(z.object({ values: z.array(cellSchema).max(256).optional() }))
                .max(100)
                .optional(),
            }),
          )
          .max(1)
          .optional(),
      }),
    )
    .length(1),
});
const metadataFields =
  'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))';
const selectedFields =
  'spreadsheetId,sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(effectiveValue,userEnteredValue(formulaValue),formattedValue,effectiveFormat(numberFormat(type))))))';
function sheetOutput(sheet: z.infer<typeof sheetSchema>): GoogleSheetMetadata {
  return {
    id: sheet.properties.sheetId,
    title: sheet.properties.title,
    ...sheet.properties.gridProperties,
  };
}

function cachedValue(
  cell: z.infer<typeof cellSchema>,
  source: { sheet: string; row: number; column: number },
  issues: ImportIssue[],
  rejectFormulas = false,
  interpretDates = true,
): ImportCell {
  const warn = (code: string, message: string) =>
    issues.push({ severity: 'warning', code, message, source });
  if (rejectFormulas && cell.userEnteredValue?.formulaValue !== undefined) {
    warn(
      'sheet_formula_present',
      'this cell contains a formula; it cannot confirm a raw-value export write.',
    );
    return null;
  }
  const value = cell.effectiveValue;
  if (!value || Object.values(value).every((item) => item === undefined)) {
    if (cell.userEnteredValue?.formulaValue)
      warn(
        'formula_cache_missing',
        'this formula has no cached value. correct the cell or explicitly accept omitting its value.',
      );
    return null;
  }
  if (value.errorValue) {
    warn(
      'sheet_cell_error',
      'this sheet cell contains an error. correct it or explicitly accept omitting its value.',
    );
    return null;
  }
  if (value.formulaValue !== undefined) {
    warn(
      'formula_cache_missing',
      'this cell returned a formula without a cached value. correct it or explicitly accept omitting its value.',
    );
    return null;
  }
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.numberValue === undefined) return null;
  const number = value.numberValue,
    type = cell.effectiveFormat?.numberFormat?.type;
  if (!interpretDates) return number;
  if (!['DATE', 'TIME', 'DATE_TIME'].includes(type ?? '')) return number;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(number * 86_400_000));
  if (
    !Number.isFinite(date.valueOf()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  ) {
    warn(
      'sheet_date_invalid',
      'this date or time value is outside the supported calendar range. correct it or accept omitting it.',
    );
    return null;
  }
  const iso = date.toISOString();
  if (type === 'DATE_TIME') {
    warn(
      'sheet_local_datetime',
      'this date-time is a local wall value, without a time-zone offset. map its day, time, and zone explicitly before importing.',
    );
    return iso.slice(0, 19);
  }
  if (type === 'DATE') {
    if (Math.abs(number - Math.floor(number)) > 1e-9)
      warn(
        'sheet_hidden_time',
        'this date cell also contains a time. its calendar-day value omits that hidden time.',
      );
    return iso.slice(0, 10);
  }
  if (date.getUTCSeconds() || date.getUTCMilliseconds())
    warn('sheet_time_precision', 'lanes uses minute precision. this time value omits seconds.');
  return iso.slice(11, 16);
}

/** Each method sends one request. The caller owns authorization, budgets, durable intent, and retries. */
export class GoogleSheetsClient {
  private readonly fetcher: GoogleSheetsFetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  constructor(private readonly options: GoogleSheetsClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 30_000 ||
      !Number.isInteger(this.maxBytes) ||
      this.maxBytes < 1024 ||
      this.maxBytes > 4 * 1024 * 1024
    )
      throw invalid();
  }
  private failed(write: boolean, status: number | null = null): GoogleSheetsError {
    return new GoogleSheetsError(write ? 'outcome_uncertain' : 'provider_unavailable', {
      status,
      retryable: !write,
      outcome: write ? 'uncertain' : 'rejected',
    });
  }
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<T> {
    const write = method !== 'GET',
      url = new URL(base + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    if (this.options.signal?.aborted) throw new GoogleSheetsError('conflict', { status: 409 });
    let token: string;
    try {
      token =
        typeof this.options.accessToken === 'string'
          ? this.options.accessToken
          : await this.options.accessToken();
    } catch (error) {
      if (error instanceof AppError || error instanceof GoogleSheetsError) throw error;
      throw this.failed(false);
    }
    if (!token || token.length > 16_384 || /[\x00-\x20\x7f]/.test(token))
      throw new GoogleSheetsError('reconnect_required', { status: 401 });
    if (this.options.signal?.aborted) throw new GoogleSheetsError('conflict', { status: 409 });
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(this.options.signal ? [this.options.signal] : []),
    ]);
    const headers = new Headers({ Accept: 'application/json', Authorization: 'Bearer ' + token });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    let result: Response;
    try {
      result = await this.fetcher(url, {
        method,
        headers,
        redirect: 'manual',
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof AppError || error instanceof GoogleSheetsError) throw error;
      throw this.failed(write);
    }
    if (
      result.status === 408 ||
      result.status >= 500 ||
      result.status < 200 ||
      (result.status >= 300 && result.status < 400)
    ) {
      await discard(result);
      throw this.failed(write, result.status);
    }
    if (!result.ok) throw await rejection(result, this.options.now?.() ?? Date.now());
    try {
      const json: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(result, this.maxBytes)),
      );
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new Error();
      return parsed.data;
    } catch {
      throw this.failed(write, result.status);
    }
  }

  async metadata(input: string): Promise<GoogleSpreadsheetMetadata> {
    const id = parseSpreadsheetId(input);
    const result = await this.request('GET', '/spreadsheets/' + encoded(id), metadataSchema, {
      fields: metadataFields,
    });
    if (
      result.spreadsheetId !== id ||
      new Set(result.sheets.map((sheet) => sheet.properties.sheetId)).size !== result.sheets.length
    )
      throw this.failed(false, 200);
    return {
      id,
      title: result.properties.title,
      locale: result.properties.locale ?? null,
      timeZone: result.properties.timeZone ?? null,
      sheets: result.sheets.map(sheetOutput),
    };
  }

  async readRange(
    input: string,
    selection: { sheet: string; range: string; rejectFormulas?: boolean; interpretDates?: boolean },
  ): Promise<ImportTable> {
    const id = parseSpreadsheetId(input),
      sheet = parse(sheetTitle, selection.sheet),
      range = parseSheetRange(selection.range);
    if (range.rowCount > 100) throw invalid();
    const result = await this.request('GET', '/spreadsheets/' + encoded(id), selectedGridSchema, {
      fields: selectedFields,
      ranges: `${quotedSheet(sheet)}!${range.range}`,
    });
    const observed = result.sheets[0]!;
    if (result.spreadsheetId !== id || observed.properties.title !== sheet)
      throw this.failed(false, 200);
    const grid = observed.data?.[0],
      observedRows = grid?.rowData ?? [];
    if (
      (grid &&
        ((grid.startRow ?? 0) !== range.startRow - 1 ||
          (grid.startColumn ?? 0) !== range.startColumn - 1)) ||
      observedRows.length > range.rowCount ||
      observedRows.some((row) => (row.values?.length ?? 0) > range.columnCount)
    )
      throw this.failed(false, 200);
    const cellIssues: ImportIssue[] = [];
    const rows = Array.from({ length: range.rowCount }, (_, row) =>
      Array.from({ length: range.columnCount }, (_, column): ImportCell => {
        const cell = observedRows[row]?.values?.[column];
        return cell
          ? cachedValue(
              cell,
              { sheet, row: range.startRow + row, column: range.startColumn + column },
              cellIssues,
              selection.rejectFormulas ?? false,
              selection.interpretDates ?? true,
            )
          : null;
      }),
    );
    return { name: sheet, startRow: range.startRow, rows, cellIssues };
  }

  async createSpreadsheet(input: NewSpreadsheet): Promise<CreatedSpreadsheet> {
    const value = parse(
      z
        .object({
          title: z.string().trim().min(1).max(1024),
          sheets: z
            .array(
              z
                .object({
                  title: sheetTitle,
                  rowCount: positive.default(1000),
                  columnCount: z.number().int().min(1).max(256).default(26),
                })
                .strict(),
            )
            .min(1)
            .max(100),
        })
        .strict(),
      input,
    );
    if (
      new Set(value.sheets.map((sheet) => sheet.title.toLowerCase())).size !==
        value.sheets.length ||
      value.sheets.reduce((sum, sheet) => sum + sheet.rowCount * sheet.columnCount, 0) > 20_000_000
    )
      throw invalid();
    const result = await this.request(
      'POST',
      '/spreadsheets',
      createdSchema,
      {
        fields:
          'spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
      },
      {
        properties: { title: value.title },
        sheets: value.sheets.map((sheet) => ({
          properties: {
            title: sheet.title,
            gridProperties: { rowCount: sheet.rowCount, columnCount: sheet.columnCount },
          },
        })),
      },
    );
    if (
      result.sheets.length !== value.sheets.length ||
      result.sheets.some(
        (sheet, index) =>
          sheet.properties.title !== value.sheets[index]?.title ||
          sheet.properties.gridProperties.rowCount !== value.sheets[index]?.rowCount ||
          sheet.properties.gridProperties.columnCount !== value.sheets[index]?.columnCount,
      ) ||
      new Set(result.sheets.map((sheet) => sheet.properties.sheetId)).size !== result.sheets.length
    )
      throw this.failed(true, 200);
    return {
      id: result.spreadsheetId,
      url: `https://docs.google.com/spreadsheets/d/${result.spreadsheetId}/edit`,
      sheets: result.sheets.map(sheetOutput),
    };
  }

  async writeRawRows(
    input: string,
    sheet: string,
    startRow: number,
    inputRows: readonly (readonly ImportCell[])[],
  ): Promise<RawRowsResult> {
    const id = parseSpreadsheetId(input),
      title = parse(sheetTitle, sheet);
    const rows = parse(
      z
        .array(
          z
            .array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))
            .min(1)
            .max(256),
        )
        .min(1)
        .max(10),
      inputRows,
    );
    const columns = Math.max(...rows.map((row) => row.length));
    if (!Number.isInteger(startRow) || startRow < 1 || startRow + rows.length - 1 > 20_000_000)
      throw invalid();
    const range = `${quotedSheet(title)}!A${startRow}:${columnName(columns)}${startRow + rows.length - 1}`;
    const body = {
      range,
      majorDimension: 'ROWS',
      values: rows.map((row) => Array.from({ length: columns }, (_, column) => row[column] ?? '')),
    };
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 64 * 1024) throw invalid();
    const result = await this.request(
      'PUT',
      '/spreadsheets/' + encoded(id) + '/values/' + encoded(range),
      z.object({
        spreadsheetId: idSchema,
        updatedRange: z.string().min(1).max(1024),
        updatedRows: z.number().int().nonnegative(),
        updatedColumns: z.number().int().nonnegative(),
        updatedCells: z.number().int().nonnegative(),
      }),
      {
        valueInputOption: 'RAW',
        includeValuesInResponse: 'false',
        fields: 'spreadsheetId,updatedRange,updatedRows,updatedColumns,updatedCells',
      },
      body,
    );
    if (
      result.spreadsheetId !== id ||
      !sameReturnedRange(
        result.updatedRange,
        title,
        `A${startRow}:${columnName(columns)}${startRow + rows.length - 1}`,
      ) ||
      result.updatedRows !== rows.length ||
      result.updatedColumns !== columns ||
      result.updatedCells !== rows.length * columns
    )
      throw this.failed(true, 200);
    return {
      updatedRows: result.updatedRows,
      updatedColumns: result.updatedColumns,
      updatedCells: result.updatedCells,
    };
  }
}
