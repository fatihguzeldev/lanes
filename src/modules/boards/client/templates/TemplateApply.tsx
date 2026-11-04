import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import {
  ApplyTemplateSchema,
  TemplateRunSummarySchema,
  type TemplateRunSummary,
} from '../../template-contract';
import { TemplateApplicationOptionsSchema } from '../../../tasks/template-contract';
import { accountToday } from '../../../tasks/planning';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { request } from '../../../../shared/browser/http/http';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import { Select } from '../../../../shared/ui/select/Select';
import {
  type PersonalTemplate,
  type InputIdentity,
  baseFor,
  ref,
  query,
  errorMessage,
  providerWritable,
  applicationCapacityMessage,
  unchangedInputIdentity,
} from './template-model';
import { type BoardsResource, BoardChoice, SnapshotContent } from './TemplateSource';
import { type TemplateWorkspaceProps } from './TemplateWorkspace';
import { ApplicationPreviewSchema, RunPageSchema, ConflictPageSchema } from './template-client';
import { useLifetime, useDirty, CloseGuard } from './TemplateDraft';
import { ServerRecovery, PageState } from './TemplateFeedback';
import { RunDetail } from './TemplateRun';

export function ApplyEditor({
  account,
  template,
  boards,
  clockOffset,
  onClose,
  onRun,
  onOpenOperation,
  onRefreshInventory,
  onDirtyChange,
}: {
  account: ConnectionSummary;
  template: PersonalTemplate;
  boards: BoardsResource;
  clockOffset: number;
  onClose: () => void;
  onRun: (run: TemplateRunSummary) => void;
  onOpenOperation: TemplateWorkspaceProps['onOpenOperation'];
  onRefreshInventory: TemplateWorkspaceProps['onRefreshInventory'];
  onDirtyChange: TemplateWorkspaceProps['onDirtyChange'];
}) {
  const today = accountToday(
    account.planningZone,
    new Date(Date.now() + clockOffset).toISOString(),
  );
  const [boardId, setBoardId] = useState(''),
    [newBoard, setNewBoard] = useState(false),
    [title, setTitle] = useState(template.name),
    [day, setDay] = useState(today),
    [relative, setRelative] = useState(template.snapshot.dateMode === 'relative'),
    [prefix, setPrefix] = useState('');
  const [preview, setPreview] = useState<{
      fingerprint: string;
      value: z.infer<typeof ApplicationPreviewSchema>;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [acknowledged, setAcknowledged] = useState(false);
  const [inspectedRun, setInspectedRun] = useState<TemplateRunSummary | null>(null);
  const [attempt, setAttempt] = useState<{
    id: string;
    input: z.infer<typeof ApplyTemplateSchema>;
  } | null>(null);
  const lifetime = useLifetime(),
    identity = useRef<InputIdentity | null>(null),
    base = baseFor(account.id);
  const connection = useServerConnection();
  const selectedBoard = boards.items.find((item) => item.id === boardId);
  const settings = { applicationDay: day, useRelativeDates: relative, listPrefix: prefix };
  const input = {
    ...settings,
    template: ref(template),
    destination: newBoard
      ? { kind: 'new', title }
      : { kind: 'existing', boardId, boardRevision: selectedBoard?.revision ?? -1 },
    confirmed: true,
  };
  const fingerprint = JSON.stringify(input),
    currentPreview = preview?.fingerprint === fingerprint ? preview.value : null;
  useEffect(() => setAcknowledged(false), [fingerprint]);
  const previousRuns = usePagedResource(
    `${account.id}:previous-template-runs:${template.snapshot.id}`,
    (cursor, signal) => request(`${base}/template-runs${query(cursor)}`, RunPageSchema, { signal }),
    (item) => item.id,
  );
  const sameRuns = previousRuns.items.filter(
    (run) => run.accountId === account.id && run.snapshotId === template.snapshot.id,
  );
  const conflicts = usePagedResource(
    currentPreview && currentPreview.preview.labelColorConflictCount > 0
      ? `${account.id}:${template.snapshot.id}:color-conflicts`
      : null,
    (cursor, signal) =>
      request(`${base}/templates/label-conflicts`, ConflictPageSchema, {
        method: 'POST',
        body: { template: ref(template), limit: 50, ...(cursor ? { cursor } : {}) },
        signal,
      }),
    (item) => item.name,
  );
  const dirty = Boolean(boardId || newBoard || day !== today || prefix || attempt);
  useDirty(dirty, onDirtyChange);
  async function previewApplication() {
    const parsed = TemplateApplicationOptionsSchema.safeParse(settings);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'check the application day.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const value = await request(
        `${base}/templates/application-preview`,
        ApplicationPreviewSchema,
        {
          method: 'POST',
          body: { template: ref(template), options: parsed.data },
          signal: lifetime.current.signal,
        },
      );
      if (!lifetime.current.signal.aborted) {
        setPreview({ fingerprint, value });
        setAcknowledged(false);
      }
    } catch (caught) {
      if (!lifetime.current.signal.aborted) setError(errorMessage(caught));
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  async function begin(event: FormEvent) {
    event.preventDefault();
    if (!providerWritable(account) || busy || connection !== 'reachable') return;
    const parsed = ApplyTemplateSchema.safeParse(attempt?.input ?? input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'choose a current destination.');
      return;
    }
    if (
      !attempt &&
      (!currentPreview ||
        applicationCapacityMessage(
          currentPreview.preview.requiredListSlots,
          currentPreview.capacity,
        ) ||
        !acknowledged)
    )
      return;
    identity.current = unchangedInputIdentity(identity.current, parsed.data, () =>
      newOperationId(clockOffset),
    );
    const captured = attempt ?? { id: identity.current.id, input: parsed.data };
    setAttempt(captured);
    setBusy(true);
    setError('');
    try {
      const run = await request(`${base}/template-runs`, TemplateRunSummarySchema, {
        method: 'POST',
        body: { operationId: captured.id, input: captured.input },
        signal: lifetime.current.signal,
      });
      if (!lifetime.current.signal.aborted && run.accountId === account.id) onRun(run);
    } catch (caught) {
      if (!lifetime.current.signal.aborted)
        setError(
          `${errorMessage(caught)} the same captured input and operation identity are retained for retry. inspect that operation before starting another copy.`,
        );
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  const capacityMessage = currentPreview
    ? applicationCapacityMessage(currentPreview.preview.requiredListSlots, currentPreview.capacity)
    : '';
  return (
    <>
      <CloseGuard
        dirty={dirty}
        busy={busy}
        onClose={onClose}
        title={attempt ? 'leave this copy?' : undefined}
        discardLabel={attempt ? 'leave editor' : undefined}
        message={
          attempt
            ? 'the server may already have saved this copy. closing this editor does not cancel it. inspect the retained operation before making another copy.'
            : undefined
        }
      >
        {(close) => (
          <Dialog title={`use ${template.name}`} onClose={close} wide pending={busy}>
            <form className="dialog__body templates__form" onSubmit={(event) => void begin(event)}>
              <ServerRecovery />
              <p>
                content v{template.contentRevision} · this creates new lists and open tasks.
                matching names stay separate.
              </p>
              <fieldset disabled={busy || Boolean(attempt) || !providerWritable(account)}>
                {template.kind === 'board' && (
                  <label>
                    destination
                    <Select
                      value={newBoard ? 'new' : 'existing'}
                      onChange={(selectedValue) => {
                        setNewBoard(selectedValue === 'new');
                        setAcknowledged(false);
                      }}
                      aria-label="destination"
                      options={[
                        { value: 'existing', label: 'add lists to an existing board' },
                        { value: 'new', label: 'create a new board' },
                      ]}
                    />
                  </label>
                )}
                {newBoard ? (
                  <label>
                    new board name
                    <input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      required
                    />
                  </label>
                ) : (
                  <BoardChoice
                    resource={boards}
                    value={boardId}
                    onChange={setBoardId}
                    label="destination board"
                  />
                )}
                <div className="templates__two-fields">
                  <label>
                    application day
                    <input
                      type="date"
                      value={day}
                      onChange={(event) => setDay(event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    list-name prefix <small>optional</small>
                    <input
                      value={prefix}
                      onChange={(event) => setPrefix(event.target.value)}
                      placeholder="e.g. november"
                    />
                  </label>
                </div>
                <label className="templates__check">
                  <input
                    type="checkbox"
                    checked={relative}
                    onChange={(event) => setRelative(event.target.checked)}
                    disabled={template.snapshot.dateMode === 'none'}
                  />
                  use relative dates, saved times and repeat presets
                </label>
                {template.snapshot.dateMode === 'none' && (
                  <p>this snapshot was saved without dates. there are no dates to restore.</p>
                )}
                <button
                  type="button"
                  className="templates__secondary"
                  onClick={() => void previewApplication()}
                >
                  preview this copy
                </button>
              </fieldset>
              {currentPreview && (
                <div className="templates__preview">
                  <div className="templates__numbers">
                    <span>
                      <strong>{currentPreview.preview.listCount}</strong>new lists
                    </span>
                    <span>
                      <strong>{currentPreview.preview.taskCount}</strong>open tasks
                    </span>
                    <span>
                      <strong>{currentPreview.capacity.available ?? 'unknown'}</strong>list slots
                      available
                    </span>
                  </div>
                  <p>
                    {currentPreview.preview.requiredListSlots} slots required ·{' '}
                    {currentPreview.capacity.known ?? 'unknown'} existing lists ·{' '}
                    {currentPreview.capacity.reserved} slots reserved · account limit 2,000.
                  </p>
                  {capacityMessage && (
                    <p className="templates__warning">
                      {capacityMessage}
                      {onRefreshInventory && (
                        <button
                          type="button"
                          className="templates__text"
                          onClick={onRefreshInventory}
                        >
                          refresh inventory
                        </button>
                      )}
                      <button
                        type="button"
                        className="templates__text"
                        disabled={busy || Boolean(attempt)}
                        onClick={() => void previewApplication()}
                      >
                        check capacity again
                      </button>
                    </p>
                  )}
                  {currentPreview.preview.negativeDateCount > 0 && (
                    <p className="templates__warning">
                      {currentPreview.preview.negativeDateCount} tasks will be dated before {day}.
                      those dates are kept as shown.
                    </p>
                  )}
                  <p>
                    {currentPreview.preview.omittedDates} dates,{' '}
                    {currentPreview.preview.omittedTimes} times,{' '}
                    {currentPreview.preview.omittedRepeatRules} repeat rules and{' '}
                    {currentPreview.preview.omittedDependencyCount} external dependencies omitted.
                  </p>
                  <p>
                    {currentPreview.preview.labelDefinitionCount} saved label definitions. matching
                    names reuse your account labels; their existing colors are kept.
                  </p>
                  {currentPreview.preview.labelColorConflictCount > 0 && (
                    <details>
                      <summary>
                        {currentPreview.preview.labelColorConflictCount} label color differences
                      </summary>
                      <ul className="templates__conflicts">
                        {conflicts.items.map((item) => (
                          <li key={item.name}>
                            {item.name}
                            <span>
                              <i style={{ background: item.requestedColor }} />
                              saved {item.requestedColor}
                              <Icon name="right" size={11} />
                              <i style={{ background: item.keptColor }} />
                              keep {item.keptColor}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <PageState resource={conflicts} />
                    </details>
                  )}
                </div>
              )}
              <details className="templates__disclosure">
                <summary>preview tasks and resulting dates</summary>
                <SnapshotContent
                  accountId={account.id}
                  snapshotId={template.snapshot.id}
                  applicationDay={day || today}
                  relative={relative}
                />
              </details>
              <details className="templates__disclosure">
                <summary>
                  previous copies of this snapshot
                  {sameRuns.length ? ` · ${sameRuns.length} loaded` : ''}
                </summary>
                {sameRuns.map((run) => (
                  <p key={run.id}>
                    {run.slotDay} · {run.state}{' '}
                    <button
                      type="button"
                      className="templates__text"
                      onClick={() => setInspectedRun(run)}
                    >
                      inspect retained output
                    </button>
                  </p>
                ))}
                {previousRuns.loaded && !sameRuns.length && (
                  <p>
                    no matching copy in the loaded run history.
                    {previousRuns.nextCursor ? ' more history is available.' : ''}
                  </p>
                )}
                <PageState resource={previousRuns} />
                <p>
                  a new copy does not resume or clean up earlier work. inspect partial or uncertain
                  runs before making another copy.
                </p>
              </details>
              {sameRuns.some((run) => !['succeeded', 'cancelled'].includes(run.state)) && (
                <p className="templates__warning templates__prior-output">
                  this snapshot already has retained unfinished output.{' '}
                  <button
                    className="templates__text"
                    type="button"
                    onClick={() =>
                      setInspectedRun(
                        sameRuns.find((run) => !['succeeded', 'cancelled'].includes(run.state))!,
                      )
                    }
                  >
                    inspect the existing run before creating another copy
                  </button>
                </p>
              )}
              {currentPreview && !attempt && (
                <label className="templates__check">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  create a separate new copy with the counts and dates above; previous output stays
                  intact
                </label>
              )}
              {error && (
                <p className="templates__error" role="alert">
                  {error}
                </p>
              )}
              {attempt && (
                <p className="templates__retained">
                  captured operation <code>{attempt.id}</code>
                  {onOpenOperation && (
                    <button
                      type="button"
                      className="templates__text"
                      onClick={() => onOpenOperation(attempt.id)}
                    >
                      inspect operation
                    </button>
                  )}
                </p>
              )}
              <footer>
                <button type="button" disabled={busy} onClick={close}>
                  close
                </button>
                <button
                  className="primary"
                  type="submit"
                  disabled={
                    busy ||
                    connection !== 'reachable' ||
                    !providerWritable(account) ||
                    (!attempt && (!currentPreview || Boolean(capacityMessage) || !acknowledged))
                  }
                >
                  {busy ? 'admitting copy…' : attempt ? 'retry captured copy' : 'create fresh copy'}
                </button>
              </footer>
            </form>
          </Dialog>
        )}
      </CloseGuard>
      {inspectedRun && (
        <RunDetail
          account={account}
          run={inspectedRun}
          onClose={() => setInspectedRun(null)}
          onChanged={() => void previousRuns.reload()}
          onOpenOperation={onOpenOperation}
        />
      )}
    </>
  );
}
