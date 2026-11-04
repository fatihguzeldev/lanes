import { useState } from 'react';
import { Dialog } from '../../../ui/Dialog';
import { TransferImport } from './imports/TransferImport';
import { TransferExport } from './exports/TransferExport';
import { TransferAccounts } from './TransferAccounts';
import { TransferArchive } from './archives/TransferArchive';
import { type TransferProps } from './transfer-context';
import { TransferConnection } from './TransferFeedback';
import { TransferActivity } from './TransferActivity';
import './TransferWorkspace.css';
export type TransferWorkspaceProps = TransferProps;
type Tab = 'import' | 'export' | 'accounts' | 'archive' | 'activity';
export function TransferWorkspace(props: TransferWorkspaceProps) {
  return <TransferBody key={props.account.id} {...props} />;
}
function TransferBody(props: TransferProps) {
  const [tab, setTab] = useState<Tab>(props.initialTab ?? 'import'),
    [dirty, setDirty] = useState(false),
    [nextTab, setNextTab] = useState<Tab | null>(null);
  const dirtyChanged = (value: boolean) => {
    setDirty(value);
    props.onDirtyChange?.(value);
  };
  const children = { ...props, onDirtyChange: dirtyChanged };
  return (
    <section className="transfer" aria-label="import, export and transfer">
      <header className="transfer__heading">
        <span className="transfer__eyebrow">your work can move with you</span>
        <h2>bring it along</h2>
        <p>{props.account.email}</p>
      </header>
      <nav className="transfer__tabs" aria-label="portability views">
        {(['import', 'export', 'accounts', 'archive', 'activity'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={value === tab}
            onClick={() => {
              if (value === tab) return;
              if (dirty) setNextTab(value);
              else setTab(value);
            }}
          >
            {value === 'accounts' ? 'account copy' : value}
          </button>
        ))}
      </nav>
      <TransferConnection />
      {tab === 'import' && <TransferImport {...children} />}{' '}
      {tab === 'export' && <TransferExport {...children} />}{' '}
      {tab === 'accounts' && <TransferAccounts {...children} />}{' '}
      {tab === 'archive' && <TransferArchive {...children} />}{' '}
      {tab === 'activity' && <TransferActivity {...children} />}
      {nextTab && (
        <Dialog title="leave this editor?" onClose={() => setNextTab(null)}>
          <div className="dialog__body">
            <p>
              unsent local drafts will be discarded. captured operations stay saved; leaving does
              not cancel admitted work. inspect retained output before starting another copy.
            </p>
            <footer>
              <button type="button" onClick={() => setNextTab(null)}>
                keep editing
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setTab(nextTab);
                  setNextTab(null);
                  dirtyChanged(false);
                }}
              >
                leave editor
              </button>
            </footer>
          </div>
        </Dialog>
      )}
    </section>
  );
}
