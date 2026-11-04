import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { ImportTable } from '../../parse-contract';
import { MAX_IMPORT_EXPANDED_BYTES } from '../../parse-contract';
import { request } from '../../../../shared/browser/http/http';
import { ImportTableSchema } from '../response-contracts';
import { sheetRangePages } from '../import-input';
import { transferBase } from '../transfer-context';

export interface SelectedSheetSource {
  account: ConnectionSummary | undefined;
  accountId: string;
  spreadsheetId: string;
  selectedSheets: readonly string[];
  ranges: Readonly<Record<string, string>>;
}
export async function readSelectedSheetTables(
  source: SelectedSheetSource,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<ImportTable[]> {
  if (
    !source.account ||
    !source.account.permissions.sheetsImport ||
    source.account.state !== 'connected'
  )
    throw new Error('authorize sheets read access for the selected source account first.');
  if (!source.selectedSheets.length) throw new Error('select at least one tab and explicit range.');
  const requestCount = source.selectedSheets.reduce(
    (sum, sheet) => sum + sheetRangePages(source.ranges[sheet] ?? '').length,
    0,
  );
  if (requestCount > 1000)
    throw new Error(
      'these ranges require more than 1,000 bounded reads. choose smaller explicit ranges before previewing.',
    );
  const tables: ImportTable[] = [];
  let selectedBytes = 0;
  for (const sheet of source.selectedSheets) {
    const range = source.ranges[sheet] ?? '',
      pages = sheetRangePages(range);
    let combined: ImportTable | null = null;
    for (const page of pages) {
      onProgress(`reading ${sheet} · ${page}`);
      const value = (await request(
        `${transferBase(source.accountId)}/sheets/range`,
        ImportTableSchema,
        {
          method: 'POST',
          body: { spreadsheetId: source.spreadsheetId, sheet, range: page },
          signal,
        },
      )) as ImportTable;
      selectedBytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (selectedBytes > MAX_IMPORT_EXPANDED_BYTES)
        throw new Error(
          'the selected spreadsheet values exceed 100 mib. choose smaller explicit ranges; no partial import was captured.',
        );
      if (!combined) combined = value;
      else {
        combined.rows.push(...value.rows);
        combined.cellIssues = [...(combined.cellIssues ?? []), ...(value.cellIssues ?? [])];
      }
    }
    if (combined) tables.push(combined);
  }
  return tables;
}
