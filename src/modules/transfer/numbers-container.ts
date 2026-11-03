import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, TransferParseError } from './parse-contract';
import type { ImportIssue } from './parse-contract';

interface Field {
  wire: number;
  data: Uint8Array;
}
type Fields = Map<number, Field[]>;
interface Message {
  id: number;
  type: number;
  fields: Fields;
}
export interface NumbersFormulaCell {
  sheet: string;
  row: number;
  column: number;
}
function invalid(): never {
  throw new TransferParseError(
    'invalid_container',
    'the numbers packet data is corrupt or unsupported. open it in numbers and save a values-only xlsx copy.',
  );
}
function varint(
  bytes: Uint8Array,
  offset: number,
  end = bytes.length,
): { next: number; value: number | null } {
  let value = 0,
    shift = 0;
  for (let count = 0; count < 10; count++) {
    if (offset >= end) return invalid();
    const byte = bytes[offset++]!;
    if (count === 9 && byte > 1) return invalid();
    value += (byte & 127) * 2 ** shift;
    shift += 7;
    if (!(byte & 128)) return { next: offset, value: Number.isSafeInteger(value) ? value : null };
  }
  return invalid();
}
function integer(field: Field | undefined): number {
  if (!field || field.wire !== 0) return invalid();
  const value = varint(field.data, 0);
  if (value.next !== field.data.length || value.value === null) return invalid();
  return value.value;
}
function bytesField(fields: Fields, index: number): Uint8Array {
  const field = fields.get(index)?.[0];
  if (!field || field.wire !== 2) return invalid();
  return field.data;
}
function parse(bytes: Uint8Array, budget?: { remaining: number }): Fields {
  const fields: Fields = new Map();
  let offset = 0,
    count = 0;
  while (offset < bytes.length) {
    if (++count > 100_000 || (budget && --budget.remaining < 0)) return invalid();
    const tag = varint(bytes, offset);
    if (tag.value === null) return invalid();
    offset = tag.next;
    const wire = tag.value & 7,
      number = Math.floor(tag.value / 8);
    if (!number || number > 65_535) return invalid();
    let start = offset,
      end = offset;
    if (wire === 0) end = varint(bytes, offset).next;
    else if (wire === 1) end = offset + 8;
    else if (wire === 5) end = offset + 4;
    else if (wire === 2) {
      const length = varint(bytes, offset);
      if (length.value === null) return invalid();
      start = length.next;
      end = start + length.value;
    } else return invalid();
    if (end > bytes.length) return invalid();
    const values = fields.get(number) ?? [];
    values.push({ wire, data: bytes.subarray(start, end) });
    fields.set(number, values);
    offset = end;
  }
  return fields;
}

