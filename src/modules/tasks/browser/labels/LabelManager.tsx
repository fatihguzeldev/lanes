import { useState } from 'react';
import { z } from 'zod';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { Icon } from '../../../../shared/ui/icon/Icon';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import { LabelSchema, type Label } from '../../contracts/task';
import { LabelPageSchema, TaskCoverageSchema } from '../../contracts/query';
import { LabelDeletionJobSchema } from '../../contracts/metadata-commands';
import {
  Confirmation,
  type ConfirmationChoice,
} from '../../../operations/browser/submission/Confirmation';
import { checkServerConnection, request } from '../../../../shared/browser/http/http';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import './LabelManager.css';

const deletionPage = z
  .object({
    items: z.array(LabelDeletionJobSchema).max(100),
    nextCursor: z.string().nullable(),
    coverage: TaskCoverageSchema,
  })
  .strict();
interface Props {
  account: ConnectionSummary;
  version: number;
  clockOffset: number;
  onChanged: () => void;
  onClose: () => void;
}
export function LabelManager({ account, version, clockOffset, onChanged, onClose }: Props) {
  const [form, setForm] = useState<Label | null | false>(false),
    [confirmation, setConfirmation] = useState<ConfirmationChoice | null>(null);
  const [readError, setReadError] = useState('');
  const connection = useServerConnection();
  const commands = useCommands(account.id, clockOffset, onChanged);
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
  const pending = new Set(jobs.items.map((job) => job.labelId));
  const writable =
    !['disconnected', 'disconnecting'].includes(account.state) && connection === 'reachable';
  const review = async () => {
    if (!form) return false;
    setReadError('');
    try {
      const value = await request(
        `${base}/resolve`,
        z.object({ items: z.array(LabelSchema).max(100) }).strict(),
        { method: 'POST', body: { ids: [form.id] } },
      );
      const current = value.items[0];
      if (!current) {
        setReadError('this label is no longer available. your typed fields are still here.');
        return false;
      }
      setForm(current);
      commands.clearError();
      return true;
    } catch (error) {
      setReadError(error instanceof Error ? error.message : 'the current label could not load.');
      return false;
    }
  };
  const continueJob = async (jobId: string) => {
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
  };
  const remove = (label: Label) =>
    setConfirmation({
      title: `delete ${label.name}?`,
      message:
        'this label will be removed from tasks in this account. their google content stays. a large label can take several bounded steps to detach.',
      confirmLabel: 'delete label',
      onConfirm: async (identity) => {
        const result = await commands.submit(
          { kind: 'label.delete.start', labelId: label.id, expectedRevision: label.revision },
          'local',
          identity,
        );
        if (result?.state !== 'succeeded') return false;
        await continueJob(`label-delete:${identity}`);
        return true;
      },
    });
  return (
    <>
      <Dialog title="labels" onClose={onClose} wide pending={commands.busy}>
        <div className="dialog__body label-manager">
          <p>labels belong to this google account. use them across its boards.</p>
          {connection !== 'reachable' && (
            <p role="status">
              the server connection is paused.{' '}
              <button
                onClick={() => {
                  if (connection === 'incompatible') window.location.reload();
                  else
                    void checkServerConnection().catch((error) =>
                      setReadError(
                        error instanceof Error ? error.message : 'the server is still unavailable.',
                      ),
                    );
                }}
              >
                {connection === 'incompatible' ? 'reload lanes' : 'check connection'}
              </button>
            </p>
          )}
          {form !== false ? (
            <LabelForm
              key={form?.id ?? 'new'}
              label={form}
              clockOffset={clockOffset}
              pending={commands.busy}
              writable={writable}
              error={commands.error || readError}
              onReview={review}
              onCancel={() => setForm(false)}
              onSubmit={async (name, color, identity) => {
                const command = form
                  ? {
                      kind: 'label.update',
                      labelId: form.id,
                      expectedRevision: form.revision,
                      input: { name, color },
                    }
                  : { kind: 'label.create', input: { name, color } };
                const result = await commands.submit(command, 'local', identity);
                if (result?.state === 'succeeded') {
                  setForm(false);
                  onChanged();
                }
              }}
            />
          ) : (
            <button
              className="label-manager__new"
              disabled={!writable || commands.busy}
              onClick={() => setForm(null)}
            >
              <Icon name="plus" size={14} />
              new label
            </button>
          )}
          <ul className="label-manager__labels">
            {labels.items.map((label) => (
              <li key={label.id}>
                <span className="label-manager__swatch" style={{ backgroundColor: label.color }} />
                <strong>{label.name}</strong>
                {pending.has(label.id) ? (
                  <small>deleting…</small>
                ) : (
                  <>
                    <button
                      disabled={!writable || commands.busy}
                      onClick={() => setForm(label)}
                      aria-label={`edit ${label.name}`}
                    >
                      <Icon name="pen" size={14} />
                    </button>
                    <button
                      disabled={!writable || commands.busy}
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
              {labels.error}
            </p>
          )}
          {labels.loaded && !labels.items.length && <p>no labels yet.</p>}
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
                    disabled={!writable || commands.busy}
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
          {(commands.error || readError) && form === false && (
            <p role="alert" className="error">
              {commands.error || readError}
            </p>
          )}
        </div>
      </Dialog>
      {confirmation && (
        <Confirmation
          choice={confirmation}
          clockOffset={clockOffset}
          error={commands.error}
          onClose={() => setConfirmation(null)}
        />
      )}
    </>
  );
}
function LabelForm({
  label,
  clockOffset,
  pending,
  writable,
  error,
  onReview,
  onSubmit,
  onCancel,
}: {
  label: Label | null;
  clockOffset: number;
  pending: boolean;
  writable: boolean;
  error: string;
  onReview: () => Promise<boolean>;
  onSubmit: (name: string, color: string, identity: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(label?.name ?? ''),
    [color, setColor] = useState(() =>
      label?.color.length === 4
        ? '#' + [...label.color.slice(1)].map((value) => value + value).join('')
        : (label?.color ?? '#65734f'),
    ),
    [identity, setIdentity] = useState(() => newOperationId(clockOffset));
  return (
    <form
      className="label-manager__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (writable && !pending) void onSubmit(name, color, identity);
      }}
    >
      <label>
        name
        <input value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
      </label>
      <label>
        color
        <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {label && error && (
        <button
          type="button"
          disabled={pending || !writable}
          onClick={() =>
            void onReview().then((done) => {
              if (done) setIdentity(newOperationId(clockOffset));
            })
          }
        >
          review current revision and keep these fields
        </button>
      )}
      <footer>
        <button type="button" onClick={onCancel} disabled={pending}>
          cancel
        </button>
        <button className="primary" disabled={pending || !writable} type="submit">
          {pending ? 'saving…' : label ? 'save label' : 'create label'}
        </button>
      </footer>
    </form>
  );
}
