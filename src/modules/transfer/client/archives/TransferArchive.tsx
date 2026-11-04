import { useState } from 'react';
import { type TransferProps } from '../transfer-context';
import { useTransferDirty } from '../useTransferDirty';
import { TransferArchiveExport } from './TransferArchiveExport';
import { ArchiveImport } from './ArchiveImport';
export function TransferArchive(props: TransferProps) {
  const [dirtyImport, setDirtyImport] = useState(false),
    [dirtyExport, setDirtyExport] = useState(false);
  useTransferDirty(dirtyImport || dirtyExport, props.onDirtyChange);
  return (
    <>
      <details className="transfer__details">
        <summary>export a private workspace archive</summary>
        <TransferArchiveExport {...props} onDirtyChange={setDirtyExport} />
      </details>
      <ArchiveImport {...props} onDirtyChange={setDirtyImport} />
    </>
  );
}
