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
