import { lazy, Suspense, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';

const TemplateWorkspace = lazy(() =>
  import('./TemplateWorkspace').then((module) => ({ default: module.TemplateWorkspace })),
);
export function useTemplateDialog() {
  const [open, setOpen] = useState(false),
    [dirty, setDirty] = useState(false);
  return {
    open,
    dirty,
    setDirty,
    show() {
      setOpen(true);
    },
    close() {
      setOpen(false);
      setDirty(false);
    },
  };
}
interface Props {
  controller: ReturnType<typeof useTemplateDialog>;
  account: ConnectionSummary;
  clockOffset: number;
  version: number;
  guard(action: () => void): void;
  onChanged(): void;
  onInspect(id: string): void;
  onRefreshInventory(): void;
}
export function TemplateDialog({
  controller,
  account,
  clockOffset,
  version,
  guard,
  onChanged,
  onInspect,
  onRefreshInventory,
}: Props) {
  return (
    <>
      {controller.open && (
        <Dialog
          title="templates"
          wide
          onClose={() =>
            guard(() => {
              controller.close();
            })
          }
        >
          <Suspense fallback={<div className="dialog__body">opening templates…</div>}>
            <TemplateWorkspace
              account={account}
              clockOffset={clockOffset}
              version={version}
              onChanged={onChanged}
              onDirtyChange={controller.setDirty}
              onOpenOperation={(id) => {
                onInspect(id);
              }}
              onRefreshInventory={onRefreshInventory}
            />
          </Suspense>
        </Dialog>
      )}
    </>
  );
}
