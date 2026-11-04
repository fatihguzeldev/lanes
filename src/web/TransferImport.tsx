import { useRef, useState } from 'react';
import { z } from 'zod';
import { parseFileInWorker } from '../modules/transfer/parser-client';
import {
  importFields,
  MAX_IMPORT_EXPANDED_BYTES,
  type ImportField,
  type ImportMapping,
  type ImportOptions,
  type ImportPreview,
  type ImportTable,
} from '../modules/transfer/parse-contract';
import {
  SpreadsheetMetadataSchema,
  type SpreadsheetMetadata,
} from '../modules/transfer/sheets-contract';
import { request } from '../client/http';
import { newOperationId } from '../client/operation-identity';
import {
  boundedBatches,
  clearSheetsDraft,
  parseExcludedRows,
  parseTransferInWorker,
  readSheetsDraft,
  sheetRangePages,
  writeSheetsDraft,
} from './transfer-client';
import { ImportSummarySchema, ImportTableSchema, type ImportSummary } from './transfer-schemas';
import {
  AccountChoice,
  DestinationChoice,
  destinationValue,
  escaped,
  providerReady,
  sheetsConsent,
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
import { Select } from '../ui/Select';
type Source = 'file' | 'sheets';
interface MappingDraft {
  sheet: string;
  fields: ImportMapping;
  headerRow: number;
  excluded: string;
}
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
export function TransferImport(props: TransferProps) {
  const { account, accounts, clockOffset, onChanged, onDirtyChange } = props;
  const restored = useRef(
    readSheetsDraft(
      account.id,
      accounts.map((value) => value.id),
    ),
  ).current;
  const returnedSource = new URLSearchParams(location.search).get('source');
  const validReturnedSource =
    returnedSource && accounts.some((value) => value.id === returnedSource) ? returnedSource : null;
  const [source, setSource] = useState<Source>(restored || validReturnedSource ? 'sheets' : 'file'),
    [sourceAccountId, setSourceAccountId] = useState(
      restored?.sourceAccountId ?? validReturnedSource ?? account.id,
    ),
    [file, setFile] = useState<File | null>(null),
    [spreadsheet, setSpreadsheet] = useState(restored?.spreadsheet ?? ''),
    [metadata, setMetadata] = useState<SpreadsheetMetadata | null>(null),
    [sheetRanges, setSheetRanges] = useState<Record<string, string>>(restored?.ranges ?? {}),
    [selectedSheets, setSelectedSheets] = useState<string[]>(restored?.selectedSheets ?? []);
  const [selectionText, setSelectionText] = useState(''),
    [manualExclusions, setManualExclusions] = useState(''),
    [issueLimit, setIssueLimit] = useState(100),
    [headerRow, setHeaderRow] = useState(1),
    [mapping, setMapping] = useState<MappingDraft[]>([]),
    [convention, setConvention] = useState<'iso' | 'day-first' | 'month-first'>('iso'),
    [groupBy, setGroupBy] = useState<'auto' | 'sheet' | 'list-column' | 'single'>('auto'),
    [listName, setListName] = useState('imported tasks'),
    [skipCompleted, setSkipCompleted] = useState(false),
    [destinationKind, setDestinationKind] = useState<'new' | 'existing'>('new'),
    [listId, setListId] = useState('');
  const [draftRevision, setDraftRevision] = useState(0),
    [preview, setPreview] = useState<{ value: ImportPreview; revision: number } | null>(null),
    [run, setRun] = useState<ImportSummary | null>(null),
    [uploadProgress, setUploadProgress] = useState('');
  const attempt = useRef<{
      id: string;
      manifest: unknown;
      chunks: ReturnType<typeof importChunk>[];
      nextChunk: number;
    } | null>(null),
    destination = useBoardLists(account.id, props.version),
    action = useTransferAction(account.id),
    tableCache = useRef<ImportTable[] | null>(null);
  const sourceAccount = accounts.find((item) => item.id === sourceAccountId),
    current = preview?.revision === draftRevision ? preview.value : null,
    frozen = Boolean(attempt.current),
    changed = () => {
      setDraftRevision((value) => value + 1);
    };
  useTransferDirty(
    Boolean(!run && (file || spreadsheet || selectionText || manualExclusions || frozen)),
    onDirtyChange,
  );
  const options = (): ImportOptions => ({
    headerRow,
    dateConvention: convention,
    ...(groupBy === 'auto' ? {} : { groupBy }),
    singleListTitle: listName,
    destination: destinationKind,
    skipCompleted,
    ...(mapping.length
      ? {
          mappingBySheet: mapping.map((item) => ({
            sheet: item.sheet,
            fields: item.fields,
            headerRow: item.headerRow,
          })),
          excludedRows: mapping.map((item) => ({
            sheet: item.sheet,
            rows: parseExcludedRows(item.excluded),
          })),
        }
      : {}),
    ...(manualExclusions.trim()
      ? {
          excludedRows: [
            ...mapping.map((item) => ({
              sheet: item.sheet,
              rows: parseExcludedRows(item.excluded),
            })),
            ...manualExclusions
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean)
              .map((value) => {
                const colon = value.lastIndexOf(':');
                if (colon < 1) throw new Error('use one sheet name: 2, 4-8 exclusion per line.');
                return {
                  sheet: value.slice(0, colon).trim(),
                  rows: parseExcludedRows(value.slice(colon + 1)),
                };
              }),
          ],
        }
      : {}),
    ...(selectionText.trim() && source === 'file'
      ? {
          selections: selectionText
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean)
            .map((value) => {
              const delimiter = value.lastIndexOf('!');
              return delimiter < 0
                ? { sheet: value }
                : { sheet: value.slice(0, delimiter), range: value.slice(delimiter + 1) };
            }),
        }
      : {}),
  });
  async function readSheetTables(signal: AbortSignal) {
    if (
      !sourceAccount ||
      !sourceAccount.permissions.sheetsImport ||
      sourceAccount.state !== 'connected'
    )
      throw new Error('authorize sheets read access for the selected source account first.');
    if (!selectedSheets.length) throw new Error('select at least one tab and explicit range.');
    const requestCount = selectedSheets.reduce(
      (sum, sheet) => sum + sheetRangePages(sheetRanges[sheet] ?? '').length,
      0,
    );
    if (requestCount > 1000)
      throw new Error(
        'these ranges require more than 1,000 bounded reads. choose smaller explicit ranges before previewing.',
      );
    const tables: ImportTable[] = [];
    let selectedBytes = 0;
    for (const sheet of selectedSheets) {
      const range = sheetRanges[sheet] ?? '',
        pages = sheetRangePages(range);
      let combined: ImportTable | null = null;
      for (const page of pages) {
        setUploadProgress(`reading ${sheet} · ${page}`);
        const value = (await request(
          `${transferBase(sourceAccountId)}/sheets/range`,
          ImportTableSchema,
          {
            method: 'POST',
            body: { spreadsheetId: metadata?.id ?? spreadsheet, sheet, range: page },
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
    tableCache.current = tables;
    return tables;
  }
  async function parse(signal: AbortSignal) {
    const revision = draftRevision,
      settings = options();
    setUploadProgress('reading selected values…');
    let value: ImportPreview;
    if (source === 'file') {
      if (!file) throw new Error('select a supported local file.');
      value = await parseFileInWorker(file, settings, { signal, timeoutMs: 30000 });
    } else {
      const tables = tableCache.current ?? (await readSheetTables(signal));
      value = await parseTransferInWorker({ kind: 'tables', tables, options: settings }, signal);
    }
    if (!signal.aborted) {
      setPreview({ value, revision });
      setIssueLimit(100);
      setMapping(
        value.mapping.map((item) => ({
          ...item,
          excluded: mapping.find((draft) => draft.sheet === item.sheet)?.excluded ?? '',
        })),
      );
      setUploadProgress('');
    }
  }
  async function stage(signal: AbortSignal) {
    if (!attempt.current) {
      if (!current) throw new Error('preview the current source and mappings first.');
      if (current.issues.some((issue) => issue.severity === 'error'))
        throw new Error(
          'correct mappings or explicitly exclude the error rows, then preview again.',
        );
      const sourceValue =
        source === 'file'
          ? { kind: 'file', name: file!.name, format: current.format }
          : {
              kind: 'sheets',
              accountId: sourceAccountId,
              spreadsheetId: metadata!.id,
              ranges: selectedSheets.map((sheet) => ({ sheet, range: sheetRanges[sheet] ?? '' })),
            };
      const id = newOperationId(clockOffset),
        records: StagedRecord[] = [
          ...current.lists.map((value, position) => ({ kind: 'lists' as const, position, value })),
          ...current.tasks.map((value, position) => ({ kind: 'tasks' as const, position, value })),
          ...current.issues.map((value, position) => ({
            kind: 'issues' as const,
            position,
            value,
          })),
        ];
      const manifest = {
        id,
        source: sourceValue,
        destination: destinationValue(destination, destinationKind, listId),
        totalLists: current.lists.length,
        totalTasks: current.tasks.length,
        issueCount: current.issues.length,
        mapping: current.mapping,
        skippedBlankRows: current.skippedBlankRows,
        skippedCompletedTasks: current.skippedCompletedTasks,
        parentContextCount: current.parentContextCount,
      };
      if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > 65536)
        throw new Error(
          'the selected source and mapping header exceeds 64 kib. choose fewer tables or a smaller mapping before capture.',
        );
      attempt.current = {
        id,
        manifest,
        chunks: [...boundedBatches(records, importChunk)].map(importChunk),
        nextChunk: 0,
      };
    }
    const capture = attempt.current,
      base = `${transferBase(account.id)}/imports`,
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
      setUploadProgress(
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
        setUploadProgress(
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
      setRun(summary);
      setUploadProgress('');
      clearSheetsDraft(account.id);
      onChanged?.();
    }
  }
  if (run) return <TransferImportRun {...props} run={run} />;
  return (
    <section className="transfer__form">
      <TransferConnection />
      <p>
        preview a file or selected spreadsheet values. nothing is created in google until you
        confirm the frozen plan.
      </p>
      <fieldset disabled={action.busy || frozen || !writable(account)}>
        <div className="transfer__segmented">
          {(['file', 'sheets'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={source === value}
              onClick={() => {
                setSource(value);
                setPreview(null);
                setMapping([]);
                tableCache.current = null;
                changed();
              }}
            >
              {value === 'file' ? 'local file' : 'google sheets'}
            </button>
          ))}
        </div>
        {source === 'file' ? (
          <>
            <label>
              source file
              <input
                type="file"
                accept=".csv,.tsv,.xlsx,.xls,.ods,.numbers,.txt,.md,.json"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setMapping([]);
                  setPreview(null);
                  changed();
                }}
              />
            </label>
            <p>
              csv, tsv, xlsx, xls, ods, numbers, text, markdown or google takeout Tasks.json · up to
              20 mib. complex files are parsed in a separate browser worker.
            </p>
            <details className="transfer__details">
              <summary>select workbook tables or ranges before reading</summary>
              <label>
                one sheet name or sheet!A1:Q2000 per line
                <textarea
                  value={selectionText}
                  rows={3}
                  onChange={(event) => {
                    setSelectionText(event.target.value);
                    setMapping([]);
                    changed();
                  }}
                />
              </label>
              <p>
                leave this blank to read all supported tables. choose a smaller explicit selection
                if the source exceeds 2,000 tasks or 100 lists.
              </p>
            </details>
          </>
        ) : (
          <>
            <AccountChoice
              accounts={accounts}
              value={sourceAccountId}
              onChange={(value) => {
                setSourceAccountId(value);
                setMetadata(null);
                setSelectedSheets([]);
                setMapping([]);
                tableCache.current = null;
                changed();
              }}
              label="google account reading the spreadsheet"
            />
            <details className="transfer__details" open={!sourceAccount?.permissions.sheetsImport}>
              <summary>
                {sourceAccount?.permissions.sheetsImport
                  ? 'manage optional sheets read permission'
                  : 'authorize optional sheets read permission'}
              </summary>
              <p>
                optional sheets read permission can read this account's spreadsheets. lanes requests
                only your selected spreadsheet and ranges; google does not limit this grant to one
                file. declining leaves tasks access unchanged.
              </p>
              <button
                type="button"
                onClick={() =>
                  void action.run(async (signal) => {
                    writeSheetsDraft(account.id, {
                      sourceAccountId,
                      spreadsheet,
                      selectedSheets,
                      ranges: sheetRanges,
                    });
                    await sheetsConsent(sourceAccountId, 'sheets_import', signal, account.id);
                  })
                }
              >
                {sourceAccount?.permissions.sheetsImport
                  ? 'renew sheets import permission'
                  : 'authorize sheets import'}
              </button>
            </details>
            <label>
              spreadsheet url or id
              <input
                value={spreadsheet}
                onChange={(event) => {
                  setSpreadsheet(event.target.value);
                  setMetadata(null);
                  tableCache.current = null;
                  changed();
                }}
              />
            </label>
            <button
              type="button"
              className="transfer__secondary"
              disabled={
                !sourceAccount?.permissions.sheetsImport ||
                sourceAccount?.state !== 'connected' ||
                !spreadsheet
              }
              onClick={() =>
                void action.run(async (signal) => {
                  const value = await request(
                    `${transferBase(sourceAccountId)}/sheets/metadata`,
                    SpreadsheetMetadataSchema,
                    { method: 'POST', body: { spreadsheetId: spreadsheet }, signal },
                  );
                  setMetadata(value);
                  setSelectedSheets((prior) =>
                    prior.filter((name) => value.sheets.some((sheet) => sheet.title === name)),
                  );
                  tableCache.current = null;
                })
              }
            >
              read tab names
            </button>
            {metadata && (
              <div className="transfer__preview">
                <h3>{metadata.title}</h3>
                <p>
                  {metadata.timeZone ?? 'no spreadsheet zone supplied'} · select up to 100 tabs, at
                  most 10,000 rows and 256 columns per selected range.
                </p>
                {metadata.sheets.map((sheet) => (
                  <div className="transfer__sheet" key={sheet.id}>
                    <label className="transfer__check">
                      <input
                        type="checkbox"
                        checked={selectedSheets.includes(sheet.title)}
                        disabled={
                          !selectedSheets.includes(sheet.title) && selectedSheets.length >= 100
                        }
                        onChange={(event) => {
                          setSelectedSheets((prior) =>
                            event.target.checked
                              ? [...prior, sheet.title]
                              : prior.filter((value) => value !== sheet.title),
                          );
                          tableCache.current = null;
                          setMapping([]);
                          changed();
                        }}
                      />
                      {sheet.title}
                    </label>
                    {selectedSheets.includes(sheet.title) && (
                      <label>
                        range for {sheet.title}
                        <input
                          value={sheetRanges[sheet.title] ?? ''}
                          placeholder="A1:Q1000"
                          onChange={(event) => {
                            setSheetRanges((prior) => ({
                              ...prior,
                              [sheet.title]: event.target.value,
                            }));
                            tableCache.current = null;
                            setMapping([]);
                            changed();
                          }}
                        />
                      </label>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <DestinationChoice
          resource={destination}
          kind={destinationKind}
          setKind={(value) => {
            setDestinationKind(value);
            changed();
          }}
          listId={listId}
          setListId={(value) => {
            setListId(value);
            changed();
          }}
          disabled={action.busy || frozen}
        />
        <div className="transfer__two">
          <label>
            group new lists by
            <Select
              value={groupBy}
              disabled={destinationKind === 'existing'}
              onChange={(selectedValue) => {
                setGroupBy(selectedValue as typeof groupBy);
                changed();
              }}
              aria-label="group new lists by"
              options={[
                { value: 'auto', label: 'detected list column, otherwise worksheet' },
                { value: 'sheet', label: 'worksheet / text heading' },
                { value: 'list-column', label: 'mapped list column' },
                { value: 'single', label: 'one new list' },
              ]}
            />
          </label>
          <label>
            dates
            <Select
              value={convention}
              onChange={(selectedValue) => {
                setConvention(selectedValue as typeof convention);
                changed();
              }}
              aria-label="dates"
              options={[
                { value: 'iso', label: 'iso dates only' },
                { value: 'day-first', label: 'day / month / year' },
                { value: 'month-first', label: 'month / day / year' },
              ]}
            />
          </label>
        </div>
        {groupBy === 'single' && destinationKind === 'new' && (
          <label>
            new list title
            <input
              value={listName}
              onChange={(event) => {
                setListName(event.target.value);
                changed();
              }}
            />
          </label>
        )}
        <details className="transfer__details">
          <summary>exclude source rows before preview</summary>
          <label>
            one sheet name: 2, 4-8 per line
            <textarea
              rows={3}
              value={manualExclusions}
              onChange={(event) => {
                setManualExclusions(event.target.value);
                changed();
              }}
            />
          </label>
          <p>
            these rows are explicitly excluded before normalization. for csv/tsv, the table name is
            the filename without its extension
            {file ? ` · ${file.name.replace(/\.[^.]+$/, '')}` : ''}.
          </p>
        </details>
        <label>
          default header row
          <input
            type="number"
            min={1}
            max={10000}
            value={headerRow}
            onChange={(event) => {
              setHeaderRow(Number(event.target.value));
              setMapping([]);
              changed();
            }}
          />
        </label>
        <label className="transfer__check">
          <input
            type="checkbox"
            checked={skipCompleted}
            onChange={(event) => {
              setSkipCompleted(event.target.checked);
              changed();
            }}
          />
          skip completed tasks; include a completed parent as open context if an open child needs it
        </label>
      </fieldset>
      {mapping.length > 0 && (
        <details className="transfer__details">
          <summary>field mappings and excluded rows</summary>
          <p>
            the title mapping is required. correct an invalid field or explicitly exclude its source
            row, then preview again.
          </p>
          {mapping.map((table, index) => {
            const columns =
              preview?.value.columns?.find((value) => value.sheet === table.sheet)?.headers ?? [];
            return (
              <fieldset key={table.sheet} disabled={frozen || action.busy}>
                <legend>{table.sheet}</legend>
                <label>
                  header row in this selected table
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={table.headerRow}
                    onChange={(event) => {
                      setMapping((prior) =>
                        prior.map((item, position) =>
                          position === index
                            ? { ...item, headerRow: Number(event.target.value) }
                            : item,
                        ),
                      );
                      changed();
                    }}
                  />
                </label>
                <div className="transfer__mapping">
                  {importFields.map((field) => (
                    <label key={field}>
                      {field.replaceAll('_', ' ')}
                      <Select
                        value={String(table.fields[field] ?? '')}
                        onChange={(selectedValue) => {
                          const value = selectedValue;
                          setMapping((prior) =>
                            prior.map((item, position) => {
                              if (position !== index) return item;
                              const fields = { ...item.fields };
                              if (value === '') delete fields[field];
                              else fields[field] = Number(value);
                              return { ...item, fields };
                            }),
                          );
                          changed();
                        }}
                        aria-label={field.replaceAll('_', ' ')}
                        options={[
                          {
                            value: '',
                            label: field === 'task' ? 'required · choose a column' : 'not mapped',
                          },
                          ...Array.from(
                            {
                              length: Math.max(
                                columns.length,
                                ...Object.values(table.fields).map((value) => (value ?? 0) + 1),
                                26,
                              ),
                            },
                            (_, column) => ({
                              value: String(column),
                              label: `${column + 1} · ${columns[column] || `column ${column + 1}`}`,
                            }),
                          ),
                        ]}
                      />
                    </label>
                  ))}
                </div>
                <label>
                  exclude source rows · e.g. 3, 8-10
                  <input
                    value={table.excluded}
                    onChange={(event) => {
                      setMapping((prior) =>
                        prior.map((item, position) =>
                          position === index ? { ...item, excluded: event.target.value } : item,
                        ),
                      );
                      changed();
                    }}
                  />
                </label>
              </fieldset>
            );
          })}
        </details>
      )}
      <div className="transfer__actions">
        <button
          type="button"
          className="transfer__secondary"
          disabled={action.busy || frozen || (source === 'sheets' && !metadata)}
          onClick={() => void action.run(parse)}
        >
          preview selected values
        </button>
        {current && (
          <button
            type="button"
            className="transfer__primary"
            disabled={action.busy || current.issues.some((issue) => issue.severity === 'error')}
            onClick={() => void action.run(stage)}
          >
            freeze this preview
          </button>
        )}
        {frozen && (
          <button
            type="button"
            className="transfer__primary"
            disabled={action.busy}
            onClick={() => void action.run(stage)}
          >
            continue the same capture
          </button>
        )}
      </div>
      {uploadProgress && <p role="status">{uploadProgress}</p>}
      {preview && (
        <div className="transfer__preview">
          <div className="transfer__numbers">
            <span>
              <strong>{preview.value.lists.length}</strong>lists
            </span>
            <span>
              <strong>{preview.value.tasks.length}</strong>tasks
            </span>
            <span>
              <strong>{preview.value.tasks.filter((task) => task.parentKey).length}</strong>subtasks
            </span>
            <span>
              <strong>{preview.value.tasks.filter((task) => task.completed).length}</strong>
              completed
            </span>
          </div>
          {!current && (
            <p className="transfer__warning">the options changed. preview again before freezing.</p>
          )}
          <p>
            {preview.value.skippedBlankRows} blank rows skipped ·{' '}
            {preview.value.skippedCompletedTasks} completed tasks skipped ·{' '}
            {preview.value.parentContextCount} open parent context records. at most 2,000 tasks and
            100 lists per import.
          </p>
          <details>
            <summary>detected list titles and sample tasks</summary>
            <p>{preview.value.lists.map((list) => list.title).join(' · ')}</p>
            <ol>
              {preview.value.tasks.slice(0, 20).map((task) => (
                <li key={task.key}>
                  {task.parentKey ? '↳ ' : ''}
                  {task.title} · {task.scheduledDay ?? 'no date'}
                </li>
              ))}
            </ol>
            <p>
              showing {Math.min(preview.value.tasks.length, 20)} sample tasks; the complete selected
              plan is captured.
            </p>
          </details>
          <details open={preview.value.issues.some((issue) => issue.severity === 'error')}>
            <summary>
              {preview.value.issues.filter((issue) => issue.severity === 'error').length} errors ·{' '}
              {preview.value.issues.filter((issue) => issue.severity === 'warning').length} warnings
            </summary>
            <ol className="transfer__issues">
              {preview.value.issues.slice(0, issueLimit).map((issue, index) => (
                <li key={index} className={issue.severity === 'error' ? 'transfer__warning' : ''}>
                  <strong>
                    {issue.severity} · {issue.source?.sheet}{' '}
                    {issue.source?.row ? `row ${issue.source.row}` : ''}
                    {issue.field ? ` · ${issue.field}` : ''}
                  </strong>
                  <p>{issue.message}</p>
                </li>
              ))}
            </ol>
            {preview.value.issues.length > issueLimit && (
              <button
                type="button"
                className="transfer__text"
                onClick={() => setIssueLimit((value) => value + 100)}
              >
                show the next {Math.min(100, preview.value.issues.length - issueLimit)} diagnostics
              </button>
            )}
          </details>
        </div>
      )}
      <TransferError>{action.error}</TransferError>
    </section>
  );
}
