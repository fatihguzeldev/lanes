import { useEffect, useState } from 'react';
import { CLONE_COMMAND, copyInstallCommand } from './copy-command';
import './copy-command.css';

export function CopyCommand() {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'unavailable'>('idle');

  useEffect(() => {
    if (status !== 'copied') return;
    const timeout = window.setTimeout(() => setStatus('idle'), 2_000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  async function copy() {
    setStatus('copying');
    const copied = await copyInstallCommand(navigator.clipboard);
    setStatus(copied ? 'copied' : 'unavailable');
  }

  const label = {
    idle: 'copy',
    copying: 'copying…',
    copied: 'copied',
    unavailable: 'copy unavailable',
  }[status];

  return (
    <div className="copy-command">
      <code className="copy-command__text">{CLONE_COMMAND}</code>
      <button
        className="copy-command__button"
        type="button"
        onClick={copy}
        disabled={status === 'copying'}
        aria-label={status === 'idle' ? 'copy clone command' : label}
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
        <span>{label}</span>
      </button>
      <span className="copy-command__status" role="status">
        {status === 'copied'
          ? 'command copied to clipboard.'
          : status === 'unavailable'
            ? 'clipboard unavailable. select and copy the command.'
            : ''}
      </span>
    </div>
  );
}
