import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  OperationProgressSchema,
  OperationSummarySchema,
  type OperationSummary,
} from '../modules/tasks/operation-contract';
import {
  ConfirmImportSchema,
  DEFAULT_IMPORTED_LABEL_COLOR,
} from '../modules/transfer/server-contract';
import {
  accountBase,
  escaped,
  message,
  providerReady,
  transferBase,
  TransferConnection,
  TransferError,
  useTransferAction,
  writable,
  type TransferProps,
} from './TransferCommon';
import { request } from './http';
import {
  ImportOutputPageSchema,
  ImportRecordPageSchema,
  ImportSummarySchema,
  ListCapacitySchema,
  type ImportSummary,
} from './transfer-schemas';
import { Select } from '../ui/Select';

export function TransferImportRun({
  run: initial,
  ...props
}: TransferProps & { run: ImportSummary }) {
  const { account, onChanged, onOpenOperation, onOpenTask } = props;
  const [run, setRun] = useState(initial),
    [operation, setOperation] = useState<OperationSummary | null>(null),
    [warnings, setWarnings] = useState(false),
    [repeat, setRepeat] = useState(false),
    [cancel, setCancel] = useState(false),
    [capacity, setCapacity] = useState<z.infer<typeof ListCapacitySchema> | null>(null);
  const [records, setRecords] = useState<z.infer<typeof ImportRecordPageSchema>['items']>([]),
    [recordKind, setRecordKind] = useState<'list' | 'task' | 'issue'>('task'),
    [recordCursor, setRecordCursor] = useState<number | null>(null),
    [outputs, setOutputs] = useState<z.infer<typeof ImportOutputPageSchema>['items']>([]),
    [outputCursor, setOutputCursor] = useState<string | null>(null);
  const [labelColors, setLabelColors] = useState<
    { name: string; incomingColor: string; currentColor: string | null; conflict: boolean }[]
  >([]);
  const [counts, setCounts] = useState<z.infer<typeof OperationProgressSchema> | null>(null),
    lastCountsRead = useRef(0);
  const action = useTransferAction(`${account.id}:${initial.id}`),
    base = `${transferBase(account.id)}/imports/${escaped(initial.id)}`;
  async function readCounts(operationId: string, signal: AbortSignal, force = false) {
    if (!force && Date.now() - lastCountsRead.current < 2000) return;
    const value = await request(
      `${accountBase(account.id)}/operations/${escaped(operationId)}/progress`,
      OperationProgressSchema,
      { signal },
    );
    lastCountsRead.current = Date.now();
    setCounts(value);
  }
  async function refresh(signal: AbortSignal) {
    const latest = await request(base, ImportSummarySchema, { signal });
    setRun(latest);
    setCapacity(
      await request(`${transferBase(account.id)}/capacity`, ListCapacitySchema, { signal }),
    );
    if (latest.operationId) {
      setOperation(
        await request(
          `${accountBase(account.id)}/operations/${escaped(latest.operationId)}`,
          OperationSummarySchema,
          { signal },
        ),
      );
      await readCounts(latest.operationId, signal, true);
    }
    return latest;
  }
  useEffect(() => {
    void action.run(async (signal) => {
      await refresh(signal);
      await loadRecords(signal, undefined, true);
    });
  }, [initial.id]);
  useEffect(() => {
    setRecords([]);
    setRecordCursor(null);
    void action.run((signal) => loadRecords(signal, undefined, true));
  }, [recordKind, initial.id]);
  async function loadRecords(signal: AbortSignal, cursor?: number, replace = false) {
    const result = await request(
      `${base}/records?kind=${recordKind}&limit=10${cursor === undefined ? '' : `&cursor=${cursor}`}`,
      ImportRecordPageSchema,
      { signal },
    );
    setRecords((prior) => (replace ? result.items : [...prior, ...result.items]));
    setRecordCursor(result.nextCursor);
    const definitions = result.items.flatMap(
      (row) =>
        row.labelDefinitions ??
        (row.value && 'labels' in row.value
          ? row.value.labels.map((name) => ({ name, color: DEFAULT_IMPORTED_LABEL_COLOR }))
          : []),
    );
    if (definitions.length) {
      const schema = z
        .object({
          items: z
            .array(
              z
                .object({
                  name: z.string(),
                  incomingColor: z.string(),
                  currentColor: z.string().nullable(),
                  conflict: z.boolean(),
                })
                .strict(),
            )
            .max(200),
        })
        .strict();
      const compared = await request(`${transferBase(account.id)}/labels/compare`, schema, {
        method: 'POST',
        body: { definitions },
        signal,
      });
      setLabelColors((prior) => {
        const next = new Map(
          (replace ? [] : prior).map((value) => [value.name.normalize('NFC').toLowerCase(), value]),
        );
        for (const value of compared.items)
          next.set(value.name.normalize('NFC').toLowerCase(), value);
        return [...next.values()];
      });
    } else if (replace) setLabelColors([]);
  }
  async function loadOutput(signal: AbortSignal, cursor?: string) {
    const result = await request(
      `${base}/output?limit=10${cursor ? `&cursor=${escaped(cursor)}` : ''}`,
      ImportOutputPageSchema,
      { signal },
    );
    setOutputs((prior) => (cursor ? [...prior, ...result.items] : result.items));
    setOutputCursor(result.nextCursor);
  }
  async function captureSource(signal: AbortSignal) {
    const path =
        run.source.kind === 'account'
          ? `${transferBase(account.id)}/accounts/${escaped(run.id)}/capture`
          : run.source.kind === 'archive'
            ? `${transferBase(account.id)}/archives/copies/${escaped(run.id)}/capture`
            : `${base}/preview`,
      deadline = Date.now() + 30000;
    let current = run;
    if (current.paused)
      current = await request(`${base}/resume`, ImportSummarySchema, {
        method: 'POST',
        body: {},
        signal,
      });
    do {
      current = await request(path, ImportSummarySchema, { method: 'POST', body: {}, signal });
      setRun(current);
    } while (
      current.state === 'staging' &&
      !current.paused &&
      Date.now() < deadline &&
      !signal.aborted
    );
    onChanged?.();
  }
  async function progress(signal: AbortSignal) {
    let current = run;
    if (current.paused) {
      current = await request(`${base}/resume`, ImportSummarySchema, {
        method: 'POST',
        body: {},
        signal,
      });
      setRun(current);
    }
    if (operation && ['reconnect_required', 'blocked_by_limit'].includes(operation.state))
      await request(
        `${accountBase(account.id)}/operations/${escaped(operation.id)}/resume`,
        OperationSummarySchema,
        { method: 'POST', body: {}, signal },
      );
    const deadline = Date.now() + 30000;
    do {
      current = await request(`${base}/advance`, ImportSummarySchema, {
        method: 'POST',
        body: {},
        signal,
      });
      setRun(current);
      onChanged?.();
      if (current.operationId) {
        const receipt = await request(
          `${accountBase(account.id)}/operations/${escaped(current.operationId)}`,
          OperationSummarySchema,
          { signal },
        );
        setOperation(receipt);
        await readCounts(current.operationId, signal, receipt.finished);
        if (
          receipt.finished ||
          ['uncertain', 'reconnect_required', 'blocked_by_limit', 'failed'].includes(
            receipt.state,
          ) ||
          (receipt.nextAttemptAt && receipt.nextAttemptAt > Date.now() + 1500)
        )
          break;
      }
      if (['finished', 'cancelled', 'preview', 'staging'].includes(current.state)) break;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 500);
        function done() {
          signal.removeEventListener('abort', abort);
          resolve();
        }
        function abort() {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        }
        signal.addEventListener('abort', abort, { once: true });
      });
    } while (Date.now() < deadline && !signal.aborted);
    await loadOutput(signal);
    return current;
  }
  const capacityError =
    run.requiredListSlots > 0 &&
    (!capacity || capacity.stale || capacity.available === null
      ? 'refresh list inventory before confirming this copy.'
      : run.requiredListSlots > capacity.available
        ? `${run.requiredListSlots} list slots needed; ${capacity.available} available.`
        : '');
  const canConfirm =
    run.state === 'preview' &&
    Boolean(run.previewHash) &&
    !run.errorCount &&
    (!run.warningCount || warnings) &&
    (!run.repeatingCount || repeat) &&
    !capacityError &&
    !run.paused &&
    providerReady(account);
  return (
    <section className="transfer__run" aria-label="captured import">
      <TransferConnection />
      <div className="transfer__section-title">
        <h3>
          {run.source.kind === 'account'
            ? 'account copy'
            : run.source.kind === 'archive'
              ? 'archive snapshot copy'
              : 'import preview'}
        </h3>
        <span>{run.state}</span>
      </div>
      <p>{run.freshnessNote}</p>
      <div className="transfer__numbers">
        <span>
          <strong>{run.totalLists}</strong>source lists
        </span>
        <span>
          <strong>{run.totalTasks}</strong>tasks
        </span>
        <span>
          <strong>{run.subtaskCount}</strong>subtasks
        </span>
        <span>
          <strong>{run.completedCount}</strong>completed
        </span>
      </div>
      <p>
        {run.requiredListSlots} new list slots · {run.skippedBlankRows} blank rows skipped ·{' '}
        {run.skippedCompletedTasks} completed tasks skipped · {run.parentContextCount} open parent
        context records.
      </p>
      {capacity && (
        <p>
          {capacity.known ?? 'unknown'} existing lists · {capacity.reserved} slots reserved ·{' '}
          {capacity.available ?? 'unknown'} available · limit 2,000.
        </p>
      )}
      {capacityError && run.state === 'preview' && (
        <p className="transfer__warning">{capacityError}</p>
      )}
      {counts && (
        <div className="transfer__preview">
          <div className="transfer__numbers">
            <span>
              <strong>{counts.taskCreates.confirmed}</strong>tasks confirmed
            </span>
            <span>
              <strong>{counts.taskCreates.failed}</strong>failed
            </span>
            <span>
              <strong>{counts.taskCreates.uncertain}</strong>uncertain
            </span>
            <span>
              <strong>
                {Math.max(
                  0,
                  run.totalTasks -
                    Object.values(counts.taskCreates).reduce((sum, value) => sum + value, 0),
                )}
              </strong>
              remaining
            </span>
          </div>
          <p>
            {counts.taskCreates.cancelled} task creations cancelled · counts checked{' '}
            {new Intl.DateTimeFormat('en', {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: account.planningZone,
            }).format(counts.checkedAt)}
            .
          </p>
        </div>
      )}
      {operation && (
        <>
          <progress
            value={operation.confirmedSteps}
            max={operation.totalSteps}
            aria-label="confirmed copy steps"
          />
          <p>
            {operation.confirmedSteps} of {operation.totalSteps} steps confirmed ·{' '}
            {operation.state.replaceAll('_', ' ')}. steps include preparation, containers, tasks and
            dependency links.
          </p>
          {operation.error && <p className="transfer__warning">{operation.error.message}</p>}
        </>
      )}
      <details className="transfer__details">
        <summary>
          review frozen records and warnings · {run.warningCount} warnings, {run.errorCount} errors
        </summary>
        <label>
          show
          <Select
            value={recordKind}
            disabled={action.busy}
            onChange={(selectedValue) => setRecordKind(selectedValue as typeof recordKind)}
            aria-label="show"
            options={[
              { value: 'task', label: 'tasks' },
              { value: 'list', label: 'lists' },
              { value: 'issue', label: 'warnings and errors' },
            ]}
          />
        </label>
        <button
          type="button"
          className="transfer__text"
          disabled={action.busy}
          onClick={() => void action.run((signal) => loadRecords(signal, undefined, true))}
        >
          load selected records
        </button>
        <ol className="transfer__records">
          {records.map((record) =>
            record.value === null ? (
              <li key={record.position}>
                source record {record.position + 1} is no longer retained. confirmed destination
                receipts remain available below.
              </li>
            ) : (
              <li key={record.position}>
                {'severity' in record.value ? (
                  <>
                    <strong>
                      {record.value.severity} · {record.value.source?.sheet}{' '}
                      {record.value.source?.row ? `row ${record.value.source.row}` : ''}
                    </strong>
                    <p>{record.value.message}</p>
                  </>
                ) : (
                  <>
                    <strong>{'title' in record.value ? record.value.title : ''}</strong>
                    {'notes' in record.value && (
                      <>
                        <p>
                          {record.value.parentKey
                            ? `subtask of ${record.value.parentKey}`
                            : 'top-level task'}{' '}
                          · {record.value.scheduledDay ?? 'no date'}
                          {record.value.scheduledTime
                            ? ` · ${record.value.scheduledTime} ${record.value.timeZone}`
                            : ''}{' '}
                          · {record.value.completed ? 'completed' : 'open'}
                        </p>
                        <details>
                          <summary>notes and metadata</summary>
                          <pre>{JSON.stringify(record.value, null, 2)}</pre>
                        </details>
                      </>
                    )}
                    {record.labelDefinitions && (
                      <p>
                        saved label colors:{' '}
                        {record.labelDefinitions
                          .map((label) => `${label.name} ${label.color}`)
                          .join(' · ')}
                        . matching destination label colors are preserved.
                      </p>
                    )}
                  </>
                )}
              </li>
            ),
          )}
        </ol>
        {labelColors.length > 0 && (
          <div className="transfer__preview">
            <h4>label colors in loaded records</h4>
            {labelColors.map((label) => (
              <p key={label.name} className={label.conflict ? 'transfer__warning' : ''}>
                {label.name} · incoming {label.incomingColor} →{' '}
                {label.currentColor
                  ? `keep destination ${label.currentColor}`
                  : 'create missing label with incoming color'}
              </p>
            ))}
          </div>
        )}
        {recordCursor !== null && (
          <button
            type="button"
            className="transfer__text"
            disabled={action.busy}
            onClick={() => void action.run((signal) => loadRecords(signal, recordCursor))}
          >
            more records
          </button>
        )}
      </details>
      {run.state === 'staging' && (
        <p className="transfer__notice">
          this preview is not completely captured. no task creation is admitted yet.{' '}
          {run.source.kind === 'account' ||
          run.source.kind === 'archive' ||
          (run.capturedLists === run.totalLists && run.capturedTasks === run.totalTasks) ? (
            <button
              type="button"
              disabled={action.busy}
              onClick={() => void action.run(captureSource)}
            >
              continue capture / validation
            </button>
          ) : (
            'complete capture in the original editor, or cancel this unconfirmed preview and select the source again.'
          )}
        </p>
      )}
      {run.validation && (
        <p role="status">
          {run.validation.checkedRecords} of {run.validation.totalRecords} records validated ·{' '}
          {run.validation.remainingGraphNodes} graph nodes remaining.
        </p>
      )}
      {run.paused && run.state !== 'staging' && (
        <p className="transfer__notice">
          this capture is paused
          {run.pauseReason ? ` · ${run.pauseReason.replaceAll('_', ' ')}` : ''}.
          <button
            type="button"
            disabled={action.busy || !writable(account)}
            onClick={() =>
              void action.run(async (signal) => {
                setRun(
                  await request(`${base}/resume`, ImportSummarySchema, {
                    method: 'POST',
                    body: {},
                    signal,
                  }),
                );
              })
            }
          >
            resume this retained capture
          </button>
        </p>
      )}
      {run.state === 'preview' && (
        <>
          <p>
            the plan is frozen. this creates a separate copy and preserves earlier output. resume a
            retained operation rather than repeating an uncertain whole-file import. review warnings
            before creating any google content. imported completed tasks keep their completion
            state; missing original completion times remain unknown. imported completions do not
            start recurrence.
          </p>
          {run.warningCount > 0 && (
            <label className="transfer__check">
              <input
                type="checkbox"
                checked={warnings}
                onChange={(event) => setWarnings(event.target.checked)}
              />
              accept the shown optional-field omissions and warnings
            </label>
          )}
          {run.repeatingCount > 0 && (
            <label className="transfer__check">
              <input
                type="checkbox"
                checked={repeat}
                onChange={(event) => setRepeat(event.target.checked)}
              />
              create {run.repeatingCount} independent lanes repeat series; source series stay active
            </label>
          )}
          <button
            className="transfer__primary"
            type="button"
            disabled={action.busy || !canConfirm}
            onClick={() =>
              void action.run(async (signal) => {
                const next = await request(`${base}/confirm`, ImportSummarySchema, {
                  method: 'POST',
                  body: ConfirmImportSchema.parse({
                    previewHash: run.previewHash,
                    acceptWarnings: warnings,
                    confirmIndependentRepeat: repeat,
                  }),
                  signal,
                });
                setRun(next);
                onChanged?.();
              })
            }
          >
            confirm this copy
          </button>
        </>
      )}
      <div className="transfer__actions">
        <button type="button" disabled={action.busy} onClick={() => void action.run(refresh)}>
          refresh confirmed state
        </button>
        {run.operationId && onOpenOperation && (
          <button type="button" onClick={() => onOpenOperation(run.operationId!)}>
            inspect operation
          </button>
        )}
        {['capturing', 'running'].includes(run.state) && (
          <button
            type="button"
            className="transfer__primary"
            disabled={
              action.busy ||
              !providerReady(account) ||
              operation?.state === 'uncertain' ||
              operation?.finished
            }
            onClick={() => void action.run(progress)}
          >
            {action.busy ? 'continuing…' : 'continue this copy'}
          </button>
        )}
      </div>
      {run.operationId && (
        <details className="transfer__details">
          <summary>confirmed destination tasks</summary>
          <p>these identities come from saved provider receipts. source data stays intact.</p>
          <button
            type="button"
            disabled={action.busy}
            onClick={() => void action.run((signal) => loadOutput(signal))}
          >
            load confirmed output
          </button>
          <ul className="transfer__output">
            {outputs.map((item) => (
              <li key={item.key}>
                <span>
                  {item.key}
                  {item.sourceCompletion?.completed && (
                    <small>
                      {item.sourceCompletion.completedAt
                        ? `original completion ${item.sourceCompletion.completedAt}`
                        : 'original completion time unknown'}
                      {item.sourceCompletion.providerTimeMayDiffer
                        ? ' · google may record the import time'
                        : ''}
                    </small>
                  )}
                </span>
                {onOpenTask ? (
                  <button
                    type="button"
                    onClick={() => onOpenTask({ accountId: account.id, taskId: item.taskId })}
                  >
                    open copied task
                  </button>
                ) : (
                  <code>{item.taskId}</code>
                )}
              </li>
            ))}
          </ul>
          {outputCursor && (
            <button
              type="button"
              disabled={action.busy}
              onClick={() => void action.run((signal) => loadOutput(signal, outputCursor))}
            >
              more confirmed output
            </button>
          )}
        </details>
      )}
      {!['finished', 'cancelled'].includes(run.state) && (
        <details className="transfer__details">
          <summary>cancel unsent work</summary>
          <p>
            confirmed output is preserved. already dispatched work still needs to settle.
            cancellation never deletes the source.
          </p>
          <label className="transfer__check">
            <input
              type="checkbox"
              checked={cancel}
              onChange={(event) => setCancel(event.target.checked)}
            />
            keep existing output and stop remaining work
          </label>
          <button
            type="button"
            className="transfer__danger"
            disabled={action.busy || !cancel || !writable(account)}
            onClick={() =>
              void action.run(async (signal) => {
                setRun(
                  await request(`${base}/cancel`, ImportSummarySchema, {
                    method: 'POST',
                    body: {},
                    signal,
                  }),
                );
                onChanged?.();
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
