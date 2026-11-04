import { useRef, useState } from 'react';
import type { ConnectionSummary } from '../../accounts/contracts';
import { OperationSummarySchema, OperationStepPageSchema } from '../operation-contract';
import { request } from '../../../shared/browser/http/http';
import { newestChangeReceipt } from './change-status';
import { useServerConnection } from '../../../shared/browser/connectivity/useServerConnection';
import { useCommands } from './useCommands';
import { usePagedResource } from '../../../shared/browser/resources/usePagedResource';

import './ChangeStatus.css';

interface Props {
  account: ConnectionSummary;
  operationId: string;
  clockOffset: number;
  version: number;
  onChanged: () => void;
  onClose?: () => void;
  onResolve: (id: string) => void;
  onOpenTask: (id: string) => void;
  onOpenList: (id: string) => void;
}

const labels = {
  accepted: 'waiting to save',
  running: 'saving',
  succeeded: 'saved',
  partial: 'partly saved',
  reconnect_required: 'reconnect google to continue',
  blocked_by_limit: 'account limit reached',
  uncertain: 'the result needs checking',
  failed: 'couldn’t save',
  cancelled: 'stopped',
} as const;

export function ChangeStatus(props: Props) {
  const [error, setError] = useState(''),
    [acting, setActing] = useState(false);
  const actionFlight = useRef(false);
  const connection = useServerConnection();
  const changed = () => {
    props.onChanged();
  };
  const base = `/api/accounts/${encodeURIComponent(props.account.id)}/operations/${encodeURIComponent(props.operationId)}`;
  const record = usePagedResource(
    base,
    async (_cursor, signal) => ({
      items: [await request(base, OperationSummarySchema, { signal })],
      nextCursor: null,
      coverage: { complete: true, stale: false, lastSyncedAt: null },
    }),
    (item) => item.id,
    props.version,
  );
  const saved = usePagedResource(
    `${base}:saved`,
    (cursor, signal) =>
      request(
        `${base}/steps${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        OperationStepPageSchema,
        { signal },
      ),
    (item) => item.key,
    props.version,
  );
  const commands = useCommands(props.account.id, props.clockOffset, changed);
  const operation = newestChangeReceipt(
    record.items[0],
    commands.latest?.id === props.operationId ? commands.latest : null,
  );
  const canContinue =
    operation &&
    !operation.finished &&
    ['accepted', 'running', 'partial'].includes(operation.state);
  const writable =
    connection === 'reachable' && !['disconnected', 'disconnecting'].includes(props.account.state);
  const disabled = commands.busy || acting || !writable;
  const action = async (kind: 'cancel' | 'resume') => {
    if (disabled || actionFlight.current) return;
    actionFlight.current = true;
    setActing(true);
    setError('');
    try {
      await request(`${base}/${kind}`, OperationSummarySchema, { method: 'POST', body: {} });
      changed();
      if (kind === 'resume') await commands.advance(props.operationId);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'couldn’t update this change.');
    } finally {
      actionFlight.current = false;
      setActing(false);
    }
  };
  return (
    <div className="dialog__body change-status">
      {operation ? (
        <>
          <p role="status">{labels[operation.state]}</p>
          {operation.totalSteps > 1 && (
            <p>
              {operation.confirmedSteps} of {operation.totalSteps} changes saved
            </p>
          )}
          {operation.error && (
            <p className="error" role="alert">
              {operation.error.message}
            </p>
          )}
          <div className="change-status__actions">
            {canContinue && (
              <button disabled={disabled} onClick={() => void commands.advance(operation.id)}>
                continue saving
              </button>
            )}
            {!operation.finished &&
              ['reconnect_required', 'blocked_by_limit'].includes(operation.state) && (
                <button
                  disabled={disabled || props.account.state !== 'connected'}
                  onClick={() => void action('resume')}
                >
                  try again
                </button>
              )}
            {operation.state === 'uncertain' && (
              <button disabled={disabled} onClick={() => props.onResolve(operation.id)}>
                review result
              </button>
            )}
            {!operation.finished && !operation.cancelRequested && (
              <button disabled={disabled} onClick={() => void action('cancel')}>
                stop remaining changes
              </button>
            )}
            {operation.finished ? (
              <button
                onClick={() => {
                  changed();
                  props.onClose?.();
                }}
              >
                back to workspace
              </button>
            ) : (
              <button disabled={disabled} onClick={changed}>
                check status
              </button>
            )}
          </div>
          {saved.items.some(
            (step) =>
              step.state === 'confirmed' &&
              !step.deleted &&
              (step.taskId || step.listId || step.spreadsheetId),
          ) && (
            <div className="change-status__items">
              {saved.items
                .filter((step) => step.state === 'confirmed' && !step.deleted)
                .map((step) => (
                  <span key={step.key}>
                    {step.taskId ? (
                      <button onClick={() => props.onOpenTask(step.taskId!)}>
                        open saved task
                      </button>
                    ) : step.listId ? (
                      <button onClick={() => props.onOpenList(step.listId!)}>
                        open saved list
                      </button>
                    ) : step.spreadsheetId && /^[\w-]+$/.test(step.spreadsheetId) ? (
                      <a
                        href={`https://docs.google.com/spreadsheets/d/${encodeURIComponent(step.spreadsheetId)}/edit`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        open spreadsheet
                      </a>
                    ) : null}
                  </span>
                ))}
            </div>
          )}
        </>
      ) : record.status === 'loading' ? (
        <p role="status">checking this change…</p>
      ) : null}
      {saved.nextCursor && (
        <button disabled={saved.status === 'loading'} onClick={() => void saved.loadMore()}>
          more saved changes
        </button>
      )}
      {(record.error || saved.error || error || commands.error) && (
        <p className="error" role="alert">
          {record.error || saved.error || error || commands.error}
        </p>
      )}
    </div>
  );
}
