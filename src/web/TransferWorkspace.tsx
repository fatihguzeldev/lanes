import { useState } from 'react';
import {
  ArchiveExportSummarySchema,
  type ArchiveExportSummary,
} from '../modules/transfer/archive-export-contract';
import { TransferArchiveExport } from './TransferArchiveExport';
import {
  SheetsExportSummarySchema,
  type SheetsExportSummary,
} from '../modules/transfer/export-contract';
import {
  ArchiveSummarySchema,
  ImportSummarySchema,
  transferPage,
  type ImportSummary,
} from './transfer-schemas';
import { request } from '../client/http';
import { usePagedResource } from '../client/usePagedResource';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { TransferImport } from './TransferImport';
import { TransferImportRun } from './TransferImportRun';
import { TransferExport } from './TransferExport';
import { TransferAccounts } from './TransferAccounts';
import { ArchiveImport, ArchiveRestorePanel, TransferArchive } from './TransferArchive';
import { TransferSheetsExport } from './TransferSheetsExport';
import {
  pageQuery,
  transferBase,
  TransferConnection,
  TransferPages,
  type TransferProps,
} from './TransferCommon';
import type { z } from 'zod';
import { Select } from '../ui/Select';
import './TransferWorkspace.css';
export type TransferWorkspaceProps = TransferProps;
type Tab = 'import' | 'export' | 'accounts' | 'archive' | 'activity';
export function TransferWorkspace(props: TransferWorkspaceProps) {
  return <TransferBody key={props.account.id} {...props} />;
}
function TransferBody(props: TransferProps) {
  const [tab, setTab] = useState<Tab>(props.initialTab ?? 'import'),
    [dirty, setDirty] = useState(false),
    [nextTab, setNextTab] = useState<Tab | null>(null);
  const dirtyChanged = (value: boolean) => {
    setDirty(value);
    props.onDirtyChange?.(value);
  };
  const children = { ...props, onDirtyChange: dirtyChanged };
  return (
    <section className="transfer" aria-label="import, export and transfer">
      <header className="transfer__heading">
        <span className="transfer__eyebrow">your work can move with you</span>
        <h2>bring it along</h2>
        <p>{props.account.email}</p>
      </header>
      <nav className="transfer__tabs" aria-label="portability views">
        {(['import', 'export', 'accounts', 'archive', 'activity'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={value === tab}
            onClick={() => {
              if (value === tab) return;
              if (dirty) setNextTab(value);
              else setTab(value);
            }}
          >
            {value === 'accounts' ? 'account copy' : value}
          </button>
        ))}
      </nav>
      <TransferConnection />
      {tab === 'import' && <TransferImport {...children} />}{' '}
      {tab === 'export' && <TransferExport {...children} />}{' '}
      {tab === 'accounts' && <TransferAccounts {...children} />}{' '}
      {tab === 'archive' && <TransferArchive {...children} />}{' '}
      {tab === 'activity' && <TransferActivity {...children} />}
      {nextTab && (
        <Dialog title="leave this editor?" onClose={() => setNextTab(null)}>
          <div className="dialog__body">
            <p>
              unsent local drafts will be discarded. captured operations stay saved; leaving does
              not cancel admitted work. inspect retained output before starting another copy.
            </p>
            <footer>
              <button type="button" onClick={() => setNextTab(null)}>
                keep editing
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setTab(nextTab);
                  setNextTab(null);
                  dirtyChanged(false);
                }}
              >
                leave editor
              </button>
            </footer>
          </div>
        </Dialog>
      )}
    </section>
  );
}
function TransferActivity(props: TransferProps) {
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
