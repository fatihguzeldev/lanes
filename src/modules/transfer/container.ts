import { Inflate } from 'fflate';
import { NumbersInspection } from './numbers-container';
import type { NumbersFormulaCell } from './numbers-container';
import type { ImportIssue } from './parse-contract';
import {
  MAX_IMPORT_EXPANDED_BYTES,
  MAX_IMPORT_FILE_BYTES,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  TransferParseError,
} from './parse-contract';

interface Entry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  declaredSize: number;
  offset: number;
  dataOffset: number;
}
export interface ContainerInspection {
  entries: string[];
  expandedBytes: number;
  formulaCells: NumbersFormulaCell[];
  issues: ImportIssue[];
}
const maxEntries = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value;
}
function invalid(
  message = 'the workbook container is corrupt. save a fresh copy as xlsx and try again.',
): never {
  throw new TransferParseError('invalid_container', message);
}
function overLimit(): never {
  throw new TransferParseError(
    'expanded_too_large',
    'the workbook expands beyond 100 mib. select a smaller source and save it as a separate workbook.',
  );
}
function encrypted(): never {
  throw new TransferParseError(
    'encrypted_container',
    'encrypted workbooks are not supported. remove the password and save an unencrypted copy.',
  );
}
function u16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) return invalid();
  return view.getUint16(offset, true);
}
function u32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) return invalid();
  return view.getUint32(offset, true);
}
function xmlText(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new TransferParseError(
      'unsupported_encoding',
      'this workbook uses an unsupported xml encoding. save a fresh values-only xlsx copy.',
    );
  }
}
function decodedName(bytes: Uint8Array): string {
  let name: string;
  try {
    name = decoder.decode(bytes);
  } catch {
    return invalid('this workbook uses unsupported entry-name encoding. save a fresh xlsx copy.');
  }
  if (
    !name ||
    name.length > 1024 ||
    /[\x00-\x1f\x7f\\]/.test(name) ||
    name.startsWith('/') ||
    name.split('/').some((part) => part === '.' || part === '..')
  )
    return invalid();
  return name;
}
function zipEntries(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (u32(view, offset) === 0x06054b50 && offset + 22 + u16(view, offset + 20) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) return invalid();
  const count = u16(view, end + 10),
    size = u32(view, end + 12),
    start = u32(view, end + 16);
  if (
    u16(view, end + 4) ||
    u16(view, end + 6) ||
    u16(view, end + 8) !== count ||
    count === 65_535 ||
    start === 0xffffffff ||
    size === 0xffffffff
  )
    return invalid(
      'split and zip64 workbook containers are not supported. save a smaller xlsx copy.',
    );
  if (!count || count > maxEntries || start + size !== end) return invalid();
  const entries: Entry[] = [],
    names = new Set<string>();
  let position = start;
  for (let index = 0; index < count; index++) {
    if (u32(view, position) !== 0x02014b50 || position + 46 > end) return invalid();
    const flags = u16(view, position + 8),
      method = u16(view, position + 10),
      nameLength = u16(view, position + 28);
    const extraLength = u16(view, position + 30),
      commentLength = u16(view, position + 32);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (flags & (1 | 64 | 8192)) return encrypted();
    if (method !== 0 && method !== 8)
      return invalid('this workbook uses unsupported zip compression. save a fresh xlsx copy.');
    if (next > end || nameLength > 4096 || u16(view, position + 34)) return invalid();
    const name = decodedName(bytes.subarray(position + 46, position + 46 + nameLength));
    if (names.has(name) || ((u32(view, position + 38) >>> 16) & 0xf000) === 0xa000)
      return invalid();
    names.add(name);
    const compressedSize = u32(view, position + 20),
      declaredSize = u32(view, position + 24),
      offset = u32(view, position + 42);
    if (
      compressedSize === 0xffffffff ||
      declaredSize === 0xffffffff ||
      offset === 0xffffffff ||
      offset + 30 > start ||
      u32(view, offset) !== 0x04034b50
    )
      return invalid();
    const localFlags = u16(view, offset + 6),
      localMethod = u16(view, offset + 8),
      localNameLength = u16(view, offset + 26),
      localExtraLength = u16(view, offset + 28);
    if (localFlags & (1 | 64 | 8192)) return encrypted();
    const dataOffset = offset + 30 + localNameLength + localExtraLength;
    if (
      localMethod !== method ||
      localFlags !== flags ||
      dataOffset > start ||
      compressedSize > start - dataOffset ||
      decodedName(bytes.subarray(offset + 30, offset + 30 + localNameLength)) !== name
    )
      return invalid();
    if (
      !(flags & 8) &&
      (u32(view, offset + 18) !== compressedSize || u32(view, offset + 22) !== declaredSize)
    )
      return invalid();
    entries.push({
      name,
      method,
      crc: u32(view, position + 16),
      compressedSize,
      declaredSize,
      offset,
      dataOffset,
    });
    position = next;
  }
  if (position !== end) return invalid();
  const spans = [...entries].sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < spans.length; index++) {
    const previous = spans[index - 1],
      current = spans[index];
    if (previous && current && previous.dataOffset + previous.compressedSize > current.offset)
      return invalid();
  }
  return entries;
}

