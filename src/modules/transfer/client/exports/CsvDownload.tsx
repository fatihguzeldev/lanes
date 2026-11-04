import { useRef, useState } from 'react';
import { type CsvExportRequest } from '../../export-contract';
import { accountToday } from '../../../tasks/planning';
import { request } from '../../../../client/http';
import { downloadFile } from '../download-file';
import { CsvPageSchema } from '../response-contracts';
import { transferBase, type TransferProps } from '../transfer-context';
import { TransferError } from '../TransferFeedback';
import { useTransferAction } from '../useTransferAction';
import { useTransferDirty } from '../useTransferDirty';
export function CsvDownload({
  account,
  input,
  onDirtyChange,
}: TransferProps & { input: CsvExportRequest }) {
  const [preview, setPreview] = useState<{
      fingerprint: string;
      value: Awaited<ReturnType<typeof readPage>>;
      input: CsvExportRequest;
    } | null>(null),
    [progress, setProgress] = useState(''),
    [done, setDone] = useState(false);
  const attempt = useRef<{
      input: CsvExportRequest;
      parts: BlobPart[];
      cursor: string | null;
      bytes: number;
      tasks: number;
    } | null>(null),
    action = useTransferAction(account.id),
    fingerprint = JSON.stringify(input),
    current = preview?.fingerprint === fingerprint ? preview : null;
  useTransferDirty(Boolean(attempt.current && !done), onDirtyChange);
  async function readPage(settings: CsvExportRequest, signal: AbortSignal, cursor?: string) {
    return request(`${transferBase(account.id)}/exports/csv/page`, CsvPageSchema, {
      method: 'POST',
      body: { request: settings, ...(cursor ? { cursor } : {}) },
      signal,
    });
  }
  async function download(signal: AbortSignal) {
    if (!attempt.current) {
      if (!current) throw new Error('preview this exact scope first.');
      attempt.current = {
        input: current.input,
        parts: [current.value.chunk],
        cursor: current.value.nextCursor,
        bytes: new TextEncoder().encode(current.value.chunk).length,
        tasks: current.value.counts.tasks,
      };
    }
    const download = attempt.current,
      deadline = Date.now() + 30000;
    while (download.cursor && Date.now() < deadline && !signal.aborted) {
      const page = await readPage(download.input, signal, download.cursor),
        bytes = new TextEncoder().encode(page.chunk).length;
      if (download.bytes + bytes > 100 * 1024 * 1024)
        throw new Error(
          'this download exceeds the browser fallback limit of 100 mib. choose a narrower scope; no truncated file was downloaded.',
        );
      download.parts.push(page.chunk);
      download.bytes += bytes;
      download.tasks += page.counts.tasks;
      download.cursor = page.nextCursor;
      setProgress(
        `${download.tasks} task rows collected · ${(download.bytes / 1024).toFixed(0)} kib`,
      );
    }
    if (!download.cursor) {
      downloadFile(
        download.parts,
        `lanes-${account.email}-${accountToday(account.planningZone)}.csv`,
        'text/csv;charset=utf-8',
      );
      setDone(true);
      setProgress(`${download.tasks} task rows downloaded.`);
      attempt.current = null;
    }
  }
  return (
    <div className="transfer__export">
      <p>
        csv contains export-local task/parent keys, plain notes, dates, completion and structured
        lanes metadata. formula-like text is escaped; use a workspace archive for an exact-text
        copy.
      </p>
      <div className="transfer__actions">
        <button
          type="button"
          className="transfer__secondary"
          disabled={action.busy || Boolean(attempt.current)}
          onClick={() =>
            void action.run(async (signal) => {
              const captured = { ...input, exportId: crypto.randomUUID().replaceAll('-', '') },
                value = await readPage(captured, signal);
              setPreview({ fingerprint, value, input: captured });
              setDone(false);
            })
          }
        >
          preview export freshness
        </button>
        {current && !done && (
          <button
            type="button"
            className="transfer__primary"
            disabled={action.busy}
            onClick={() => void action.run(download)}
          >
            {attempt.current ? 'continue this download' : 'download csv'}
          </button>
        )}
      </div>
      {current && (
        <div className="transfer__preview">
          <p>
            generated {current.value.generatedAt} ·{' '}
            {current.value.freshness.stale ? 'stale retained data' : 'retained projection'} ·{' '}
            {current.value.freshness.complete
              ? 'selection coverage complete'
              : 'selection coverage partial'}
            {current.value.freshness.lastSyncedAt
              ? ` · last synced ${current.value.freshness.lastSyncedAt}`
              : ' · no completed sync time'}
          </p>
          <p>{current.value.consistencyExplanation}</p>
          <p>{current.value.formulaEscapeExplanation}</p>
          <p>
            first page: {current.value.counts.tasks} task rows ·{' '}
            {current.value.counts.parentContext} parent context records ·{' '}
            {current.value.counts.omittedDependencies} external dependencies omitted.
          </p>
          <details>
            <summary>first rows · plain csv text</summary>
            <pre>{current.value.chunk}</pre>
          </details>
        </div>
      )}
      {attempt.current && !current && (
        <p className="transfer__notice">
          an earlier download keeps its original scope. continue it below before preparing a
          different selection.
          <button type="button" onClick={() => void action.run(download)} disabled={action.busy}>
            continue original download
          </button>
        </p>
      )}
      {progress && <p role="status">{progress}</p>}
      <TransferError>{action.error}</TransferError>
    </div>
  );
}
