import { afterEach, expect, it, vi } from 'vitest';
import { normalizeImportTables } from '../../../formats/normalize';
import { captureImport, createImportCapture } from '../capture-import';
import { ImportSummarySchema } from '../../protocol/response-contracts';

const source = { kind: 'file' as const, name: 'tasks.csv', format: 'csv' };
const destination = { kind: 'new' as const, boardId: 'board', boardRevision: 2 };
function fixture() {
  const preview = normalizeImportTables(
    [
      {
        name: 'todo',
        rows: [['title'], ...Array.from({ length: 23 }, (_, index) => [`task ${index}`])],
      },
    ],
    'csv',
  );
  const capture = createImportCapture('capture', preview, source, destination);
  const summary = ImportSummarySchema.parse({
    id: capture.id,
    accountId: 'destination-account',
    state: 'staging',
    revision: 1,
    source,
    destination,
    totalLists: preview.lists.length,
    totalTasks: preview.tasks.length,
    capturedLists: 0,
    capturedTasks: 0,
    capturedIssues: 0,
    warningCount: preview.issues.length,
    errorCount: 0,
    completedCount: 0,
    subtaskCount: 0,
    repeatingCount: 0,
    requiredListSlots: preview.lists.length,
    skippedBlankRows: preview.skippedBlankRows,
    skippedCompletedTasks: 0,
    parentContextCount: 0,
    previewHash: null,
    operationId: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    freshnessNote: 'retained captured input',
  });
  return { capture, summary };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('resumes the same capture at its first unacknowledged chunk without replaying confirmed rows', async () => {
  const { capture, summary } = fixture();
  const admissions: unknown[] = [],
    accepted: unknown[] = [];
  let chunkCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
      const body: unknown = JSON.parse(String(init.body));
      if (path.endsWith('/imports')) admissions.push(body);
      else if (path.endsWith('/chunks')) {
        chunkCalls++;
        if (chunkCalls === 2)
          return Response.json(
            {
              error: {
                code: 'storage_unavailable',
                message: 'retry the same captured chunk',
                requestId: 'request',
                retryable: true,
              },
            },
            { status: 503 },
          );
        accepted.push(body);
      } else if (path.endsWith('/preview')) return Response.json({ ...summary, state: 'preview' });
      else throw new Error(`unexpected mutation: ${path}`);
      return Response.json(summary);
    }),
  );
  await expect(
    captureImport('destination-account', capture, new AbortController().signal, vi.fn()),
  ).rejects.toThrow('retry the same captured chunk');
  expect(capture.nextChunk).toBe(1);
  const result = await captureImport(
    'destination-account',
    capture,
    new AbortController().signal,
    vi.fn(),
  );
  expect(admissions).toEqual([capture.manifest, capture.manifest]);
  expect(accepted).toEqual(capture.chunks);
  expect(capture.nextChunk).toBe(capture.chunks.length);
  expect(result?.state).toBe('preview');
});

it('returns control at the capture deadline while retaining its acknowledged chunk cursor', async () => {
  const { capture, summary } = fixture();
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      calls.push(path);
      return Response.json(summary);
    }),
  );
  const result = await captureImport(
    'destination-account',
    capture,
    new AbortController().signal,
    () => {
      now = 31_001;
    },
  );
  expect(result).toBeNull();
  expect(capture.nextChunk).toBe(1);
  expect(calls).toEqual([
    '/api/accounts/destination-account/transfer/imports',
    '/api/accounts/destination-account/transfer/imports/capture/chunks',
  ]);
});

it('continues bounded preview validation without changing its sealed source or destination', async () => {
  const { capture, summary } = fixture();
  let previewCalls = 0;
  const progress = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path.endsWith('/preview')) {
        previewCalls++;
        return Response.json({
          ...summary,
          state: previewCalls === 3 ? 'preview' : 'staging',
          validation: {
            checkedRecords: previewCalls,
            totalRecords: 23,
            remainingGraphNodes: 3 - previewCalls,
          },
        });
      }
      return Response.json(summary);
    }),
  );
  const manifest = JSON.stringify(capture.manifest);
  const result = await captureImport(
    'destination-account',
    capture,
    new AbortController().signal,
    progress,
  );
  expect(result?.state).toBe('preview');
  expect(previewCalls).toBe(3);
  expect(progress).toHaveBeenLastCalledWith('3 of 23 records validated · 0 graph nodes remaining');
  expect(JSON.stringify(capture.manifest)).toBe(manifest);
});
