import { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { newOperationId } from './operation-identity';

export type Prompt = {
  title: string;
  label: string;
  initial: string;
  description?: string;
  destructive?: boolean;
  submit: (value: string, identity: string) => Promise<boolean>;
};

export function PromptDialog({
  prompt,
  onClose,
  clockOffset,
}: {
  prompt: Prompt;
  onClose: () => void;
  clockOffset: number;
}) {
  const [value, setValue] = useState(prompt.initial),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [identity] = useState(() => newOperationId(clockOffset));
  return (
    <Dialog title={prompt.title} onClose={onClose} pending={pending}>
      <form
        className="dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setError('');
          void prompt
            .submit(value, identity)
            .then((done) => {
              if (done) onClose();
              else setError('the save is not confirmed yet. check its status before trying again.');
            })
            .catch((error) =>
              setError(
                error instanceof Error ? error.message : 'this change could not be submitted.',
              ),
            )
            .finally(() => setPending(false));
        }}
      >
        {prompt.description && <p>{prompt.description}</p>}
        <label>
          {prompt.label}
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
            maxLength={1024}
            autoFocus
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose} disabled={pending}>
            cancel
          </button>
          <button
            type="submit"
            className={`primary${prompt.destructive ? ' danger' : ''}`}
            disabled={pending}
          >
            {pending ? 'saving…' : prompt.destructive ? 'delete' : 'save'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
