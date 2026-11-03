import { MAX_IMPORT_FILE_BYTES } from '../modules/transfer/parse-contract';
import type { ArchiveDocument } from '../modules/transfer/archive-contract';
import type { ImportOptions, ImportPreview, ImportTable } from '../modules/transfer/parse-contract';
import { z } from 'zod';

export function googleAuthorizationHref(value: string): string {
  const authorization = new URL(value);
  if (
    authorization.protocol !== 'https:' ||
    authorization.hostname !== 'accounts.google.com' ||
    authorization.username ||
    authorization.password ||
    authorization.port
  )
    throw new Error('the authorization address is invalid. reload lanes before authorizing.');
  return authorization.href;
}

const SheetsDraftSchema = z
  .object({
    createdAt: z.number().int().nonnegative(),
    sourceAccountId: z.string().min(1).max(1024),
    spreadsheet: z.string().max(4096),
    selectedSheets: z.array(z.string().min(1).max(256)).max(100),
    ranges: z
      .record(z.string().min(1).max(256), z.string().max(100))
      .refine((value) => Object.keys(value).length <= 100),
  })
  .strict();
export type SheetsSourceDraft = z.infer<typeof SheetsDraftSchema>;
export function decodeSheetsDraft(
  serialized: string | null,
  accountIds: readonly string[],
  now = Date.now(),
): SheetsSourceDraft | null {
  if (!serialized || serialized.length > 64000) return null;
  try {
    const value = SheetsDraftSchema.safeParse(JSON.parse(serialized));
    return value.success &&
      accountIds.includes(value.data.sourceAccountId) &&
      value.data.createdAt <= now + 300000 &&
      now - value.data.createdAt < 86400000
      ? value.data
      : null;
  } catch {
    return null;
  }
}
export function readSheetsDraft(
  destinationAccountId: string,
  accountIds: readonly string[],
): SheetsSourceDraft | null {
  try {
    return decodeSheetsDraft(
      sessionStorage.getItem(`lanes:transfer-source:${destinationAccountId}`),
      accountIds,
    );
  } catch {
    return null;
  }
}
export function writeSheetsDraft(
  destinationAccountId: string,
  draft: Omit<SheetsSourceDraft, 'createdAt'>,
): void {
  const value = SheetsDraftSchema.parse({ ...draft, createdAt: Date.now() });
  sessionStorage.setItem(`lanes:transfer-source:${destinationAccountId}`, JSON.stringify(value));
}
export function clearSheetsDraft(destinationAccountId: string): void {
  try {
    sessionStorage.removeItem(`lanes:transfer-source:${destinationAccountId}`);
  } catch {
    /* A blocked session store does not affect a confirmed server capture. */
  }
}

export function* boundedBatches<T>(
  records: readonly T[],
  wrap: (rows: T[]) => unknown,
  maximumBytes = 65536,
): Generator<T[]> {
  let page: T[] = [];
  const bytes = (rows: T[]) => new TextEncoder().encode(JSON.stringify(wrap(rows))).byteLength;
  for (const record of records) {
    if (bytes([record]) > maximumBytes)
      throw new Error(
        'one record exceeds the 64 kib request bound. narrow or correct that source record before staging.',
      );
    if (page.length && (page.length === 10 || bytes([...page, record]) > maximumBytes)) {
      yield page;
      page = [];
    }
    page.push(record);
  }
  if (page.length) yield page;
}
export function parseExcludedRows(input: string): number[] {
  const result = new Set<number>();
  for (const part of input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part),
      first = Number(match?.[1]),
      last = Number(match?.[2] ?? match?.[1]);
    if (!match || first < 1 || last < first || last > 1_048_576 || last - first >= 10000)
      throw new Error('use source row numbers or ascending ranges, at most 10,000 rows.');
    for (let row = first; row <= last; row++) {
      result.add(row);
      if (result.size > 10000) throw new Error('exclude at most 10,000 source rows.');
    }
  }
  return [...result].sort((left, right) => left - right);
}
export function sheetRangePages(input: string): string[] {
  const match = /^([A-Za-z]{1,3})([1-9]\d{0,6}):([A-Za-z]{1,3})([1-9]\d{0,6})$/.exec(input.trim());
  if (!match) throw new Error('choose an explicit range such as A1:Q1000.');
  const column = (value: string) =>
    [...value.toUpperCase()].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
  const firstColumn = column(match[1]!),
    lastColumn = column(match[3]!),
    first = Number(match[2]),
    last = Number(match[4]);
  if (lastColumn > 256 || lastColumn < firstColumn)
    throw new Error('select columns within A through IV (256 columns).');
  if (last < first || last > 1_048_576 || last - first + 1 > 10000)
    throw new Error('select at most 10,000 rows in an ascending range.');
  return Array.from(
    { length: Math.ceil((last - first + 1) / 100) },
    (_, index) =>
      `${match[1]!.toUpperCase()}${first + index * 100}:${match[3]!.toUpperCase()}${Math.min(last, first + index * 100 + 99)}`,
  );
}

type TransferParseRequest =
  | { kind: 'archive'; bytes: ArrayBuffer }
  | { kind: 'tables'; tables: ImportTable[]; options: ImportOptions };
export function parseTransferInWorker(
  input: { kind: 'archive'; file: File },
  signal: AbortSignal,
): Promise<ArchiveDocument>;
export function parseTransferInWorker(
  input: { kind: 'tables'; tables: ImportTable[]; options: ImportOptions },
  signal: AbortSignal,
): Promise<ImportPreview>;
export async function parseTransferInWorker(
  input:
    | { kind: 'archive'; file: File }
    | { kind: 'tables'; tables: ImportTable[]; options: ImportOptions },
  signal: AbortSignal,
): Promise<ArchiveDocument | ImportPreview> {
  if (input.kind === 'archive' && input.file.size > MAX_IMPORT_FILE_BYTES)
    throw new Error('an archive may contain at most 20 mib. select a narrower export.');
  const payload: TransferParseRequest =
    input.kind === 'archive' ? { kind: 'archive', bytes: await input.file.arrayBuffer() } : input;
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  const worker = new Worker(new URL('./transfer-parser.worker.ts', import.meta.url), {
    type: 'module',
  });
  return new Promise((resolve, reject) => {
    const end = (error?: Error, value?: ArchiveDocument | ImportPreview) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => end(new DOMException('aborted', 'AbortError'));
    const timeout = setTimeout(
      () =>
        end(
          new Error(
            'the preview exceeded 30 seconds. select a smaller range or convert it to csv.',
          ),
        ),
      30000,
    );
    worker.onerror = () =>
      end(new Error('the preview parser stopped. use a smaller source or a supported conversion.'));
    worker.onmessage = (
      event: MessageEvent<{ ok: boolean; value?: ArchiveDocument | ImportPreview; error?: string }>,
    ) => {
      if (event.data.ok) end(undefined, event.data.value);
      else end(new Error(event.data.error ?? 'this source could not be parsed safely.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.postMessage(payload, payload.kind === 'archive' ? [payload.bytes] : []);
  });
}
export function downloadFile(parts: BlobPart[], name: string, type: string) {
  const url = URL.createObjectURL(new Blob(parts, { type })),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
