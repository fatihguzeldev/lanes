import { CoverageSchema } from '../../../../shared/contracts/coverage';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
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
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import { ColorPicker, ColorPreview } from '../../../../shared/ui/color-picker/ColorPicker';
import { Popover } from '../../../../shared/ui/popover/Popover';
import { InlineField } from '../../../../shared/ui/inline-field/InlineField';
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
  version: number;
  clockOffset: number;
  onChanged: () => void;
  onClose: () => void;
}
export function LabelManager({ account, version, clockOffset, onChanged, onClose }: Props) {
  const [form, setForm] = useState<Label | null | false>(false),
    [confirmation, setConfirmation] = useState<ConfirmationChoice | null>(null);
  const [readError, setReadError] = useState('');
  const [colorChange, setColorChange] = useState<{
    source: Label;
    color: string;
    confirmed: boolean;
  } | null>(null);
  const colorFlight = useRef(false);
  const nameFlight = useRef(false);
  const closeRequested = useRef(false);
  const connection = useServerConnection();
  const commands = useCommands(account.id, clockOffset, onChanged);
  useEffect(() => {
    if (closeRequested.current && !commands.busy && !colorFlight.current && !nameFlight.current) {
      closeRequested.current = false;
      if (!commands.error) onClose();
    }
  }, [commands.busy, commands.error, onClose]);
  const close = () => {
    if (commands.busy || colorFlight.current || nameFlight.current) closeRequested.current = true;
    else onClose();
  };
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
  useEffect(() => {
    if (!colorChange?.confirmed) return;
    const current = labels.items.find((label) => label.id === colorChange.source.id);
    if (
      (current && current.revision > colorChange.source.revision) ||
      (!current && labels.loaded && labels.status !== 'loading' && !labels.error)
    )
      setColorChange(null);
  }, [colorChange, labels.items, labels.loaded, labels.status, labels.error]);
  const writable =
    !['disconnected', 'disconnecting'].includes(account.state) && connection === 'reachable';
  async function changeColor(label: Label, color: string) {
    if (colorFlight.current || colorChange || commands.busy || !writable || form !== false)
      return false;
    if (label.color === color) return true;
    colorFlight.current = true;
    setColorChange({ source: label, color, confirmed: false });
    try {
      const result = await commands.submit(
        {
          kind: 'label.update',
          labelId: label.id,
          expectedRevision: label.revision,
          input: { color },
        },
        'local',
      );
      if (result?.state === 'succeeded') {
        setColorChange((current) => (current ? { ...current, confirmed: true } : null));
        return true;
      }
      setColorChange(null);
      return false;
    } finally {
      colorFlight.current = false;
    }
  }
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
      <Dialog title="labels" onClose={close} wide>
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
            <LabelDraft
              key={form?.id ?? 'new'}
              label={form}
              clockOffset={clockOffset}
              pending={commands.busy || !!colorChange}
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
                nameFlight.current = true;
                try {
                  const result = await commands.submit(command, 'local', identity);
                  if (result?.state === 'succeeded') setForm(false);
                  return result?.state === 'succeeded';
                } finally {
                  nameFlight.current = false;
                }
              }}
            />
          ) : (
            <button
              className="label-manager__new"
              disabled={!writable || commands.busy || !!colorChange}
              onClick={() => setForm(null)}
            >
              <Icon name="plus" size={14} />
              new label
            </button>
          )}
          <ul className="label-manager__labels">
            {labels.items.map((label) => (
              <li key={label.id}>
                <Popover
                  label={`${label.name} color`}
                  disabled={
                    !writable ||
                    commands.busy ||
                    !!colorChange ||
                    pending.has(label.id) ||
                    form !== false
                  }
                  trigger={
                    <ColorPreview
                      value={colorChange?.source.id === label.id ? colorChange.color : label.color}
                    />
                  }
                >
                  {(close) => (
                    <ColorPicker
                      value={colorChange?.source.id === label.id ? colorChange.color : label.color}
                      disabled={commands.busy || !!colorChange}
                      onChange={async (color) => {
                        const done = await changeColor(label, color);
                        if (done) close();
                        return done;
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
                      disabled={!writable || commands.busy || !!colorChange}
                      onClick={() => setForm(label)}
                      aria-label={`edit ${label.name}`}
                    >
                      <Icon name="pen" size={14} />
                    </button>
                    <button
                      disabled={!writable || commands.busy || !!colorChange}
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
                    disabled={!writable || commands.busy || !!colorChange}
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
function LabelDraft({
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
  onSubmit: (name: string, color: string, identity: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [identity, setIdentity] = useState(() => newOperationId(clockOffset));
  return (
    <div className="label-manager__draft">
      <InlineField
        value={label?.name ?? ''}
        label="label name"
        placeholder="label name"
        maxLength={128}
        autoFocus
        disabled={pending || !writable}
        onCancel={onCancel}
        onCommit={(name) => {
          const parsed = LabelSchema.shape.name.safeParse(name);
          if (!parsed.success)
            throw new Error(parsed.error.issues[0]?.message ?? 'check this label name.');
          return onSubmit(parsed.data, label?.color ?? '#82966f', identity);
        }}
      />
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
    </div>
  );
}
