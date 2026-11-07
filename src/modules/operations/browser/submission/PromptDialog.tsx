import { useRef, useState } from 'react';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { newOperationId } from './operation-identity';

export type Prompt = {
  title: string;
  label: string;
  initial: string;
  description?: string;
  destructive?: boolean;
  validate?: (value: string) => string | null;
  submit: (value: string, identity: string) => Promise<boolean>;
};

export function PromptDialog({
  prompt,
  onClose,
  clockOffset,
  onError,
}: {
  prompt: Prompt;
  onClose: () => void;
  clockOffset: number;
  onError?: (message: string) => void;
}) {
  const [value, setValue] = useState(prompt.initial),
    [error, setError] = useState('');
  const [identity] = useState(() => newOperationId(clockOffset));
  const captured = useRef(false);
  return (
    <Dialog title={prompt.title} onClose={onClose}>
      <form
        className="dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          if (captured.current) return;
          const invalid = prompt.validate?.(value);
          if (invalid) {
            setError(invalid);
            return;
          }
          captured.current = true;
          try {
            const submission = prompt.submit(value, identity);
            onClose();
            void submission.catch((caught) =>
              onError?.(
                caught instanceof Error ? caught.message : 'this change could not be submitted.',
              ),
            );
          } catch (caught) {
            captured.current = false;
            setError(
              caught instanceof Error ? caught.message : 'this change could not be submitted.',
            );
          }
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
          <button type="button" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className={`primary${prompt.destructive ? ' danger' : ''}`}>
            {prompt.destructive ? 'delete' : 'save'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
