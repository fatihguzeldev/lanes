import { CoverageSchema } from '../../../../shared/contracts/coverage';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Icon } from '../../../../shared/ui/icon/Icon';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import { LabelSchema, type Label } from '../../contracts/task';
import { LabelPageSchema } from '../../contracts/query';
import { LabelDeletionJobSchema } from '../../contracts/metadata-commands';
import {
  Confirmation,
  type ConfirmationChoice,
} from '../../../operations/browser/submission/Confirmation';
import { checkServerConnection, request } from '../../../../shared/browser/http/http';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import { ColorPicker, ColorPreview } from '../../../../shared/ui/color-picker/ColorPicker';
import { AnchoredPopover, Popover } from '../../../../shared/ui/popover/Popover';
import { InlineField } from '../../../../shared/ui/inline-field/InlineField';
import { useLabelChanges } from './useLabelChanges';
import './LabelManager.css';

const deletionPage = z
  .object({
    items: z.array(LabelDeletionJobSchema).max(100),
    nextCursor: z.string().nullable(),
    coverage: CoverageSchema,
  })
  .strict();
interface Props {
  account: ConnectionSummary;
  anchor: HTMLElement;
  onBusyChange?(busy: boolean): void;
  onError?(message: string, operationId?: string): void;
  initialCreate?: boolean;
  presented?: boolean;
  version: number;
  clockOffset: number;
  onChanged: () => void;
  onClose: () => void;
}
export function LabelManager({
  account,
  anchor,
  onBusyChange,
  onError,
  initialCreate = false,
  presented = true,
  version,
  clockOffset,
  onChanged,
  onClose,
}: Props) {
  const [form, setForm] = useState<Label | null | false>(initialCreate ? null : false);
  const [confirmation, setConfirmation] = useState<ConfirmationChoice | null>(null);
  const [readError, setReadError] = useState('');
  const [closing, setClosing] = useState(false);
  const connection = useServerConnection();
  const commands = useCommands(account.id, clockOffset, onChanged);
  const busyListener = useRef(onBusyChange);
  busyListener.current = onBusyChange;
  const base = `/api/accounts/${encodeURIComponent(account.id)}/labels`;
  const labels = usePagedResource(
    `${account.id}:manage-labels`,
    (cursor, signal) =>
      request(base + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), LabelPageSchema, {
        signal,
      }),
    (label) => label.id,
    version,
  );
  const jobs = usePagedResource(
    `${account.id}:manage-label-jobs`,
    (cursor, signal) =>
      request(
        `${base}/deletions${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        deletionPage,
        { signal },
      ),
    (job) => job.id,
    version,
  );
  async function continueJob(jobId: string) {
    for (let slice = 0; slice < 20; slice++) {
      const job = await request(
        `${base}/deletions?jobId=${encodeURIComponent(jobId)}`,
        LabelDeletionJobSchema,
      );
      if (job.state === 'completed') break;
      const result = await commands.submit(
        { kind: 'label.delete.continue', jobId, limit: 10 },
        'local',
      );
      if (result?.state !== 'succeeded') break;
    }
    onChanged();
  }
  const changes = useLabelChanges({
    accountId: account.id,
    clockOffset,
    version,
    labels: labels.items,
    inventoryReady: labels.settled && labels.status === 'ready' && !labels.error,
    submit: (command, identity) => commands.submit(command, 'local', identity),
    onChanged,
    onDeleted: (identity) => continueJob(`label-delete:${identity}`),
    onError(message, operationId) {
      onError?.(message, operationId);
      setReadError(message);
      setClosing(false);
    },
  });
  const busy = commands.busy || changes.isSaving();
  useEffect(() => {
    busyListener.current?.(busy);
  }, [busy]);
  useEffect(() => () => busyListener.current?.(false), []);
  useEffect(() => {
    if (closing && !busy) {
      if (readError) setClosing(false);
      else onClose();
    }
  }, [closing, busy, readError, onClose]);
  const close = () => {
    if (changes.isSaving() || commands.isBusy?.()) setClosing(true);
    else onClose();
  };
  const writable =
    !['disconnected', 'disconnecting'].includes(account.state) && connection === 'reachable';
  const pending = new Set(jobs.items.map((job) => job.labelId));
  const remove = (label: Label) =>
    setConfirmation({
      title: `delete ${label.name}?`,
      message: 'this label will be removed from tasks in this account. their google content stays.',
      confirmLabel: 'delete label',
      onConfirm: async (identity) => changes.remove(label, identity),
    });
  return (
    <>
      {presented && !closing && !confirmation && (
        <AnchoredPopover anchor={anchor} label="labels" onClose={close} className="label-manager">
          <div className="label-manager__body">
            <div className="label-manager__heading">
              <h3>labels</h3>
              <button type="button" aria-label="close labels" onClick={close}>
                <Icon name="close" size={15} />
              </button>
            </div>
            {connection !== 'reachable' && (
              <p role="status">
                the server connection is paused.{' '}
                <button
                  onClick={() => {
                    if (connection === 'incompatible') window.location.reload();
                    else
                      void checkServerConnection().catch((error) =>
                        setReadError(
                          error instanceof Error
                            ? error.message
                            : 'the server is still unavailable.',
                        ),
                      );
                  }}
                >
                  {connection === 'incompatible' ? 'reload lanes' : 'check connection'}
                </button>
              </p>
            )}
            {form !== false ? (
              <LabelDraft
                key={form?.id ?? 'new'}
                label={form}
                writable={writable}
                onCancel={() => setForm(false)}
                onSubmit={async (name, color) => {
                  const accepted = form
                    ? changes.change(form, { name, color })
                    : changes.create(name, color);
                  if (accepted) setForm(false);
                  return accepted;
                }}
              />
            ) : (
              <button
                className="label-manager__new"
                disabled={!writable}
                onClick={() => {
                  setReadError('');
                  setForm(null);
                }}
              >
                <Icon name="plus" size={14} /> new label
              </button>
            )}
            <ul className="label-manager__labels">
              {changes.labels.map((label) => (
                <li key={label.id}>
                  <Popover
                    label={`${label.name} color`}
                    disabled={!writable || pending.has(label.id)}
                    trigger={<ColorPreview value={label.color} />}
                  >
                    {(closePicker) => (
                      <ColorPicker
                        value={label.color}
                        disabled={!writable}
                        onChange={async (color) => {
                          const accepted = changes.change(label, { color });
                          if (accepted) closePicker();
                          return accepted;
                        }}
                      />
                    )}
                  </Popover>
                  <strong>{label.name}</strong>
                  {pending.has(label.id) ? (
                    <small>deleting…</small>
                  ) : (
                    <>
                      <button
                        disabled={!writable}
                        onClick={() => {
                          setReadError('');
                          setForm(label);
                        }}
                        aria-label={`edit ${label.name}`}
                      >
                        <Icon name="pen" size={14} />
                      </button>
                      <button
                        disabled={!writable}
                        onClick={() => remove(label)}
                        aria-label={`delete ${label.name}`}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {labels.status === 'loading' && <p>loading labels…</p>}
            {labels.error && (
              <p role="alert" className="error">
                {labels.error} <button onClick={() => void labels.reload()}>retry</button>
              </p>
            )}
            {labels.nextCursor && (
              <button disabled={labels.status === 'loading'} onClick={() => void labels.loadMore()}>
                more labels
              </button>
            )}
            {jobs.items.length > 0 && (
              <div className="label-manager__jobs">
                <h3>finishing deletions</h3>
                {jobs.items.map((job) => (
                  <div key={job.id}>
                    <span>
                      {job.labelName} · {job.removedAssociations} tasks detached
                    </span>
                    <button
                      disabled={!writable}
                      onClick={() =>
                        void continueJob(job.id).catch((error) =>
                          setReadError(
                            error instanceof Error
                              ? error.message
                              : 'label deletion progress could not load.',
                          ),
                        )
                      }
                    >
                      continue
                    </button>
                  </div>
                ))}
                {jobs.nextCursor && (
                  <button onClick={() => void jobs.loadMore()}>more deletions</button>
                )}
              </div>
            )}
            {changes.failures.map((change) => (
              <div key={change.identity} className="error" role="alert">
                <p>
                  {change.input.name ?? change.source.name}: {change.error}
                </p>
                {change.command !== undefined && (
                  <button type="button" onClick={() => changes.retry(change.identity)}>
                    retry this save
                  </button>
                )}
              </div>
            ))}
            {(commands.error || readError) && !changes.failures.length && (
              <p role="alert" className="error">
                {readError || commands.error}
              </p>
            )}
          </div>
        </AnchoredPopover>
      )}
      {presented && confirmation && (
        <Confirmation
          choice={confirmation}
          clockOffset={clockOffset}
          onError={setReadError}
          onClose={() => setConfirmation(null)}
        />
      )}
    </>
  );
}
function LabelDraft({
  label,
  writable,
  onSubmit,
  onCancel,
}: {
  label: Label | null;
  writable: boolean;
  onSubmit(name: string, color: string): Promise<boolean>;
  onCancel(): void;
}) {
  return (
    <div className="label-manager__draft">
      <InlineField
        value={label?.name ?? ''}
        label="label name"
        placeholder="label name"
        maxLength={64}
        autoFocus
        disabled={!writable}
        onCancel={onCancel}
        onCommit={(name) => {
          const parsed = LabelSchema.shape.name.safeParse(name);
          if (!parsed.success)
            throw new Error(parsed.error.issues[0]?.message ?? 'check this label name.');
          return onSubmit(parsed.data, label?.color ?? '#82966f');
        }}
      />
    </div>
  );
}
