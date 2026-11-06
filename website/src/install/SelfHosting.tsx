import { useEffect, useRef } from 'react';
import { CopyCommand } from './CopyCommand';
import { AgentPrompt } from './AgentPrompt';
import { WorkbenchIcon } from '../details/WorkbenchIcon';
import './SelfHosting.css';

const GUIDE = 'https://github.com/fatihguzeldev/lanes/blob/main/agents/self-hosting.md';

export function SelfHosting({ open, onClose }: { open: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    if (open && !panel.open) panel.showModal();
    else if (!open && panel.open) panel.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="self-host-dialog"
      id="self-host"
      aria-labelledby="self-host-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="self-host-dialog__header">
        <div>
          <h2 id="self-host-title">host your own lanes</h2>
          <p>deploy to your cloudflare account.</p>
        </div>
        <button
          className="self-host-dialog__close"
          type="button"
          aria-label="close setup"
          onClick={onClose}
        >
          <WorkbenchIcon name="close" />
        </button>
      </header>
      <div className="self-host-dialog__fields">
        <CopyCommand />
        <AgentPrompt />
      </div>
      <footer className="self-host-dialog__footer">
        <a href={GUIDE}>read the setup guide</a>
      </footer>
    </dialog>
  );
}
