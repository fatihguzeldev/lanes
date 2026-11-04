import { useState } from 'react';
import {
  ArchiveExportSummarySchema,
  type ArchiveExportSummary,
} from '../../contracts/archive-export';
import { TransferArchiveExport } from '../archives/TransferArchiveExport';
import { SheetsExportSummarySchema, type SheetsExportSummary } from '../../contracts/export';
import {
  ArchiveSummarySchema,
  ImportSummarySchema,
  transferPage,
  type ImportSummary,
} from '../protocol/response-contracts';
import { request } from '../../../../shared/browser/http/http';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { TransferImportRun } from '../imports/TransferImportRun';
import { ArchiveImport } from '../archives/ArchiveImport';
import { ArchiveRestorePanel } from '../archives/ArchiveRestorePanel';
import { TransferSheetsExport } from '../sheets/TransferSheetsExport';
import { pageQuery, transferBase, type TransferProps } from './transfer-context';
import { TransferPages } from './TransferFeedback';
import type { z } from 'zod';
import { Select } from '../../../../shared/ui/select/Select';
export function TransferActivity(props: TransferProps) {
  const [dirty, setDirty] = useState(false),
    [confirmBack, setConfirmBack] = useState(false);
  const childProps = {
    ...props,
    onDirtyChange: (value: boolean) => {
      setDirty(value);
      props.onDirtyChange?.(value);
    },
  };
  const [kind, setKind] = useState<'imports' | 'archives' | 'sheets' | 'archive_exports'>(
      'imports',
    ),
    [selection, setSelection] = useState<
      | { kind: 'import'; run: ImportSummary }
      | { kind: 'archive'; archive: z.infer<typeof ArchiveSummarySchema> }
      | { kind: 'sheets'; run: SheetsExportSummary }
      | { kind: 'archive_export'; run: ArchiveExportSummary }
      | null
    >(null);
  const base = transferBase(props.account.id);
  const imports = usePagedResource(
    kind === 'imports' ? `${props.account.id}:imports` : null,
    (cursor, signal) =>
      request(`${base}/imports${pageQuery(cursor)}`, transferPage(ImportSummarySchema), { signal }),
    (item) => item.id,
    props.version ?? 0,
  );
  const archives = usePagedResource(
    kind === 'archives' ? `${props.account.id}:archives` : null,
    (cursor, signal) =>
      request(`${base}/archives${pageQuery(cursor)}`, transferPage(ArchiveSummarySchema), {
        signal,
      }),
    (item) => item.id,
    props.version ?? 0,
  );
  const sheets = usePagedResource(
    kind === 'sheets' ? `${props.account.id}:sheets-exports` : null,
    (cursor, signal) =>
      request(
        `${base}/exports/sheets${pageQuery(cursor)}`,
        transferPage(SheetsExportSummarySchema),
        { signal },
      ),
    (item) => item.id,
    props.version ?? 0,
  );
  const archiveExports = usePagedResource(
    kind === 'archive_exports' ? `${props.account.id}:archive-exports` : null,
    (cursor, signal) =>
      request(
        `${base}/archives/exports${pageQuery(cursor)}`,
        transferPage(ArchiveExportSummarySchema),
        { signal },
      ),
    (item) => item.id,
    props.version ?? 0,
  );
  if (selection)
    return (
      <>
        <button
          type="button"
          className="transfer__text"
          onClick={() => {
            if (dirty) setConfirmBack(true);
            else setSelection(null);
          }}
        >
          <Icon name="left" size={12} />
          back to retained work
        </button>
        {selection.kind === 'import' && (
          <TransferImportRun key={selection.run.id} {...childProps} run={selection.run} />
        )}{' '}
        {selection.kind === 'archive' &&
          (selection.archive.state === 'staging' ? (
            <ArchiveImport {...childProps} retained={selection.archive} />
          ) : (
            <ArchiveRestorePanel {...childProps} archive={selection.archive} />
          ))}{' '}
        {selection.kind === 'archive_export' && (
          <TransferArchiveExport {...childProps} retained={selection.run} />
        )}{' '}
        {selection.kind === 'sheets' && (
          <TransferSheetsExport
            account={props.account}
            clockOffset={props.clockOffset}
            initialRun={selection.run}
            {...(props.onChanged ? { onChanged: props.onChanged } : {})}
            {...(props.onOpenOperation ? { onOpenOperation: props.onOpenOperation } : {})}
            {...{ onDirtyChange: childProps.onDirtyChange }}
          />
        )}
        {confirmBack && (
          <Dialog title="leave these changes?" onClose={() => setConfirmBack(false)}>
            <div className="dialog__body">
              <p>
                unsaved choices will be discarded. captured work stays retained and is not
                cancelled.
              </p>
              <footer>
                <button type="button" onClick={() => setConfirmBack(false)}>
                  keep editing
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    setSelection(null);
                    setConfirmBack(false);
                    setDirty(false);
                    props.onDirtyChange?.(false);
                  }}
                >
                  leave editor
                </button>
              </footer>
            </div>
          </Dialog>
        )}
      </>
    );
  const resource =
    kind === 'imports'
      ? imports
      : kind === 'archives'
        ? archives
        : kind === 'archive_exports'
          ? archiveExports
          : sheets;
  return (
    <div className="transfer__form">
      <p>
        continue the captured operation. a new import or export is a separate action and may create
        another copy.
      </p>
      <label>
        retained work
        <Select
          value={kind}
          onChange={(selectedValue) => setKind(selectedValue as typeof kind)}
          aria-label="retained work"
          options={[
            { value: 'imports', label: 'task imports and account copies' },
            { value: 'archives', label: 'workspace archive restores' },
            { value: 'sheets', label: 'google sheets exports' },
            { value: 'archive_exports', label: 'workspace archive exports' },
          ]}
        />
      </label>
      <div className="transfer__activity">
        {kind === 'imports' &&
          imports.items.map((run) => (
            <article key={run.id}>
              <div>
                <strong>
                  {run.source.kind === 'file' || run.source.kind === 'archive'
                    ? run.source.name
                    : run.source.kind === 'account'
                      ? 'account copy'
                      : 'sheets import'}
                </strong>
                <p>
                  {run.state} · {run.totalLists} lists · {run.totalTasks} tasks · {run.createdAt}
                </p>
              </div>
              <button type="button" onClick={() => setSelection({ kind: 'import', run })}>
                inspect
              </button>
            </article>
          ))}
        {kind === 'archives' &&
          archives.items.map((archive) => (
            <article key={archive.id}>
              <div>
                <strong>{archive.header.source.email}</strong>
                <p>
                  {archive.mode === 'restore_metadata' ? 'metadata restore' : 'snapshot copy'} ·{' '}
                  {archive.state} · {archive.recordCount} records
                </p>
              </div>
              <button type="button" onClick={() => setSelection({ kind: 'archive', archive })}>
                inspect
              </button>
            </article>
          ))}
        {kind === 'archive_exports' &&
          archiveExports.items.map((run) => (
            <article key={run.id}>
              <div>
                <strong>private workspace archive</strong>
                <p>
                  {run.state} · {run.recordCount} records · {(run.bytes / 1024).toFixed(0)} kib
                </p>
              </div>
              <button type="button" onClick={() => setSelection({ kind: 'archive_export', run })}>
                inspect
              </button>
            </article>
          ))}
        {kind === 'sheets' &&
          sheets.items.map((run) => (
            <article key={run.id}>
              <div>
                <strong>spreadsheet export</strong>
                <p>
                  {run.state} · {run.confirmedRows} of {run.totalRows} rows confirmed
                </p>
              </div>
              <button type="button" onClick={() => setSelection({ kind: 'sheets', run })}>
                inspect
              </button>
            </article>
          ))}
      </div>
      {resource.loaded && !resource.items.length && (
        <p className="transfer__quiet">no retained work in this category.</p>
      )}
      <TransferPages resource={resource} />
    </div>
  );
}
