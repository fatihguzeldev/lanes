import { useRef, useState } from 'react';
import type { BoardList } from '../../../boards/contracts/board';
import { request } from '../../../../shared/browser/http/http';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { AccountChoice, ListSelection } from './TransferSelection';
import {
  escaped,
  providerReady,
  transferBase,
  type TransferProps,
} from '../workspace/transfer-context';
import { TransferConnection, TransferError } from '../workspace/TransferFeedback';
import { useBoardLists } from '../workspace/useBoardLists';
import { useTransferAction } from '../workspace/useTransferAction';
import { useTransferDirty } from '../workspace/useTransferDirty';
import { ImportSummarySchema, type ImportSummary } from '../protocol/response-contracts';
import { TransferImportRun } from '../imports/TransferImportRun';
export function TransferAccounts(props: TransferProps) {
  const [sourceId, setSourceId] = useState(
      props.accounts.find((account) => account.id !== props.account.id)?.id ?? '',
    ),
    [lists, setLists] = useState<BoardList[]>([]),
    [completed, setCompleted] = useState(true),
    [confirmed, setConfirmed] = useState(false),
    [run, setRun] = useState<ImportSummary | null>(null);
  const attempt = useRef<{
      id: string;
      sourceAccountId: string;
      listIds: string[];
      includeCompleted: boolean;
    } | null>(null),
    action = useTransferAction(props.account.id),
    resource = useBoardLists(sourceId, props.version),
    source = props.accounts.find((account) => account.id === sourceId);
  useTransferDirty(!run && Boolean(lists.length || attempt.current), props.onDirtyChange);
  async function capture(signal: AbortSignal) {
    if (!attempt.current)
      attempt.current = {
        id: newOperationId(props.clockOffset),
        sourceAccountId: sourceId,
        listIds: lists.map((list) => list.id),
        includeCompleted: completed,
      };
    const input = attempt.current,
      base = transferBase(props.account.id),
      deadline = Date.now() + 30000;
    let summary = await request(`${base}/accounts`, ImportSummarySchema, {
      method: 'POST',
      body: input,
      signal,
    });
    while (summary.state === 'staging' && Date.now() < deadline && !signal.aborted)
      summary = await request(
        `${base}/accounts/${escaped(input.id)}/capture`,
        ImportSummarySchema,
        { method: 'POST', body: {}, signal },
      );
    setRun(summary);
    props.onChanged?.();
  }
  if (run) return <TransferImportRun {...props} run={run} />;
  return (
    <section className="transfer__form">
      <TransferConnection />
      <h3>copy between your accounts</h3>
      <p>
        the source stays intact. new lists are placed on the destination's main board, including
        when those titles already exist.
      </p>
      <fieldset disabled={action.busy || Boolean(attempt.current)}>
        <AccountChoice
          accounts={props.accounts}
          value={sourceId}
          onChange={(value) => {
            setSourceId(value);
            setLists([]);
            setConfirmed(false);
          }}
          exclude={props.account.id}
          label="source google account"
        />
        <label>
          destination account
          <input readOnly value={props.account.email} />
        </label>
        {sourceId && (
          <ListSelection
            resource={resource}
            selected={lists}
            onChange={(value) => {
              setLists(value);
              setConfirmed(false);
            }}
            maximum={100}
          />
        )}
        <label className="transfer__check">
          <input
            type="checkbox"
            checked={completed}
            onChange={(event) => {
              setCompleted(event.target.checked);
              setConfirmed(false);
            }}
          />
          include completed tasks
        </label>
        <div className="transfer__preview">
          <p>
            titles, notes, hierarchy, order, dates, completion and lanes task metadata are copied.
            internal dependencies are remapped; omitted external references and label color
            differences appear in the frozen preview.
          </p>
          <p>
            source repeat series stay active. copied repeat rules become independent destination
            series. list colors, board placement/backgrounds, schedules and history are not copied
            by this action.
          </p>
          <p>
            one operation may copy at most 2,000 tasks, including subtasks, and 100 lists. the
            destination also needs enough of its 2,000-list account quota.
          </p>
        </div>
        <label className="transfer__check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          capture these source lists for a new, source-preserving copy
        </label>
      </fieldset>
      {(!source || !providerReady(source) || !providerReady(props.account)) && (
        <p className="transfer__notice">
          choose distinct connected accounts with tasks access before capturing this copy.
        </p>
      )}
      <div className="transfer__actions">
        <button
          type="button"
          className="transfer__primary"
          disabled={
            action.busy ||
            !source ||
            !providerReady(source) ||
            !providerReady(props.account) ||
            !lists.length ||
            !confirmed
          }
          onClick={() => void action.run(capture)}
        >
          {attempt.current ? 'retry the same source capture' : 'capture and preview copy'}
        </button>
      </div>
      <TransferError>{action.error}</TransferError>
    </section>
  );
}
