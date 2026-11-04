import { z } from 'zod';
import {
  CsvExportRequestSchema,
  type CsvExportRequest,
  type SheetsExportSummary,
} from '../../contracts/export';
import { OperationIdSchema } from '../../../operations/contracts/receipt';
const DraftSchema = z
  .object({
    version: z.literal(1),
    accountId: z.string().min(1).max(1024),
    title: z.string().min(1).max(1024),
    exportRequest: CsvExportRequestSchema.optional(),
    operationId: OperationIdSchema.optional(),
    savedAt: z.number().int().nonnegative(),
  })
  .strict();
export type SheetsExportDraft = z.infer<typeof DraftSchema>;
export function decodeSheetsExportDraft(
  serialized: string | null,
  accountId: string,
  now = Date.now(),
): SheetsExportDraft | null {
  if (!serialized || serialized.length > 65536) return null;
  try {
    const value = DraftSchema.safeParse(JSON.parse(serialized));
    return value.success &&
      value.data.accountId === accountId &&
      value.data.savedAt <= now + 300000 &&
      now - value.data.savedAt < 86400000
      ? value.data
      : null;
  } catch {
    return null;
  }
}
export function readSheetsExportDraft(accountId: string): SheetsExportDraft | null {
  try {
    return decodeSheetsExportDraft(
      sessionStorage.getItem('lanes:transfer-sheets-export:' + accountId),
      accountId,
    );
  } catch {
    return null;
  }
}
export function saveSheetsExportDraft(
  accountId: string,
  input: { title: string; exportRequest?: CsvExportRequest; operationId?: string },
): void {
  const value = DraftSchema.parse({ version: 1, accountId, ...input, savedAt: Date.now() });
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 65536)
    throw Error('choose a narrower export scope before saving its consent draft.');
  sessionStorage.setItem('lanes:transfer-sheets-export:' + accountId, serialized);
}
export function clearSheetsExportDraft(accountId: string): void {
  try {
    sessionStorage.removeItem('lanes:transfer-sheets-export:' + accountId);
  } catch {
    /* Server-owned output does not depend on browser storage. */
  }
}
export function canConfirmSheetsRun(run: SheetsExportSummary): boolean {
  return run.state === 'ready' && /^[a-f0-9]{64}$/.test(run.captureHash ?? '') && !run.operation;
}
export function canAdvanceSheetsRun(run: SheetsExportSummary): boolean {
  return !run.operation?.finished && ['accepted', 'running', 'partial'].includes(run.state);
}
export function spreadsheetHref(file: { id: string; url: string } | null): string | null {
  if (!file || !/^[A-Za-z0-9_-]{1,256}$/.test(file.id)) return null;
  const expected = 'https://docs.google.com/spreadsheets/d/' + file.id + '/edit';
  return file.url === expected ? expected : null;
}
export function describeSheetsScope(input: CsvExportRequest): string {
  const scope = input.scope;
  const kind = scope.listIds
    ? `${scope.listIds.length} explicitly selected ${scope.listIds.length === 1 ? 'list' : 'lists'}`
    : scope.boardId
      ? 'the selected board'
      : 'the selected account';
  return `${kind}${scope.query ? ` · search “${scope.query}”` : ''} · ${input.includeCompleted ? 'including' : 'excluding'} completed tasks`;
}
