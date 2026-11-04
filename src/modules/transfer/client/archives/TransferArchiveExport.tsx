import { useRef, useState } from 'react';
import {
  ArchiveDownloadPageSchema,
  ArchiveExportSummarySchema,
  type ArchiveExportSummary,
} from '../../archive-export-contract';
import { accountToday } from '../../../tasks/model/planning';
import { request } from '../../../../shared/browser/http/http';
import { downloadFile } from '../download-file';
import { BoardChoice } from '../TransferSelection';
import { escaped, transferBase, type TransferProps } from '../transfer-context';
import { TransferConnection, TransferError } from '../TransferFeedback';
import { useBoardLists } from '../useBoardLists';
import { useTransferAction } from '../useTransferAction';
import { useTransferDirty } from '../useTransferDirty';
import { Select } from '../../../../shared/ui/select/Select';
export function TransferArchiveExport(props: TransferProps & { retained?: ArchiveExportSummary }) {
  const [scope, setScope] = useState<'board' | 'account'>('board'),
    [snapshots, setSnapshots] = useState(true),
    [run, setRun] = useState<ArchiveExportSummary | null>(props.retained ?? null),
    [progress, setProgress] = useState(''),
    [cancel, setCancel] = useState(false);
  const resource = useBoardLists(props.account.id, props.version),
    action = useTransferAction(props.account.id),
    base = `${transferBase(props.account.id)}/archives/exports`;
  const attempt = useRef<{
      id: string;
      boardId?: string;
      includeTaskSnapshots: boolean;
      today: string;
    } | null>(null),
    download = useRef<{
      parts: BlobPart[];
      cursor: string | null;
      started: boolean;
      bytes: number;
    } | null>(null);
  useTransferDirty(Boolean((attempt.current && !run) || download.current), props.onDirtyChange);
  async function capture(signal: AbortSignal) {
    if (!attempt.current && !run) {
      if (scope === 'board' && !resource.board) throw new Error('choose a loaded board.');
      attempt.current = {
        id: crypto.randomUUID().replaceAll('-', ''),
        ...(scope === 'board' ? { boardId: resource.board!.id } : {}),
        includeTaskSnapshots: snapshots,
        today: accountToday(
          props.account.planningZone,
          new Date(Date.now() + props.clockOffset).toISOString(),
        ),
      };
    }
    let current =
      run ??
      (await request(base, ArchiveExportSummarySchema, {
        method: 'POST',
        body: attempt.current!,
        signal,
      }));
    setRun(current);
    const deadline = Date.now() + 30000;
    while (current.state === 'capturing' && Date.now() < deadline && !signal.aborted) {
      current = await request(
        `${base}/${escaped(current.id)}/capture`,
        ArchiveExportSummarySchema,
        { method: 'POST', body: {}, signal },
      );
      setRun(current);
      setProgress(
        `${current.recordCount} records · ${(current.bytes / 1024).toFixed(0)} kib · ${current.phase.replaceAll('_', ' ')}`,
      );
    }
  }
  async function save(signal: AbortSignal) {
    if (!run || run.state !== 'ready' || !run.downloadAvailable) return;
    if (!download.current) download.current = { parts: [], cursor: null, started: false, bytes: 0 };
    const saved = download.current,
      deadline = Date.now() + 30000;
    do {
      const page = await request(
        `${base}/${escaped(run.id)}/download?limit=10${saved.cursor ? `&cursor=${escaped(saved.cursor)}` : ''}`,
        ArchiveDownloadPageSchema,
        { signal },
      );
      const bytes = new TextEncoder().encode(page.chunk).length;
      if (saved.bytes + bytes > 20 * 1024 * 1024)
        throw new Error(
          'the archive exceeds 20 mib. choose a narrower scope; no truncated file was downloaded.',
        );
      saved.parts.push(page.chunk);
      saved.bytes += bytes;
      saved.cursor = page.nextCursor;
      saved.started = true;
      setProgress(`${(saved.bytes / 1024).toFixed(0)} kib collected for download`);
    } while (saved.cursor && Date.now() < deadline && !signal.aborted);
    if (!saved.cursor && saved.started) {
      downloadFile(
        saved.parts,
        `lanes-workspace-${props.account.email}-${accountToday(props.account.planningZone)}.json`,
        'application/json;charset=utf-8',
      );
      setProgress('the complete private archive was downloaded.');
      download.current = null;
    }
  }
  return (
    <section className="transfer__form">
      <TransferConnection />
      <p>
        select an account or board. exact-text task snapshots are optional; organization, labels,
        templates, paused schedule definitions, preferences and retained history belong to the
        archive.
      </p>
      <fieldset disabled={action.busy || Boolean(attempt.current) || Boolean(run)}>
        <label>
          archive scope
          <Select
            value={scope}
            onChange={(selectedValue) => setScope(selectedValue as typeof scope)}
            aria-label="archive scope"
            options={[
              { value: 'board', label: 'selected board' },
              { value: 'account', label: 'selected account' },
            ]}
          />
        </label>
        {scope === 'board' && <BoardChoice resource={resource} />}
        <label className="transfer__check">
          <input
            type="checkbox"
            checked={snapshots}
            onChange={(event) => setSnapshots(event.target.checked)}
          />
          include readable task snapshots with exact titles, notes and completion
        </label>
        <p>
          {snapshots
            ? 'task snapshots are limited to 2,000 tasks and 100 lists per archive. choose a narrower board if this account is larger.'
            : 'metadata-only archives can cover more lists within the 20 mib byte limit and do not consume task-creation quota.'}
        </p>
        <p>
          the private file includes account addresses, verified google subjects, provider mappings
          and task data. it excludes credentials, sessions, encryption keys and deployment secrets.
        </p>
      </fieldset>
      <div className="transfer__actions">
        {!run && (
          <button
            className="transfer__primary"
            type="button"
            disabled={action.busy}
            onClick={() => void action.run(capture)}
          >
            {attempt.current ? 'retry captured export' : 'capture private archive'}
          </button>
        )}
        {run?.state === 'capturing' && (
          <button
            className="transfer__primary"
            type="button"
            disabled={action.busy}
            onClick={() => void action.run(capture)}
          >
            continue archive capture
          </button>
        )}
        {run?.state === 'ready' && run.downloadAvailable && (
          <button
            className="transfer__primary"
            type="button"
            disabled={action.busy}
            onClick={() => void action.run(save)}
          >
            {download.current ? 'continue this download' : 'download complete archive'}
          </button>
        )}
      </div>
      {run && (
        <div className="transfer__preview">
          <h3>
            {run.state} · {run.phase.replaceAll('_', ' ')}
          </h3>
          <p>
            {run.recordCount} records · {run.taskCount} tasks · {run.listCount} lists ·{' '}
            {(run.bytes / 1024).toFixed(0)} kib.
          </p>
          {run.freshness && (
            <p>
              {run.freshness.stale ? 'stale retained projection' : 'retained projection'} ·{' '}
              {run.freshness.complete ? 'complete selected coverage' : 'partial selected coverage'}
              {run.freshness.lastSyncedAt ? ` · last synced ${run.freshness.lastSyncedAt}` : ''}.
            </p>
          )}
          <p>{run.header.generationNote}</p>
          {run.payloadExpiresAt && (
            <p>
              the captured download is retained until {run.payloadExpiresAt}. your downloaded
              private file remains yours.
            </p>
          )}
          {run.state === 'ready' && !run.downloadAvailable && (
            <p className="transfer__notice">
              this captured download expired. its result is retained, and a fresh archive needs a
              new capture.
              <button
                type="button"
                onClick={() => {
                  setRun(null);
                  attempt.current = null;
                  download.current = null;
                }}
              >
                choose a fresh archive capture
              </button>
            </p>
          )}
          {run.unmatchedSchedules > 0 && (
            <p className="transfer__warning">
              {run.unmatchedSchedules} schedules whose targets/template content are outside the
              archive scope were omitted.
            </p>
          )}
          {run.error && <p className="transfer__warning">{run.error.message}</p>}
          {run.state !== 'ready' && run.state !== 'cancelled' && (
            <>
              <label className="transfer__check">
                <input
                  type="checkbox"
                  checked={cancel}
                  onChange={(event) => setCancel(event.target.checked)}
                />
                cancel this export capture
              </label>
              <button
                type="button"
                className="transfer__danger"
                disabled={action.busy || !cancel}
                onClick={() =>
                  void action.run(async (signal) =>
                    setRun(
                      await request(
                        `${base}/${escaped(run.id)}/cancel`,
                        ArchiveExportSummarySchema,
                        { method: 'POST', body: {}, signal },
                      ),
                    ),
                  )
                }
              >
                cancel export
              </button>
            </>
          )}
        </div>
      )}
      {progress && <p role="status">{progress}</p>}
      <TransferError>{action.error}</TransferError>
    </section>
  );
}