/** Bounded structural checks precede SheetJS, whose Numbers parser can log and skip malformed IWA packets. */
export class NumbersInspection {
  private readonly messages = new Map<number, Message>();
  private readonly formulas = new Map<number, { row: number; column: number }[]>();
  private legacy = false;
  private packetCount = 0;
  private readonly budget = { remaining: 1_000_000 };
  private parse(bytes: Uint8Array): Fields {
    return parse(bytes, this.budget);
  }
  private reference(fields: Fields, index: number): number {
    return integer(this.parse(bytesField(fields, index)).get(1)?.[0]);
  }
  add(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (++this.packetCount > 100_000) return invalid();
      const headerLength = varint(bytes, offset);
      if (headerLength.value === null || headerLength.value > bytes.length - headerLength.next)
        return invalid();
      offset = headerLength.next;
      const header = this.parse(bytes.subarray(offset, offset + headerLength.value));
      offset += headerLength.value;
      const id = integer(header.get(1)?.[0]),
        metadata = header.get(2);
      if (!id || !metadata?.length || this.messages.has(id)) return invalid();
      for (const item of metadata) {
        if (item.wire !== 2) return invalid();
        const info = this.parse(item.data),
          length = integer(info.get(3)?.[0]),
          type = integer(info.get(1)?.[0]);
        if (length > bytes.length - offset) return invalid();
        const fields = this.parse(bytes.subarray(offset, offset + length));
        offset += length;
        const message = { id, type, fields };
        // the supported table references resolve to the first message, as in the vendor reader.
        if (!this.messages.has(id)) this.messages.set(id, message);
        if (type === 6002) this.tile(message);
      }
    }
  }
  private tile(message: Message): void {
    const storage = message.fields.get(7)?.[0] ? integer(message.fields.get(7)?.[0]) : -1;
    if (storage > 1) return invalid();
    const cells: { row: number; column: number }[] = [];
    for (const item of message.fields.get(5) ?? []) {
      if (item.wire !== 2) return invalid();
      const row = this.parse(item.data),
        rowIndex = integer(row.get(1)?.[0]),
        count = integer(row.get(2)?.[0]);
      if (rowIndex >= MAX_TABLE_ROWS || count > MAX_TABLE_COLUMNS) return invalid();
      const modern = row.has(7) && storage !== 0;
      const offsets = bytesField(row, modern ? 7 : 4),
        values = bytesField(row, modern ? 6 : 3);
      if (offsets.length % 2 || offsets.length / 2 > MAX_TABLE_COLUMNS) return invalid();
      const width = row.get(8)?.[0] && integer(row.get(8)?.[0]) ? 4 : 1;
      const view = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength),
        positions: { column: number; offset: number }[] = [];
      for (let column = 0; column < offsets.length / 2; column++) {
        const offset = view.getUint16(column * 2, true);
        if (offset !== 65535) positions.push({ column, offset: offset * width });
      }
      if (positions.length !== count) return invalid();
      for (let index = 0; index < positions.length; index++) {
        const position = positions[index]!,
          end = positions[index + 1]?.offset ?? values.length;
        if (position.offset >= end || end > values.length) return invalid();
        const cell = values.subarray(position.offset, end);
        if (cell[0] === 5) {
          if (cell.length < 12) return invalid();
          const flags = new DataView(cell.buffer, cell.byteOffset, cell.byteLength).getUint32(
            8,
            true,
          );
          if (flags & 512) cells.push({ row: rowIndex, column: position.column });
        } else if ((cell[0] ?? 255) <= 4) this.legacy = true;
        else return invalid();
      }
    }
    this.formulas.set(message.id, cells);
  }
  finish(): { formulaCells: NumbersFormulaCell[]; issues: ImportIssue[] } {
    const formulaCells: NumbersFormulaCell[] = [];
    const roots = [...this.messages.values()].filter((message) => message.type === 1);
    const root =
      this.messages.get(1)?.type === 1
        ? this.messages.get(1)
        : roots.length === 1
          ? roots[0]
          : null;
    if (!root) return invalid();
    for (const document of [root]) {
      for (const sheetRef of document.fields.get(1) ?? []) {
        if (sheetRef.wire !== 2) return invalid();
        const sheet = this.messages.get(integer(this.parse(sheetRef.data).get(1)?.[0]));
        if (!sheet || sheet.type !== 2) return invalid();
        let name: string;
        try {
          name = new TextDecoder('utf-8', { fatal: true }).decode(bytesField(sheet.fields, 1));
        } catch {
          return invalid();
        }
        let tableIndex = 0;
        for (const tableRef of sheet.fields.get(2) ?? []) {
          if (tableRef.wire !== 2) return invalid();
          const table = this.messages.get(integer(this.parse(tableRef.data).get(1)?.[0]));
          if (!table) return invalid();
          if (table.type !== 6000) continue;
          const model = this.messages.get(this.reference(table.fields, 2));
          if (!model || model.type !== 6001) return invalid();
          const store = this.parse(bytesField(model.fields, 4)),
            tileList = this.parse(bytesField(store, 3)),
            tree = this.parse(bytesField(store, 9));
          const tiles = tileList.get(1) ?? [],
            label = tableIndex++ === 0 ? name : `${name}_${tableIndex - 1}`;
          for (const node of tree.get(1) ?? []) {
            if (node.wire !== 2) return invalid();
            const value = this.parse(node.data),
              base = integer(value.get(1)?.[0]),
              tileIndex = integer(value.get(2)?.[0]),
              tile = tiles[tileIndex];
            if (!tile || tile.wire !== 2) return invalid();
            const tileId = this.reference(this.parse(tile.data), 2);
            if (!this.messages.has(tileId)) return invalid();
            for (const cell of this.formulas.get(tileId) ?? [])
              formulaCells.push({
                sheet: label,
                row: base + cell.row + 1,
                column: cell.column + 1,
              });
          }
        }
      }
    }
    return {
      formulaCells,
      issues: this.legacy
        ? [
            {
              severity: 'warning',
              code: 'numbers_legacy_formula_visibility',
              message:
                'this older numbers cell format exposes cached values but cannot identify every uncached formula. inspect empty fields or export a values-only xlsx copy before confirming.',
            },
          ]
        : [],
    };
  }
}
