import { useState } from 'react';
import { copyText } from './copy-command';
import './copy-command.css';

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'unavailable'>('idle');

  async function copy() {
    setStatus('copying');
    const copied = await copyText(text, navigator.clipboard);
    setStatus(copied ? 'copied' : 'unavailable');
  }

  const buttonText = {
    idle: 'copy',
    copying: 'copying…',
    copied: 'copied',
    unavailable: 'copy unavailable',
  }[status];

  return (
    <>
      <button
        className="install-copy-button"
        type="button"
        onClick={copy}
        disabled={status === 'copying'}
        aria-label={status === 'idle' ? label : `${label}, ${buttonText}`}
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          {status === 'copied' ? (
            <path d="m4.5 10 3.5 3.5 7.5-7.5" />
          ) : (
            <>
              <rect x="6.5" y="6.5" width="9" height="10" rx="1.5" />
              <path d="M12.5 6.5V4A1.5 1.5 0 0 0 11 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h2.5" />
            </>
          )}
        </svg>
        <span>{buttonText}</span>
      </button>
      <span className="install-copy-status" role="status">
        {status === 'copied'
          ? 'copied to clipboard.'
          : status === 'unavailable'
            ? 'clipboard unavailable. select and copy the text.'
            : ''}
      </span>
    </>
  );
}
