import { useRef, useState } from 'react';
import { LabelSchema, type TaskFilter } from '../../../tasks/contracts';
import type { BoardList } from '../../../boards/contracts';
import { CsvExportRequestSchema } from '../../export-contract';
import { accountToday } from '../../../tasks/planning';
import { request } from '../../../../client/http';
import { transferPage } from '../response-contracts';
import { accountBase, pageQuery, type TransferProps } from '../transfer-context';
import { BoardChoice, ListSelection } from '../TransferSelection';
import { TransferConnection, TransferPages } from '../TransferFeedback';
import { useBoardLists } from '../useBoardLists';
import { usePagedResource } from '../../../../client/usePagedResource';
import { TransferSheetsExport } from '../sheets/TransferSheetsExport';
import { Dialog } from '../../../../ui/Dialog';
import { describeSheetsScope, readSheetsExportDraft } from '../sheets/export-state';
import { Select } from '../../../../ui/Select';
import { CsvDownload } from './CsvDownload';
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
          <Select
            value={scopeKind}
            onChange={(selectedValue) => setScopeKind(selectedValue as typeof scopeKind)}
            aria-label="export scope"
            options={[
              { value: 'board', label: 'one board' },
              { value: 'lists', label: 'selected lists' },
              { value: 'search', label: 'account search and filters' },
              { value: 'account', label: 'all lists in this account' },
            ]}
          />
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
                <Select
                  value={filter.starred === undefined ? 'any' : String(filter.starred)}
                  onChange={(selectedValue) => {
                    const value = selectedValue;
                    setFilter((prior) => {
                      const next = { ...prior };
                      if (value === 'any') delete next.starred;
                      else next.starred = value === 'true';
                      return next;
                    });
                  }}
                  aria-label="star"
                  options={[
                    { value: 'any', label: 'any task' },
                    { value: 'true', label: 'starred' },
                    { value: 'false', label: 'without a star' },
                  ]}
                />
              </label>
              <label>
                scheduled
                <Select
                  value={filter.scheduled?.kind ?? 'any'}
                  onChange={(selectedValue) => {
                    const value = selectedValue;
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
                  aria-label="scheduled"
                  options={[
                    { value: 'any', label: 'any day' },
                    { value: 'today', label: 'today' },
                    { value: 'overdue', label: 'overdue' },
                    { value: 'none', label: 'no date' },
                    { value: 'range', label: 'date range' },
                  ]}
                />
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
                  <Select
                    value={filter.labelMatch ?? 'any'}
                    onChange={(selectedValue) =>
                      setFilter((prior) => ({
                        ...prior,
                        labelMatch: selectedValue as 'any' | 'all',
                      }))
                    }
                    aria-label="label match"
                    options={[
                      { value: 'any', label: 'any selected label' },
                      { value: 'all', label: 'every selected label' },
                    ]}
                  />
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
