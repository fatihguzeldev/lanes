import { useRef, useState } from 'react';
import { z } from 'zod';
import { type ArchiveDocument } from '../../archive-contract';
import { request } from '../../../../client/http';
import { newOperationId } from '../../../../client/operation-identity';
import { boundedBatches } from '../import-input';
import { parseTransferInWorker } from '../parsing/preview-parser';
import { ArchiveSummarySchema } from '../response-contracts';
import { escaped, transferBase, writable, type TransferProps } from '../transfer-context';
import { TransferConnection, TransferError } from '../TransferFeedback';
import { useTransferAction } from '../useTransferAction';
import { useTransferDirty } from '../useTransferDirty';
import { Select } from '../../../../ui/Select';
import { ArchiveRestorePanel } from './ArchiveRestorePanel';
export function ArchiveImport(
  props: TransferProps & { retained?: z.infer<typeof ArchiveSummarySchema> },
) {
  const [file, setFile] = useState<File | null>(null),
    [document, setDocument] = useState<ArchiveDocument | null>(null),
    [mode, setMode] = useState<'restore_metadata' | 'copy_task_snapshots'>('restore_metadata'),
    [mapped, setMapped] = useState(false),
    [archive, setArchive] = useState(props.retained ?? null),
    [captureProgress, setCaptureProgress] = useState('');
  const attempt = useRef<{
      id: string;
      document: ArchiveDocument;
      mode: typeof mode;
      chunks: { position: number; value: ArchiveDocument['records'][number] }[][];
      position: number;
    } | null>(null),
    action = useTransferAction(props.account.id);
  useTransferDirty(
    Boolean(!archive || archive.state === 'staging') &&
      Boolean(file || document || attempt.current),
    props.onDirtyChange,
  );
  async function stage(signal: AbortSignal) {
    if (!attempt.current) {
      if (!document || !mapped)
        throw new Error('read the archive and confirm its explicit account mapping first.');
      const records = document.records.map((value, position) => ({ position, value }));
      attempt.current = {
        id: newOperationId(props.clockOffset),
        document,
        mode,
        chunks: [...boundedBatches(records, (rows) => rows)],
        position: 0,
      };
    }
    const capture = attempt.current,
      base = `${transferBase(props.account.id)}/archives/${escaped(capture.id)}`,
      deadline = Date.now() + 30000;
    let saved = await request(`${transferBase(props.account.id)}/archives`, ArchiveSummarySchema, {
      method: 'POST',
      body: {
        id: capture.id,
        mode: capture.mode,
        header: capture.document.header,
        recordCount: capture.document.records.length,
      },
      signal,
    });
    setArchive(saved);
    while (capture.position < capture.chunks.length && Date.now() < deadline && !signal.aborted) {
      saved = await request(`${base}/chunks`, ArchiveSummarySchema, {
        method: 'POST',
        body: capture.chunks[capture.position],
        signal,
      });
      capture.position++;
      setArchive(saved);
      setCaptureProgress(`${capture.position} of ${capture.chunks.length} bounded chunks captured`);
    }
    while (
      capture.position === capture.chunks.length &&
      saved.state === 'staging' &&
      Date.now() < deadline &&
      !signal.aborted
    ) {
      saved = await request(`${base}/seal`, ArchiveSummarySchema, {
        method: 'POST',
        body: {},
        signal,
      });
      setArchive(saved);
      setCaptureProgress(
        saved.validation
          ? `${saved.validation.checkedRecords} of ${saved.validation.totalRecords} records validated · ${saved.validation.remainingGraphNodes} graph nodes remaining`
          : 'validating complete archive references…',
      );
    }
    if (saved.state !== 'staging') {
      setCaptureProgress('');
      props.onChanged?.();
    }
  }
  if (archive && archive.state !== 'staging')
    return <ArchiveRestorePanel {...props} archive={archive} />;
  return (
    <section className="transfer__form">
      <TransferConnection />
      <h3>bring a workspace archive home</h3>
      <p>
        version 1 preserves lanes organization and exact task text. archives contain personal
        account/task data; they never carry oauth tokens, sessions or deployment secrets.
      </p>
      <fieldset disabled={action.busy || Boolean(attempt.current) || Boolean(props.retained)}>
        <label>
          lanes workspace json
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setDocument(null);
              setMapped(false);
            }}
          />
        </label>
        <button
          className="transfer__secondary"
          type="button"
          disabled={!file}
          onClick={() =>
            void action.run(async (signal) => {
              if (file) setDocument(await parseTransferInWorker({ kind: 'archive', file }, signal));
            })
          }
        >
          read and validate archive
        </button>
        {document && (
          <>
            <div className="transfer__preview">
              <h3>{document.header.source.email}</h3>
              <p>
                google subject <code>{document.header.source.googleSubject}</code>
              </p>
              <p>
                generated {document.header.generatedAt} · {document.records.length} records ·{' '}
                {document.header.includesTaskSnapshots
                  ? 'task snapshots included'
                  : 'metadata only'}
                .
              </p>
              <p>{document.header.generationNote}</p>
            </div>
            <label>
              import mode
              <Select
                value={mode}
                onChange={(selectedValue) => {
                  setMode(selectedValue as typeof mode);
                  setMapped(false);
                }}
                aria-label="import mode"
                options={[
                  {
                    value: 'restore_metadata',
                    label: 'restore lanes metadata to the same google subject',
                  },
                  {
                    value: 'copy_task_snapshots',
                    label: 'copy included task snapshots as new google content',
                    disabled: !document.header.includesTaskSnapshots,
                  },
                ]}
              />
            </label>
            <p>
              {mode === 'restore_metadata'
                ? 'exact provider resources must match under the same verified google subject. current values are kept unless you select incoming conflicts. unmatched content is never created.'
                : 'this creates ordinary new lists/tasks in the selected account. historical events are not copied onto these new identities.'}
            </p>
            <label className="transfer__check">
              <input
                type="checkbox"
                checked={mapped}
                onChange={(event) => setMapped(event.target.checked)}
              />
              {mode === 'restore_metadata'
                ? `map archived subject ${document.header.source.googleSubject} explicitly to ${props.account.email}; the server must verify the same subject`
                : `copy these snapshots into ${props.account.email} with new identities; preserve the source`}
            </label>
          </>
        )}
      </fieldset>
      {document && (
        <button
          type="button"
          className="transfer__primary"
          disabled={action.busy || !mapped || !writable(props.account)}
          onClick={() => void action.run(stage)}
        >
          {attempt.current ? 'continue the same archive capture' : 'capture archive for preview'}
        </button>
      )}
      {archive?.state === 'staging' && !attempt.current && (
        <div className="transfer__notice">
          <p>
            {archive.recordCount} of {archive.expectedRecords} records captured.{' '}
            {archive.recordCount < archive.expectedRecords
              ? 'complete this upload in its original editor, or cancel and select the file again. no google content was created.'
              : 'the complete upload is available; continue bounded validation.'}
          </p>
          {archive.recordCount === archive.expectedRecords && (
            <button
              type="button"
              disabled={action.busy}
              onClick={() =>
                void action.run(async (signal) =>
                  setArchive(
                    await request(
                      `${transferBase(props.account.id)}/archives/${escaped(archive.id)}/seal`,
                      ArchiveSummarySchema,
                      { method: 'POST', body: {}, signal },
                    ),
                  ),
                )
              }
            >
              continue archive validation
            </button>
          )}
        </div>
      )}
      {captureProgress && <p role="status">{captureProgress}</p>}
      {archive && (
        <button
          type="button"
          className="transfer__text"
          disabled={action.busy}
          onClick={() =>
            void action.run(async (signal) =>
              setArchive(
                await request(
                  `${transferBase(props.account.id)}/archives/${escaped(archive.id)}/cancel`,
                  ArchiveSummarySchema,
                  { method: 'POST', body: {}, signal },
                ),
              ),
            )
          }
        >
          cancel unconfirmed capture
        </button>
      )}
      <TransferError>{action.error}</TransferError>
    </section>
  );
}
