import { useState } from 'react';
import type { ReopenPreview } from '../modules/tasks/recurrence-contract';
import { RecurrenceStatusSchema } from '../modules/tasks/recurrence-contract';
import { Dialog } from '../ui/Dialog';
import { request } from '../client/http';
import { newOperationId } from '../client/operation-identity';
import { Select } from '../ui/Select';

export function ReopenDialog({
  accountId,
  title,
  preview,
  clockOffset,
  onClose,
  onAdmitted,
}: {
  accountId: string;
  title: string;
  preview: ReopenPreview;
  clockOffset: number;
  onClose: () => void;
  onAdmitted: () => void;
}) {
  const [choice, setChoice] = useState(preview.choices[0] ?? 'one_off'),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [identity] = useState(() => newOperationId(clockOffset));
  return (
    <Dialog title={`reopen ${title || 'this occurrence'}?`} onClose={onClose} pending={pending}>
      <form
        className="dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setError('');
          void request(
            `/api/accounts/${encodeURIComponent(accountId)}/tasks/${encodeURIComponent(preview.taskId)}/recurrence/reopen`,
            RecurrenceStatusSchema.nullable(),
            {
              method: 'POST',
              body: {
                taskId: preview.taskId,
                revision: preview.revision,
                operationId: identity,
                choice,
                confirm: true,
                token: preview.token,
              },
            },
          )
            .then(() => {
              onAdmitted();
              onClose();
            })
            .catch((error) =>
              setError(
                error instanceof Error ? error.message : 'the reopen choice could not be recorded.',
              ),
            )
            .finally(() => setPending(false));
        }}
      >
        <p>{preview.reason}</p>
        {preview.successorTitle && (
          <p>
            successor: {preview.successorTitle}
            {preview.successorSubtaskCount ? ` · ${preview.successorSubtaskCount} subtasks` : ''}
          </p>
        )}
        <label>
          how to reopen
          <Select
            value={choice}
            onChange={(selectedValue) => setChoice(selectedValue as typeof choice)}
            disabled={pending}
            aria-label="how to reopen"
            options={[
              ...preview.choices.map((value) => ({
                value: value,
                label:
                  value === 'cancel_pending'
                    ? 'cancel the unsent successor'
                    : value === 'remove_untouched'
                      ? 'verify and remove the untouched successor'
                      : 'keep the successor; make this a one-off',
              })),
            ]}
          />
        </label>
        {choice === 'remove_untouched' && (
          <p className="entry-note">
            the successor and its checklist will be checked against google before deletion. changed
            content stays in place.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={pending} onClick={onClose}>
            cancel
          </button>
          <button className="primary" type="submit" disabled={pending}>
            {pending ? 'recording…' : 'confirm reopen'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