/** Validate Snappy output lengths and backward references without allocating the expanded bytes. */
function snappy(bytes: Uint8Array, remainingBudget: number, output?: Uint8Array): number {
  let offset = 0,
    total = 0,
    frames = 0;
  while (offset < bytes.length) {
    if (++frames > 100_000 || offset + 4 > bytes.length || bytes[offset] !== 0) return invalid();
    const length =
      (bytes[offset + 1] ?? 0) | ((bytes[offset + 2] ?? 0) << 8) | ((bytes[offset + 3] ?? 0) << 16);
    offset += 4;
    const end = offset + length;
    if (!length || end > bytes.length) return invalid();
    let declared = 0,
      shift = 0,
      last = 0;
    do {
      if (offset >= end || shift > 28) return invalid();
      last = bytes[offset++] ?? 0;
      if (shift === 28 && last > 15) return invalid();
      declared += (last & 127) * 2 ** shift;
      shift += 7;
    } while (last & 128);
    if (declared > remainingBudget - total) return overLimit();
    let produced = 0;
    while (offset < end) {
      const tag = bytes[offset++] ?? 0,
        kind = tag & 3;
      let count: number;
      if (!kind) {
        const encoded = tag >>> 2;
        if (encoded < 60) count = encoded + 1;
        else {
          const size = encoded - 59;
          if (offset + size > end) return invalid();
          count = 0;
          for (let index = 0; index < size; index++)
            count += (bytes[offset++] ?? 0) * 2 ** (8 * index);
          count++;
        }
        if (count > end - offset) return invalid();
        if (output) output.set(bytes.subarray(offset, offset + count), total + produced);
        offset += count;
      } else {
        let distance = 0;
        if (kind === 1) {
          if (offset >= end) return invalid();
          count = ((tag >>> 2) & 7) + 4;
          distance = ((tag & 224) << 3) | (bytes[offset++] ?? 0);
        } else {
          const size = kind === 2 ? 2 : 4;
          if (offset + size > end) return invalid();
          count = (tag >>> 2) + 1;
          for (let index = 0; index < size; index++)
            distance += (bytes[offset++] ?? 0) * 2 ** (8 * index);
        }
        if (!distance || distance > produced) return invalid();
        if (output)
          for (let index = 0; index < count; index++)
            output[total + produced + index] = output[total + produced + index - distance]!;
      }
      produced += count;
      if (produced > declared) return invalid();
      if (produced > remainingBudget - total) return overLimit();
    }
    if (produced !== declared) return invalid();
    total += produced;
  }
  return total;
}

export function inspectNumbersSnappy(
  bytes: Uint8Array,
  remainingBudget = MAX_IMPORT_EXPANDED_BYTES,
): number {
  return snappy(bytes, remainingBudget);
}
export function decodeNumbersSnappy(
  bytes: Uint8Array,
  limit = MAX_IMPORT_EXPANDED_BYTES,
): Uint8Array {
  const size = snappy(bytes, limit),
    output = new Uint8Array(size);
  snappy(bytes, limit, output);
  return output;
}

/** ODS repeat attributes must be checked before a parser can materialize repeated cells. */
export function inspectOdsXml(xml: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return invalid();
  let rowRepeat = 1,
    rowColumns = 0,
    totalCells = 0;
  const repeated = (attributes: string, name: string, limit: number) => {
    const matches = [
      ...attributes.matchAll(
        new RegExp('(?:[\\w.-]+:)?' + name + '\\s*=\\s*["\']([^"\']+)["\']', 'g'),
      ),
    ];
    if (matches.length > 1) return invalid();
    const raw = matches[0]?.[1];
    if (raw === undefined) return 1;
    if (!/^[1-9]\d*$/.test(raw)) return invalid();
    const count = Number(raw);
    if (!Number.isSafeInteger(count) || count > limit)
      throw new TransferParseError(
        'table_bounds',
        'this ods table repeats more rows or columns than the import can safely expand. save a smaller values-only xlsx copy.',
      );
    return count;
  };
  for (const match of xml.matchAll(
    /<(\/?)(?:[\w.-]+:)?(table-row|table-cell|covered-table-cell)\b([^>]*?)\/?>/g,
  )) {
    if (match[1]) continue;
    if (match[2] === 'table-row') {
      rowRepeat = repeated(match[3] ?? '', 'number-rows-repeated', MAX_TABLE_ROWS);
      rowColumns = 0;
    } else {
      const columns = repeated(match[3] ?? '', 'number-columns-repeated', MAX_TABLE_COLUMNS);
      rowColumns += columns;
      totalCells += columns * rowRepeat;
      if (rowColumns > MAX_TABLE_COLUMNS || totalCells > 1_000_000)
        throw new TransferParseError(
          'table_bounds',
          'this ods table exceeds the safe cell bound. save a smaller values-only xlsx copy.',
        );
    }
  }
}

