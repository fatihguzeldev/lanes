import type { ImportPreview } from '../../parse-contract';
import { request } from '../../../../client/http';
import { ImportSummarySchema, type ImportSummary } from '../response-contracts';
import { boundedBatches } from '../import-input';
import { escaped, transferBase } from '../transfer-context';

type StagedRecord = { kind: 'lists' | 'tasks' | 'issues'; position: number; value: unknown };
const importChunk = (rows: StagedRecord[]) => ({
  lists: rows
    .filter((row) => row.kind === 'lists')
    .map(({ position, value }) => ({ position, value })),
  tasks: rows
    .filter((row) => row.kind === 'tasks')
    .map(({ position, value }) => ({ position, value })),
  issues: rows
    .filter((row) => row.kind === 'issues')
    .map(({ position, value }) => ({ position, value })),
});
export interface ImportCapture {
  id: string;
  manifest: unknown;
  chunks: ReturnType<typeof importChunk>[];
  nextChunk: number;
}
export function createImportCapture(
  id: string,
  preview: ImportPreview,
  source: ImportSummary['source'],
  destination: ImportSummary['destination'],
): ImportCapture {
  const records: StagedRecord[] = [
    ...preview.lists.map((value, position) => ({ kind: 'lists' as const, position, value })),
    ...preview.tasks.map((value, position) => ({ kind: 'tasks' as const, position, value })),
    ...preview.issues.map((value, position) => ({
      kind: 'issues' as const,
      position,
      value,
    })),
  ];
  const manifest = {
    id,
    source,
    destination,
    totalLists: preview.lists.length,
    totalTasks: preview.tasks.length,
    issueCount: preview.issues.length,
    mapping: preview.mapping,
    skippedBlankRows: preview.skippedBlankRows,
    skippedCompletedTasks: preview.skippedCompletedTasks,
    parentContextCount: preview.parentContextCount,
  };
  if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > 65536)
    throw new Error(
      'the selected source and mapping header exceeds 64 kib. choose fewer tables or a smaller mapping before capture.',
    );
  return {
    id,
    manifest,
    chunks: [...boundedBatches(records, importChunk)].map(importChunk),
    nextChunk: 0,
  };
}
export async function captureImport(
  accountId: string,
  capture: ImportCapture,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<ImportSummary | null> {
  const base = `${transferBase(accountId)}/imports`,
    deadline = Date.now() + 30000;
  let summary = await request(base, ImportSummarySchema, {
    method: 'POST',
    body: capture.manifest,
    signal,
  });
  while (capture.nextChunk < capture.chunks.length && Date.now() < deadline && !signal.aborted) {
    summary = await request(`${base}/${escaped(capture.id)}/chunks`, ImportSummarySchema, {
      method: 'POST',
      body: capture.chunks[capture.nextChunk],
      signal,
    });
    capture.nextChunk++;
    onProgress(
      `${capture.nextChunk} of ${capture.chunks.length} bounded chunks saved · no google writes yet`,
    );
  }
  if (capture.nextChunk === capture.chunks.length) {
    do {
      summary = await request(`${base}/${escaped(capture.id)}/preview`, ImportSummarySchema, {
        method: 'POST',
        body: {},
        signal,
      });
      onProgress(
        summary.validation
          ? `${summary.validation.checkedRecords} of ${summary.validation.totalRecords} records validated · ${summary.validation.remainingGraphNodes} graph nodes remaining`
          : 'validating complete captured references…',
      );
    } while (
      summary.state === 'staging' &&
      !summary.paused &&
      Date.now() < deadline &&
      !signal.aborted
    );
    return summary;
  }
  return null;
}
