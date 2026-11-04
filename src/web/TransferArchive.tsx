import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ArchiveChoiceChunkSchema,
  type ArchiveDocument,
  type ArchiveField,
} from '../modules/transfer/archive-contract';
import { request } from '../client/http';
import { newOperationId } from '../client/operation-identity';
import { boundedBatches, parseTransferInWorker } from './transfer-client';
import {
  ArchivePreviewSchema,
  ArchiveRecordPageSchema,
  ArchiveSummarySchema,
  ImportSummarySchema,
  type ImportSummary,
} from './transfer-schemas';
import {
  DestinationChoice,
  destinationValue,
  escaped,
  providerReady,
  transferBase,
  TransferConnection,
  TransferError,
  useBoardLists,
  useTransferAction,
  useTransferDirty,
  writable,
  type TransferProps,
} from './TransferCommon';
import { TransferImportRun } from './TransferImportRun';
import { TransferArchiveExport } from './TransferArchiveExport';
import { Select } from '../ui/Select';
export function TransferArchive(props: TransferProps) {
  const [dirtyImport, setDirtyImport] = useState(false),
    [dirtyExport, setDirtyExport] = useState(false);
  useTransferDirty(dirtyImport || dirtyExport, props.onDirtyChange);
  return (
    <>
      <details className="transfer__details">
        <summary>export a private workspace archive</summary>
        <TransferArchiveExport {...props} onDirtyChange={setDirtyExport} />
      </details>
      <ArchiveImport {...props} onDirtyChange={setDirtyImport} />
    </>
  );
}
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
export function ArchiveRestorePanel(
  props: TransferProps & { archive: z.infer<typeof ArchiveSummarySchema> },
) {
  const [archive, setArchive] = useState(props.archive),
    [preview, setPreview] = useState<z.infer<typeof ArchivePreviewSchema> | null>(null),
    [page, setPage] = useState<z.infer<typeof ArchiveRecordPageSchema> | null>(null),
    [after, setAfter] = useState(-1),
    [priorPages, setPriorPages] = useState<number[]>([]),
    [drafts, setDrafts] = useState<
      Record<string, { fields: ArchiveField[]; acceptOmittedReferences: boolean }>
    >({}),
    [acknowledged, setAcknowledged] = useState(false),
    [cancel, setCancel] = useState(false),
    [run, setRun] = useState<ImportSummary | null>(null),
    [destinationKind, setDestinationKind] = useState<'new' | 'existing'>('new'),
    [listId, setListId] = useState('');
  const copyAttempt = useRef<{
      id: string;
      destination: ReturnType<typeof destinationValue>;
    } | null>(null),
    action = useTransferAction(`${props.account.id}:${archive.id}`),
    destination = useBoardLists(props.account.id, props.version),
    base = `${transferBase(props.account.id)}/archives/${escaped(archive.id)}`;
  useTransferDirty(
    Object.keys(drafts).length > 0 || Boolean(copyAttempt.current && !run),
    props.onDirtyChange,
  );
  async function refresh(signal: AbortSignal) {
    const saved = await request(base, ArchiveSummarySchema, { signal });
    setArchive(saved);
    if (saved.mode === 'restore_metadata' && saved.state !== 'staging') {
      const value = await request(`${base}/preview`, ArchivePreviewSchema, { signal });
      setPreview(value);
    }
    return saved;
  }
  async function loadPage(signal: AbortSignal, position = after) {
    const value = await request(
      `${base}/records?limit=10${position < 0 ? '' : `&after=${position}`}`,
      ArchiveRecordPageSchema,
      { signal },
    );
    setPage(value);
    setAfter(position);
  }
  useEffect(() => {
    void action.run(async (signal) => {
      await refresh(signal);
      await loadPage(signal, -1);
    });
  }, [archive.id]);
  async function match(signal: AbortSignal) {
    const deadline = Date.now() + 30000;
    let value = preview;
    do {
      value = await request(`${base}/preview-next`, ArchivePreviewSchema, {
        method: 'POST',
        body: {},
        signal,
      });
      setPreview(value);
      setArchive(value.archive);
    } while (value.pendingMatches > 0 && Date.now() < deadline && !signal.aborted);
    await loadPage(signal);
  }
  async function saveChoices(signal: AbortSignal) {
    const choices = ArchiveChoiceChunkSchema.parse(
        Object.entries(drafts).map(([key, choice]) => ({ key, ...choice })),
      ),
      value = await request(`${base}/choices`, ArchivePreviewSchema, {
        method: 'POST',
        body: choices,
        signal,
      });
    setPreview(value);
    setArchive(value.archive);
    setDrafts({});
    setAcknowledged(false);
    await loadPage(signal);
  }
  async function restore(signal: AbortSignal) {
    let current = archive;
    if (current.paused)
      current = await request(`${base}/resume`, ArchiveSummarySchema, {
        method: 'POST',
        body: {},
        signal,
      });
    else if (current.state === 'preview')
      current = await request(`${base}/confirm`, ArchiveSummarySchema, {
        method: 'POST',
        body: { previewHash: current.previewHash, revision: current.revision },
        signal,
      });
    setArchive(current);
    const deadline = Date.now() + 30000;
    while (
      current.state === 'restoring' &&
      !current.paused &&
      Date.now() < deadline &&
      !signal.aborted
    ) {
      current = await request(`${base}/advance`, ArchiveSummarySchema, {
        method: 'POST',
        body: {},
        signal,
      });
      setArchive(current);
      props.onChanged?.();
    }
    await refresh(signal);
    await loadPage(signal);
  }
  async function copy(signal: AbortSignal) {
    if (!copyAttempt.current)
      copyAttempt.current = {
        id: newOperationId(props.clockOffset),
        destination: destinationValue(destination, destinationKind, listId),
      };
    const input = copyAttempt.current;
    let result = await request(`${base}/copy`, ImportSummarySchema, {
      method: 'POST',
      body: input,
      signal,
    });
    const deadline = Date.now() + 30000;
    while (result.state === 'staging' && Date.now() < deadline && !signal.aborted)
      result = await request(
        `${transferBase(props.account.id)}/archives/copies/${escaped(input.id)}/capture`,
        ImportSummarySchema,
        { method: 'POST', body: {}, signal },
      );
    setRun(result);
    props.onChanged?.();
  }
  if (run) return <TransferImportRun {...props} run={run} />;
  const editable =
    archive.state === 'preview' && !archive.paused && !action.busy && writable(props.account);
  return (
    <section className="transfer__form">
      <TransferConnection />
      <div className="transfer__section-title">
        <h3>{archive.mode === 'restore_metadata' ? 'restore metadata' : 'copy task snapshots'}</h3>
        <span>
          {archive.state}
          {archive.paused ? ' · paused' : ''}
        </span>
      </div>
      <p>
        archived account {archive.header.source.email} → {props.account.email} ·{' '}
        {archive.recordCount} captured records.
      </p>
      {archive.mode === 'copy_task_snapshots' ? (
        <>
          <p>
            new tasks/lists use ordinary import quota and recovery. retained history will not appear
            as history of the copies.
          </p>
          <DestinationChoice
            resource={destination}
            kind={destinationKind}
            setKind={setDestinationKind}
            listId={listId}
            setListId={setListId}
            disabled={action.busy || Boolean(copyAttempt.current)}
          />
          <label className="transfer__check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            prepare a distinct source-preserving snapshot copy for final import preview
          </label>
          <button
            type="button"
            className="transfer__primary"
            disabled={
              action.busy || !acknowledged || !providerReady(props.account) || archive.paused
            }
            onClick={() => void action.run(copy)}
          >
            {copyAttempt.current ? 'retry the same snapshot copy' : 'prepare snapshot copy'}
          </button>
        </>
      ) : (
        <>
          {preview && (
            <>
              <div className="transfer__numbers">
                <span>
                  <strong>{preview.matched}</strong>matched
                </span>
                <span>
                  <strong>{preview.conflicts}</strong>conflicts
                </span>
                <span>
                  <strong>{preview.unmatched}</strong>unmatched
                </span>
                <span>
                  <strong>{preview.pendingMatches}</strong>not checked
                </span>
              </div>
              <p>
                {preview.newRecords} new lanes definitions · {preview.selected} selected records ·{' '}
                {preview.restored} restored · {preview.skipped} skipped.
              </p>
              {preview.pendingMatches > 0 && archive.state === 'preview' && (
                <button
                  className="transfer__secondary"
                  type="button"
                  disabled={action.busy || archive.paused}
                  onClick={() => void action.run(match)}
                >
                  match the next records
                </button>
              )}
              <details className="transfer__details">
                <summary>account planning preferences</summary>
                <p>
                  current {preview.preferences.current.planningZone} · week starts{' '}
                  {preview.preferences.current.weekStart === 1 ? 'monday' : 'sunday'}
                </p>
                <p>
                  incoming {preview.preferences.incoming.planningZone} · week starts{' '}
                  {preview.preferences.incoming.weekStart === 1 ? 'monday' : 'sunday'}
                </p>
                <label className="transfer__check">
                  <input
                    type="checkbox"
                    checked={preview.preferences.selected}
                    disabled={!editable}
                    onChange={(event) => {
                      const selected = event.target.checked;
                      void action.run(async (signal) => {
                        const value = await request(`${base}/preferences`, ArchivePreviewSchema, {
                          method: 'POST',
                          body: { selected },
                          signal,
                        });
                        setPreview(value);
                        setArchive(value.archive);
                        setAcknowledged(false);
                      });
                    }}
                  />
                  select incoming planning preferences
                </label>
              </details>
            </>
          )}
          <div className="transfer__records">
            {page?.items.map((row) => {
              if (!row.value)
                return (
                  <article key={row.position}>
                    <p>
                      record {row.position + 1} keeps its retained receipt; the original source body
                      is no longer available.
                    </p>
                    <small>{row.restoreState}</small>
                  </article>
                );
              const value = row.value,
                match = row.match,
                selected = drafts[value.key] ?? {
                  fields: row.fields ?? match?.defaultIncomingFields ?? [],
                  acceptOmittedReferences: row.acceptOmittedReferences ?? false,
                };
              return (
                <article key={value.key}>
                  <div className="transfer__section-title">
                    <h4>
                      {value.kind.replaceAll('_', ' ')} ·{' '}
                      {'title' in value ? value.title : 'name' in value ? value.name : value.key}
                    </h4>
                    <small>
                      {match?.status ?? 'not checked'} · {row.restoreState}
                    </small>
                  </div>
                  {match && (
                    <>
                      <p>{match.message}</p>
                      {match.status === 'unmatched' && (
                        <p>this record stays skipped. snapshot copy is a separate explicit mode.</p>
                      )}
                      {match.fields.map((field) => {
                        const blocked = match.blockedFields[field],
                          canOmit =
                            field === 'dependencies' && Boolean(match.missingDependencyCount);
                        return (
                          <div key={field} className="transfer__archive-field">
                            <label className="transfer__check">
                              <input
                                type="checkbox"
                                checked={selected.fields.includes(field)}
                                disabled={
                                  !editable ||
                                  Boolean(blocked && !(canOmit && selected.acceptOmittedReferences))
                                }
                                onChange={(event) => {
                                  setDrafts((prior) => ({
                                    ...prior,
                                    [value.key]: {
                                      ...selected,
                                      fields: event.target.checked
                                        ? [...selected.fields, field]
                                        : selected.fields.filter((value) => value !== field),
                                    },
                                  }));
                                  setAcknowledged(false);
                                }}
                              />
                              use incoming {field}
                            </label>
                            {blocked && <p className="transfer__warning">{blocked}</p>}
                            {canOmit && (
                              <label className="transfer__check">
                                <input
                                  type="checkbox"
                                  checked={selected.acceptOmittedReferences}
                                  disabled={!editable}
                                  onChange={(event) => {
                                    const accept = event.target.checked;
                                    setDrafts((prior) => ({
                                      ...prior,
                                      [value.key]: {
                                        acceptOmittedReferences: accept,
                                        fields: accept
                                          ? selected.fields
                                          : selected.fields.filter(
                                              (value) => value !== 'dependencies',
                                            ),
                                      },
                                    }));
                                    setAcknowledged(false);
                                  }}
                                />
                                accept omitting {match.missingDependencyCount} unmatched dependency
                                references
                              </label>
                            )}
                            {match.changes[field] && (
                              <details>
                                <summary>compare current and incoming {field}</summary>
                                <div className="transfer__compare">
                                  <div>
                                    <small>current</small>
                                    <pre>
                                      {JSON.stringify(match.changes[field]!.current, null, 2)}
                                    </pre>
                                  </div>
                                  <div>
                                    <small>incoming</small>
                                    <pre>
                                      {JSON.stringify(match.changes[field]!.incoming, null, 2)}
                                    </pre>
                                  </div>
                                </div>
                              </details>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}
                </article>
              );
            })}
          </div>
          <div className="transfer__actions">
            {priorPages.length > 0 && (
              <button
                type="button"
                disabled={action.busy || Object.keys(drafts).length > 0}
                onClick={() =>
                  void action.run(async (signal) => {
                    const previous = priorPages.at(-1)!;
                    setPriorPages((prior) => prior.slice(0, -1));
                    await loadPage(signal, previous);
                  })
                }
              >
                previous records
              </button>
            )}
            {page?.nextCursor !== null && page?.nextCursor !== undefined && (
              <button
                type="button"
                disabled={action.busy || Object.keys(drafts).length > 0}
                onClick={() =>
                  void action.run(async (signal) => {
                    setPriorPages((prior) => [...prior, after]);
                    await loadPage(signal, page.nextCursor!);
                  })
                }
              >
                next records
              </button>
            )}
            {Object.keys(drafts).length > 0 && (
              <>
                <button type="button" disabled={action.busy} onClick={() => setDrafts({})}>
                  discard unsaved field choices
                </button>
                <button
                  type="button"
                  className="transfer__primary"
                  disabled={action.busy}
                  onClick={() => void action.run(saveChoices)}
                >
                  save explicit field choices
                </button>
              </>
            )}
          </div>
          <p>
            current values are preserved by default. new templates restore as reusable data;
            schedules restore paused. history keeps its original identity/time and normal 90-day
            retention.
          </p>
          {archive.state === 'preview' && (
            <label className="transfer__check">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              restore only the saved selections; skip unmatched records and preserve google content
            </label>
          )}
          {['preview', 'restoring'].includes(archive.state) && (
            <button
              type="button"
              className="transfer__primary"
              disabled={
                action.busy ||
                !writable(props.account) ||
                Object.keys(drafts).length > 0 ||
                (archive.state === 'preview' &&
                  (!acknowledged || !preview || preview.pendingMatches > 0)) ||
                !['preview', 'restoring'].includes(archive.state)
              }
              onClick={() => void action.run(restore)}
            >
              {archive.paused
                ? 'resume saved restoration'
                : archive.state === 'restoring'
                  ? 'continue saved restoration'
                  : 'confirm metadata restore'}
            </button>
          )}
        </>
      )}
      <div className="transfer__actions">
        {archive.paused && archive.mode === 'copy_task_snapshots' && (
          <button
            type="button"
            disabled={action.busy || !writable(props.account)}
            onClick={() =>
              void action.run(async (signal) =>
                setArchive(
                  await request(`${base}/resume`, ArchiveSummarySchema, {
                    method: 'POST',
                    body: {},
                    signal,
                  }),
                ),
              )
            }
          >
            resume retained archive
          </button>
        )}
        <button
          type="button"
          disabled={action.busy || Object.keys(drafts).length > 0}
          onClick={() =>
            void action.run(async (signal) => {
              await refresh(signal);
              await loadPage(signal);
            })
          }
        >
          refresh retained state
        </button>
      </div>
      {!['finished', 'cancelled'].includes(archive.state) && (
        <details className="transfer__details">
          <summary>stop this restoration</summary>
          <p>
            already applied metadata remains. cancelling stops unsent remaining work and never rolls
            back provider content.
          </p>
          <label className="transfer__check">
            <input
              type="checkbox"
              checked={cancel}
              onChange={(event) => setCancel(event.target.checked)}
            />
            keep applied values and cancel remaining restoration
          </label>
          <button
            className="transfer__danger"
            type="button"
            disabled={action.busy || !cancel || !writable(props.account)}
            onClick={() =>
              void action.run(async (signal) => {
                setArchive(
                  await request(`${base}/cancel`, ArchiveSummarySchema, {
                    method: 'POST',
                    body: {},
                    signal,
                  }),
                );
                props.onChanged?.();
              })
            }
          >
            cancel remaining work
          </button>
        </details>
      )}
      <TransferError>{action.error}</TransferError>
    </section>
  );
}
