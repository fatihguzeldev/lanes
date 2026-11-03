import { useState } from 'react';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import {
  OperationPageSchema,
  OperationStepPageSchema,
  OperationSummarySchema,
  type OperationSummary,
} from '../modules/tasks/operation-contract';
import { request } from './http';
import { useCommands } from './useCommands';
import { usePagedResource } from './usePagedResource';
import { useServerConnection } from './useServerConnection';
interface Props {
  account: ConnectionSummary;
  version: number;
  clockOffset: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  onResolve: (id: string) => void;
  onOpenTask: (id: string) => void;
  onOpenList: (id: string) => void;
}
export function OperationsPanel({
  account,
  version,
  clockOffset,
  selectedId,
  onSelect,
  onChanged,
  onResolve,
  onOpenTask,
  onOpenList,
}: Props) {
  const base = `/api/accounts/${encodeURIComponent(account.id)}`,
    [activeOnly, setActiveOnly] = useState(false),
    [error, setError] = useState('');
  const connection = useServerConnection(),
    commands = useCommands(account.id, clockOffset, onChanged);
  const operations = usePagedResource(
    `${account.id}:operations:${activeOnly}`,
    (cursor, signal) =>
      request(
        `${base}/operations?active=${activeOnly ? '1' : '0'}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
        OperationPageSchema,
        { signal },
      ),
    (item) => item.id,
    version,
  );
  const steps = usePagedResource(
    selectedId ? `${account.id}:operation:${selectedId}` : null,
    (cursor, signal) =>
      request(
        `${base}/operations/${encodeURIComponent(selectedId!)}/steps${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        OperationStepPageSchema,
        { signal },
      ),
    (item) => item.key,
    version,
  );
  const action = async (operation: OperationSummary, kind: 'cancel' | 'resume') => {
    setError('');
    try {
      await request(
        `${base}/operations/${encodeURIComponent(operation.id)}/${kind}`,
        OperationSummarySchema,
        { method: 'POST', body: {} },
      );
      onChanged();
      if (kind === 'resume') await commands.advance(operation.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'this operation could not continue.');
    }
  };
  return (
    <div className="dialog__body">
      <p>
        submitted work keeps its original account and destination. cancellation leaves confirmed
        output in place.
      </p>
      <label>
        <span>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={activeOnly}
            onChange={(event) => setActiveOnly(event.target.checked)}
          />{' '}
          unfinished operations only
        </span>
      </label>
      <button onClick={() => void operations.reload()} disabled={operations.status === 'loading'}>
        refresh progress
      </button>
      <ul className="workspace__operations">
        {operations.items.map((operation) => (
          <li key={operation.id}>
            <div>
              <button
                className="operations__title"
                aria-expanded={selectedId === operation.id}
                onClick={() => onSelect(selectedId === operation.id ? null : operation.id)}
              >
                {operation.kind.replaceAll('.', ' · ')}
              </button>
              <span>
                {operation.state.replaceAll('_', ' ')} · {operation.confirmedSteps}/
                {operation.totalSteps} steps confirmed
              </span>
              {operation.error && <p>{operation.error.message}</p>}
              <small>{new Date(operation.createdAt).toLocaleString()}</small>
              {selectedId === operation.id && (
                <div className="operations__steps">
                  <ol>
                    {steps.items.map((step) => (
                      <li key={step.key}>
                        <div>
                          <span>
                            {step.position + 1}. {step.kind.replaceAll('.', ' · ')} · {step.state}
                          </span>
                          {step.stopDecision === 'keep_provider_current' && (
                            <small>google state kept · remaining work stopped</small>
                          )}
                          {step.taskId && !step.deleted && (
                            <button onClick={() => onOpenTask(step.taskId!)}>open task</button>
                          )}
                          {step.listId && !step.deleted && (
                            <button onClick={() => onOpenList(step.listId!)}>open list</button>
                          )}
                          {step.spreadsheetId && /^[\w-]+$/.test(step.spreadsheetId) && (
                            <a
                              href={`https://docs.google.com/spreadsheets/d/${encodeURIComponent(step.spreadsheetId)}/edit`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              open spreadsheet
                            </a>
                          )}
                          {step.deleted && <small>confirmed deletion · history is retained</small>}
                          {step.errorCode && <small>{step.errorCode.replaceAll('_', ' ')}</small>}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {steps.status === 'loading' && <p role="status">reading recorded steps…</p>}
                  {steps.error && (
                    <p className="error" role="alert">
                      {steps.error}
                    </p>
                  )}
                  {!steps.coverage.complete && (
                    <p>input capture is still in progress; more steps may follow.</p>
                  )}
                  {steps.nextCursor && (
                    <button
                      disabled={steps.status === 'loading'}
                      onClick={() => void steps.loadMore()}
                    >
                      more steps
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="operations__actions">
              {!operation.finished &&
                ['accepted', 'running', 'partial'].includes(operation.state) && (
                  <button
                    disabled={commands.busy || connection !== 'reachable'}
                    onClick={() => void commands.advance(operation.id)}
                  >
                    continue
                  </button>
                )}
              {!operation.finished &&
                ['reconnect_required', 'blocked_by_limit'].includes(operation.state) && (
                  <button
                    disabled={
                      commands.busy || account.state !== 'connected' || connection !== 'reachable'
                    }
                    onClick={() => void action(operation, 'resume')}
                  >
                    resume
                  </button>
                )}
              {operation.state === 'uncertain' && (
                <button
                  disabled={commands.busy || connection !== 'reachable'}
                  onClick={() => onResolve(operation.id)}
                >
                  resolve outcome
                </button>
              )}
              {!operation.finished && (
                <button
                  disabled={connection !== 'reachable'}
                  onClick={() => void action(operation, 'cancel')}
                >
                  cancel unsent
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {(error || commands.error || operations.error) && (
        <p className="error" role="alert">
          {error || commands.error || operations.error}
        </p>
      )}
      {operations.status === 'loading' && <p role="status">loading operations…</p>}
      {operations.loaded && !operations.items.length && (
        <p>no {activeOnly ? 'unfinished ' : ''}operations here.</p>
      )}
      {operations.nextCursor && (
        <button
          disabled={operations.status === 'loading'}
          onClick={() => void operations.loadMore()}
        >
          more operations
        </button>
      )}
    </div>
  );
}
