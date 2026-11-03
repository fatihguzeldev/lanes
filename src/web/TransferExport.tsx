import { useRef, useState } from 'react';
import { LabelSchema, type TaskFilter } from '../modules/tasks/contracts';
import type { BoardList } from '../modules/boards/contracts';
import { CsvExportRequestSchema, type CsvExportRequest } from '../modules/transfer/export-contract';
import { accountToday } from '../modules/tasks/planning';
import { request } from './http';
import { downloadFile } from './transfer-client';
import { CsvPageSchema, transferPage } from './transfer-schemas';
import {
  accountBase,
  BoardChoice,
  ListSelection,
  pageQuery,
  transferBase,
  TransferConnection,
  TransferError,
  TransferPages,
  useBoardLists,
  useTransferAction,
  useTransferDirty,
  type TransferProps,
} from './TransferCommon';
import { usePagedResource } from './usePagedResource';
import { TransferSheetsExport } from './TransferSheetsExport';
import { Dialog } from '../ui/Dialog';
import { describeSheetsScope, readSheetsExportDraft } from './transfer-sheets-model';
export function TransferExport(props: TransferProps) {
  const returnedFromSheets =
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('portability') === 'export' &&
    Boolean(new URLSearchParams(location.search).get('source'));
  const [format, setFormat] = useState<'csv' | 'sheets'>(returnedFromSheets ? 'sheets' : 'csv'),
    [scopeKind, setScopeKind] = useState<'account' | 'board' | 'lists' | 'search'>('board'),
    [selectedLists, setSelectedLists] = useState<BoardList[]>([]),
    [includeCompleted, setIncludeCompleted] = useState(true),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState<TaskFilter>({});
  const restoredRequest = useRef(
    returnedFromSheets ? readSheetsExportDraft(props.account.id)?.exportRequest : undefined,
  ).current;
  const [clearRestored, setClearRestored] = useState(false);
  const [childDirty, setChildDirty] = useState(false),
    [nextFormat, setNextFormat] = useState<'csv' | 'sheets' | 'scope' | null>(null),
    [presentation, setPresentation] = useState(0);
  const dirtyChanged = (dirty: boolean) => {
    setChildDirty(dirty);
    props.onDirtyChange?.(dirty);
  };
  const changeFormat = (next: 'csv' | 'sheets') => {
    if (next === format) return;
    if (childDirty) setNextFormat(next);
    else setFormat(next);
  };
  const resource = useBoardLists(props.account.id, props.version),
    today = accountToday(
      props.account.planningZone,
      new Date(Date.now() + props.clockOffset).toISOString(),
    );
  const labels = usePagedResource(
    `${props.account.id}:export-labels`,
    (cursor, signal) =>
      request(
        `${accountBase(props.account.id)}/labels${pageQuery(cursor, 50)}`,
        transferPage(LabelSchema),
        { signal },
      ),
    (item) => item.id,
    props.version ?? 0,
  );
  const { completion: _completion, ...exportFilter } = filter;
  const input = {
    exportId: 'preview_identity_00000000',
    scope: {
      ...(scopeKind === 'board' && resource.board ? { boardId: resource.board.id } : {}),
      ...(scopeKind === 'lists' ? { listIds: selectedLists.map((list) => list.id) } : {}),
      query: scopeKind === 'search' ? search : '',
      filter: scopeKind === 'search' ? exportFilter : {},
    },
    includeCompleted,
    today,
    limit: 10,
  };
  const parsed = CsvExportRequestSchema.safeParse(input),
    valid =
      parsed.success &&
      (scopeKind !== 'board' || Boolean(resource.board)) &&
      (scopeKind !== 'lists' || selectedLists.length > 0);
  if (restoredRequest && !clearRestored)
    return (
      <section className="transfer__form">
        <TransferConnection />
        <div className="transfer__preview">
          <h3>your export scope was kept</h3>
          <p>{describeSheetsScope(restoredRequest)}</p>
          <p>
            the planning-day filter remains anchored to {restoredRequest.today}. a captured
            spreadsheet operation keeps this exact input.
          </p>
          <details>
            <summary>review the saved selection</summary>
            <pre>{JSON.stringify(restoredRequest.scope, null, 2)}</pre>
          </details>
        </div>
        <TransferSheetsExport
          key={presentation}
          account={props.account}
          clockOffset={props.clockOffset}
          exportRequest={restoredRequest}
          {...(props.onChanged ? { onChanged: props.onChanged } : {})}
          {...(props.onOpenOperation ? { onOpenOperation: props.onOpenOperation } : {})}
          onDirtyChange={dirtyChanged}
        />
        <button
          type="button"
          className="transfer__text"
          onClick={() => {
            if (childDirty) setNextFormat('scope');
            else setClearRestored(true);
          }}
        >
          choose a different scope
        </button>
        {nextFormat && (
          <Dialog title="leave this export draft?" onClose={() => setNextFormat(null)}>
            <div className="dialog__body">
              <p>
                unsent choices are discarded. captured spreadsheet operations remain in activity;
                leaving does not cancel them.
              </p>
              <footer>
                <button type="button" onClick={() => setNextFormat(null)}>
                  keep editing
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    setClearRestored(true);
                    setNextFormat(null);
                    setPresentation((value) => value + 1);
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
  return (
    <section className="transfer__form">
      <TransferConnection />
      <p>
        take tasks from {props.account.email}. choose the scope and whether to include completed
        work.
      </p>
      <div className="transfer__segmented">
        <button type="button" aria-pressed={format === 'csv'} onClick={() => changeFormat('csv')}>
          csv download
        </button>
        <button
          type="button"
          aria-pressed={format === 'sheets'}
          onClick={() => changeFormat('sheets')}
        >
          new google spreadsheet
        </button>
      </div>
      <fieldset disabled={childDirty}>
        <label>
          export scope
          <select
            value={scopeKind}
            onChange={(event) => setScopeKind(event.target.value as typeof scopeKind)}
          >
            <option value="board">one board</option>
            <option value="lists">selected lists</option>
            <option value="search">account search and filters</option>
            <option value="account">all lists in this account</option>
          </select>
        </label>
        {scopeKind === 'board' && <BoardChoice resource={resource} />}{' '}
        {scopeKind === 'lists' && (
          <ListSelection
            resource={resource}
            selected={selectedLists}
            onChange={setSelectedLists}
            maximum={2000}
          />
        )}{' '}
        {scopeKind === 'search' && (
          <>
            <label>
              search
              <input
                value={search}
                maxLength={512}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <details className="transfer__details">
              <summary>filter the selected account</summary>
              <label>
                star
                <select
                  value={filter.starred === undefined ? 'any' : String(filter.starred)}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFilter((prior) => {
                      const next = { ...prior };
                      if (value === 'any') delete next.starred;
                      else next.starred = value === 'true';
                      return next;
                    });
                  }}
                >
                  <option value="any">any task</option>
                  <option value="true">starred</option>
                  <option value="false">without a star</option>
                </select>
              </label>
              <label>
                scheduled
                <select
                  value={filter.scheduled?.kind ?? 'any'}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFilter((prior) => {
                      const next = { ...prior };
                      if (value === 'any') delete next.scheduled;
                      else
                        next.scheduled =
                          value === 'range'
                            ? { kind: 'range', from: today, to: today }
                            : { kind: value as 'none' | 'today' | 'overdue' };
                      return next;
                    });
                  }}
                >
                  <option value="any">any day</option>
                  <option value="today">today</option>
                  <option value="overdue">overdue</option>
                  <option value="none">no date</option>
                  <option value="range">date range</option>
                </select>
              </label>
              {filter.scheduled?.kind === 'range' && (
                <div className="transfer__two">
                  <label>
                    from
                    <input
                      type="date"
                      value={filter.scheduled.from}
                      onChange={(event) =>
                        setFilter((prior) => ({
                          ...prior,
                          scheduled: {
                            kind: 'range',
                            from: event.target.value,
                            to: prior.scheduled?.kind === 'range' ? prior.scheduled.to : today,
                          },
                        }))
                      }
                    />
                  </label>
                  <label>
                    through
                    <input
                      type="date"
                      value={filter.scheduled.to}
                      onChange={(event) =>
                        setFilter((prior) => ({
                          ...prior,
                          scheduled: {
                            kind: 'range',
                            from: prior.scheduled?.kind === 'range' ? prior.scheduled.from : today,
                            to: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                </div>
              )}
              <fieldset>
                <legend>priorities</legend>
                {(['none', 'low', 'medium', 'high'] as const).map((value) => (
                  <label key={value} className="transfer__check">
                    <input
                      type="checkbox"
                      checked={filter.priorities?.includes(value) ?? false}
                      onChange={(event) =>
                        setFilter((prior) => ({
                          ...prior,
                          priorities: event.target.checked
                            ? [...(prior.priorities ?? []), value]
                            : (prior.priorities?.filter((item) => item !== value) ?? []),
                        }))
                      }
                    />
                    {value}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>dependencies</legend>
                {(['blocked', 'unblocked', 'unknown'] as const).map((value) => (
                  <label key={value} className="transfer__check">
                    <input
                      type="checkbox"
                      checked={filter.dependencyStates?.includes(value) ?? false}
                      onChange={(event) =>
                        setFilter((prior) => ({
                          ...prior,
                          dependencyStates: event.target.checked
                            ? [...(prior.dependencyStates ?? []), value]
                            : (prior.dependencyStates?.filter((item) => item !== value) ?? []),
                        }))
                      }
                    />
                    {value}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>labels</legend>
                {labels.items.map((label) => (
                  <label className="transfer__check" key={label.id}>
                    <input
                      type="checkbox"
                      checked={filter.labelIds?.includes(label.id) ?? false}
                      disabled={
                        !filter.labelIds?.includes(label.id) && (filter.labelIds?.length ?? 0) >= 20
                      }
                      onChange={(event) =>
                        setFilter((prior) => ({
                          ...prior,
                          labelIds: event.target.checked
                            ? [...(prior.labelIds ?? []), label.id]
                            : (prior.labelIds?.filter((id) => id !== label.id) ?? []),
                        }))
                      }
                    />
                    {label.name}
                  </label>
                ))}
                <TransferPages resource={labels} />
                <label>
                  label match
                  <select
                    value={filter.labelMatch ?? 'any'}
                    onChange={(event) =>
                      setFilter((prior) => ({
                        ...prior,
                        labelMatch: event.target.value as 'any' | 'all',
                      }))
                    }
                  >
                    <option value="any">any selected label</option>
                    <option value="all">every selected label</option>
                  </select>
                </label>
              </fieldset>
              <button type="button" className="transfer__text" onClick={() => setFilter({})}>
                clear filters
              </button>
            </details>
          </>
        )}
        <label className="transfer__check">
          <input
            type="checkbox"
            checked={includeCompleted}
            onChange={(event) => setIncludeCompleted(event.target.checked)}
          />
          include completed tasks
        </label>
      </fieldset>
      {childDirty && (
        <button type="button" className="transfer__text" onClick={() => setNextFormat('scope')}>
          choose a different scope
        </button>
      )}
      {!valid && <p className="transfer__quiet">choose a valid scope before exporting.</p>}
      {valid &&
        parsed.success &&
        (format === 'csv' ? (
          <CsvDownload
            key={presentation}
            {...props}
            input={parsed.data}
            onDirtyChange={dirtyChanged}
          />
        ) : (
          <TransferSheetsExport
            key={presentation}
            account={props.account}
            clockOffset={props.clockOffset}
            exportRequest={parsed.data}
            {...(props.onChanged ? { onChanged: props.onChanged } : {})}
            {...(props.onOpenOperation ? { onOpenOperation: props.onOpenOperation } : {})}
            onDirtyChange={dirtyChanged}
          />
        ))}
      {nextFormat && (
        <Dialog title="leave this export draft?" onClose={() => setNextFormat(null)}>
          <div className="dialog__body">
            <p>
              unsent local choices or an unfinished download buffer will be discarded. captured
              spreadsheet operations remain in activity; leaving does not cancel them.
            </p>
            <footer>
              <button type="button" onClick={() => setNextFormat(null)}>
                keep editing
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (nextFormat !== 'scope') setFormat(nextFormat);
                  setNextFormat(null);
                  setPresentation((value) => value + 1);
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
function CsvDownload({
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