/** Actual streamed ZIP output plus the inner Numbers Snappy output share one expansion budget. */
export async function inspectWorkbookContainer(
  bytes: Uint8Array,
  format: 'xlsx' | 'ods' | 'numbers',
  options: { maxExpandedBytes?: number } = {},
): Promise<ContainerInspection> {
  if (bytes.byteLength > MAX_IMPORT_FILE_BYTES)
    throw new TransferParseError(
      'file_too_large',
      'the file exceeds 20 mib. select a smaller source.',
    );
  const limit = options.maxExpandedBytes ?? MAX_IMPORT_EXPANDED_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_IMPORT_EXPANDED_BYTES)
    return invalid();
  const entries = zipEntries(bytes),
    names = entries.map((entry) => entry.name);
  if (names.some((name) => /\.iwpv2$|^EncryptionInfo$|^EncryptedPackage$/.test(name)))
    return encrypted();
  const supported =
    format === 'xlsx'
      ? names.includes('[Content_Types].xml') && names.includes('xl/workbook.xml')
      : format === 'ods'
        ? names.includes('mimetype') && names.includes('content.xml')
        : names.includes('Index/Document.iwa');
  if (!supported)
    throw new TransferParseError(
      'unsupported_container',
      `this is not a supported ${format} workbook. open it in its source application and save an xlsx copy.`,
    );
  let expanded = 0;
  const numbers = format === 'numbers' ? new NumbersInspection() : null;
  let xmlRecords = 0;
  for (const entry of entries) {
    let actual = 0,
      crc = 0xffffffff;
    const iwa = format === 'numbers' && entry.name.endsWith('.iwa'),
      odsXml = format === 'ods' && ['content.xml', 'META-INF/manifest.xml'].includes(entry.name),
      xlsxXml =
        format === 'xlsx' &&
        /(?:^xl\/worksheets\/[^/]+\.xml$)|(?:^xl\/sharedStrings\.xml$)/.test(entry.name),
      chunks: Uint8Array[] = [];
    const receive = (chunk: Uint8Array) => {
      expanded += chunk.byteLength;
      actual += chunk.byteLength;
      if (expanded > limit) return overLimit();
      for (const byte of chunk) crc = (crcTable[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
      if (iwa || odsXml || xlsxXml) chunks.push(chunk.slice());
      if (format === 'ods' && entry.name === 'mimetype') chunks.push(chunk.slice());
    };
    try {
      const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
      if (entry.method === 0) receive(compressed);
      else {
        const inflater = new Inflate(receive);
        for (let offset = 0; offset < compressed.length; offset += 512)
          inflater.push(
            compressed.subarray(offset, offset + 512),
            offset + 512 >= compressed.length,
          );
        if (!compressed.length) inflater.push(new Uint8Array(), true);
      }
    } catch (error) {
      if (error instanceof TransferParseError) throw error;
      return invalid();
    }
    if (actual !== entry.declaredSize || (crc ^ 0xffffffff) >>> 0 !== entry.crc) return invalid();
    if (iwa || odsXml || xlsxXml || (format === 'ods' && entry.name === 'mimetype')) {
      const value = new Uint8Array(actual);
      let position = 0;
      for (const chunk of chunks) {
        value.set(chunk, position);
        position += chunk.byteLength;
      }
      if (iwa) {
        const decoded = decodeNumbersSnappy(value, limit - expanded);
        expanded += decoded.byteLength;
        numbers?.add(decoded);
      } else if (xlsxXml) {
        const xml = xmlText(value);
        if (/<!DOCTYPE|<!ENTITY/i.test(xml)) invalid();
        const pattern = /<(?:[\w.-]+:)?(?:c|si)\b/g;
        while (pattern.exec(xml))
          if (++xmlRecords > 1_000_000)
            throw new TransferParseError(
              'table_bounds',
              'this workbook contains more cells or shared strings than can be parsed safely. save the selected range as a smaller workbook.',
            );
      } else if (odsXml) {
        const xml = xmlText(value);
        if (entry.name === 'content.xml') inspectOdsXml(xml);
        else if (/<(?:[\w.-]+:)?encryption-data\b/.test(xml)) encrypted();
      } else if (decoder.decode(value) !== 'application/vnd.oasis.opendocument.spreadsheet')
        throw new TransferParseError(
          'unsupported_container',
          'the archive is not an ods spreadsheet. save an xlsx copy.',
        );
    }
  }
  const inspected = numbers?.finish() ?? { formulaCells: [], issues: [] };
  return { entries: names, expandedBytes: expanded, ...inspected };
}
